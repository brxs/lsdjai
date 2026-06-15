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
use slipmate_engine::host::{Health, Host};
use slipmate_engine::{
    EqBand, FxKind, LoopRegion, LoopSlotStatus, TrackStatus, DECK_COUNT, LOOP_SLOT_COUNT,
};

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

// --- Playback deck transport ---

/// Load a decoded track (interleaved-stereo f32 @ 48 kHz) onto a deck. The
/// webview decodes + resamples and ships the samples; the engine takes ownership
/// and switches the deck to Playback.
#[tauri::command]
pub fn load_track(state: tauri::State<'_, Host>, deck: usize, samples: Vec<f32>) {
    if valid_deck(deck) {
        state.load_track(deck, samples);
    }
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

/// Load a decoded loop/pad (interleaved-stereo f32 @ 48 kHz) into a slot. A
/// one-shot plays once; otherwise it loops (seam folded).
#[tauri::command]
pub fn load_generated_loop(
    state: tauri::State<'_, Host>,
    deck: usize,
    slot: usize,
    samples: Vec<f32>,
    one_shot: bool,
) {
    if valid_deck(deck) && valid_slot(slot) {
        state.load_generated_loop(deck, slot, samples, one_shot);
    }
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
