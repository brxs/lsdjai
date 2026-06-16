//! The Tauri IPC command surface for the audio engine (Phase 2, step 2).
//!
//! One `#[tauri::command]` per [`Host`] control op, plus the read-back commands
//! (`engine_telemetry`, `track_status`, `loop_slots`). Each command wraps the
//! matching [`Host`] method, which enqueues a command over the host's wait-free
//! channel to the render thread (or, for read-backs, reads the published
//! snapshot / telemetry atomics). Nothing here touches the cpal callback.
//!
//! # Trust boundary
//!
//! The webview is an untrusted caller (`.claude/rules/security.md`): every deck
//! index, band, FX name, slot, and numeric is validated/clamped HERE before it
//! reaches the engine, whose `&mut self` methods `assert!` on a bad deck index (a
//! programming-error contract, not a runtime one). An out-of-range deck/slot is a
//! silent no-op rather than a panic that would take down the render thread; an
//! unknown FX name is rejected with an `Err` the webview can surface. The engine
//! itself already clamps the *values* (crossfade, volume, EQ, rate) into range.
//!
//! The argument/return types are plain serde structs/enums so the surface is
//! self-describing to the webview; the engine types stay serde-free (the DTOs
//! convert at the boundary).

use serde::{Deserialize, Serialize};
use serde_json::json;
use slipmate_engine::host::{Health, Host};
use slipmate_engine::{
    EqBand, FxKind, LoopRegion, LoopSlotStatus, TrackStatus, DECK_COUNT, LOOP_SLOT_COUNT,
};

use tauri::ipc::{Channel, InvokeResponseBody};

use crate::sidecar::{PcmTaps, Sidecars};

/// Reject a deck index outside `[0, DECK_COUNT)`. A bad index from the webview is
/// a no-op (the command returns without touching the engine), never a panic.
fn valid_deck(deck: usize) -> bool {
    deck < DECK_COUNT
}

/// Reject a loop-slot index outside `[0, LOOP_SLOT_COUNT)`.
fn valid_slot(slot: usize) -> bool {
    slot < LOOP_SLOT_COUNT
}

/// The EQ band as it crosses the IPC boundary. Mirrors the engine [`EqBand`] but
/// is a serde enum so the webview names bands by intent, not a magic index.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EqBandArg {
    Low,
    Mid,
    High,
}

impl From<EqBandArg> for EqBand {
    fn from(band: EqBandArg) -> Self {
        match band {
            EqBandArg::Low => EqBand::Low,
            EqBandArg::Mid => EqBand::Mid,
            EqBandArg::High => EqBand::High,
        }
    }
}

/// The Color FX kind as it crosses the IPC boundary (the six `fx.ts` effects).
/// A serde enum so an unknown effect name is a clean deserialization `Err` rather
/// than a silent fallback.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FxKindArg {
    Filter,
    DubEcho,
    Space,
    Crush,
    Noise,
    Sweep,
}

impl From<FxKindArg> for FxKind {
    fn from(kind: FxKindArg) -> Self {
        match kind {
            FxKindArg::Filter => FxKind::Filter,
            FxKindArg::DubEcho => FxKind::DubEcho,
            FxKindArg::Space => FxKind::Space,
            FxKindArg::Crush => FxKind::Crush,
            FxKindArg::Noise => FxKind::Noise,
            FxKindArg::Sweep => FxKind::Sweep,
        }
    }
}

/// A loop region (`[start, end)` in frames) for the wire. Mirrors the engine
/// [`LoopRegion`].
#[derive(Debug, Clone, Copy, Serialize)]
pub struct LoopRegionDto {
    pub start: u64,
    pub end: u64,
}

impl From<LoopRegion> for LoopRegionDto {
    fn from(region: LoopRegion) -> Self {
        LoopRegionDto {
            start: region.start,
            end: region.end,
        }
    }
}

