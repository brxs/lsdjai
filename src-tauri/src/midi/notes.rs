//! The shell note-steering service (issue #48, ADR-0031 over ADR-0023).
//!
//! The single sender for a deck's note/drum conditioning: native MIDI (the
//! KEYBOARD pad bank and external keyboards), the MCP `set_notes`/`set_drums`
//! tools, and any UI surface all land here. The service owns the held-note
//! set, the key/scale snap, the pitches→multihot mapping (ported from the
//! retired `frontend/src/audio/notes.ts`), and the on-grid onset timing; it
//! sends `set_notes` straight over the deck control socket
//! ([`Sidecars::send`]) and mirrors the authored state into the store — the
//! webview only displays. The old path (MCP writes the store, the webview
//! adopts and relays to the worker) retired with this module: the sender now
//! sits beside the beat clock (ADR-0025), which is what lets onset mode
//! quantise without crossing a process boundary.
//!
//! Messages carry FULL state, never deltas (ADR-0023's idempotence rule), and
//! the held state resets on stream discontinuities (play / stop / worker
//! death) like every other conditioning consumer.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Manager};

use lsdj_engine::host::Host;
use lsdj_engine::{DECK_COUNT, SAMPLE_RATE};

use crate::sidecar::Sidecars;
use crate::store::{InterfaceStore, NoteModeSnap, NoteSteeringSnap, PerformanceSnap, ScaleSnap};

/// The wire multihot width (one slot per MIDI pitch, docs/spike-mrt2.md).
pub const NOTE_SLOTS: usize = 128;
/// Wire states: 0 off, 1 sustain, 2 onset, 3 model-decides.
const NOTE_OFF: i32 = 0;
const NOTE_SUSTAIN: i32 = 1;
const NOTE_ONSET: i32 = 2;
const NOTE_MODEL_DECIDES: i32 = 3;
/// Chord-follow's wire state for a held pitch: the model picks the attacks
/// (state 3) — pure sustain would ask it to continue notes it never attacked.
const CHORD_FOLLOW_STATE: i32 = NOTE_MODEL_DECIDES;

/// The FLX4 performance-pad count (the KEYBOARD bank).
pub const PAD_COUNT: usize = 8;

/// Chunk sizes for the ADR-0023 performance knob: an armed deck drops to
/// ~200 ms chunks for playable latency; disarmed returns to the 1 s default.
/// The worker applies the change between chunks (`set_chunk_frames`).
pub const ARMED_CHUNK_FRAMES: u32 = 5;
pub const DEFAULT_CHUNK_FRAMES: u32 = 25;

/// A scale's pitch classes relative to the key root. The tonic sits at MIDI
/// `60 + key` (the C4 octave) so pads land in the model's comfortable
/// melodic register.
fn scale_classes(scale: ScaleSnap) -> &'static [u8] {
    match scale {
        ScaleSnap::Major => &[0, 2, 4, 5, 7, 9, 11],
        ScaleSnap::Minor => &[0, 2, 3, 5, 7, 8, 10],
        ScaleSnap::PentatonicMinor => &[0, 3, 5, 7, 10],
        ScaleSnap::Chromatic => &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    }
}

const TONIC_BASE: i32 = 60;

/// The pitch of scale degree `n` (0-based, unbounded — degree 7 of a 7-note
/// scale is the octave tonic) in the given key.
fn degree_pitch(key: u8, scale: ScaleSnap, degree: usize) -> i32 {
    let classes = scale_classes(scale);
    let octave = (degree / classes.len()) as i32;
    TONIC_BASE + key as i32 + classes[degree % classes.len()] as i32 + 12 * octave
}

/// The pitches a performance pad plays: the diatonic triad on that scale
/// degree (degrees d, d+2, d+4 — one finger = harmony, the issue #48 pad
/// mapping). The chromatic "scale" has no meaningful stacked thirds, so its
/// pads play single semitone steps instead.
pub fn pad_pitches(key: u8, scale: ScaleSnap, pad: usize) -> Vec<u8> {
    let degrees: &[usize] = if scale == ScaleSnap::Chromatic {
        &[0]
    } else {
        &[0, 2, 4]
    };
    degrees
        .iter()
        .map(|offset| degree_pitch(key, scale, pad + offset))
        .filter(|&p| (0..NOTE_SLOTS as i32).contains(&p))
        .map(|p| p as u8)
        .collect()
}

