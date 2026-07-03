//! The shell-level interface-state store (ADR-0020, issue #37 Phase 1).
//!
//! Rust is the single source of truth for the instrument's **semantic/identity +
//! audio-param** interface state; the webview is a unidirectional projection of it.
//! The on-screen UI, the hardware (MIDI), and — later — an MCP agent are symmetric
//! peer controllers: each emits an intent that mutates this one store; the store
//! emits a [`STORE_CHANGED_EVENT`] change event carrying the fresh snapshot; the
//! webview re-renders from it.
//!
//! # Layering (what lives here vs. the engine)
//!
//! The real-time audio core ([`lsdj_engine`]) stays the truth of *what the audio is
//! doing* — gains, EQ coefficients, crossfade, loop regions, buffers, and the live
//! read-backs (playhead, levels, ring fill) the webview already polls via
//! `engine_snapshot`. This store is the truth of *what the instrument shows*: the
//! values that were set. A mutation forwards the audio-affecting change to the
//! engine / sidecar as the commands already do, **and** records it here so the
//! projection (and a future MCP `resources` read) has one authoritative copy with
//! no read-back getters to bolt on.
//!
//! Per ADR-0020 (accepted with the issue #37 narrowing), **ephemeral view state**
//! (active tab, scroll/highlight, in-progress form fields, the
//! loaded-but-not-confirmed selection) deliberately stays in React and is *not*
//! held here.
//!
//! # Testability
//!
//! The mutation logic lives in pure [`InterfaceState`] methods (no `AppHandle`, no
//! IPC — unit-tested directly). [`InterfaceStore`] is the thin shell wrapper that
//! locks the state, applies a mutation, and emits the snapshot.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use lsdj_engine::{EqBand, FxKind, DECK_COUNT};

/// The Tauri event the webview subscribes to for store changes. Each mutation emits
/// it with the full fresh [`InterfaceState`] snapshot (the state is small —
/// semantic/audio params, never audio buffers — so carrying it whole is simpler
/// than diffing and the projection just replaces its cache).
pub const STORE_CHANGED_EVENT: &str = "store://changed";

/// A Color FX kind as it appears in the snapshot — a serde camelCase enum mirroring
/// the frontend `FxKind` (the six `fx.ts` effects), so the projection names the
/// effect by intent rather than a magic index.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FxKindSnap {
    Filter,
    DubEcho,
    Space,
    Crush,
    Noise,
    Sweep,
}

impl From<FxKind> for FxKindSnap {
    fn from(kind: FxKind) -> Self {
        match kind {
            FxKind::Filter => FxKindSnap::Filter,
            FxKind::DubEcho => FxKindSnap::DubEcho,
            FxKind::Space => FxKindSnap::Space,
            FxKind::Crush => FxKindSnap::Crush,
            FxKind::Noise => FxKindSnap::Noise,
            FxKind::Sweep => FxKindSnap::Sweep,
        }
    }
}

/// A deck's three-band EQ in the snapshot (each 0..1, mirroring the frontend
/// `Record<EqBand, number>`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct EqSnap {
    pub low: f32,
    pub mid: f32,
    pub high: f32,
}

/// A deck's Color FX in the snapshot: the active effect (or `None`) plus the knob
/// amount. The amount persists across a kind change exactly as the frontend keeps
/// it — `set_fx` records the kind, the follow-up `set_fx_amount` records the rest
/// value the deck re-applies.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxSnap {
    pub kind: Option<FxKindSnap>,
    pub amount: f32,
}

/// A loaded track's identity in the store (a playback-deck read-back the store
/// mirrors). `Deserialize` too — it crosses as a `set_deck_track` command argument.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackIdentitySnap {
    pub title: String,
    /// Offline beat-tracker BPM, or `None` when the gate refuses a number.
    pub bpm: Option<f64>,
    pub duration_seconds: f64,
}

/// An active loop region on a playback deck, in track seconds (mirrors the frontend
/// `TrackLoop`). `Deserialize` too — it crosses as a `set_deck_transport` argument.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopRegionSnap {
    pub start_seconds: f64,
    pub end_seconds: f64,
}

/// A playback deck's live transport read-back (a throttled mirror the webview writes
/// up): the playhead, varispeed rate, and the active loop region. `None` on a realtime
/// deck or with no track. The playhead is mirrored at a throttled cadence (the webview
/// caps it ~4 Hz) so this read-back doesn't churn `store://changed` at the audio poll
/// rate; an agent reads the resource on demand, so coarse freshness is enough.
/// `Deserialize` too — it crosses as a `set_deck_transport` argument.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportSnap {
    pub playhead_seconds: f64,
    /// Varispeed rate (1.0 = as recorded); effective BPM is `track.bpm * rate`.
    pub rate: f64,
    pub loop_region: Option<LoopRegionSnap>,
}

/// A point on the 2D style pad (0..1 each axis). `Deserialize`/`JsonSchema` too — the
/// cursor crosses as a `set_deck_style` / `set_style_cursor` argument (UI/MIDI and MCP).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
pub struct PadPointSnap {
    pub x: f32,
    pub y: f32,
}

