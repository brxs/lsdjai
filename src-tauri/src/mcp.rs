//! In-process MCP server (ADR-0020 Phase 2): an external AI agent (Claude Desktop /
//! Claude Code) as a co-DJ. Hosted inside the Tauri process, **always on**,
//! **loopback-only**, guarded by a **per-session bearer token**. Tools
//! mutate the one interface store (the same validated path UI and MIDI take), so an
//! agent's move is reflected on screen (the bidirectional projection); resources
//! read the store. A generation tool proxies the loopback generation server to
//! compose audio into the samples library, where the folder watcher surfaces it.
//!
//! Mirrors the generation server's spawn/supervise/shutdown discipline
//! ([`crate::generation`]): a disabled or failed start just leaves the endpoint
//! unadvertised (`port() == None`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use axum::extract::Request;
use axum::http::{header::AUTHORIZATION, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{
    AnnotateAble, ListResourcesResult, PaginatedRequestParams, RawResource,
    ReadResourceRequestParams, ReadResourceResult, ResourceContents, ServerCapabilities, ServerInfo,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::tower::{
    StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{tool, tool_handler, tool_router, ErrorData as McpError, RoleServer, ServerHandler};
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use crate::commands::{valid_deck, EqBandArg, FxKindArg};
use crate::generation::GenerationServer;
use crate::samples::{NewSample, SampleLibrary};
use crate::sidecar::Sidecars;
use crate::store::{InterfaceStore, PadPointSnap, StyleTargetSnap};
use lsdj_engine::host::Host;

/// The MCP request handler. Holds the [`AppHandle`] so a tool reaches the same
/// Tauri-managed state (`Host`, `InterfaceStore`, sidecars) the IPC commands drive —
/// no second copy of the control surface.
#[derive(Clone)]
pub struct McpHandler {
    app: AppHandle,
    tool_router: ToolRouter<Self>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CrossfadeArgs {
    /// Crossfader position, 0 = deck A, 1 = deck B.
    position: f32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeckGainArgs {
    /// Deck index: 0 = A, 1 = B.
    deck: usize,
    /// Channel volume, 0..1.
    gain: f32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeckEqArgs {
    /// Deck index: 0 = A, 1 = B.
    deck: usize,
    /// EQ band.
    band: EqBandArg,
    /// EQ amount, 0..1 (0.5 = flat).
    value: f32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CueMixArgs {
    /// Headphone cue/master blend, 0 = cue only, 1 = master.
    position: f32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeckFxArgs {
    /// Deck index: 0 = A, 1 = B.
    deck: usize,
    /// Color FX kind.
    kind: FxKindArg,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeckArgs {
    /// Deck index: 0 = A, 1 = B.
    deck: usize,
}

/// The Stable Audio 3 pad engines the generation server exposes (`/api/generate`).
/// `track` (the long-form medium model) is deliberately left out: this tool writes
/// to the *samples* library (short loops/one-shots), not the songs library.
#[derive(Debug, Clone, Copy, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Sa3Kind {
    Sfx,
    Music,
}

impl Sa3Kind {
    /// The wire value the generation server validates against (`sa3.KINDS`).
    fn as_str(self) -> &'static str {
        match self {
            Sa3Kind::Sfx => "sfx",
            Sa3Kind::Music => "music",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct GenerateSampleArgs {
    /// Text prompt describing the sound to generate.
    prompt: String,
    /// Clip length in seconds (the server validates the range; sfx/music cap at 32 s).
    seconds: f32,
    /// Engine: "sfx" or "music" (Stable Audio 3 small models).
    kind: Sa3Kind,
    /// Whether the clip plays once (a one-shot) instead of looping. Defaults to loop.
    #[serde(default)]
    one_shot: bool,
}

/// The `/api/generate` request body, matching the generation server's contract
/// (`prompt`/`seconds`/`kind`). Pulled out so the wire shape is unit-testable.
fn generate_request_body(prompt: &str, seconds: f32, kind: Sa3Kind) -> serde_json::Value {
    json!({ "prompt": prompt, "seconds": seconds, "kind": kind.as_str() })
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct HotCueArgs {
    /// Deck index: 0 = A, 1 = B.
    deck: usize,
    /// Hot-cue pad index (0-based).
    index: usize,
    /// Cue position in track seconds.
    seconds: f64,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct HotCuePadArgs {
    /// Deck index: 0 = A, 1 = B.
    deck: usize,
    /// Hot-cue pad index (0-based).
    index: usize,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SetStyleArgs {
    /// Deck index: 0 = A, 1 = B.
    deck: usize,
    /// The full set of style-pad targets (prompt + x/y position, 0..1) to install.
    targets: Vec<StyleTargetSnap>,
    /// The blend cursor on the pad (x/y, 0..1).
    cursor: PadPointSnap,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct StyleCursorArgs {
    /// Deck index: 0 = A, 1 = B.
    deck: usize,
    /// Cursor x (0..1).
    x: f32,
    /// Cursor y (0..1).
    y: f32,
}

/// How many hot-cue pads a deck currently has — the loaded track's cue-bank size, 0
/// with no track. Read from the store snapshot so the cue tools validate before
/// writing (and report "no track" / "out of range" rather than silently no-op).
fn cue_pad_count(store: &InterfaceStore, deck: usize) -> usize {
    store
        .snapshot()
        .decks
        .get(deck)
        .map(|d| d.cues.len())
        .unwrap_or(0)
}

#[tool_router]
impl McpHandler {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            tool_router: Self::tool_router(),
        }
    }

    /// Move the crossfader — forwarded to the engine and recorded in the store
    /// exactly as the UI/MIDI `set_crossfade` command does, so the on-screen
    /// crossfader follows (the bidirectional projection).
    #[tool(description = "Set the crossfader position (0 = deck A, 1 = deck B).")]
    async fn set_crossfade(
        &self,
        Parameters(CrossfadeArgs { position }): Parameters<CrossfadeArgs>,
    ) -> String {
        self.app.state::<Host>().set_crossfade(position);
        self.app.state::<InterfaceStore>().set_crossfade(position);
        format!("crossfade set to {position}")
    }

    #[tool(description = "Set a deck's channel volume (0..1). deck 0 = A, 1 = B.")]
    async fn set_volume(
        &self,
        Parameters(DeckGainArgs { deck, gain }): Parameters<DeckGainArgs>,
    ) -> String {
        if !valid_deck(deck) {
            return format!("invalid deck {deck}");
        }
        self.app.state::<Host>().set_volume(deck, gain);
        self.app.state::<InterfaceStore>().set_volume(deck, gain);
        format!("deck {deck} volume = {gain}")
    }

    #[tool(description = "Set a deck's EQ band (low/mid/high) amount (0..1; 0.5 = flat).")]
    async fn set_eq(
        &self,
        Parameters(DeckEqArgs { deck, band, value }): Parameters<DeckEqArgs>,
    ) -> String {
        if !valid_deck(deck) {
            return format!("invalid deck {deck}");
        }
        self.app.state::<Host>().set_eq(deck, band.into(), value);
        self.app.state::<InterfaceStore>().set_eq(deck, band.into(), value);
        format!("deck {deck} eq updated")
    }

    #[tool(description = "Set the headphone cue/master blend (0 = cue only, 1 = master).")]
    async fn set_cue_mix(
        &self,
        Parameters(CueMixArgs { position }): Parameters<CueMixArgs>,
    ) -> String {
        self.app.state::<Host>().set_cue_mix(position);
        self.app.state::<InterfaceStore>().set_cue_mix(position);
        format!("cue mix = {position}")
    }

    #[tool(description = "Select a deck's Color FX: filter, dubEcho, space, crush, noise, or sweep.")]
    async fn set_fx(
        &self,
        Parameters(DeckFxArgs { deck, kind }): Parameters<DeckFxArgs>,
    ) -> String {
        if !valid_deck(deck) {
            return format!("invalid deck {deck}");
        }
        self.app.state::<Host>().set_fx(deck, kind.into());
        self.app.state::<InterfaceStore>().set_fx(deck, kind.into());
        format!("deck {deck} fx selected")
    }

    #[tool(description = "Remove a deck's Color FX.")]
    async fn clear_fx(&self, Parameters(DeckArgs { deck }): Parameters<DeckArgs>) -> String {
        if !valid_deck(deck) {
            return format!("invalid deck {deck}");
        }
        self.app.state::<Host>().clear_fx(deck);
        self.app.state::<InterfaceStore>().clear_fx(deck);
        format!("deck {deck} fx cleared")
    }

    #[tool(description = "Start a realtime deck generating.")]
    async fn deck_play(&self, Parameters(DeckArgs { deck }): Parameters<DeckArgs>) -> String {
        if !valid_deck(deck) {
            return format!("invalid deck {deck}");
        }
        // Open the engine gate, then tell the worker to generate — the same order
        // the `deck_play` command takes.
        self.app.state::<Host>().set_deck_playing(deck, true);
        self.app
            .state::<Sidecars>()
            .send(deck, &json!({ "type": "play" }).to_string());
        format!("deck {deck} playing")
    }

    #[tool(description = "Stop a realtime deck.")]
    async fn deck_stop(&self, Parameters(DeckArgs { deck }): Parameters<DeckArgs>) -> String {
        if !valid_deck(deck) {
            return format!("invalid deck {deck}");
        }
        self.app.state::<Host>().set_deck_playing(deck, false);
        self.app
            .state::<Sidecars>()
            .send(deck, &json!({ "type": "stop" }).to_string());
        format!("deck {deck} stopped")
    }

    /// Set a hot-cue point on a playback deck's loaded track. Writes the store; the
    /// webview adopts the change and lights the pad (the bidirectional projection). A
    /// realtime deck / no track, or an out-of-range pad, comes back as a message.
    #[tool(
        description = "Set a hot-cue point on a deck's loaded track at the given time \
                       (track seconds). deck 0 = A, 1 = B; index is the 0-based pad."
    )]
    async fn set_hot_cue(
        &self,
        Parameters(HotCueArgs {
            deck,
            index,
            seconds,
        }): Parameters<HotCueArgs>,
    ) -> String {
        if !valid_deck(deck) {
            return format!("invalid deck {deck}");
        }
        let store = self.app.state::<InterfaceStore>();
        let pads = cue_pad_count(&store, deck);
        if pads == 0 {
            return format!("deck {deck} has no loaded track, so no hot cues");
        }
        if index >= pads {
            return format!("hot-cue pad {index} is out of range (deck {deck} has {pads})");
        }
        store.set_deck_cue(deck, index, Some(seconds));
        format!("deck {deck} hot cue {index} set to {seconds:.2}s")
    }

    #[tool(description = "Clear a hot-cue pad on a deck's loaded track. deck 0 = A, 1 = B.")]
    async fn clear_hot_cue(
        &self,
        Parameters(HotCuePadArgs { deck, index }): Parameters<HotCuePadArgs>,
    ) -> String {
        if !valid_deck(deck) {
            return format!("invalid deck {deck}");
        }
        let store = self.app.state::<InterfaceStore>();
        if index >= cue_pad_count(&store, deck) {
            return format!("deck {deck} has no hot-cue pad {index}");
        }
        store.set_deck_cue(deck, index, None);
        format!("deck {deck} hot cue {index} cleared")
    }

    /// Jump the deck's track to a hot cue — a transport seek straight to the engine
    /// (the cue point is read from the store), like the UI's filled-pad tap.
    #[tool(
        description = "Jump (seek) a deck's track to a previously set hot cue. \
                       deck 0 = A, 1 = B."
    )]
    async fn jump_to_hot_cue(
        &self,
        Parameters(HotCuePadArgs { deck, index }): Parameters<HotCuePadArgs>,
    ) -> String {
        if !valid_deck(deck) {
            return format!("invalid deck {deck}");
        }
        let cue = self
            .app
            .state::<InterfaceStore>()
            .snapshot()
            .decks
            .get(deck)
            .and_then(|d| d.cues.get(index).copied().flatten());
        match cue {
            Some(seconds) => {
                let frames = seconds * f64::from(lsdj_engine::SAMPLE_RATE);
                self.app.state::<Host>().seek_track(deck, frames);
                format!("deck {deck} jumped to hot cue {index} ({seconds:.2}s)")
            }
            None => format!("deck {deck} has no hot cue at pad {index}"),
        }
    }

    /// Replace a realtime deck's whole style pad (targets + cursor). Writes the store;
    /// `DeckColumn` adopts it and pushes the blended prompt to the worker.
    #[tool(
        description = "Replace a realtime deck's style pad: the targets (each a prompt at \
                       an x/y position, 0..1) and the blend cursor (x/y, 0..1). \
                       deck 0 = A, 1 = B."
    )]
    async fn set_style(
        &self,
        Parameters(SetStyleArgs {
            deck,
            targets,
            cursor,
        }): Parameters<SetStyleArgs>,
    ) -> String {
        if !valid_deck(deck) {
            return format!("invalid deck {deck}");
        }
        let count = targets.len();
        self.app
            .state::<InterfaceStore>()
            .set_deck_style(deck, targets, cursor);
        format!("deck {deck} style set ({count} target(s))")
    }

    #[tool(
        description = "Move a realtime deck's style-pad blend cursor (x, y in 0..1), \
                       leaving its targets. deck 0 = A, 1 = B."
    )]
    async fn set_style_cursor(
        &self,
        Parameters(StyleCursorArgs { deck, x, y }): Parameters<StyleCursorArgs>,
    ) -> String {
        if !valid_deck(deck) {
            return format!("invalid deck {deck}");
        }
        self.app
            .state::<InterfaceStore>()
            .set_deck_cursor(deck, PadPointSnap { x, y });
        format!("deck {deck} style cursor set to ({x:.2}, {y:.2})")
    }

    /// Generate a clip via the loopback generation server and save it to the samples
    /// library — the agent composes audio that lands in the Samples tab (the folder
    /// watcher surfaces it), ready to load onto a deck. Failure modes (server off,
    /// prompt too long, bad length) come back as the tool's message, like the deck
    /// guards above, rather than failing the call.
    #[tool(
        description = "Generate a short audio clip (Stable Audio 3) from a text prompt and \
                       save it to the samples library, where it appears in the Samples tab \
                       ready to load onto a deck. kind: \"sfx\" or \"music\"."
    )]
    async fn generate_sample(
        &self,
        Parameters(args): Parameters<GenerateSampleArgs>,
    ) -> String {
        match self.generate_sample_inner(args).await {
            Ok(message) | Err(message) => message,
        }
    }

    /// The fallible body of [`generate_sample`], so the proxy + save can use `?` and the
    /// tool flattens the result to one message.
    async fn generate_sample_inner(&self, args: GenerateSampleArgs) -> Result<String, String> {
        let GenerateSampleArgs {
            prompt,
            seconds,
            kind,
            one_shot,
        } = args;
        let port = self
            .app
            .state::<GenerationServer>()
            .port()
            .ok_or("the generation server is not running")?;

        // sa3 generation is serialised and can take many seconds; allow generous
        // headroom but never wait forever for a wedged worker.
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .map_err(|e| format!("could not build the http client: {e}"))?;
        let response = client
            .post(format!("http://127.0.0.1:{port}/api/generate"))
            .json(&generate_request_body(&prompt, seconds, kind))
            .send()
            .await
            .map_err(|e| format!("generation request failed: {e}"))?;
        if !response.status().is_success() {
            // The server returns a JSON `{detail}` (FastAPI HTTPException); surface it.
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return Err(format!("generation failed ({status}): {detail}"));
        }
        let wav = response
            .bytes()
            .await
            .map_err(|e| format!("could not read the generated audio: {e}"))?;

        let entry = self.app.state::<SampleLibrary>().record(
            NewSample {
                title: prompt.clone(),
                prompt: Some(prompt),
                model: Some(kind.as_str().to_string()),
                one_shot,
            },
            &wav,
        )?;
        Ok(format!(
            "generated a {} sample, saved to the samples library as {} (\"{}\")",
            kind.as_str(),
            entry.file,
            entry.title
        ))
    }
}

/// The URI the interface-state snapshot is served at — the agent reads this to
/// observe the whole instrument (the store snapshot, ADR-0020).
const STORE_RESOURCE_URI: &str = "lsdj://interface-state";

#[tool_handler(router = self.tool_router)]
impl ServerHandler for McpHandler {
    fn get_info(&self) -> ServerInfo {
        // ServerInfo is #[non_exhaustive], so build from default and set the public
        // fields: advertise BOTH tools and resources so the client lists the store.
        let mut info = ServerInfo::default();
        info.capabilities = ServerCapabilities::builder()
            .enable_tools()
            .enable_resources()
            .build();
        info.instructions = Some(
            "LSDJ.ai — a generative DJ instrument. Read the `lsdj://interface-state` \
             resource to observe the decks, mixer, and FX; call the tools to mix, drive \
             the decks, and generate audio into the samples library as a co-DJ."
                .to_string(),
        );
        info
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        Ok(ListResourcesResult {
            resources: vec![
                RawResource::new(STORE_RESOURCE_URI, "Interface state").no_annotation()
            ],
            next_cursor: None,
            ..Default::default()
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        if request.uri != STORE_RESOURCE_URI {
            return Err(McpError::resource_not_found(
                format!("unknown resource: {}", request.uri),
                None,
            ));
        }
        let snapshot = self.app.state::<InterfaceStore>().snapshot();
        let json = serde_json::to_string_pretty(&snapshot)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Ok(ReadResourceResult::new(vec![ResourceContents::text(
            json,
            STORE_RESOURCE_URI,
        )]))
    }
}

/// The supervised MCP server: its loopback port and the bearer token (surfaced via
/// `app_info`), plus the cancellation token that stops the axum task. The token is
/// **shared + mutable** (`Arc<RwLock<String>>`) so [`rotate`](McpServer::rotate)
/// swaps it in live without restarting the server, and **persisted** at `token_path`
/// so a client config stays valid across launches. Held in Tauri managed state;
/// dropping it (or `shutdown`) stops the server.
pub struct McpServer {
    port: Option<u16>,
    token: Option<Arc<RwLock<String>>>,
    /// Where the token is persisted (under the app data dir); `None` when disabled
    /// or the dir can't be resolved (then the token is in-memory only).
    token_path: Option<PathBuf>,
    cancel: CancellationToken,
}

impl McpServer {
    /// Start the MCP server — **always on**. Never fails the app: a failed start (the
    /// loopback bind couldn't be acquired) yields `port() == None` and the endpoint is
    /// simply unadvertised. Binds `127.0.0.1` on an ephemeral port; every request must
    /// carry the bearer token. Reuses the persisted token across launches.
    pub fn start(app: AppHandle) -> McpServer {
        let cancel = CancellationToken::new();
        let disabled = |cancel| McpServer {
            port: None,
            token: None,
            token_path: None,
            cancel,
        };

        // Bind synchronously so the port is known before we advertise it; hand the
        // std listener to tokio inside the task.
        let listener = match std::net::TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => listener,
            Err(e) => {
                eprintln!("lsdj-app: MCP server bind failed: {e}");
                return disabled(cancel);
            }
        };
        let port = match listener.local_addr() {
            Ok(addr) => addr.port(),
            Err(e) => {
                eprintln!("lsdj-app: MCP server local_addr failed: {e}");
                return disabled(cancel);
            }
        };
        if let Err(e) = listener.set_nonblocking(true) {
            eprintln!("lsdj-app: MCP server set_nonblocking failed: {e}");
            return disabled(cancel);
        }

        // Reuse the persisted token across launches; mint + save one on first run.
        let token_path = token_file(&app);
        let token_string = match &token_path {
            Some(path) => load_or_generate_token(path),
            None => generate_token(),
        };
        let token = Arc::new(RwLock::new(token_string));

        // The streamable-HTTP MCP service: a fresh handler per session, sharing the
        // app's managed state through the cloned AppHandle.
        let service = StreamableHttpService::new(
            move || Ok(McpHandler::new(app.clone())),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default(),
        );

        let router = axum::Router::new().nest_service("/mcp", service).layer(
            axum::middleware::from_fn_with_state(token.clone(), require_token),
        );

        let serve_cancel = cancel.clone();
        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(e) => {
                    eprintln!("lsdj-app: MCP server tokio listener failed: {e}");
                    return;
                }
            };
            println!("lsdj-app: MCP server on http://127.0.0.1:{port}/mcp");
            let result = axum::serve(listener, router)
                .with_graceful_shutdown(async move { serve_cancel.cancelled().await })
                .await;
            if let Err(e) = result {
                eprintln!("lsdj-app: MCP server stopped: {e}");
            }
        });

        McpServer {
            port: Some(port),
            token: Some(token),
            token_path,
            cancel,
        }
    }

    /// The loopback port the MCP server bound, or `None` if disabled / failed.
    pub fn port(&self) -> Option<u16> {
        self.port
    }

    /// The current bearer token a client must present, or `None` if disabled.
    pub fn token(&self) -> Option<String> {
        self.token.as_ref().map(|t| read_lock(t).clone())
    }

    /// Mint a NEW token, persist it, and swap it in live so the middleware accepts it
    /// at once (a leaked token is invalidated without restarting). Returns the new
    /// token, or `None` if the server is disabled.
    pub fn rotate(&self) -> Option<String> {
        let token = self.token.as_ref()?;
        let next = generate_token();
        if let Some(path) = &self.token_path {
            save_token(path, &next);
        }
        *write_lock(token) = next.clone();
        Some(next)
    }

    /// Stop the server task (graceful shutdown). Called from the app's `Exit` handler.
    pub fn shutdown(&self) {
        self.cancel.cancel();
    }
}