/// A playback deck's transport for the wire. Mirrors the engine [`TrackStatus`]
/// (positions in frames; the webview converts to seconds where needed).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackStatusDto {
    pub playhead: f64,
    pub playing: bool,
    pub duration_frames: u64,
    pub rate: f64,
    pub ended: bool,
    pub loop_region: Option<LoopRegionDto>,
}

impl From<TrackStatus> for TrackStatusDto {
    fn from(status: TrackStatus) -> Self {
        TrackStatusDto {
            playhead: status.playhead,
            playing: status.playing,
            duration_frames: status.duration_frames,
            rate: status.rate,
            ended: status.ended,
            loop_region: status.loop_region.map(LoopRegionDto::from),
        }
    }
}

/// One loop slot's truthful state for LEDs / telemetry (the shell's `LoopSlot`).
#[derive(Debug, Clone, Copy, Serialize)]
pub struct LoopSlotDto {
    pub filled: bool,
    pub playing: bool,
}

impl From<LoopSlotStatus> for LoopSlotDto {
    fn from(slot: LoopSlotStatus) -> Self {
        LoopSlotDto {
            filled: slot.filled,
            playing: slot.playing,
        }
    }
}

/// The engine health snapshot for the wire (the `engine_telemetry` return).
/// Mirrors [`Health`]: per-deck input-ring fill + the output-ring fill +
/// underruns + master peak + master gain reduction. BPM is intentionally absent
/// for now (no tempo analysis yet).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthDto {
    pub output_ring_frames: usize,
    pub deck_ring_frames: Vec<usize>,
    pub deck_underruns: u64,
    pub output_underruns: u64,
    pub master_peak: f32,
    pub master_gain_reduction_db: f32,
    /// Per-deck post-fader level (the channel meters, `getLevel`).
    pub deck_levels: Vec<f32>,
    /// Frames rendered since start — the shared audio clock (`getContextTime`).
    pub context_frames: u64,
}

impl From<Health> for HealthDto {
    fn from(health: Health) -> Self {
        HealthDto {
            output_ring_frames: health.output_ring_frames,
            deck_ring_frames: health.deck_ring_frames.to_vec(),
            deck_underruns: health.deck_underruns,
            output_underruns: health.output_underruns,
            master_peak: health.master_peak,
            master_gain_reduction_db: health.master_gain_reduction_db,
            deck_levels: health.deck_levels.to_vec(),
            context_frames: health.context_frames,
        }
    }
}

/// A loaded track's min/max envelope for the wire (the waveform overview). Empty
/// vecs when no track is loaded on the deck.
#[derive(Debug, Clone, Serialize)]
pub struct TrackPeaksDto {
    pub min: Vec<f32>,
    pub max: Vec<f32>,
}

/// One IPC round-trip carrying everything the per-frame UI reads back: health
/// (meters, clock, ring stats), each deck's transport, and each deck's loop
/// slots. The webview polls THIS once per animation frame and caches it, so the
/// many synchronous `getLevel`/`getTrackStatus`/… getters read a fresh local
/// snapshot instead of issuing one IPC call each.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSnapshotDto {
    pub health: HealthDto,
    /// Per-deck transport (`null` off Playback), indexed by deck.
    pub tracks: Vec<Option<TrackStatusDto>>,
    /// Per-deck loop-slot status, indexed by deck then slot.
    pub loops: Vec<Vec<LoopSlotDto>>,
}

// --- Mixer / channel control ---

#[tauri::command]
pub fn set_crossfade(state: tauri::State<'_, Host>, position: f32) {
    state.set_crossfade(position);
}

#[tauri::command]
pub fn set_eq(state: tauri::State<'_, Host>, deck: usize, band: EqBandArg, value: f32) {
    if valid_deck(deck) {
        state.set_eq(deck, band.into(), value);
    }
}

#[tauri::command]
pub fn set_volume(state: tauri::State<'_, Host>, deck: usize, gain: f32) {
    if valid_deck(deck) {
        state.set_volume(deck, gain);
    }
}