/// One style-pad target: a prompt at a pad position (the sampled-target embedding
/// id is session-only and stays out, like the persisted layout). `Deserialize`/
/// `JsonSchema` too — targets cross as a `set_deck_style` argument (UI/MIDI and MCP).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StyleTargetSnap {
    pub x: f32,
    pub y: f32,
    pub text: String,
}

/// The note mode a steering surface authors in (ADR-0023): chord-follow maps
/// held pitches to "model decides the articulation"; onset marks fresh presses
/// so the performer owns the attack timing. `Deserialize`/`JsonSchema` too —
/// it crosses as a `set_deck_notes` / MCP `set_notes` argument.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum NoteModeSnap {
    Chord,
    Onset,
}

/// The key/scale a performance surface snaps to (issue #48). Chromatic is
/// the no-snap escape hatch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ScaleSnap {
    Major,
    Minor,
    PentatonicMinor,
    Chromatic,
}

/// A deck's performance-surface config (issue #48, ADR-0031): whether the
/// surface is armed (armed decks take pad/keyboard notes AND run the small
/// ADR-0023 performance chunk), the key/scale the notes snap to, and the
/// note mode (chord-follow or on-grid onset). Owned by the shell
/// note-steering service; the store holds it for the projection.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSnap {
    pub armed: bool,
    /// Key root as a pitch class (0 = C … 11 = B).
    pub key: u8,
    pub scale: ScaleSnap,
    pub mode: NoteModeSnap,
}

impl Default for PerformanceSnap {
    fn default() -> Self {
        PerformanceSnap {
            armed: false,
            key: 0,
            scale: ScaleSnap::Major,
            mode: NoteModeSnap::Chord,
        }
    }
}

/// A realtime deck's note steering (ADR-0023): the held MIDI pitches and the
/// note mode. The shell note-steering service owns the pitches→multihot
/// mapping and drives the worker directly (ADR-0031); the store holds the
/// authored state so every surface projects the same truth. `Deserialize`/
/// `JsonSchema` too — it crosses as an MCP `set_notes` argument.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NoteSteeringSnap {
    /// Held MIDI pitches (0..=127).
    pub pitches: Vec<u8>,
    pub mode: NoteModeSnap,
}

/// A beat anchor the phase consumers can trust (M20/ADR-0025): the
/// pushed-frame index of a recent beat and the gated tempo it belongs to.
/// Published as a pair — a clock, not two independent readings — so a
/// consumer can never mix an anchor with a fresher tempo.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveBeatSnap {
    pub anchor_frame: f64,
    pub bpm: f64,
}

/// A deck's live beat analysis (ADR-0025), written by the shell's analysis
/// thread at most ~once per second: the honesty-gated readout (`None` =
/// blank, the feature), the latest estimate confidence, the phase clock, and
/// the stream origin in engine context frames (captured at reset — the
/// mapping from the anchor's pushed-frame domain onto engine time). A
/// MEASUREMENT, not a controller value: its mutation records without
/// forwarding anything.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSnap {
    pub bpm: Option<f64>,
    pub confidence: f64,
    pub live_beat: Option<LiveBeatSnap>,
    pub origin_frames: f64,
}

impl Default for AnalysisSnap {
    fn default() -> Self {
        AnalysisSnap {
            bpm: None,
            confidence: 0.0,
            live_beat: None,
            origin_frames: 0.0,
        }
    }
}

/// One deck's state in the store: the mixer channel plus the realtime-deck
/// read-backs the store mirrors (model / playing). Not `Copy` — `model` is a
/// `String`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckSnap {
    pub volume: f32,
    pub eq: EqSnap,
    /// Chain-head trim in dB (M17 gain staging; 0 dB = unity).
    pub trim_db: f32,
    /// Headphone-cue (PFL) tap on/off.
    pub cue: bool,
    /// On-air (M10 primed deck): off-air mutes only the master feed.
    pub on_air: bool,
    pub fx: FxSnap,
    /// The realtime deck's loaded model name — a sidecar read-back the store
    /// mirrors (the webview derives it from worker status and writes it up); `None`
    /// before the worker reports ready.
    pub model: Option<String>,
    /// Whether the realtime deck is generating — a derived read-back the store
    /// mirrors (set by play/stop, cleared on model-load / worker-death).
    pub playing: bool,
    /// Hot-cue points on the loaded track, in track seconds, one per pad (empty
    /// with no track). ADR-0015's cue state moves here per ADR-0020; the webview
    /// owns the set/jump logic (jump is a plain seek) and mirrors the points up.
    pub cues: Vec<Option<f64>>,
    /// The loaded track's identity on a playback deck (a read-back the store
    /// mirrors), or `None` on a realtime deck / with no track.
    pub track: Option<TrackIdentitySnap>,
    /// The playback deck's live transport (playhead / rate / loop) — a throttled
    /// read-back the webview mirrors up, `None` on a realtime deck / with no track.
    pub transport: Option<TransportSnap>,
    /// The freeze/sample loop-slot labels, one per pad (`None` for an empty slot or
    /// an unlabelled freeze) — a read-back the store mirrors. Empty until the deck
    /// reports its slots.
    pub loop_labels: Vec<Option<String>>,
    /// The realtime deck's 2D style-pad targets (prompt + position) — the UI source
    /// the deck blends into the worker prompt. Mirrored up by `DeckColumn`.
    pub style_targets: Vec<StyleTargetSnap>,
    /// Which style targets are selected into the active blend (the net mask,
    /// one bool per target) — mirrored up by the webview so the pad LEDs can
    /// burn selected targets bright and dim the rest (ADR-0031: LEDs read the
    /// store). Empty = no mask (every target pad lit full).
    pub style_selected: Vec<bool>,
    /// The 2D style-pad cursor (the blend point).
    pub cursor: PadPointSnap,
    /// Whether the deck is primed off-air (the transport-CUE LED state) — a
    /// read-back the webview mirrors up; the deck's prime/play flow owns it.
    pub primed: bool,
    /// The performance-surface config (issue #48) — armed/key/scale/mode,
    /// written through the shell note-steering service.
    pub performance: PerformanceSnap,
    /// The realtime deck's note steering (ADR-0023), or `None` when unsteered.
    /// Cleared on transport transitions — a discontinuity resets conditioning.
    pub notes: Option<NoteSteeringSnap>,
    /// Drum conditioning (ADR-0023): `None` = the model decides, `false` =
    /// suppress drums, `true` = force them. Cleared like `notes`.
    pub drums: Option<bool>,
    /// The deck's live beat analysis (ADR-0025) — a shell-written measurement,
    /// blank until the honesty gate acquires.
    pub analysis: AnalysisSnap,
}