/// Snap a raw MIDI pitch to the nearest pitch of the key/scale (ties resolve
/// downward, the flatter neighbour). Chromatic is the identity.
pub fn snap_to_scale(pitch: u8, key: u8, scale: ScaleSnap) -> u8 {
    let classes = scale_classes(scale);
    if classes.len() == 12 {
        return pitch;
    }
    let class = (pitch as i32 - key as i32).rem_euclid(12);
    let mut best: i32 = i32::MAX;
    for &c in classes {
        for lift in [-12, 0, 12] {
            let candidate = c as i32 + lift;
            let distance = (candidate - class).abs();
            let snapped = pitch as i32 + candidate - class;
            if !(0..NOTE_SLOTS as i32).contains(&snapped) {
                continue;
            }
            let best_distance = (best - class).abs();
            if distance < best_distance
                || (distance == best_distance && candidate < best)
            {
                best = candidate;
            }
        }
    }
    if best == i32::MAX {
        return pitch;
    }
    (pitch as i32 + best - class) as u8
}

/// Build the full wire multihot from held pitches, or `None` for an empty
/// hold — the port of `notes.ts` `buildNoteMultihot`. `None` means fully
/// masked (the model plays freely); an all-zero multihot would instead
/// suppress melody outright. Non-held slots are OFF so the held chord really
/// constrains the harmony. In onset mode a pitch also in `previous` is a
/// continued hold (sustain), a fresh one an attack.
pub fn build_multihot(pitches: &[u8], mode: NoteModeSnap, previous: &[u8]) -> Option<Vec<i32>> {
    if pitches.is_empty() {
        return None;
    }
    let mut multihot = vec![NOTE_OFF; NOTE_SLOTS];
    for &pitch in pitches {
        let slot = pitch as usize;
        if slot >= NOTE_SLOTS {
            continue;
        }
        multihot[slot] = match mode {
            NoteModeSnap::Chord => CHORD_FOLLOW_STATE,
            NoteModeSnap::Onset => {
                if previous.contains(&pitch) {
                    NOTE_SUSTAIN
                } else {
                    NOTE_ONSET
                }
            }
        };
    }
    Some(multihot)
}

/// Seconds until the next beat, from the deck's gated clock (ADR-0025): the
/// anchor is a pushed-frame index, `origin` the engine context-frame count
/// captured at the stream reset, `context` the engine frame clock now. `None`
/// when the gate is blank — the caller sends immediately (ADR-0010's
/// gate-blank fallback: consumers free-run).
pub fn next_beat_delay(
    context_frames: f64,
    origin_frames: f64,
    anchor_frame: f64,
    bpm: f64,
) -> Option<Duration> {
    if !(bpm.is_finite() && bpm > 0.0) {
        return None;
    }
    let period = SAMPLE_RATE as f64 * 60.0 / bpm;
    let pushed_now = context_frames - origin_frames;
    let phase = (pushed_now - anchor_frame).rem_euclid(period);
    let delay_seconds = (period - phase) / SAMPLE_RATE as f64;
    Some(Duration::from_secs_f64(delay_seconds))
}

/// One deck's steering state. Pure data + bookkeeping so the hold semantics
/// are unit-testable without an app handle.
#[derive(Default)]
struct DeckState {
    perf: PerformanceSnap,
    /// Held pitches with source refcounts — a pad triad and a keyboard note
    /// may hold the same pitch; it stays held until every holder releases.
    held: BTreeMap<u8, u32>,
    /// What each performance pad's hold contributed (release removes exactly
    /// this, even if key/scale changed mid-hold).
    pad_pitches: [Vec<u8>; PAD_COUNT],
    /// Snapped pitch per raw external-keyboard note, so the release matches
    /// its own press even across a key change.
    keyboard_pitches: BTreeMap<u8, u8>,
    /// The pitches of the last multihot actually sent (onset's
    /// sustain-vs-fresh baseline, ADR-0023 full-state semantics).
    sent: Vec<u8>,
    /// Cancels a scheduled onset send when it bumps (reset / newer schedule).
    generation: u64,
    /// Whether an onset send is scheduled (folds releases into the pending
    /// beat-aligned send instead of double-sending).
    pending: bool,
}

