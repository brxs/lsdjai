//! Wait-free telemetry shared between the non-RT producer side, the RT
//! `render()` path, and any UI reader. Everything the RT path touches here is a
//! plain atomic — no locks, no allocation — so reading and updating stats never
//! blocks or perturbs the audio callback.
//!
//! Ported from the per-deck/master counters in the Spike A `rt_engine`
//! (`spike/rust-audio/engine/src/bin/rt_engine.rs`), reshaped so the engine owns
//! one `Telemetry` and the public API exposes getters (later slices add more
//! meters without changing the handoff).

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

use crate::DECK_COUNT;

/// Master peak meter granularity: peaks are stored as the bit pattern of an
/// `f32` magnitude in an `AtomicU32`-shaped `AtomicUsize`-free way. To stay
/// dependency-light we keep the peak as fixed-point millis of full scale
/// (0..=1000+) in an `AtomicU64`, which is monotone-max friendly and lossless
/// enough for a meter. Read back via `master_peak()`.
const PEAK_SCALE: f32 = 1_000_000.0;

/// Unity (no gain reduction) as fixed-point millis-of-full-scale: `1.0 ×
/// PEAK_SCALE`. The gain-reduction meter stores the deepest *applied* linear
/// gain (monotone-min) and seeds/clears to this.
const GR_FULL_SCALE: u64 = PEAK_SCALE as u64;

/// Per-deck and master statistics. One instance per `Engine`. All fields are
/// atomics so the RT `render()` updates them without a lock and a UI thread can
/// read them at any time.
#[derive(Debug)]
pub struct Telemetry {
    /// Underruns counted the worklet's way: a `render()` block got fewer frames
    /// than requested from a primed ring (post-prebuffer). One counter, all
    /// decks — matches the Spike A definition and the M2 buffer-health stat.
    underruns: AtomicU64,
    /// `render()` invocations, for sanity / averaging.
    blocks: AtomicU64,
    /// Current ring fill (frames) per deck, written every block.
    fill_now: [AtomicUsize; DECK_COUNT],
    /// Min / max observed ring fill (frames) per deck, post-prebuffer.
    fill_min: [AtomicUsize; DECK_COUNT],
    fill_max: [AtomicUsize; DECK_COUNT],
    /// Has each deck crossed its prebuffer high-water mark yet? Until then,
    /// shortfalls are the expected prebuffer fill, not underruns.
    primed: [AtomicBool; DECK_COUNT],
    /// Master peak magnitude since the last `take_master_peak()`, fixed-point
    /// (× `PEAK_SCALE`). Monotone-max within a window.
    master_peak: AtomicU64,
    /// Deepest master limiter gain reduction since the last
    /// `take_master_gain_reduction()`, stored as the *applied linear gain*
    /// (× `PEAK_SCALE`) — i.e. monotone-*min* of `applied ∈ (0, 1]`. 1.0 = no
    /// reduction; smaller = more. Read back as dB (≤ 0) via the getters. Mirrors
    /// ADR-0017's `getMasterGainReduction` mixer readout, atomics-only.
    master_gr_gain: AtomicU64,
}

impl Telemetry {
    pub(crate) fn new() -> Self {
        Telemetry {
            underruns: AtomicU64::new(0),
            blocks: AtomicU64::new(0),
            fill_now: std::array::from_fn(|_| AtomicUsize::new(0)),
            fill_min: std::array::from_fn(|_| AtomicUsize::new(usize::MAX)),
            fill_max: std::array::from_fn(|_| AtomicUsize::new(0)),
            primed: std::array::from_fn(|_| AtomicBool::new(false)),
            master_peak: AtomicU64::new(0),
            // Start at unity (no reduction): GR_FULL_SCALE × PEAK_SCALE.
            master_gr_gain: AtomicU64::new(GR_FULL_SCALE),
        }
    }

    // --- RT-side writers (called only from `render()`; all wait-free) ---

    #[inline]
    pub(crate) fn note_block(&self) {
        self.blocks.fetch_add(1, Ordering::Relaxed);
    }

    #[inline]
    pub(crate) fn note_underrun(&self) {
        self.underruns.fetch_add(1, Ordering::Relaxed);
    }

    /// Mark a deck primed (its ring first reached the prebuffer high-water).
    #[inline]
    pub(crate) fn set_primed(&self, deck: usize) {
        self.primed[deck].store(true, Ordering::Relaxed);
    }

    /// Record a deck's current ring fill (frames) and fold it into min/max.
    #[inline]
    pub(crate) fn record_fill(&self, deck: usize, frames: usize) {
        self.fill_now[deck].store(frames, Ordering::Relaxed);
        update_min(&self.fill_min[deck], frames);
        update_max(&self.fill_max[deck], frames);
    }

