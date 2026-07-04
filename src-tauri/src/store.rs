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
/// effect by intent rather than a magic index. `Deserialize` too — it
/// round-trips through the shell settings file (ADR-0020 phase C).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
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

impl From<FxKindSnap> for FxKind {
    fn from(kind: FxKindSnap) -> Self {
        match kind {
            FxKindSnap::Filter => FxKind::Filter,
            FxKindSnap::DubEcho => FxKind::DubEcho,
            FxKindSnap::Space => FxKind::Space,
            FxKindSnap::Crush => FxKind::Crush,
            FxKindSnap::Noise => FxKind::Noise,
            FxKindSnap::Sweep => FxKind::Sweep,
        }
    }
}

/// A deck's three-band EQ in the snapshot (each 0..1, mirroring the frontend
/// `Record<EqBand, number>`). `Deserialize` too — it round-trips through the
/// shell settings file (ADR-0020 phase C).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
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

/// One style-pad target: a prompt at a pad position. The store owns the
/// arrangement (ADR-0020 phase B); a sampled chip (ADR-0011) carries its
/// session-only embedding id in `sample` — held here so there is exactly one
/// target list, but excluded from shell persistence and stripped when the
/// worker (whose cache holds the embedding) dies. `Deserialize`/`JsonSchema`
/// too — targets cross as MCP `set_style` arguments.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StyleTargetSnap {
    pub x: f32,
    pub y: f32,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample: Option<String>,
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
    /// The realtime deck's 2D style-pad targets (prompt + position). OWNED
    /// here since ADR-0020 phase B: the webview projects and emits intents;
    /// the shell style sender blends and drives the worker. (The writer-flag
    /// adoption gate this replaced is gone — a projection has nothing to
    /// adopt, which retires the whole echo-race class.)
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
    /// The worker crashed and has not been restarted (the status relay writes
    /// it — the same shell-side source the webview's reducer reads, so an
    /// agent sees a dead deck without a webview round-trip).
    pub worker_died: bool,
    /// The worker is reloading for a model switch.
    pub switching_model: bool,
    /// The deck's hardware SHIFT is held — written by the native MIDI
    /// translator (the state's origin); the webview's copy projects it for
    /// the cross-deck jog steering until Phase D consolidates.
    pub shift_held: bool,
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
            worker_died: false,
            switching_model: false,
            shift_held: false,
        }
    }
}

/// The shell recorder's state (ADR-0028): whether a take is streaming to
/// disk and where. Written by the recording commands themselves, so a
/// webview reload (or an agent) reads the truth instead of a local flag.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSnap {
    pub active: bool,
    pub path: Option<String>,
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
    /// The shell recorder's state (see [`RecordingSnap`]).
    pub recording: RecordingSnap,
    /// The chosen MAIN output device name ("" = system default) — shell-
    /// persisted (ADR-0020 phase A); the webview picker is a projection.
    pub main_device: String,
    /// The chosen CUE output device name ("" = same as main).
    pub cue_device: String,
    /// The recordings folder ("" = Downloads).
    pub recordings_folder: String,
}