impl Default for DeckSnap {
    fn default() -> Self {
        DeckSnap {
            volume: 1.0,
            eq: EqSnap {
                low: 0.5,
                mid: 0.5,
                high: 0.5,
            },
            trim_db: 0.0,
            cue: false,
            // Decks are audible by default; off-air is the deliberate primed state.
            on_air: true,
            fx: FxSnap {
                kind: None,
                amount: 0.0,
            },
            model: None,
            playing: false,
            cues: Vec::new(),
            track: None,
            transport: None,
            loop_labels: Vec::new(),
            style_targets: Vec::new(),
            style_selected: Vec::new(),
            cursor: PadPointSnap { x: 0.5, y: 0.5 },
            primed: false,
            performance: PerformanceSnap::default(),
            notes: None,
            drums: None,
            analysis: AnalysisSnap::default(),
        }
    }
}

/// The authoritative interface state — the snapshot shape the webview projects.
///
/// Pre-hydration it holds neutral defaults; on boot the webview replays its
/// persisted mixer settings through the same set commands (which record here), so
/// the store converges to the real values before the controls render. View state is
/// intentionally absent (it stays in React — the ADR-0020 narrowing).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceState {
    /// Per-deck mixer channel, indexed by deck (length [`DECK_COUNT`]).
    pub decks: Vec<DeckSnap>,
    /// Equal-power crossfader position (0 = deck A, 1 = deck B).
    pub crossfade: f32,
    /// Cue/master headphone blend (0 = cue only, 1 = master).
    pub cue_mix: f32,
}

impl Default for InterfaceState {
    fn default() -> Self {
        InterfaceState {
            decks: vec![DeckSnap::default(); DECK_COUNT],
            crossfade: 0.5,
            cue_mix: 0.5,
        }
    }
}

impl InterfaceState {
    /// A mutable handle to a deck's channel, or `None` for an out-of-range index —
    /// a bad index is a silent no-op (the store never panics on a caller's index,
    /// matching the `commands.rs` trust boundary).
    fn deck_mut(&mut self, deck: usize) -> Option<&mut DeckSnap> {
        self.decks.get_mut(deck)
    }

    pub fn set_crossfade(&mut self, position: f32) {
        self.crossfade = position;
    }

    pub fn set_cue_mix(&mut self, position: f32) {
        self.cue_mix = position;
    }

    pub fn set_volume(&mut self, deck: usize, gain: f32) {
        if let Some(d) = self.deck_mut(deck) {
            d.volume = gain;
        }
    }

    pub fn set_eq(&mut self, deck: usize, band: EqBand, value: f32) {
        if let Some(d) = self.deck_mut(deck) {
            match band {
                EqBand::Low => d.eq.low = value,
                EqBand::Mid => d.eq.mid = value,
                EqBand::High => d.eq.high = value,
            }
        }
    }

    pub fn set_trim(&mut self, deck: usize, db: f32) {
        if let Some(d) = self.deck_mut(deck) {
            d.trim_db = db;
        }
    }

    pub fn set_cue(&mut self, deck: usize, on: bool) {
        if let Some(d) = self.deck_mut(deck) {
            d.cue = on;
        }
    }

    pub fn set_on_air(&mut self, deck: usize, on: bool) {
        if let Some(d) = self.deck_mut(deck) {
            d.on_air = on;
        }
    }

    /// Select a deck's Color FX. Records only the kind; the deck immediately
    /// re-applies the effect's rest amount via `set_fx_amount`, which records the
    /// amount (mirroring the engine, which resets `fx_amount` to the kind's rest).
    pub fn set_fx(&mut self, deck: usize, kind: FxKind) {
        if let Some(d) = self.deck_mut(deck) {
            d.fx.kind = Some(kind.into());
        }
    }