#[tauri::command]
pub fn set_fx(state: tauri::State<'_, Host>, deck: usize, kind: FxKindArg) {
    if valid_deck(deck) {
        state.set_fx(deck, kind.into());
    }
}

#[tauri::command]
pub fn set_fx_amount(state: tauri::State<'_, Host>, deck: usize, amount: f32) {
    if valid_deck(deck) {
        state.set_fx_amount(deck, amount);
    }
}

/// Remove a deck's Color FX (no effect selected) — mirrors `setFx(null)`.
#[tauri::command]
pub fn clear_fx(state: tauri::State<'_, Host>, deck: usize) {
    if valid_deck(deck) {
        state.clear_fx(deck);
    }
}

/// Chain-head trim in dB (M17 gain staging; 0 dB = unity).
#[tauri::command]
pub fn set_trim(state: tauri::State<'_, Host>, deck: usize, db: f32) {
    if valid_deck(deck) {
        state.set_trim(deck, db);
    }
}

/// On-air state (M10 primed deck): off-air mutes the master feed only.
#[tauri::command]
pub fn set_on_air(state: tauri::State<'_, Host>, deck: usize, on: bool) {
    if valid_deck(deck) {
        state.set_on_air(deck, on);
    }
}

/// Headphone-cue (PFL) tap for a deck (Slice 5).
#[tauri::command]
pub fn set_cue(state: tauri::State<'_, Host>, deck: usize, on: bool) {
    if valid_deck(deck) {
        state.set_cue(deck, on);
    }
}

/// Cue/master headphone blend (0 = cue only, 1 = master).
#[tauri::command]
pub fn set_cue_mix(state: tauri::State<'_, Host>, position: f32) {
    state.set_cue_mix(position);
}

/// Start recording the master bus (exactly the speaker feed).
#[tauri::command]
pub fn start_recording(state: tauri::State<'_, Host>) {
    state.start_recording();
}

/// Stop recording and return the take as a 16-bit PCM WAV (binary — the take can
/// be many MB, so a JSON number array is not viable).
#[tauri::command]
pub fn stop_recording(state: tauri::State<'_, Host>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(state.stop_recording())
}

// --- Playback deck transport ---

/// Decode interleaved-stereo f32 (little-endian) from a raw byte payload. The
/// webview ships decoded PCM as bytes (a multi-MB track as a JSON number array is
/// not viable — Tauri's binary IPC carries it as `Vec<u8>`); any trailing partial
/// frame is ignored.
fn pcm_from_le_bytes(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Read a little-endian `u32` at `offset` from a binary payload prefix.
fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let end = offset + 4;
    let slice = bytes.get(offset..end)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// The raw bytes of a binary IPC request. The webview invokes the binary commands
/// with a `Uint8Array` as the sole argument, which Tauri's IPC delivers as an
/// [`InvokeBody::Raw`](tauri::ipc::InvokeBody::Raw) (the fast binary path, not a
/// JSON args map). The command MUST read the body here: binding a `payload: Vec<u8>`
/// parameter instead makes Tauri look for a JSON "payload" key and reject the raw
/// bytes ("expected a value for key payload but the IPC call used a bytes payload").
fn raw_payload<'a>(request: &'a tauri::ipc::Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.as_slice()),
        tauri::ipc::InvokeBody::Json(_) => Err("expected a raw bytes payload".to_string()),
    }
}

/// The audio extensions the folder browser surfaces (mirrors the frontend
/// `AUDIO_FILE` regex). Compared case-insensitively.
const AUDIO_EXTENSIONS: [&str; 7] = ["wav", "mp3", "flac", "m4a", "ogg", "aif", "aiff"];