impl DeckState {
    fn held_pitches(&self) -> Vec<u8> {
        self.held.keys().copied().collect()
    }

    fn hold(&mut self, pitches: &[u8]) {
        for &p in pitches {
            *self.held.entry(p).or_insert(0) += 1;
        }
    }

    fn release(&mut self, pitches: &[u8]) {
        for &p in pitches {
            if let Some(count) = self.held.get_mut(&p) {
                *count -= 1;
                if *count == 0 {
                    self.held.remove(&p);
                }
            }
        }
    }

    fn pad_down(&mut self, pad: usize) {
        if pad >= PAD_COUNT {
            return;
        }
        // A repeated down without an up (dropped release) replaces the hold.
        let previous = std::mem::take(&mut self.pad_pitches[pad]);
        self.release(&previous);
        let pitches = pad_pitches(self.perf.key, self.perf.scale, pad);
        self.hold(&pitches);
        self.pad_pitches[pad] = pitches;
    }

    fn pad_up(&mut self, pad: usize) {
        if pad >= PAD_COUNT {
            return;
        }
        let pitches = std::mem::take(&mut self.pad_pitches[pad]);
        self.release(&pitches);
    }

    fn key_down(&mut self, raw: u8) {
        let snapped = snap_to_scale(raw, self.perf.key, self.perf.scale);
        if let Some(previous) = self.keyboard_pitches.insert(raw, snapped) {
            self.release(&[previous]);
        }
        self.hold(&[snapped]);
    }

    fn key_up(&mut self, raw: u8) {
        if let Some(snapped) = self.keyboard_pitches.remove(&raw) {
            self.release(&[snapped]);
        }
    }

    /// Drop every hold (a stream discontinuity or an external full-state
    /// replace); the performance config survives.
    fn clear_holds(&mut self) {
        self.held.clear();
        self.pad_pitches = Default::default();
        self.keyboard_pitches.clear();
        self.sent.clear();
        self.pending = false;
        self.generation += 1;
    }
}

/// The service: per-deck state behind one lock, plus the app handle that
/// reaches the sidecars, the store, and the engine clock. Managed Tauri
/// state; every caller (MIDI callback threads, IPC commands, MCP tools)
/// goes through here.
pub struct NoteSteering {
    app: AppHandle,
    decks: Mutex<Vec<DeckState>>,
    /// Global schedule stamp — pairs with each deck's `generation` so a
    /// sleeping onset thread can tell its send is stale.
    stamp: AtomicU64,
}