impl Drop for McpServer {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// Reject any request that does not carry `Authorization: Bearer <token>`. The token
/// is read fresh each request from the shared lock, so a `rotate` takes effect at
/// once. The server is loopback-only, but the token stops another local process from
/// driving the instrument without the user's config.
async fn require_token(
    axum::extract::State(token): axum::extract::State<Arc<RwLock<String>>>,
    request: Request,
    next: Next,
) -> Response {
    let presented = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let expected = format!("Bearer {}", *read_lock(&token));
    if presented == Some(expected.as_str()) {
        next.run(request).await
    } else {
        (StatusCode::UNAUTHORIZED, "missing or invalid bearer token").into_response()
    }
}

/// Recover a poisoned lock — a panic in another holder must not wedge auth/rotation.
fn read_lock(lock: &RwLock<String>) -> std::sync::RwLockReadGuard<'_, String> {
    lock.read().unwrap_or_else(|p| p.into_inner())
}
fn write_lock(lock: &RwLock<String>) -> std::sync::RwLockWriteGuard<'_, String> {
    lock.write().unwrap_or_else(|p| p.into_inner())
}

/// The token file under the app data dir (`None` if it can't be resolved).
fn token_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("mcp-token"))
}

/// Read the persisted token, or mint + save a new one (first run / empty file).
fn load_or_generate_token(path: &Path) -> String {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let token = generate_token();
    save_token(path, &token);
    token
}