/// Whether `path` has one of [`AUDIO_EXTENSIONS`] (case-insensitive).
fn is_audio_file(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Upper bound on a file [`read_audio_file`] will return. Generous for a long
/// high-res track yet bounds a pathological huge file (a blind read into memory).
const MAX_AUDIO_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// List the audio file NAMES directly inside `dir` (non-recursive), sorted
/// case-insensitively (matching the web path's `localeCompare`). `dir` is a folder
/// the user just chose in the native picker (WKWebView has no File System Access
/// API). Only names are returned — [`read_audio_file`] re-derives and re-validates
/// the path from `dir` + name, so the webview never supplies a path to read. A read
/// error (missing / not a directory / no permission) surfaces to the webview.
#[tauri::command]
pub fn list_audio_files(dir: String) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("cannot read folder: {e}"))?;
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_audio_file(path))
        .filter_map(|path| path.file_name()?.to_str().map(str::to_string))
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    Ok(names)
}

/// Read one audio file the user picked, SCOPED to the folder they chose: `name`
/// must be a plain filename resolving to a regular file directly inside `dir`. The
/// webview is an untrusted caller (module header / `.claude/rules/security.md`), so
/// THIS — not the extension — is the boundary: without it a raw path would let a
/// compromised webview read any file the user can (SSH keys, keychains, cookie DBs).
/// Canonicalising both sides defeats `..` traversal and symlinks that escape the
/// folder; the regular-file + size checks reject FIFOs / devices / huge files that a
/// blind `read` would hang or OOM on. `async` keeps the read off the main thread.
/// Returns the bytes as binary (a track is many MB — `ipc::Response`).
#[tauri::command]
pub async fn read_audio_file(dir: String, name: String) -> Result<tauri::ipc::Response, String> {
    // `name` must be a single ordinary path component — never a path, "..", or
    // absolute — so it cannot point outside `dir`.
    let mut comps = std::path::Path::new(&name).components();
    if !matches!(
        (comps.next(), comps.next()),
        (Some(std::path::Component::Normal(_)), None)
    ) {
        return Err("invalid file name".to_string());
    }
    // Canonicalise both sides and require the resolved file is a DIRECT CHILD of the
    // resolved chosen folder — this rejects `..` and any symlink whose target
    // escapes the folder.
    let base = std::fs::canonicalize(&dir).map_err(|e| format!("cannot resolve folder: {e}"))?;
    let target =
        std::fs::canonicalize(base.join(&name)).map_err(|e| format!("cannot resolve file: {e}"))?;
    if target.parent() != Some(base.as_path()) {
        return Err("file is outside the chosen folder".to_string());
    }
    if !is_audio_file(&target) {
        return Err("not an audio file".to_string());
    }
    let meta = std::fs::metadata(&target).map_err(|e| format!("cannot stat file: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    if meta.len() > MAX_AUDIO_BYTES {
        return Err("file is too large".to_string());
    }
    let bytes = std::fs::read(&target).map_err(|e| format!("cannot read file: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Load a decoded track onto a deck, switching it to Playback. The payload is a
/// little-endian `u32` deck index followed by interleaved-stereo f32 @ 48 kHz
/// (the webview decodes + resamples a WAV and ships the bytes). Sent over Tauri's
/// binary IPC as a single `Vec<u8>` arg — a JSON number array would be megabytes
/// of text for a full track.
#[tauri::command]
pub fn load_track(
    state: tauri::State<'_, Host>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let payload = raw_payload(&request)?;
    let Some(deck) = read_u32_le(payload, 0).map(|d| d as usize) else {
        return Err("load_track payload too short".to_string());
    };
    if valid_deck(deck) {
        state.load_track(deck, pcm_from_le_bytes(&payload[4..]));
    }
    Ok(())
}

#[tauri::command]
pub fn unload_track(state: tauri::State<'_, Host>, deck: usize) {
    if valid_deck(deck) {
        state.unload_track(deck);
    }
}

#[tauri::command]
pub fn play_track(state: tauri::State<'_, Host>, deck: usize) {
    if valid_deck(deck) {
        state.play_track(deck);
    }
}

#[tauri::command]
pub fn pause_track(state: tauri::State<'_, Host>, deck: usize) {
    if valid_deck(deck) {
        state.pause_track(deck);
    }
}

#[tauri::command]
pub fn seek_track(state: tauri::State<'_, Host>, deck: usize, frames: f64) {
    if valid_deck(deck) {
        state.seek_track(deck, frames);
    }
}

#[tauri::command]
pub fn set_track_rate(state: tauri::State<'_, Host>, deck: usize, rate: f64) {
    if valid_deck(deck) {
        state.set_track_rate(deck, rate);
    }
}

#[tauri::command]
pub fn nudge_track_phase(state: tauri::State<'_, Host>, deck: usize, frames: f64) {
    if valid_deck(deck) {
        state.nudge_track_phase(deck, frames);
    }
}

#[tauri::command]
pub fn set_track_loop(state: tauri::State<'_, Host>, deck: usize, start: u64, end: u64) {
    if valid_deck(deck) {
        state.set_track_loop(deck, start, end);
    }
}

#[tauri::command]
pub fn clear_track_loop(state: tauri::State<'_, Host>, deck: usize) {
    if valid_deck(deck) {
        state.clear_track_loop(deck);
    }
}

// --- Freeze / generated loops, one-shots, style sampling ---

#[tauri::command]
pub fn capture_loop(state: tauri::State<'_, Host>, deck: usize, slot: usize, seconds: f64) {
    if valid_deck(deck) && valid_slot(slot) {
        state.capture_loop(deck, slot, seconds);
    }
}

#[tauri::command]
pub fn play_loop(state: tauri::State<'_, Host>, deck: usize, slot: usize) {
    if valid_deck(deck) && valid_slot(slot) {
        state.play_loop(deck, slot);
    }
}

#[tauri::command]
pub fn stop_loop(state: tauri::State<'_, Host>, deck: usize) {
    if valid_deck(deck) {
        state.stop_loop(deck);
    }
}

#[tauri::command]
pub fn stop_one_shot(state: tauri::State<'_, Host>, deck: usize) {
    if valid_deck(deck) {
        state.stop_one_shot(deck);
    }
}

#[tauri::command]
pub fn clear_loop(state: tauri::State<'_, Host>, deck: usize, slot: usize) {
    if valid_deck(deck) && valid_slot(slot) {
        state.clear_loop(deck, slot);
    }
}

/// Load a decoded loop/pad into a slot. The payload prefixes the interleaved f32
/// PCM with three little-endian `u32`s: deck, slot, and the one-shot flag (0/1).
/// A one-shot plays once; otherwise it loops (seam folded). Binary IPC, like
/// [`load_track`].
#[tauri::command]
pub fn load_generated_loop(
    state: tauri::State<'_, Host>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let payload = raw_payload(&request)?;
    let (Some(deck), Some(slot), Some(one_shot)) = (
        read_u32_le(payload, 0).map(|d| d as usize),
        read_u32_le(payload, 4).map(|s| s as usize),
        read_u32_le(payload, 8).map(|f| f != 0),
    ) else {
        return Err("load_generated_loop payload too short".to_string());
    };
    if valid_deck(deck) && valid_slot(slot) {
        state.load_generated_loop(deck, slot, pcm_from_le_bytes(&payload[12..]), one_shot);
    }
    Ok(())
}

/// Capture the last `seconds` of played history on a Realtime deck (M15 style
/// sampling). Round-trips through the render thread and returns the captured
/// interleaved-stereo samples, or `None` below the floor / off a Realtime deck /
/// for a bad deck index.
#[tauri::command]
pub fn capture_sample(state: tauri::State<'_, Host>, deck: usize, seconds: f64) -> Option<Vec<f32>> {
    if !valid_deck(deck) {
        return None;
    }
    state.capture_sample(deck, seconds)
}

// --- Read-back ---

/// The engine health snapshot (per-deck ring fill + underruns + master peak +
/// gain reduction). The webview polls this for the buffer-health / level meters.
#[tauri::command]
pub fn engine_telemetry(state: tauri::State<'_, Host>) -> HealthDto {
    state.health().into()
}

/// A deck's track transport, or `null` off Playback / for a bad deck index.
#[tauri::command]
pub fn track_status(state: tauri::State<'_, Host>, deck: usize) -> Option<TrackStatusDto> {
    if !valid_deck(deck) {
        return None;
    }
    state.track_status(deck).map(TrackStatusDto::from)
}

/// A deck's loop-slot status (filled / playing per slot), length
/// [`LOOP_SLOT_COUNT`]; an empty vec for a bad deck index.
#[tauri::command]
pub fn loop_slots(state: tauri::State<'_, Host>, deck: usize) -> Vec<LoopSlotDto> {
    if !valid_deck(deck) {
        return Vec::new();
    }
    state
        .loop_slots(deck)
        .iter()
        .map(|&slot| LoopSlotDto::from(slot))
        .collect()
}

/// A loaded track's min/max envelope at `buckets` resolution (the waveform
/// overview), or `null` off Playback / for a bad deck or zero buckets. Fetched
/// once per track load (the webview caches it), so the render-thread round-trip
/// is well off any hot path.
#[tauri::command]
pub fn track_peaks(state: tauri::State<'_, Host>, deck: usize, buckets: usize) -> Option<TrackPeaksDto> {
    if !valid_deck(deck) || buckets == 0 {
        return None;
    }
    state
        .track_peaks(deck, buckets)
        .map(|(min, max)| TrackPeaksDto { min, max })
}

// --- Deck inference control (forwarded to the Python sidecars, part 4) ---

/// A style-prompt entry the webview sends for `set_style` — text (or a sampled
/// style id, M15) plus its blend weight. Validated/normalised here before it
/// crosses to the sidecar (`worker.py` `set_style`).
#[derive(Debug, Clone, Deserialize)]
pub struct PromptEntryArg {
    pub text: String,
    pub weight: f32,
    #[serde(default)]
    pub sample: Option<String>,
}

#[tauri::command]
pub fn deck_play(
    state: tauri::State<'_, Sidecars>,
    engine: tauri::State<'_, Host>,
    deck: usize,
) {
    if valid_deck(deck) {
        // Open the engine gate first, so the sidecar's PCM drains the moment it
        // arrives, then tell the worker to start generating.
        engine.set_deck_playing(deck, true);
        state.send(deck, &json!({ "type": "play" }).to_string());
    }
}

#[tauri::command]
pub fn deck_stop(
    state: tauri::State<'_, Sidecars>,
    engine: tauri::State<'_, Host>,
    deck: usize,
) {
    if valid_deck(deck) {
        // Silence the deck immediately (stop draining the held buffer), then tell
        // the worker to stop generating. Without the engine gate the buffered ~1.5 s
        // would keep playing and then underrun (the native stop bug).
        engine.set_deck_playing(deck, false);
        state.send(deck, &json!({ "type": "stop" }).to_string());
    }
}

#[tauri::command]
pub fn deck_set_prompt(state: tauri::State<'_, Sidecars>, deck: usize, prompt: String) {
    if valid_deck(deck) {
        state.send(deck, &json!({ "type": "set_prompt", "prompt": prompt }).to_string());
    }
}

/// Switch a deck's model (an in-process sidecar restart, reusing the deck ring).
/// Validates the deck index and the model name at the trust boundary; the running
/// sidecar is left untouched if the respawn fails.
///
/// MUST be `async`. The restart `join()`s the outgoing reader thread, which can be
/// mid-`emit`/`Channel::send` to the webview — and a sync command runs on the MAIN
/// (event-loop) thread, the very thread that services those webview sends. On the
/// main thread the join would wait for the reader while the reader waits for the
/// main thread: a hard deadlock (it surfaced switching to the slower-loading
/// `mrt2_base`). `async` runs the command off the main thread, so the freed main
/// thread drains the reader's send, the reader exits, and the join completes.
#[tauri::command]
pub async fn deck_set_model(
    state: tauri::State<'_, Sidecars>,
    deck: usize,
    model: String,
) -> Result<(), String> {
    if !valid_deck(deck) {
        return Err("invalid deck".into());
    }
    if model.is_empty() || model.len() > 64 {
        return Err("invalid model name".into());
    }
    state.restart(deck, &model)
}

/// Embed a captured style sample (M15) into a deck's sidecar. The payload is
/// `[u32 LE deck][u32 LE id length][id utf-8][interleaved f32 LE PCM]` — binary
/// (the PCM is multi-MB), like `load_track`. The native shell routes the embed to
/// the deck's sidecar over the control socket (the generation server has no deck
/// workers).
#[tauri::command]
pub fn deck_embed_sample(
    state: tauri::State<'_, Sidecars>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let payload = raw_payload(&request)?;
    let (Some(deck), Some(id_len)) = (
        read_u32_le(payload, 0).map(|d| d as usize),
        read_u32_le(payload, 4).map(|l| l as usize),
    ) else {
        return Err("deck_embed_sample payload too short".to_string());
    };
    let id_end = 8 + id_len;
    let Some(id) = payload.get(8..id_end).and_then(|b| std::str::from_utf8(b).ok()) else {
        return Err("deck_embed_sample invalid sample id".to_string());
    };
    if valid_deck(deck) {
        state.embed(deck, id, &payload[id_end..]);
    }
    Ok(())
}

#[tauri::command]
pub fn deck_set_style(state: tauri::State<'_, Sidecars>, deck: usize, prompts: Vec<PromptEntryArg>) {
    if !valid_deck(deck) {
        return;
    }
    let entries: Vec<_> = prompts
        .into_iter()
        .map(|p| {
            let mut entry = json!({ "text": p.text, "weight": p.weight });
            if let Some(sample) = p.sample {
                entry["sample"] = json!(sample);
            }
            entry
        })
        .collect();
    state.send(deck, &json!({ "type": "set_style", "prompts": entries }).to_string());
}

// --- Analysis PCM tap (gap 1: re-feed the TS beat/loudness/band analysis) ---

/// Subscribe a deck's realtime model PCM to a webview [`Channel`]. The sidecar
/// reader tees each frame as raw interleaved-stereo f32 LE bytes; the webview
/// reinterprets them as the `Float32Array` its analysis consumes (ADR-0017:
/// analysis stays in TypeScript). One subscriber per deck — a re-subscribe
/// replaces the prior channel.
#[tauri::command]
pub fn subscribe_deck_pcm(
    taps: tauri::State<'_, PcmTaps>,
    deck: usize,
    channel: Channel<InvokeResponseBody>,
) {
    if valid_deck(deck) {
        taps.set(deck, Some(channel));
    }
}

#[tauri::command]
pub fn unsubscribe_deck_pcm(taps: tauri::State<'_, PcmTaps>, deck: usize) {
    if valid_deck(deck) {
        taps.set(deck, None);
    }
}

/// The consolidated per-frame read-back: health + every deck's transport + every
/// deck's loop slots in one round-trip. The webview polls this each animation
/// frame and serves the synchronous getters from the cached result.
#[tauri::command]
pub fn engine_snapshot(state: tauri::State<'_, Host>) -> EngineSnapshotDto {
    let tracks = (0..DECK_COUNT)
        .map(|deck| state.track_status(deck).map(TrackStatusDto::from))
        .collect();
    let loops = (0..DECK_COUNT)
        .map(|deck| {
            state
                .loop_slots(deck)
                .iter()
                .map(|&slot| LoopSlotDto::from(slot))
                .collect()
        })
        .collect();
    EngineSnapshotDto {
        health: state.health().into(),
        tracks,
        loops,
    }
}