    pub fn set_fx_amount(&mut self, deck: usize, amount: f32) {
        if let Some(d) = self.deck_mut(deck) {
            d.fx.amount = amount;
        }
    }

    /// Remove a deck's Color FX (no effect selected); the amount is left as-is, like
    /// the frontend's `setFx(null)`.
    pub fn clear_fx(&mut self, deck: usize) {
        if let Some(d) = self.deck_mut(deck) {
            d.fx.kind = None;
        }
    }

    pub fn set_model(&mut self, deck: usize, model: Option<String>) {
        if let Some(d) = self.deck_mut(deck) {
            d.model = model;
        }
    }

    pub fn set_playing(&mut self, deck: usize, playing: bool) {
        if let Some(d) = self.deck_mut(deck) {
            if d.playing != playing {
                // A transport transition is a stream discontinuity: held
                // note/drum steering resets with it (ADR-0023) — the worker
                // clears its engine state on the play/stop commands, and the
                // store must never keep claiming steering the worker dropped.
                d.notes = None;
                d.drums = None;
            }
            d.playing = playing;
        }
    }

    pub fn set_cues(&mut self, deck: usize, cues: Vec<Option<f64>>) {
        if let Some(d) = self.deck_mut(deck) {
            d.cues = cues;
        }
    }

    pub fn set_track(&mut self, deck: usize, track: Option<TrackIdentitySnap>) {
        if let Some(d) = self.deck_mut(deck) {
            d.track = track;
        }
    }

    pub fn set_transport(&mut self, deck: usize, transport: Option<TransportSnap>) {
        if let Some(d) = self.deck_mut(deck) {
            d.transport = transport;
        }
    }

    pub fn set_loop_labels(&mut self, deck: usize, labels: Vec<Option<String>>) {
        if let Some(d) = self.deck_mut(deck) {
            d.loop_labels = labels;
        }
    }

    /// Replace the style pad wholesale — targets, cursor, AND the selection
    /// mask in ONE mutation, so no emitted snapshot can ever pair fresh
    /// targets with a stale mask (or vice versa); the projection's adoption
    /// gate depends on that atomicity.
    pub fn set_style(
        &mut self,
        deck: usize,
        targets: Vec<StyleTargetSnap>,
        cursor: PadPointSnap,
        selected: Vec<bool>,
    ) {
        if let Some(d) = self.deck_mut(deck) {
            d.style_targets = targets;
            d.cursor = cursor;
            d.style_selected = selected;
        }
    }

    /// Set one hot-cue pad's point in track seconds, or clear it (`None`). A no-track
    /// deck (empty cue vec) or an out-of-range pad is a no-op — the MCP tool validates
    /// and reports first.
    pub fn set_cue_point(&mut self, deck: usize, index: usize, seconds: Option<f64>) {
        if let Some(d) = self.deck_mut(deck) {
            if let Some(slot) = d.cues.get_mut(index) {
                *slot = seconds;
            }
        }
    }

    /// Set just the style-pad cursor (the blend point), leaving the targets.
    pub fn set_cursor(&mut self, deck: usize, cursor: PadPointSnap) {
        if let Some(d) = self.deck_mut(deck) {
            d.cursor = cursor;
        }
    }

    /// Mirror the primed-off-air read-back (the transport-CUE LED state).
    pub fn set_primed(&mut self, deck: usize, primed: bool) {
        if let Some(d) = self.deck_mut(deck) {
            d.primed = primed;
        }
    }

    /// Record the performance-surface config (issue #48).
    pub fn set_performance(&mut self, deck: usize, perf: PerformanceSnap) {
        if let Some(d) = self.deck_mut(deck) {
            d.performance = perf;
        }
    }

    /// Replace a deck's note steering wholesale (`None` = unsteered) — full
    /// state, never a delta, the ADR-0023 idempotence rule.
    pub fn set_notes(&mut self, deck: usize, notes: Option<NoteSteeringSnap>) {
        if let Some(d) = self.deck_mut(deck) {
            d.notes = notes;
        }
    }

    pub fn set_drums(&mut self, deck: usize, drums: Option<bool>) {
        if let Some(d) = self.deck_mut(deck) {
            d.drums = drums;
        }
    }

    /// Record a deck's live beat analysis (ADR-0025) — a measurement the
    /// shell's analysis thread writes; nothing forwards to the engine here
    /// (the thread drives the echo clock through the [`Host`] itself).
    pub fn set_analysis(&mut self, deck: usize, analysis: AnalysisSnap) {
        if let Some(d) = self.deck_mut(deck) {
            d.analysis = analysis;
        }
    }
}

/// The shell-level store: the locked [`InterfaceState`] plus the [`AppHandle`] used
/// to broadcast changes. Held in Tauri managed state for the app's lifetime so every
/// controller path (UI/MIDI commands today, MCP tools later) mutates the one copy.
/// An in-process store-change listener (see [`InterfaceStore::watch`]).
type StoreWatcher = Box<dyn Fn(&InterfaceState) + Send + Sync>;