impl NoteSteering {
    pub fn new(app: AppHandle) -> Self {
        NoteSteering {
            app,
            decks: Mutex::new((0..DECK_COUNT).map(|_| DeckState::default()).collect()),
            stamp: AtomicU64::new(0),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<DeckState>> {
        self.decks.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A KEYBOARD-bank pad edge from the controller. A press on an unarmed
    /// deck arms it first (the bank is self-identifying — pressing it IS the
    /// intent to perform; arming also shrinks the chunk for the presses that
    /// follow).
    pub fn pad_event(&self, deck: usize, pad: usize, down: bool) {
        if deck >= DECK_COUNT {
            return;
        }
        if down && !self.lock()[deck].perf.armed {
            self.set_armed(deck, true);
        }
        let fresh = {
            let mut decks = self.lock();
            let state = &mut decks[deck];
            if down {
                state.pad_down(pad);
            } else {
                state.pad_up(pad);
            }
            down
        };
        self.dispatch(deck, fresh);
    }

    /// An external keyboard note edge; steers every armed deck (arming is the
    /// per-deck routing switch for a shared keyboard).
    pub fn keyboard_event(&self, raw: u8, down: bool) {
        for deck in 0..DECK_COUNT {
            let armed = {
                let mut decks = self.lock();
                let state = &mut decks[deck];
                if !state.perf.armed {
                    continue;
                }
                if down {
                    state.key_down(raw);
                } else {
                    state.key_up(raw);
                }
                true
            };
            if armed {
                self.dispatch(deck, down);
            }
        }
    }

    /// A pad-mode selector press: choosing the KEYBOARD bank arms the deck's
    /// performance surface, choosing any other bank disarms it (and returns
    /// the worker to the default chunk).
    pub fn pad_mode_selected(&self, deck: usize, keyboard: bool) {
        if deck >= DECK_COUNT {
            return;
        }
        if self.lock()[deck].perf.armed != keyboard {
            self.set_armed(deck, keyboard);
        }
    }

    /// The UI/IPC performance-config write (arm, key, scale, mode).
    pub fn set_performance(&self, deck: usize, perf: PerformanceSnap) {
        if deck >= DECK_COUNT || perf.key >= 12 {
            return;
        }
        let armed_change = {
            let mut decks = self.lock();
            let was = decks[deck].perf.armed;
            decks[deck].perf = perf;
            was != perf.armed
        };
        if armed_change {
            self.apply_armed(deck, perf.armed);
        }
        self.mirror_perf(deck);
    }

    fn set_armed(&self, deck: usize, armed: bool) {
        {
            let mut decks = self.lock();
            decks[deck].perf.armed = armed;
        }
        self.apply_armed(deck, armed);
        self.mirror_perf(deck);
    }

    /// The armed-transition side effects: the chunk knob, and on disarm a
    /// clean release of any held steering.
    fn apply_armed(&self, deck: usize, armed: bool) {
        let frames = if armed { ARMED_CHUNK_FRAMES } else { DEFAULT_CHUNK_FRAMES };
        self.send_control(
            deck,
            &json!({ "type": "set_chunk_frames", "frames": frames }).to_string(),
        );
        if !armed {
            self.lock()[deck].clear_holds();
            self.send_now(deck);
        }
    }

    /// An MCP/UI full-state write (ADR-0023 semantics): replaces the whole
    /// hold and the note mode, then sends. Pitches are pre-validated by the
    /// caller's trust boundary.
    pub fn apply_external(&self, deck: usize, pitches: &[u8], mode: NoteModeSnap) {
        if deck >= DECK_COUNT {
            return;
        }
        {
            let mut decks = self.lock();
            let state = &mut decks[deck];
            state.clear_holds();
            state.perf.mode = mode;
            state.hold(pitches);
        }
        self.mirror_perf(deck);
        self.send_now(deck);
    }

    /// Drum conditioning (tri-state): sends the wire flag and mirrors the
    /// store — the drum half of the single-sender contract.
    pub fn set_drums(&self, deck: usize, drums: Option<bool>) {
        if deck >= DECK_COUNT {
            return;
        }
        let flag = match drums {
            None => serde_json::Value::Null,
            Some(force) => json!(if force { 1 } else { 0 }),
        };
        self.send_control(deck, &json!({ "type": "set_drums", "drums": flag }).to_string());
        if let Some(store) = self.app.try_state::<InterfaceStore>() {
            store.set_deck_drums(deck, drums);
        }
    }

    /// A stream discontinuity (play / stop / worker death): the worker resets
    /// its own conditioning, so the service must drop the matching held state
    /// or a stale hold would re-send over the fresh stream.
    pub fn reset(&self, deck: usize) {
        if deck >= DECK_COUNT {
            return;
        }
        self.lock()[deck].clear_holds();
        self.stamp.fetch_add(1, Ordering::SeqCst);
    }

    /// Route a change: chord mode (and every release) sends immediately;
    /// a fresh press in onset mode is scheduled onto the next gated beat.
    fn dispatch(&self, deck: usize, fresh_press: bool) {
        let (mode, delay) = {
            let decks = self.lock();
            let state = &decks[deck];
            (state.perf.mode, self.beat_delay(deck))
        };
        match (mode, fresh_press, delay) {
            (NoteModeSnap::Onset, true, Some(delay)) => self.schedule(deck, delay),
            _ => {
                // A release while an onset send is pending folds into it.
                if self.lock()[deck].pending {
                    return;
                }
                self.send_now(deck);
            }
        }
    }

    /// Seconds to the deck's next beat from the gated clock in the store and
    /// the engine frame counter; `None` when the gate is blank.
    fn beat_delay(&self, deck: usize) -> Option<Duration> {
        let store = self.app.try_state::<InterfaceStore>()?;
        let host = self.app.try_state::<Host>()?;
        let snapshot = store.snapshot();
        let analysis = &snapshot.decks.get(deck)?.analysis;
        let beat = analysis.live_beat?;
        next_beat_delay(
            host.health().context_frames as f64,
            analysis.origin_frames,
            beat.anchor_frame,
            beat.bpm,
        )
    }

    /// Schedule (or reschedule) the deck's send onto the next beat. The
    /// stamped generation cancels the sleeper if a reset lands first; a
    /// newer press simply reschedules and the older sleeper no-ops.
    fn schedule(&self, deck: usize, delay: Duration) {
        let stamp = self.stamp.fetch_add(1, Ordering::SeqCst) + 1;
        {
            let mut decks = self.lock();
            decks[deck].pending = true;
            decks[deck].generation = stamp;
        }
        let app = self.app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            if let Some(service) = app.try_state::<NoteSteering>() {
                let due = {
                    let mut decks = service.lock();
                    let state = &mut decks[deck];
                    if state.generation == stamp && state.pending {
                        state.pending = false;
                        true
                    } else {
                        false
                    }
                };
                if due {
                    service.send_now(deck);
                }
            }
        });
    }

    /// Build and send the deck's current full state, mirror the store, and
    /// advance the onset baseline.
    fn send_now(&self, deck: usize) {
        let (pitches, mode, multihot) = {
            let mut decks = self.lock();
            let state = &mut decks[deck];
            let pitches = state.held_pitches();
            let multihot = build_multihot(&pitches, state.perf.mode, &state.sent);
            state.sent = pitches.clone();
            state.pending = false;
            (pitches, state.perf.mode, multihot)
        };
        let notes = match multihot {
            Some(multihot) => json!(multihot),
            None => serde_json::Value::Null,
        };
        self.send_control(deck, &json!({ "type": "set_notes", "notes": notes }).to_string());
        if let Some(store) = self.app.try_state::<InterfaceStore>() {
            store.set_deck_notes(
                deck,
                if pitches.is_empty() {
                    None
                } else {
                    Some(NoteSteeringSnap { pitches, mode })
                },
            );
        }
    }

    fn mirror_perf(&self, deck: usize) {
        let perf = self.lock()[deck].perf;
        if let Some(store) = self.app.try_state::<InterfaceStore>() {
            store.set_deck_performance(deck, perf);
        }
    }

    fn send_control(&self, deck: usize, jsons: &str) {
        if let Some(sidecars) = self.app.try_state::<Sidecars>() {
            sidecars.send(deck, jsons);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- The musical core (pure) ---

    #[test]
    fn pads_play_diatonic_triads_in_the_chosen_key() {
        // C major: pad 0 = C-E-G, pad 1 = D-F-A, pad 5 = A-C-E (the relative
        // minor), pad 7 = the octave tonic triad.
        assert_eq!(pad_pitches(0, ScaleSnap::Major, 0), vec![60, 64, 67]);
        assert_eq!(pad_pitches(0, ScaleSnap::Major, 1), vec![62, 65, 69]);
        assert_eq!(pad_pitches(0, ScaleSnap::Major, 5), vec![69, 72, 76]);
        assert_eq!(pad_pitches(0, ScaleSnap::Major, 7), vec![72, 76, 79]);
        // A minor: pad 0 = A-C-E.
        assert_eq!(pad_pitches(9, ScaleSnap::Minor, 0), vec![69, 72, 76]);
    }

    #[test]
    fn chromatic_pads_play_single_semitones() {
        assert_eq!(pad_pitches(0, ScaleSnap::Chromatic, 0), vec![60]);
        assert_eq!(pad_pitches(0, ScaleSnap::Chromatic, 7), vec![67]);
    }

    #[test]
    fn snap_keeps_in_scale_pitches_and_pulls_neighbours_in() {
        // E is in C major; Eb snaps down to D (ties resolve flat), F# to F.
        assert_eq!(snap_to_scale(64, 0, ScaleSnap::Major), 64);
        assert_eq!(snap_to_scale(63, 0, ScaleSnap::Major), 62);
        assert_eq!(snap_to_scale(66, 0, ScaleSnap::Major), 65);
        // Bb sits between A and B in C major — the tie resolves flat, to A.
        assert_eq!(snap_to_scale(70, 0, ScaleSnap::Major), 69);
        // Chromatic never moves a pitch.
        assert_eq!(snap_to_scale(63, 0, ScaleSnap::Chromatic), 63);
        // The snap respects the key: F# is IN G major.
        assert_eq!(snap_to_scale(66, 7, ScaleSnap::Major), 66);
    }

    #[test]
    fn multihot_ports_the_notes_ts_semantics() {
        // Empty hold → None (masked, model free) — NOT an all-zero vector.
        assert_eq!(build_multihot(&[], NoteModeSnap::Chord, &[]), None);
        // Chord mode: held pitches are model-decides (3), the rest OFF.
        let hot = build_multihot(&[60, 64, 67], NoteModeSnap::Chord, &[]).unwrap();
        assert_eq!(hot.len(), NOTE_SLOTS);
        assert_eq!(hot[60], 3);
        assert_eq!(hot[64], 3);
        assert_eq!(hot[67], 3);
        assert_eq!(hot[61], 0);
        // Onset mode: a re-held pitch sustains (1), a fresh one attacks (2).
        let hot = build_multihot(&[60, 64], NoteModeSnap::Onset, &[60]).unwrap();
        assert_eq!(hot[60], 1);
        assert_eq!(hot[64], 2);
    }

    #[test]
    fn next_beat_delay_lands_on_the_grid_and_blanks_without_a_gate() {
        // 120 bpm at 48 kHz → 24000-frame beats. Anchor at pushed frame 0,
        // origin 0, clock at frame 12000 → half a beat to go (250 ms).
        let delay = next_beat_delay(12_000.0, 0.0, 0.0, 120.0).unwrap();
        assert!((delay.as_secs_f64() - 0.25).abs() < 1e-9);
        // Exactly on a beat: a full period to the next one.
        let delay = next_beat_delay(24_000.0, 0.0, 0.0, 120.0).unwrap();
        assert!((delay.as_secs_f64() - 0.5).abs() < 1e-9);
        // A non-zero origin shifts the pushed-frame mapping.
        let delay = next_beat_delay(60_000.0, 48_000.0, 0.0, 120.0).unwrap();
        assert!((delay.as_secs_f64() - 0.25).abs() < 1e-9);
        // A nonsense tempo is a blank gate, not a panic.
        assert_eq!(next_beat_delay(0.0, 0.0, 0.0, 0.0), None);
        assert_eq!(next_beat_delay(0.0, 0.0, 0.0, f64::NAN), None);
    }

    // --- Hold bookkeeping ---

    #[test]
    fn pad_holds_stack_and_release_their_own_pitches() {
        let mut state = DeckState::default();
        state.pad_down(0); // C-E-G
        state.pad_down(2); // E-G-B — E and G now doubly held
        assert_eq!(state.held_pitches(), vec![60, 64, 67, 71]);
        state.pad_up(0);
        // E and G survive pad 0's release — pad 2 still holds them.
        assert_eq!(state.held_pitches(), vec![64, 67, 71]);
        state.pad_up(2);
        assert!(state.held_pitches().is_empty());
    }

    #[test]
    fn a_key_change_mid_hold_still_releases_the_original_pitches() {
        let mut state = DeckState::default();
        state.pad_down(0); // C major triad
        state.perf.key = 2; // performer re-keys to D mid-hold
        state.pad_up(0); // must release C-E-G, not D's triad
        assert!(state.held_pitches().is_empty());
    }

    #[test]
    fn keyboard_notes_snap_on_press_and_release_by_raw_pitch() {
        let mut state = DeckState::default();
        state.key_down(63); // Eb snaps to D in C major
        assert_eq!(state.held_pitches(), vec![62]);
        state.perf.key = 4; // re-key mid-hold
        state.key_up(63); // the release still finds the D it pressed
        assert!(state.held_pitches().is_empty());
    }

    #[test]
    fn a_repeated_pad_down_without_a_release_does_not_leak_holds() {
        let mut state = DeckState::default();
        state.pad_down(0);
        state.pad_down(0); // dropped release — replaces, never stacks
        state.pad_up(0);
        assert!(state.held_pitches().is_empty());
    }

    #[test]
    fn clear_holds_drops_state_but_keeps_the_performance_config() {
        let mut state = DeckState::default();
        state.perf.armed = true;
        state.perf.key = 9;
        state.pad_down(0);
        state.key_down(65);
        state.sent = vec![60];
        state.clear_holds();
        assert!(state.held_pitches().is_empty());
        assert!(state.sent.is_empty());
        assert!(state.perf.armed);
        assert_eq!(state.perf.key, 9);
    }
}