impl Default for InterfaceState {
    fn default() -> Self {
        InterfaceState {
            decks: vec![DeckSnap::default(); DECK_COUNT],
            crossfade: 0.5,
            cue_mix: 0.5,
            recording: RecordingSnap::default(),
            main_device: String::new(),
            cue_device: String::new(),
            recordings_folder: String::new(),
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

    /// Select a deck's Color FX. Records the kind AND the kind's rest amount —
    /// the engine's insert swap lands at rest (bypassed), so the store mirrors
    /// it in the same write (ADR-0020 phase C: one discrete command, no
    /// follow-up amount write whose absence leaves a stale knob in a snapshot).
    pub fn set_fx(&mut self, deck: usize, kind: FxKind) {
        if let Some(d) = self.deck_mut(deck) {
            d.fx.kind = Some(kind.into());
            d.fx.amount = kind.rest_position();
        }
    }

    pub fn set_fx_amount(&mut self, deck: usize, amount: f32) {
        if let Some(d) = self.deck_mut(deck) {
            d.fx.amount = amount;
        }
    }

    /// Remove a deck's Color FX (no effect selected); the knob parks at zero,
    /// like the frontend's `setFx(null)`.
    pub fn clear_fx(&mut self, deck: usize) {
        if let Some(d) = self.deck_mut(deck) {
            d.fx.kind = None;
            d.fx.amount = 0.0;
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

    /// Add a text target at the clearest spawn slot (ADR-0020 phase B: the
    /// add semantics — trim, length cap, dup rule, target cap, spawn
    /// geometry — live here, one copy for UI, hardware, and MCP). Returns
    /// whether the pad changed.
    pub fn style_add_target(&mut self, deck: usize, text: &str) -> bool {
        let text = text.trim();
        if text.is_empty() || text.len() > crate::style::MAX_TARGET_TEXT {
            return false;
        }
        let Some(d) = self.deck_mut(deck) else { return false };
        if d.style_targets.len() >= crate::style::MAX_TARGETS
            || d.style_targets.iter().any(|t| t.text == text)
        {
            return false;
        }
        let existing: Vec<(f32, f32)> = d.style_targets.iter().map(|t| (t.x, t.y)).collect();
        let (x, y) = crate::style::spawn_position(&existing);
        d.style_targets.push(StyleTargetSnap {
            x,
            y,
            text: text.to_string(),
            sample: None,
        });
        d.style_selected.push(false);
        true
    }

    /// Add a sampled chip (ADR-0011): a session-only embedding id under a
    /// display label; same cap/spawn rules, dup keyed on the label.
    pub fn style_add_sample_target(&mut self, deck: usize, label: &str, sample: &str) -> bool {
        let label = label.trim();
        if label.is_empty() || sample.is_empty() {
            return false;
        }
        let Some(d) = self.deck_mut(deck) else { return false };
        if d.style_targets.len() >= crate::style::MAX_TARGETS
            || d.style_targets.iter().any(|t| t.text == label)
        {
            return false;
        }
        let existing: Vec<(f32, f32)> = d.style_targets.iter().map(|t| (t.x, t.y)).collect();
        let (x, y) = crate::style::spawn_position(&existing);
        d.style_targets.push(StyleTargetSnap {
            x,
            y,
            text: label.to_string(),
            sample: Some(sample.to_string()),
        });
        d.style_selected.push(false);
        true
    }

    /// Move a target (identified by its unique text) to a clamped position.
    pub fn style_move_target(&mut self, deck: usize, text: &str, x: f32, y: f32) {
        if let Some(d) = self.deck_mut(deck) {
            if let Some(t) = d.style_targets.iter_mut().find(|t| t.text == text) {
                t.x = crate::style::clamp01(x);
                t.y = crate::style::clamp01(y);
            }
        }
    }

    /// Remove a target and its selection entry.
    pub fn style_remove_target(&mut self, deck: usize, text: &str) {
        if let Some(d) = self.deck_mut(deck) {
            if let Some(index) = d.style_targets.iter().position(|t| t.text == text) {
                d.style_targets.remove(index);
                if index < d.style_selected.len() {
                    d.style_selected.remove(index);
                }
            }
        }
    }

    /// Rename a text target in place (position and selection kept). A rename
    /// that empties, overflows, collides, or touches a sampled chip (whose
    /// label names a captured moment, not a prompt) is rejected — the same
    /// quiet rule the webview's editor applied. Returns whether it renamed.
    pub fn style_rename_target(&mut self, deck: usize, from: &str, to: &str) -> bool {
        let to = to.trim();
        if to.is_empty() || to.len() > crate::style::MAX_TARGET_TEXT {
            return false;
        }
        let Some(d) = self.deck_mut(deck) else { return false };
        if to != from && d.style_targets.iter().any(|t| t.text == to) {
            return false;
        }
        match d.style_targets.iter_mut().find(|t| t.text == from) {
            Some(t) if t.sample.is_none() => {
                t.text = to.to_string();
                true
            }
            _ => false,
        }
    }

    /// Toggle a target in or out of the net selection (the blend mask the
    /// pad LEDs mirror).
    pub fn style_toggle_selection(&mut self, deck: usize, text: &str) {
        if let Some(d) = self.deck_mut(deck) {
            if let Some(index) = d.style_targets.iter().position(|t| t.text == text) {
                if index < d.style_selected.len() {
                    d.style_selected[index] = !d.style_selected[index];
                }
            }
        }
    }

    /// The tidy-up gesture: centre the cursor and fan the targets onto the
    /// spawn circle in order.
    pub fn style_fan_out(&mut self, deck: usize) {
        if let Some(d) = self.deck_mut(deck) {
            for (index, target) in d.style_targets.iter_mut().enumerate() {
                let (x, y) = crate::style::circle_slot(index);
                target.x = x;
                target.y = y;
            }
            d.cursor = PadPointSnap { x: 0.5, y: 0.5 };
        }
    }

    /// Replace the pad wholesale (a preset load, an MCP arrangement): text
    /// targets only, selection cleared, cursor set. Invalid entries are
    /// dropped at the trust boundary before this is called.
    pub fn style_apply_preset(
        &mut self,
        deck: usize,
        targets: Vec<StyleTargetSnap>,
        cursor: PadPointSnap,
    ) {
        if let Some(d) = self.deck_mut(deck) {
            let count = targets.len().min(crate::style::MAX_TARGETS);
            d.style_targets = targets.into_iter().take(count).collect();
            d.style_selected = vec![false; count];
            d.cursor = PadPointSnap {
                x: crate::style::clamp01(cursor.x),
                y: crate::style::clamp01(cursor.y),
            };
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
            d.cursor = PadPointSnap {
                x: crate::style::clamp01(cursor.x),
                y: crate::style::clamp01(cursor.y),
            };
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

    /// Record the worker's health from a status event: a crash sets `died`
    /// (until a reload begins), a model switch sets `switching`, and `ready`
    /// clears both — the same transitions the webview reducer derives from
    /// the identical events, so the two views cannot diverge. A dead or
    /// reloading worker drops its sample cache, so the sampled style chips
    /// (whose embeddings lived in that cache, ADR-0011) strip with it.
    pub fn set_worker_health(&mut self, deck: usize, died: bool, switching: bool) {
        if let Some(d) = self.deck_mut(deck) {
            d.worker_died = died;
            d.switching_model = switching;
            if died || switching {
                let keep: Vec<bool> = d.style_targets.iter().map(|t| t.sample.is_none()).collect();
                let mut kept = keep.iter();
                d.style_targets.retain(|_| *kept.next().unwrap_or(&true));
                let mut kept = keep.iter();
                d.style_selected.retain(|_| *kept.next().unwrap_or(&true));
            }
        }
    }

    /// Record the deck's hardware SHIFT held-state (the native translator is
    /// the origin; this is a plain shell-side write, not a mirror).
    pub fn set_shift_held(&mut self, deck: usize, held: bool) {
        if let Some(d) = self.deck_mut(deck) {
            d.shift_held = held;
        }
    }

    /// Record the shell recorder's state (active + the take's path).
    pub fn set_recording(&mut self, active: bool, path: Option<String>) {
        self.recording = RecordingSnap { active, path };
    }

    /// Record the chosen output devices (shell-persisted settings).
    pub fn set_output_devices(&mut self, main: String, cue: String) {
        self.main_device = main;
        self.cue_device = cue;
    }

    /// Record the recordings folder ("" = Downloads).
    pub fn set_recordings_folder(&mut self, folder: String) {
        self.recordings_folder = folder;
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

    /// The style-pad intents (ADR-0020 phase B): one semantic surface for
    /// the UI, the hardware, and MCP — the webview projects the result.
    pub fn style_add_target(&self, deck: usize, text: &str) -> bool {
        let mut added = false;
        self.mutate(|s| added = s.style_add_target(deck, text));
        added
    }

    pub fn style_add_sample_target(&self, deck: usize, label: &str, sample: &str) -> bool {
        let mut added = false;
        self.mutate(|s| added = s.style_add_sample_target(deck, label, sample));
        added
    }

    pub fn style_move_target(&self, deck: usize, text: &str, x: f32, y: f32) {
        self.mutate(|s| s.style_move_target(deck, text, x, y));
    }

    pub fn style_remove_target(&self, deck: usize, text: &str) {
        self.mutate(|s| s.style_remove_target(deck, text));
    }

    pub fn style_rename_target(&self, deck: usize, from: &str, to: &str) -> bool {
        let mut renamed = false;
        self.mutate(|s| renamed = s.style_rename_target(deck, from, to));
        renamed
    }

    pub fn style_toggle_selection(&self, deck: usize, text: &str) {
        self.mutate(|s| s.style_toggle_selection(deck, text));
    }

    pub fn style_fan_out(&self, deck: usize) {
        self.mutate(|s| s.style_fan_out(deck));
    }

    pub fn style_apply_preset(
        &self,
        deck: usize,
        targets: Vec<StyleTargetSnap>,
        cursor: PadPointSnap,
    ) {
        self.mutate(move |s| s.style_apply_preset(deck, targets, cursor));
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

    /// Record the worker's health from the status relay (crash / model
    /// switch / ready).
    pub fn set_worker_health(&self, deck: usize, died: bool, switching: bool) {
        self.mutate(move |s| s.set_worker_health(deck, died, switching));
    }

    /// Record a deck's hardware SHIFT held-state (native translator origin).
    pub fn set_deck_shift(&self, deck: usize, held: bool) {
        self.mutate(move |s| s.set_shift_held(deck, held));
    }

    /// Record the shell recorder's state (the recording commands write it).
    pub fn set_recording(&self, active: bool, path: Option<String>) {
        self.mutate(move |s| s.set_recording(active, path));
    }

    /// Record the chosen output devices (the device commands write it after
    /// a successful switch; boot hydration seeds it from the settings file).
    pub fn set_output_devices(&self, main: String, cue: String) {
        self.mutate(move |s| s.set_output_devices(main, cue));
    }

    /// Record the recordings folder ("" = Downloads).
    pub fn set_recordings_folder(&self, folder: String) {
        self.mutate(move |s| s.set_recordings_folder(folder));
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
    fn style_add_spawns_on_the_circle_and_enforces_trim_dup_and_cap() {
        let mut state = InterfaceState::default();
        // Trim; the spawn slot comes from the geometry (empty pad → slot 0).
        assert!(state.style_add_target(0, "  dub  "));
        assert_eq!(state.decks[0].style_targets[0].text, "dub");
        let (x0, y0) = crate::style::circle_slot(0);
        assert_eq!(state.decks[0].style_targets[0].x, x0);
        assert_eq!(state.decks[0].style_targets[0].y, y0);
        // Selection grows in step, unselected.
        assert_eq!(state.decks[0].style_selected, vec![false]);
        // Duplicates and empties are rejected.
        assert!(!state.style_add_target(0, "dub"));
        assert!(!state.style_add_target(0, "   "));
        // The cap holds at MAX_TARGETS.
        for i in 0..crate::style::MAX_TARGETS {
            state.style_add_target(0, &format!("t{i}"));
        }
        assert_eq!(state.decks[0].style_targets.len(), crate::style::MAX_TARGETS);
        assert!(!state.style_add_target(0, "one too many"));
        // The other deck is untouched.
        assert!(state.decks[1].style_targets.is_empty());
    }

    #[test]
    fn style_move_clamps_and_remove_keeps_selection_aligned() {
        let mut state = InterfaceState::default();
        state.style_add_target(0, "a");
        state.style_add_target(0, "b");
        state.style_toggle_selection(0, "b");
        assert_eq!(state.decks[0].style_selected, vec![false, true]);
        // Move clamps into the unit square.
        state.style_move_target(0, "a", -0.5, 1.5);
        assert_eq!(state.decks[0].style_targets[0].x, 0.0);
        assert_eq!(state.decks[0].style_targets[0].y, 1.0);
        // Removing "a" keeps "b" selected — the mask tracks its target.
        state.style_remove_target(0, "a");
        assert_eq!(state.decks[0].style_targets.len(), 1);
        assert_eq!(state.decks[0].style_targets[0].text, "b");
        assert_eq!(state.decks[0].style_selected, vec![true]);
    }

    #[test]
    fn style_rename_keeps_position_and_rejects_collisions_and_sample_chips() {
        let mut state = InterfaceState::default();
        state.style_add_target(0, "dub");
        state.style_add_target(0, "punk");
        state.style_add_sample_target(0, "Deck B sample 1", "sample:b:1");
        let position = (state.decks[0].style_targets[0].x, state.decks[0].style_targets[0].y);
        // Rename keeps the position; collisions and empties are quiet no-ops.
        assert!(state.style_rename_target(0, "dub", "deep dub"));
        assert_eq!(state.decks[0].style_targets[0].text, "deep dub");
        assert_eq!(
            (state.decks[0].style_targets[0].x, state.decks[0].style_targets[0].y),
            position
        );
        assert!(!state.style_rename_target(0, "deep dub", "punk"));
        assert!(!state.style_rename_target(0, "punk", "  "));
        // A sampled chip's label names a captured moment — not renameable.
        assert!(!state.style_rename_target(0, "Deck B sample 1", "nice loop"));
    }

    #[test]
    fn style_fan_out_circles_the_targets_and_centres_the_cursor() {
        let mut state = InterfaceState::default();
        state.style_add_target(0, "a");
        state.style_add_target(0, "b");
        state.style_move_target(0, "a", 0.9, 0.9);
        state.set_cursor(0, PadPointSnap { x: 0.1, y: 0.1 });
        state.style_fan_out(0);
        let (x0, y0) = crate::style::circle_slot(0);
        let (x1, y1) = crate::style::circle_slot(1);
        assert_eq!(state.decks[0].style_targets[0].x, x0);
        assert_eq!(state.decks[0].style_targets[0].y, y0);
        assert_eq!(state.decks[0].style_targets[1].x, x1);
        assert_eq!(state.decks[0].style_targets[1].y, y1);
        assert_eq!(state.decks[0].cursor, PadPointSnap { x: 0.5, y: 0.5 });
    }

    #[test]
    fn style_apply_preset_replaces_wholesale_and_clears_selection() {
        let mut state = InterfaceState::default();
        state.style_add_target(0, "old");
        state.style_toggle_selection(0, "old");
        state.style_apply_preset(
            0,
            vec![StyleTargetSnap {
                x: 0.2,
                y: 0.8,
                text: "dub".to_string(),
                sample: None,
            }],
            PadPointSnap { x: 0.3, y: 0.4 },
        );
        assert_eq!(state.decks[0].style_targets.len(), 1);
        assert_eq!(state.decks[0].style_targets[0].text, "dub");
        assert_eq!(state.decks[0].style_selected, vec![false]);
        assert_eq!(state.decks[0].cursor, PadPointSnap { x: 0.3, y: 0.4 });
    }

    #[test]
    fn worker_death_strips_sampled_chips_and_their_selection() {
        let mut state = InterfaceState::default();
        state.style_add_target(0, "dub");
        state.style_add_sample_target(0, "Deck B sample 1", "sample:b:1");
        state.style_toggle_selection(0, "dub");
        state.style_toggle_selection(0, "Deck B sample 1");
        // The dying worker takes its embedding cache — the chip goes with it,
        // the text target (and its selection) survives.
        state.set_worker_health(0, true, false);
        assert_eq!(state.decks[0].style_targets.len(), 1);
        assert_eq!(state.decks[0].style_targets[0].text, "dub");
        assert_eq!(state.decks[0].style_selected, vec![true]);
        assert!(state.decks[0].worker_died);
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
        state.style_add_target(0, "a");
        state.set_cursor(0, PadPointSnap { x: 0.7, y: 0.3 });
        assert_eq!(state.decks[0].cursor, PadPointSnap { x: 0.7, y: 0.3 });
        // The targets are left exactly as they were.
        assert_eq!(state.decks[0].style_targets.len(), 1);
        assert_eq!(state.decks[0].style_targets[0].text, "a");
        // And the cursor clamps into the unit square.
        state.set_cursor(0, PadPointSnap { x: -1.0, y: 2.0 });
        assert_eq!(state.decks[0].cursor, PadPointSnap { x: 0.0, y: 1.0 });
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
    fn fx_select_parks_the_amount_at_rest_and_clear_at_zero() {
        // Phase C: set_fx records kind + the kind's rest amount in ONE write —
        // the engine's insert swap lands at rest, and a snapshot between the
        // old two-write sequence must never pair the new kind with the stale
        // amount. clear_fx parks at zero, like the webview's setFx(null).
        let mut state = InterfaceState::default();
        state.set_fx(0, FxKind::DubEcho);
        state.set_fx_amount(0, 0.7);
        assert_eq!(state.decks[0].fx.kind, Some(FxKindSnap::DubEcho));
        assert_eq!(state.decks[0].fx.amount, 0.7);

        // A kind swap lands at the new kind's rest (filter is bipolar: 0.5).
        state.set_fx(0, FxKind::Filter);
        assert_eq!(state.decks[0].fx.kind, Some(FxKindSnap::Filter));
        assert_eq!(state.decks[0].fx.amount, 0.5);

        state.clear_fx(0);
        assert_eq!(state.decks[0].fx.kind, None);
        assert_eq!(state.decks[0].fx.amount, 0.0);
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