pub struct InterfaceStore {
    state: Mutex<InterfaceState>,
    app: AppHandle,
    /// In-process change listeners (the native LED painter, ADR-0031), called
    /// with the fresh snapshot after every real mutation — the Rust-side
    /// equivalent of the webview's `store://changed` subscription, without a
    /// serde round-trip.
    watchers: Mutex<Vec<StoreWatcher>>,
}

impl InterfaceStore {
    pub fn new(app: AppHandle) -> Self {
        InterfaceStore {
            state: Mutex::new(InterfaceState::default()),
            app,
            watchers: Mutex::new(Vec::new()),
        }
    }

    /// Register an in-process change listener (never unregistered — watchers
    /// live as long as the app, like the managed state that owns them).
    pub fn watch(&self, watcher: impl Fn(&InterfaceState) + Send + Sync + 'static) {
        self.watchers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(Box::new(watcher));
    }

    /// The current snapshot — what the webview hydrates from on mount (`store_snapshot`).
    pub fn snapshot(&self) -> InterfaceState {
        self.lock().clone()
    }

    /// Apply a mutation under the lock, then emit the fresh snapshot to the webview.
    /// The clone happens under the lock and the emit after it drops, so serialisation
    /// never holds the mutex. A poisoned lock is recovered (a panic in another
    /// holder must not wedge every later control).
    ///
    /// A mutation that leaves the state unchanged emits nothing — many mirror writers
    /// re-push identical values (a boot replay, a `track?.cues` reference change with
    /// the same points), and a redundant `store://changed` would re-render every
    /// projection consumer for no reason.
    fn mutate(&self, f: impl FnOnce(&mut InterfaceState)) {
        let snapshot = {
            let mut state = self.lock();
            let before = state.clone();
            f(&mut state);
            if *state == before {
                return;
            }
            state.clone()
        };
        let _ = self.app.emit(STORE_CHANGED_EVENT, &snapshot);
        for watcher in self.watchers.lock().unwrap_or_else(|p| p.into_inner()).iter() {
            watcher(&snapshot);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, InterfaceState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn set_crossfade(&self, position: f32) {
        self.mutate(|s| s.set_crossfade(position));
    }

    pub fn set_cue_mix(&self, position: f32) {
        self.mutate(|s| s.set_cue_mix(position));
    }

    pub fn set_volume(&self, deck: usize, gain: f32) {
        self.mutate(|s| s.set_volume(deck, gain));
    }

    pub fn set_eq(&self, deck: usize, band: EqBand, value: f32) {
        self.mutate(|s| s.set_eq(deck, band, value));
    }

    pub fn set_trim(&self, deck: usize, db: f32) {
        self.mutate(|s| s.set_trim(deck, db));
    }

    pub fn set_cue(&self, deck: usize, on: bool) {
        self.mutate(|s| s.set_cue(deck, on));
    }

    pub fn set_on_air(&self, deck: usize, on: bool) {
        self.mutate(|s| s.set_on_air(deck, on));
    }

    pub fn set_fx(&self, deck: usize, kind: FxKind) {
        self.mutate(|s| s.set_fx(deck, kind));
    }

    pub fn set_fx_amount(&self, deck: usize, amount: f32) {
        self.mutate(|s| s.set_fx_amount(deck, amount));
    }

    pub fn clear_fx(&self, deck: usize) {
        self.mutate(|s| s.clear_fx(deck));
    }

    /// Mirror a realtime deck's model read-back. The webview derives it from
    /// worker status (`ready`/`model_loading`) and writes the current value up;
    /// the store holds it for MCP reads.
    pub fn set_deck_model(&self, deck: usize, model: Option<String>) {
        self.mutate(move |s| s.set_model(deck, model));
    }

    /// Set a realtime deck's transport. The store OWNS `playing` (ADR-0020): the
    /// `deck_play`/`deck_stop` commands write it for every controller (UI, MIDI,
    /// MCP), the sidecar status relay drops it when a worker dies or reloads, and
    /// the webview's button is a projection of this value — never a writer.
    pub fn set_playing(&self, deck: usize, playing: bool) {
        self.mutate(move |s| s.set_playing(deck, playing));
    }

    /// Mirror the loaded track's hot-cue points (ADR-0015 → ADR-0020). The webview
    /// owns the set/jump logic and writes the current points up.
    pub fn set_deck_cues(&self, deck: usize, cues: Vec<Option<f64>>) {
        self.mutate(move |s| s.set_cues(deck, cues));
    }

    /// Mirror the loaded track's identity (a playback-deck read-back). The webview
    /// writes it on load / unload; `None` clears it.
    pub fn set_deck_track(&self, deck: usize, track: Option<TrackIdentitySnap>) {
        self.mutate(move |s| s.set_track(deck, track));
    }

    /// Mirror a playback deck's live transport (playhead / rate / loop). The webview
    /// owns the read-back and writes the current value up at a throttled cadence;
    /// `None` clears it on unload / a realtime deck.
    pub fn set_deck_transport(&self, deck: usize, transport: Option<TransportSnap>) {
        self.mutate(move |s| s.set_transport(deck, transport));
    }

    /// Mirror the freeze/sample loop-slot labels (a read-back the webview writes up
    /// when its slots change).
    pub fn set_deck_loop_labels(&self, deck: usize, labels: Vec<Option<String>>) {
        self.mutate(move |s| s.set_loop_labels(deck, labels));
    }

    /// Mirror the realtime deck's 2D style-pad state (targets + cursor + the net
    /// selection mask, one atomic write — see [`InterfaceState::set_style`]).
    /// `DeckColumn` writes it up on change.
    pub fn set_deck_style(
        &self,
        deck: usize,
        targets: Vec<StyleTargetSnap>,
        cursor: PadPointSnap,
        selected: Vec<bool>,
    ) {
        self.mutate(move |s| s.set_style(deck, targets, cursor, selected));
    }

    /// Set one hot-cue pad's point (MCP `set_hot_cue` / `clear_hot_cue`). The webview
    /// adopts the change and re-renders the pad; jump stays a transport seek.
    pub fn set_deck_cue(&self, deck: usize, index: usize, seconds: Option<f64>) {
        self.mutate(move |s| s.set_cue_point(deck, index, seconds));
    }

    /// Set just the style-pad cursor (MCP `set_style_cursor`). `DeckColumn` adopts it
    /// and re-pushes the blended prompt to the worker.
    pub fn set_deck_cursor(&self, deck: usize, cursor: PadPointSnap) {
        self.mutate(move |s| s.set_cursor(deck, cursor));
    }

    /// Mirror the primed-off-air read-back (the transport-CUE LED state).
    pub fn set_deck_primed(&self, deck: usize, primed: bool) {
        self.mutate(move |s| s.set_primed(deck, primed));
    }

    /// Record a deck's performance-surface config (written by the shell
    /// note-steering service — UI and hardware both go through it).
    pub fn set_deck_performance(&self, deck: usize, perf: PerformanceSnap) {
        self.mutate(move |s| s.set_performance(deck, perf));
    }

    /// Replace a deck's note steering (UI/MIDI writes it up; MCP `set_notes` writes
    /// it for the webview to adopt and drive the worker — ADR-0023 over ADR-0020's
    /// projection). `None` = unsteered.
    pub fn set_deck_notes(&self, deck: usize, notes: Option<NoteSteeringSnap>) {
        self.mutate(move |s| s.set_notes(deck, notes));
    }

    /// Set a deck's drum conditioning tri-state (`None` = the model decides).
    pub fn set_deck_drums(&self, deck: usize, drums: Option<bool>) {
        self.mutate(move |s| s.set_drums(deck, drums));
    }

    /// Record a deck's live beat analysis (ADR-0025) — written by the shell's
    /// analysis thread at the estimate cadence; the no-change suppression in
    /// [`InterfaceStore::mutate`] keeps a held (or blank) reading silent.
    pub fn set_analysis(&self, deck: usize, analysis: AnalysisSnap) {
        self.mutate(move |s| s.set_analysis(deck, analysis));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_has_one_channel_per_deck_at_neutral() {
        let state = InterfaceState::default();
        assert_eq!(state.decks.len(), DECK_COUNT);
        assert_eq!(state.crossfade, 0.5);
        assert_eq!(state.cue_mix, 0.5);
        for deck in &state.decks {
            assert_eq!(deck.volume, 1.0);
            assert_eq!(deck.eq, EqSnap { low: 0.5, mid: 0.5, high: 0.5 });
            assert!(deck.on_air);
            assert!(!deck.cue);
            assert_eq!(deck.fx.kind, None);
            assert_eq!(deck.model, None);
            assert!(!deck.playing);
            assert!(deck.cues.is_empty());
            assert_eq!(deck.track, None);
            assert_eq!(deck.transport, None);
            assert!(deck.loop_labels.is_empty());
            assert!(deck.style_targets.is_empty());
            assert_eq!(deck.cursor, PadPointSnap { x: 0.5, y: 0.5 });
            assert_eq!(deck.notes, None);
            assert_eq!(deck.drums, None);
        }
    }

    #[test]
    fn note_and_drum_steering_are_mirrored_per_deck() {
        let mut state = InterfaceState::default();
        state.set_notes(
            0,
            Some(NoteSteeringSnap {
                pitches: vec![60, 64, 67],
                mode: NoteModeSnap::Chord,
            }),
        );
        state.set_drums(0, Some(false));
        assert_eq!(state.decks[0].notes.as_ref().unwrap().pitches, vec![60, 64, 67]);
        assert_eq!(state.decks[0].drums, Some(false));
        // The other deck is untouched.
        assert_eq!(state.decks[1].notes, None);
        assert_eq!(state.decks[1].drums, None);
        // Clearing returns to unsteered.
        state.set_notes(0, None);
        state.set_drums(0, None);
        assert_eq!(state.decks[0].notes, None);
        assert_eq!(state.decks[0].drums, None);
    }

    #[test]
    fn analysis_is_blank_by_default_and_mirrored_per_deck() {
        let mut state = InterfaceState::default();
        assert_eq!(state.decks[0].analysis, AnalysisSnap::default());
        assert_eq!(state.decks[0].analysis.bpm, None);
        state.set_analysis(
            0,
            AnalysisSnap {
                bpm: Some(128.0),
                confidence: 0.62,
                live_beat: Some(LiveBeatSnap {
                    anchor_frame: 96_000.0,
                    bpm: 128.0,
                }),
                origin_frames: 48_000.0,
            },
        );
        assert_eq!(state.decks[0].analysis.bpm, Some(128.0));
        assert_eq!(
            state.decks[0].analysis.live_beat,
            Some(LiveBeatSnap {
                anchor_frame: 96_000.0,
                bpm: 128.0
            })
        );
        // The other deck is untouched, and an out-of-range deck is a no-op.
        assert_eq!(state.decks[1].analysis, AnalysisSnap::default());
        state.set_analysis(9, AnalysisSnap::default());
    }

    #[test]
    fn transport_transitions_reset_note_and_drum_steering() {
        let mut state = InterfaceState::default();
        state.set_playing(0, true);
        state.set_notes(
            0,
            Some(NoteSteeringSnap {
                pitches: vec![60],
                mode: NoteModeSnap::Onset,
            }),
        );
        state.set_drums(0, Some(true));
        // Re-asserting the same transport state is not a discontinuity.
        state.set_playing(0, true);
        assert!(state.decks[0].notes.is_some());
        // A stop is: steering resets with the stream (ADR-0023).
        state.set_playing(0, false);
        assert_eq!(state.decks[0].notes, None);
        assert_eq!(state.decks[0].drums, None);
        // Steering set while stopped dies at the next play — a fresh
        // stream starts unsteered, exactly like the worker's engine.
        state.set_notes(
            0,
            Some(NoteSteeringSnap {
                pitches: vec![62],
                mode: NoteModeSnap::Chord,
            }),
        );
        state.set_playing(0, true);
        assert_eq!(state.decks[0].notes, None);
    }

    #[test]
    fn style_targets_cursor_and_selection_are_one_atomic_write() {
        let mut state = InterfaceState::default();
        state.set_style(
            0,
            vec![StyleTargetSnap {
                x: 0.2,
                y: 0.8,
                text: "dub".to_string(),
            }],
            PadPointSnap { x: 0.3, y: 0.4 },
            vec![true],
        );
        assert_eq!(state.decks[0].style_targets.len(), 1);
        assert_eq!(state.decks[0].style_targets[0].text, "dub");
        assert_eq!(state.decks[0].cursor, PadPointSnap { x: 0.3, y: 0.4 });
        assert_eq!(state.decks[0].style_selected, vec![true]);
        // The other deck is untouched.
        assert!(state.decks[1].style_targets.is_empty());
        assert_eq!(state.decks[1].cursor, PadPointSnap { x: 0.5, y: 0.5 });
        // The mask replaces WITH the targets — never a stale pairing (the
        // projection's adoption gate depends on the atomicity).
        state.set_style(0, Vec::new(), PadPointSnap { x: 0.5, y: 0.5 }, Vec::new());
        assert!(state.decks[0].style_targets.is_empty());
        assert!(state.decks[0].style_selected.is_empty());
    }

    #[test]
    fn loop_labels_are_mirrored_per_deck() {
        let mut state = InterfaceState::default();
        state.set_loop_labels(0, vec![Some("kick".to_string()), None]);
        assert_eq!(state.decks[0].loop_labels, vec![Some("kick".to_string()), None]);
        assert!(state.decks[1].loop_labels.is_empty());
    }

    #[test]
    fn track_identity_is_mirrored_and_cleared_per_deck() {
        let mut state = InterfaceState::default();
        state.set_track(
            0,
            Some(TrackIdentitySnap {
                title: "Take 1".to_string(),
                bpm: Some(128.0),
                duration_seconds: 180.0,
            }),
        );
        let track = state.decks[0].track.as_ref().unwrap();
        assert_eq!(track.title, "Take 1");
        assert_eq!(track.bpm, Some(128.0));
        assert_eq!(state.decks[1].track, None);
        // Unload clears it.
        state.set_track(0, None);
        assert_eq!(state.decks[0].track, None);
    }

    #[test]
    fn transport_is_mirrored_and_cleared_per_deck() {
        let mut state = InterfaceState::default();
        state.set_transport(
            0,
            Some(TransportSnap {
                playhead_seconds: 12.5,
                rate: 1.08,
                loop_region: Some(LoopRegionSnap {
                    start_seconds: 8.0,
                    end_seconds: 16.0,
                }),
            }),
        );
        let transport = state.decks[0].transport.as_ref().unwrap();
        assert_eq!(transport.playhead_seconds, 12.5);
        assert_eq!(transport.rate, 1.08);
        assert_eq!(transport.loop_region.unwrap().end_seconds, 16.0);
        // The other deck is untouched.
        assert_eq!(state.decks[1].transport, None);
        // Unload / realtime clears it.
        state.set_transport(0, None);
        assert_eq!(state.decks[0].transport, None);
    }

    #[test]
    fn realtime_read_backs_are_mirrored_per_deck() {
        let mut state = InterfaceState::default();
        state.set_model(0, Some("mrt2_base".to_string()));
        state.set_playing(0, true);
        assert_eq!(state.decks[0].model.as_deref(), Some("mrt2_base"));
        assert!(state.decks[0].playing);
        // The other deck is untouched.
        assert_eq!(state.decks[1].model, None);
        assert!(!state.decks[1].playing);
    }

    #[test]
    fn hot_cues_are_mirrored_per_deck() {
        let mut state = InterfaceState::default();
        state.set_cues(0, vec![Some(1.5), None, Some(3.0)]);
        assert_eq!(state.decks[0].cues, vec![Some(1.5), None, Some(3.0)]);
        assert!(state.decks[1].cues.is_empty());
    }

    #[test]
    fn set_cue_point_sets_or_clears_one_pad_in_range() {
        let mut state = InterfaceState::default();
        // A no-track deck (empty cue vec) is a silent no-op — the MCP tool reports it.
        state.set_cue_point(0, 0, Some(4.0));
        assert!(state.decks[0].cues.is_empty());
        // With a cue bank, set one pad and clear it; the neighbours are untouched.
        state.set_cues(0, vec![None, None, None]);
        state.set_cue_point(0, 1, Some(12.5));
        assert_eq!(state.decks[0].cues, vec![None, Some(12.5), None]);
        state.set_cue_point(0, 1, None);
        assert_eq!(state.decks[0].cues, vec![None, None, None]);
        // An out-of-range pad on a loaded deck is a no-op too.
        state.set_cue_point(0, 9, Some(1.0));
        assert_eq!(state.decks[0].cues, vec![None, None, None]);
    }

    #[test]
    fn set_cursor_moves_the_blend_point_leaving_targets() {
        let mut state = InterfaceState::default();
        state.set_style(
            0,
            vec![StyleTargetSnap {
                x: 0.1,
                y: 0.2,
                text: "a".to_string(),
            }],
            PadPointSnap { x: 0.5, y: 0.5 },
            Vec::new(),
        );
        state.set_cursor(0, PadPointSnap { x: 0.7, y: 0.3 });
        assert_eq!(state.decks[0].cursor, PadPointSnap { x: 0.7, y: 0.3 });
        // The targets are left exactly as they were.
        assert_eq!(state.decks[0].style_targets.len(), 1);
        assert_eq!(state.decks[0].style_targets[0].text, "a");
    }

    #[test]
    fn mixer_mutations_record_per_deck() {
        let mut state = InterfaceState::default();
        state.set_crossfade(0.25);
        state.set_cue_mix(0.0);
        state.set_volume(1, 0.6);
        state.set_eq(0, EqBand::Low, 0.1);
        state.set_eq(0, EqBand::High, 0.9);
        state.set_trim(1, -3.0);
        state.set_cue(0, true);
        state.set_on_air(1, false);

        assert_eq!(state.crossfade, 0.25);
        assert_eq!(state.cue_mix, 0.0);
        assert_eq!(state.decks[1].volume, 0.6);
        assert_eq!(state.decks[0].eq.low, 0.1);
        assert_eq!(state.decks[0].eq.high, 0.9);
        // The mid band is untouched by a low/high write.
        assert_eq!(state.decks[0].eq.mid, 0.5);
        assert_eq!(state.decks[1].trim_db, -3.0);
        assert!(state.decks[0].cue);
        assert!(!state.decks[1].on_air);
    }

    #[test]
    fn fx_select_keeps_amount_then_clear_keeps_amount() {
        let mut state = InterfaceState::default();
        state.set_fx(0, FxKind::DubEcho);
        state.set_fx_amount(0, 0.7);
        assert_eq!(state.decks[0].fx.kind, Some(FxKindSnap::DubEcho));
        assert_eq!(state.decks[0].fx.amount, 0.7);

        // Clearing the effect drops the kind but leaves the amount (matches the
        // frontend's setFx(null)).
        state.clear_fx(0);
        assert_eq!(state.decks[0].fx.kind, None);
        assert_eq!(state.decks[0].fx.amount, 0.7);
    }

    #[test]
    fn out_of_range_deck_is_a_silent_no_op() {
        let mut state = InterfaceState::default();
        // Bad index must not panic and must not touch a valid deck.
        state.set_volume(DECK_COUNT, 0.0);
        state.set_eq(99, EqBand::Mid, 0.0);
        state.set_fx(7, FxKind::Crush);
        assert_eq!(state.decks[0], DeckSnap::default());
        assert_eq!(state.decks[DECK_COUNT - 1], DeckSnap::default());
    }

    #[test]
    fn snapshot_serialises_camelcase_for_the_webview() {
        let mut state = InterfaceState::default();
        state.set_fx(0, FxKind::DubEcho);
        let json = serde_json::to_string(&state).unwrap();
        // The projection reads these keys; lock the wire shape.
        assert!(json.contains("\"cueMix\""));
        assert!(json.contains("\"onAir\""));
        assert!(json.contains("\"trimDb\""));
        assert!(json.contains("\"dubEcho\""));
    }
}