    /// Fold a master output magnitude into the peak meter (monotone-max).
    #[inline]
    pub(crate) fn record_master_peak(&self, magnitude: f32) {
        let v = (magnitude * PEAK_SCALE) as u64;
        update_max_u64(&self.master_peak, v);
    }

    /// Fold the master limiter's applied gain (linear, `(0, 1]`; 1.0 = no
    /// reduction) into the gain-reduction meter (monotone-MIN, so the deepest
    /// reduction in the window wins). Wait-free.
    #[inline]
    pub(crate) fn record_master_gain_reduction(&self, applied_gain: f32) {
        // Clamp to (0, 1]: only reduction is meaningful; the makeup-cancelled
        // staging gain is excluded upstream so unity here means transparent.
        let g = applied_gain.clamp(0.0, 1.0);
        let v = (g * PEAK_SCALE) as u64;
        update_min_u64(&self.master_gr_gain, v);
    }

    // --- Reader-side getters (any thread; wait-free) ---

    pub fn underruns(&self) -> u64 {
        self.underruns.load(Ordering::Relaxed)
    }

    pub fn blocks(&self) -> u64 {
        self.blocks.load(Ordering::Relaxed)
    }

    /// Current ring fill (frames) for a deck.
    pub fn ring_fill(&self, deck: usize) -> usize {
        self.fill_now[deck].load(Ordering::Relaxed)
    }

    /// Min ring fill (frames) seen post-prebuffer; 0 before any reading.
    pub fn ring_fill_min(&self, deck: usize) -> usize {
        match self.fill_min[deck].load(Ordering::Relaxed) {
            usize::MAX => 0,
            v => v,
        }
    }

    /// Max ring fill (frames) seen post-prebuffer.
    pub fn ring_fill_max(&self, deck: usize) -> usize {
        self.fill_max[deck].load(Ordering::Relaxed)
    }

    pub fn primed(&self, deck: usize) -> bool {
        self.primed[deck].load(Ordering::Relaxed)
    }

    /// Read the master peak magnitude (0.0..) WITHOUT clearing it.
    pub fn master_peak(&self) -> f32 {
        self.master_peak.load(Ordering::Relaxed) as f32 / PEAK_SCALE
    }

    /// Read the master peak magnitude and reset the window to 0 — the typical
    /// meter read (UI samples this each frame). Atomic swap, wait-free.
    pub fn take_master_peak(&self) -> f32 {
        self.master_peak.swap(0, Ordering::Relaxed) as f32 / PEAK_SCALE
    }

    /// Read the deepest master limiter gain reduction in the window as dB (≤ 0;
    /// 0 when the limiter is idle), WITHOUT clearing it. Mirrors ADR-0017's
    /// `getMasterGainReduction` readout.
    pub fn master_gain_reduction_db(&self) -> f32 {
        gr_gain_to_db(self.master_gr_gain.load(Ordering::Relaxed))
    }

    /// Read the deepest gain reduction (dB, ≤ 0) and reset the window to unity —
    /// the typical meter read. Atomic swap, wait-free.
    pub fn take_master_gain_reduction_db(&self) -> f32 {
        gr_gain_to_db(self.master_gr_gain.swap(GR_FULL_SCALE, Ordering::Relaxed))
    }
}

/// Convert a stored applied-gain fixed-point value (`(0, 1] × PEAK_SCALE`) to a
/// reduction in dB (≤ 0; 0 at unity). A zero/empty store reads as 0 dB.
#[inline]
fn gr_gain_to_db(stored: u64) -> f32 {
    let gain = stored as f32 / PEAK_SCALE;
    if gain >= 1.0 || gain <= 0.0 {
        0.0
    } else {
        20.0 * gain.log10()
    }
}

#[inline]
fn update_min(a: &AtomicUsize, v: usize) {
    let mut cur = a.load(Ordering::Relaxed);
    while v < cur {
        match a.compare_exchange_weak(cur, v, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(x) => cur = x,
        }
    }
}

#[inline]
fn update_max(a: &AtomicUsize, v: usize) {
    let mut cur = a.load(Ordering::Relaxed);
    while v > cur {
        match a.compare_exchange_weak(cur, v, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(x) => cur = x,
        }
    }
}

#[inline]
fn update_max_u64(a: &AtomicU64, v: u64) {
    let mut cur = a.load(Ordering::Relaxed);
    while v > cur {
        match a.compare_exchange_weak(cur, v, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(x) => cur = x,
        }
    }
}

#[inline]
fn update_min_u64(a: &AtomicU64, v: u64) {
    let mut cur = a.load(Ordering::Relaxed);
    while v < cur {
        match a.compare_exchange_weak(cur, v, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(x) => cur = x,
        }
    }
}