/// Persist the token owner-read/write only — it's a secret (out of the repo and
/// logs; on disk like an SSH key).
fn save_token(path: &Path, token: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::write(path, token).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

/// A bearer token: 32 random bytes, hex-encoded.
fn generate_token() -> String {
    let bytes: [u8; 32] = rand::random();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::{generate_request_body, generate_token, load_or_generate_token, save_token, Sa3Kind};

    #[test]
    fn generate_body_matches_the_server_contract() {
        // The keys + the wire `kind` value must match what `/api/generate` validates.
        let body = generate_request_body("warm pad", 4.0, Sa3Kind::Music);
        assert_eq!(body["prompt"], "warm pad");
        assert_eq!(body["seconds"], 4.0);
        assert_eq!(body["kind"], "music");
        assert_eq!(generate_request_body("", 1.0, Sa3Kind::Sfx)["kind"], "sfx");
    }

    #[test]
    fn token_is_64_hex_chars_and_unique() {
        let token = generate_token();
        assert_eq!(token.len(), 64); // 32 bytes, two hex chars each
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        // Random — two draws differ.
        assert_ne!(token, generate_token());
    }

    #[test]
    fn token_persists_across_loads_and_a_rewrite_rotates_it() {
        let dir = std::env::temp_dir().join(format!("lsdj-mcp-{}", generate_token()));
        let path = dir.join("mcp-token");
        // First load mints + persists; the second reuses the same value (stable
        // across launches).
        let first = load_or_generate_token(&path);
        assert_eq!(load_or_generate_token(&path), first);
        // A rewrite (what `rotate` does) changes the persisted value.
        let rotated = generate_token();
        save_token(&path, &rotated);
        assert_ne!(rotated, first);
        assert_eq!(load_or_generate_token(&path), rotated);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
