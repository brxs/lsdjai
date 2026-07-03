//! Beat detection (ADR-0025): a pure, incremental tempo estimator over a
//! deck's PCM feed, and the honesty gates in front of it — the estimator
//! must say nothing rather than a wrong number.
//!
//! This is a port of the corpus-calibrated `frontend/src/audio/beat.ts`
//! plus the anchor-agreement layer that lived in `useDeck`. Every constant
//! is a *measurement* traced to the spike corpus (ADR-0010,
//! docs/spike-beat-detection.md); the port does not get to re-pick them,
//! and the corpus regression below is the cutover gate (ADR-0025). To keep
//! the measured margins, the arithmetic mirrors the JS original: envelopes
//! are stored as f32 (`Float32Array`) and read back rounded, while every
//! accumulation and transcendental runs in f64 (JS numbers).
//!
//! Shape: an onset envelope (half-wave-rectified log-energy flux per hop)
//! autocorrelated over the DJ tempo range; the best lag wins by a comb
//! score (a true beat period also correlates at its double) under a mild
//! log-normal prior centred near club tempo. Confidence is the raw
//! autocorrelation coefficient at the winning lag — periodicity, not prior.

/// One estimator reading. `anchor_frame` is the pushed-frame index of the
/// most recent beat (M20): a recency-weighted fold of the onset envelope by
/// the period, absent when the fold is incoherent — phase honesty mirrors
/// the gate's.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BeatEstimate {
    pub bpm: f64,
    pub confidence: f64,
    pub anchor_frame: Option<f64>,
}

const HOP_FRAMES: usize = 512;
const WINDOW_SECONDS: f64 = 12.0;
const MIN_SECONDS: f64 = 6.0;
const MIN_BPM: f64 = 60.0;
const MAX_BPM: f64 = 200.0;
/// Band-split flux (one-pole crossovers): drum onsets concentrate in
/// distinct bands — kick in the lows, hats in the highs — so per-band
/// log-flux keeps a beat visible against sustained content that masks it
/// at full bandwidth (measured on the spike corpus).
const LOW_CROSSOVER_HZ: f64 = 200.0;
const HIGH_CROSSOVER_HZ: f64 = 4000.0;
/// Octave ties break toward this tempo (log-normal prior).
const PRIOR_CENTER_BPM: f64 = 120.0;
const PRIOR_OCTAVE_SIGMA: f64 = 0.7;
const EPS: f64 = 1e-10;
/// Envelope variance below this is not rhythm. Flux lives in log-energy
/// units, so the floor is volume-invariant.
const MIN_FLUX_VARIANCE: f64 = 1e-4;
/// Smoothing spreads each onset across neighbouring hops so half-integer
/// lags (150 bpm = 37.5 hops) still correlate.
const SMOOTHING: [f64; 5] = [0.25, 0.5, 1.0, 0.5, 0.25];
/// The anchor fold must concentrate at least this hard before a beat phase
/// is reported (the meter's honesty floor, M20).
const MIN_ANCHOR_RESULTANT: f64 = 0.25;

fn tempo_prior(bpm: f64) -> f64 {
    let octaves = (bpm / PRIOR_CENTER_BPM).log2();
    (-0.5 * (octaves / PRIOR_OCTAVE_SIGMA).powi(2)).exp()
}

/// The incremental estimator. Feed interleaved stereo f32 — the deck wire
/// format — via [`BeatTracker::push`]; read [`BeatTracker::estimate`] at
/// most ~once per second; [`BeatTracker::reset`] on stream discontinuities.
pub struct BeatTracker {
    hop_seconds: f64,
    capacity: usize,
    flux: Vec<f32>,
    /// The low band's LINEAR energy rise, for the beat anchor (M20):
    /// offbeat hats put full-band onsets at half-period positions and
    /// cancel a fold — linear low-band rise is the honest kick detector.
    low_flux: Vec<f32>,
    previous_low_energy: Option<f64>,
    head: usize,
    filled: usize,
    low_alpha: f64,
    high_alpha: f64,
    low_state: f64,
    high_state: f64,
    hop_energy: [f64; 3],
    hop_fill: usize,
    previous_log_energy: Option<[f64; 3]>,
    /// Total flux hops written since reset — maps window indices onto
    /// pushed-frame time for the beat anchor (M20).
    hops_pushed: u64,
}

impl BeatTracker {
    pub fn new(sample_rate: f64) -> Self {
        let hop_seconds = HOP_FRAMES as f64 / sample_rate;
        let capacity = ((WINDOW_SECONDS / hop_seconds).round() as usize).max(16);
        BeatTracker {
            hop_seconds,
            capacity,
            flux: vec![0.0; capacity],
            low_flux: vec![0.0; capacity],
            previous_low_energy: None,
            head: 0,
            filled: 0,
            low_alpha: 1.0 - (-2.0 * std::f64::consts::PI * LOW_CROSSOVER_HZ / sample_rate).exp(),
            high_alpha: 1.0 - (-2.0 * std::f64::consts::PI * HIGH_CROSSOVER_HZ / sample_rate).exp(),
            low_state: 0.0,
            high_state: 0.0,
            hop_energy: [0.0; 3],
            hop_fill: 0,
            previous_log_energy: None,
            hops_pushed: 0,
        }
    }

    fn push_hop(&mut self) {
        let log_energy = [
            (self.hop_energy[0] / HOP_FRAMES as f64 + EPS).ln(),
            (self.hop_energy[1] / HOP_FRAMES as f64 + EPS).ln(),
            (self.hop_energy[2] / HOP_FRAMES as f64 + EPS).ln(),
        ];
        let low_energy = self.hop_energy[0] / HOP_FRAMES as f64;
        if let Some(previous) = self.previous_log_energy {
            let mut rise = 0.0f64;
            for band in 0..log_energy.len() {
                rise += (log_energy[band] - previous[band]).max(0.0);
            }
            self.flux[self.head] = rise as f32;
            self.low_flux[self.head] = match self.previous_low_energy {
                None => 0.0,
                Some(p) => (low_energy - p).max(0.0) as f32,
            };
            self.head = (self.head + 1) % self.capacity;
            self.filled = (self.filled + 1).min(self.capacity);
            self.hops_pushed += 1;
        }
        // Tracked outside the guard so both envelopes warm up on the same
        // hop — the first written low_flux is a real rise, not a zero.
        self.previous_low_energy = Some(low_energy);
        self.previous_log_energy = Some(log_energy);
    }

    /// Feed interleaved stereo float32 — the deck wire format.
    pub fn push(&mut self, samples: &[f32]) {
        for pair in samples.chunks_exact(2) {
            let mono = (pair[0] as f64 + pair[1] as f64) / 2.0;
            self.low_state += self.low_alpha * (mono - self.low_state);
            self.high_state += self.high_alpha * (mono - self.high_state);
            let low = self.low_state;
            let mid = self.high_state - self.low_state;
            let high = mono - self.high_state;
            self.hop_energy[0] += low * low;
            self.hop_energy[1] += mid * mid;
            self.hop_energy[2] += high * high;
            self.hop_fill += 1;
            if self.hop_fill == HOP_FRAMES {
                self.push_hop();
                self.hop_energy = [0.0; 3];
                self.hop_fill = 0;
            }
        }
    }

    /// Latest estimate, or `None` while there is too little signal.
    pub fn estimate(&self) -> Option<BeatEstimate> {
        if (self.filled as f64) * self.hop_seconds < MIN_SECONDS {
            return None;
        }
        // Linearise the ring oldest-first, smooth, then remove the mean.
        let n = self.filled;
        let start = (self.head + self.capacity - self.filled) % self.capacity;
        let mut raw = vec![0.0f32; n];
        for (i, value) in raw.iter_mut().enumerate() {
            *value = self.flux[(start + i) % self.capacity];
        }
        let mut x = vec![0.0f32; n];
        let half = (SMOOTHING.len() as isize - 1) / 2;
        let mut mean = 0.0f64;
        for i in 0..n {
            let mut sum = 0.0f64;
            let mut weight = 0.0f64;
            for (k, smooth) in SMOOTHING.iter().enumerate() {
                let j = i as isize + k as isize - half;
                if j < 0 || j >= n as isize {
                    continue;
                }
                sum += raw[j as usize] as f64 * smooth;
                weight += smooth;
            }
            x[i] = (sum / weight) as f32;
            mean += x[i] as f64;
        }
        mean /= n as f64;
        let mut r0 = 0.0f64;
        for value in x.iter_mut() {
            *value = (*value as f64 - mean) as f32;
            r0 += *value as f64 * *value as f64;
        }
        // A flat envelope (silence, a steady tone, a beatless pad) has no
        // rhythm worth reporting.
        if r0 / (n as f64) < MIN_FLUX_VARIANCE {
            return None;
        }

        let lag_min = ((60.0 / (MAX_BPM * self.hop_seconds)).floor() as usize).max(2);
        let lag_max = (n - 2).min((60.0 / (MIN_BPM * self.hop_seconds)).ceil() as usize);
        if lag_max <= lag_min {
            return None;
        }
        // Coefficients run to 2×lag_max so every candidate can consult its
        // harmonic; unbiased normalisation keeps long lags honest.
        let lag_top = (2 * lag_max).min(n - 2);
        let mut coeff = vec![0.0f32; lag_top + 1];
        for lag in lag_min..=lag_top {
            let mut sum = 0.0f64;
            for i in 0..(n - lag) {
                sum += x[i] as f64 * x[i + lag] as f64;
            }
            coeff[lag] = (sum / (n - lag) as f64 / (r0 / n as f64)) as f32;
        }

        let mut best_lag = 0usize;
        let mut best_score = f64::NEG_INFINITY;
        for lag in lag_min..=lag_max {
            let harmonic = if 2 * lag <= lag_top {
                coeff[2 * lag] as f64
            } else {
                0.0
            };
            // A candidate whose HALF lag also correlates is the octave-down
            // alias of a faster beat — penalise it so the true tempo wins
            // (the prior alone can't break this tie).
            let lower = lag / 2;
            let subharmonic = if lower >= lag_min {
                (coeff[lower] as f64 + coeff[(lower + 1).min(lag_top)] as f64) / 2.0
            } else {
                0.0
            };
            let score = (coeff[lag] as f64 + 0.5 * harmonic - 0.5 * subharmonic)
                * tempo_prior(60.0 / (lag as f64 * self.hop_seconds));
            if score > best_score {
                best_score = score;
                best_lag = lag;
            }
        }
        if best_lag == 0 {
            return None;
        }

        // Parabolic interpolation for sub-hop lag resolution (±5% per hop
        // at club tempo would otherwise swamp the ±2% target). best_lag+1
        // stays in bounds at real parameters (lag_top ≥ 2·lag_max whenever
        // the 6 s minimum window holds at 48 kHz); guard anyway.
        let gamma = *coeff.get(best_lag + 1)? as f64;
        let alpha = coeff[best_lag - 1] as f64;
        let beta = coeff[best_lag] as f64;
        let denominator = alpha - 2.0 * beta + gamma;
        let shift = if denominator == 0.0 {
            0.0
        } else {
            (0.5 * (alpha - gamma) / denominator).clamp(-0.5, 0.5)
        };
        let bpm = 60.0 / ((best_lag as f64 + shift) * self.hop_seconds);
        let confidence = beta.clamp(0.0, 1.0);

        // Beat anchor (M20): fold the window's LOW-band onset energy by the
        // period — the kick carries the phase — recency-weighted (half-life
        // ~4 beats) so the phase tracks where the beat is NOW rather than
        // averaging the whole window.
        let period_hops = best_lag as f64 + shift;
        let tau = 4.0 * period_hops;
        let mut ax = 0.0f64;
        let mut ay = 0.0f64;
        let mut aw = 0.0f64;
        for i in 0..n {
            let low = self.low_flux[(start + i) % self.capacity] as f64;
            let weight = if low > 0.0 {
                low * ((i as f64 - n as f64) / tau).exp()
            } else {
                0.0
            };
            if weight == 0.0 {
                continue;
            }
            let global_hop = self.hops_pushed as f64 - n as f64 + i as f64;
            let angle = 2.0 * std::f64::consts::PI * ((global_hop / period_hops) % 1.0);
            ax += angle.cos() * weight;
            ay += angle.sin() * weight;
            aw += weight;
        }
        let mut anchor_frame = None;
        if aw > EPS && ax.hypot(ay) / aw >= MIN_ANCHOR_RESULTANT {
            let phase = (ay.atan2(ax) / (2.0 * std::f64::consts::PI) + 1.0) % 1.0;
            let beats_to_now = (self.hops_pushed as f64 / period_hops - phase).floor();
            anchor_frame = Some((beats_to_now + phase) * period_hops * HOP_FRAMES as f64);
        }
        Some(BeatEstimate {
            bpm,
            confidence,
            anchor_frame,
        })
    }

    /// Drop accumulated signal (stream reset / model switch).
    pub fn reset(&mut self) {
        self.head = 0;
        self.filled = 0;
        self.low_state = 0.0;
        self.high_state = 0.0;
        self.hop_energy = [0.0; 3];
        self.hop_fill = 0;
        self.previous_log_energy = None;
        self.hops_pushed = 0;
        self.low_flux.fill(0.0);
        self.previous_low_energy = None;
    }
}

/// The honesty gate: a BPM is shown only after [`GATE_STABLE_COUNT`]
/// consecutive confident estimates agreeing within [`GATE_TOLERANCE`].
/// Acquisition is strict; once showing, a single unconfident estimate is
/// ridden out (generative music breathes, and re-acquiring costs 3+ s) —
/// the second consecutive miss drops the readout.
pub const GATE_MIN_CONFIDENCE: f64 = 0.4;
pub const GATE_STABLE_COUNT: usize = 3;
pub const GATE_TOLERANCE: f64 = 0.04;
pub const GATE_GRACE_MISSES: u32 = 1;

/// A confident estimate at a near-exact half or double of the anchor is
/// the same rhythm read at another metrical level — fold it onto the
/// anchor so octave-flapping reads as the agreement it is.
fn fold_octave(bpm: f64, anchor: f64) -> f64 {
    for factor in [0.5, 2.0] {
        if (bpm * factor - anchor).abs() <= anchor * GATE_TOLERANCE {
            return bpm * factor;
        }
    }
    bpm
}

pub struct BeatGate {
    recent: Vec<f64>,
    displayed: Option<f64>,
    misses: u32,
    unstable: usize,
}

impl Default for BeatGate {
    fn default() -> Self {
        Self::new()
    }
}

impl BeatGate {
    pub fn new() -> Self {
        BeatGate {
            recent: Vec::new(),
            displayed: None,
            misses: 0,
            unstable: 0,
        }
    }

    /// Feed the latest estimate; returns what may be displayed now.
    pub fn push(&mut self, estimate: Option<BeatEstimate>) -> Option<f64> {
        let estimate = match estimate {
            Some(e) if e.confidence >= GATE_MIN_CONFIDENCE => e,
            _ => {
                self.recent.clear();
                self.misses += 1;
                if self.misses > GATE_GRACE_MISSES {
                    self.displayed = None;
                }
                return self.displayed;
            }
        };
        self.misses = 0;
        let anchor = self.displayed.or_else(|| self.recent.last().copied());
        self.recent.push(match anchor {
            None => estimate.bpm,
            Some(anchor) => fold_octave(estimate.bpm, anchor),
        });
        if self.recent.len() > GATE_STABLE_COUNT {
            self.recent.remove(0);
        }
        if self.recent.len() < GATE_STABLE_COUNT {
            return self.displayed;
        }
        let mut sorted = self.recent.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).expect("gate bpm values are finite"));
        let median = sorted[sorted.len() / 2];
        let stable = sorted[sorted.len() - 1] - sorted[0] <= median * GATE_TOLERANCE;
        if stable {
            // Hysteresis: successive windows jitter by fractions of a bpm;
            // a locked readout holds still (and the synced echo's delay
            // stays put) until the median genuinely moves.
            match self.displayed {
                Some(displayed) if (median - displayed).abs() <= displayed * GATE_TOLERANCE => {}
                _ => self.displayed = Some(median),
            }
            self.unstable = 0;
        } else {
            // Confident but disagreeing: hold briefly (a tempo change is
            // locking in), but a persistent quarrel means we no longer know
            // the tempo — showing the old number would be a lie.
            self.unstable += 1;
            if self.unstable >= GATE_STABLE_COUNT {
                self.displayed = None;
            }
        }
        self.displayed
    }

    pub fn current(&self) -> Option<f64> {
        self.displayed
    }

    /// Back to blank instantly (stream reset).
    pub fn reset(&mut self) {
        self.recent.clear();
        self.displayed = None;
        self.misses = 0;
        self.unstable = 0;
    }
}

/// The published live beat clock: the pushed-frame index of a beat and the
/// gated tempo it belongs to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LiveBeat {
    pub anchor_frame: f64,
    pub bpm: f64,
}

/// The anchor-agreement gate (M20, formerly in `useDeck`): the live beat
/// clock is exposed only while the tempo gate shows AND consecutive
/// anchors agree modulo the period. Generative music breathes, so a single
/// miss — an incoherent fold or one contradicting anchor — rides out on
/// the held clock, which stays valid modulo the period while the tempo
/// holds; the second consecutive miss drops the meter, and a blank tempo
/// gate drops it instantly.
pub struct AnchorGate {
    sample_rate: f64,
    candidate: Option<f64>,
    misses: u32,
    live: Option<LiveBeat>,
}

impl AnchorGate {
    pub fn new(sample_rate: f64) -> Self {
        AnchorGate {
            sample_rate,
            candidate: None,
            misses: 0,
            live: None,
        }
    }

    /// Feed the gate's displayed tempo and the estimate's anchor; returns
    /// the live clock that may be published now.
    pub fn push(&mut self, displayed: Option<f64>, anchor_frame: Option<f64>) -> Option<LiveBeat> {
        match (displayed, anchor_frame) {
            (None, _) => {
                self.candidate = None;
                self.misses = 0;
                self.live = None;
            }
            (Some(_), None) => {
                self.candidate = None;
                self.miss();
            }
            (Some(displayed), Some(anchor)) => {
                let period_frames = (60.0 / displayed) * self.sample_rate;
                let previous = self.candidate;
                self.candidate = Some(anchor);
                if let Some(previous) = previous {
                    let gap = (((anchor - previous) % period_frames) + period_frames)
                        % period_frames;
                    if gap.min(period_frames - gap) <= period_frames * 0.15 {
                        self.misses = 0;
                        self.live = Some(LiveBeat {
                            anchor_frame: anchor,
                            bpm: displayed,
                        });
                    } else {
                        self.miss();
                    }
                }
            }
        }
        self.live
    }

    fn miss(&mut self) {
        self.misses += 1;
        if self.misses > 1 {
            self.live = None;
        }
    }

    pub fn current(&self) -> Option<LiveBeat> {
        self.live
    }

    pub fn reset(&mut self) {
        self.candidate = None;
        self.misses = 0;
        self.live = None;
    }
}

/// Offline pass for a decoded track (M19, ADR-0013/0030): stream the buffer
/// through a fresh tracker and gate at the live cadence — one estimate per
/// simulated second — so a track clears the same honesty bar as the stream,
/// just faster than real time. One number per track: a piece that drifts
/// mid-way keeps its last stable reading (the body is what gets mixed, not
/// the outro).
pub fn track_bpm(left: &[f32], right: &[f32], sample_rate: f64) -> Option<f64> {
    let mut tracker = BeatTracker::new(sample_rate);
    let mut gate = BeatGate::new();
    let mut last_stable = None;
    let chunk_frames = sample_rate as usize; // one second per push, the wire cadence
    let mut interleaved = Vec::with_capacity(chunk_frames * 2);
    let mut start = 0usize;
    while start < left.len() {
        let end = (start + chunk_frames).min(left.len());
        interleaved.clear();
        for frame in start..end {
            interleaved.push(left[frame]);
            interleaved.push(right[frame]);
        }
        tracker.push(&interleaved);
        if let Some(gated) = gate.push(tracker.estimate()) {
            last_stable = Some(gated);
        }
        start += chunk_frames;
    }
    last_stable
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! Deterministic rhythm fixtures, ported from
    //! `frontend/src/test/clickTrack.ts` — the same mulberry32 stream and
    //! interleaved-stereo caricatures, bit-compatible with the TS tests.

    /// Deterministic noise (mulberry32) — tests must not use a real RNG.
    pub fn noise_source(seed: u32) -> impl FnMut() -> f64 {
        let mut state = seed;
        move || {
            state = state.wrapping_add(0x6d2b_79f5);
            let mut t = (state ^ (state >> 15)).wrapping_mul(1 | state);
            t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
            (((t ^ (t >> 14)) as f64) / 4_294_967_296.0) * 2.0 - 1.0
        }
    }

    /// Interleaved stereo: decaying noise bursts on every beat over a
    /// quiet noise floor.
    pub fn click_track(bpm: f64, seconds: f64, sample_rate: f64, seed: u32) -> Vec<f32> {
        let mut noise = noise_source(seed);
        let frames = (seconds * sample_rate).round() as usize;
        let beat_period = ((60.0 / bpm) * sample_rate).round() as usize;
        let burst_frames = (0.02 * sample_rate).round() as usize;
        let mut out = vec![0.0f32; frames * 2];
        for i in 0..frames {
            let since_beat = i % beat_period;
            let mut sample = noise() * 0.01;
            if since_beat < burst_frames {
                sample += noise() * 0.8 * (1.0 - since_beat as f64 / burst_frames as f64);
            }
            out[2 * i] = sample as f32;
            out[2 * i + 1] = sample as f32;
        }
        out
    }

    /// Four-on-the-floor caricature with offbeat hats (M20): a low thump on
    /// every beat, a brighter noise tick half a period later — the fixture
    /// that catches full-band fold cancellation.
    pub fn kick_hat_track(bpm: f64, seconds: f64, sample_rate: f64, seed: u32) -> Vec<f32> {
        let mut noise = noise_source(seed);
        let frames = (seconds * sample_rate).round() as usize;
        let beat_period = ((60.0 / bpm) * sample_rate).round() as usize;
        let half = (beat_period as f64 / 2.0).round() as usize;
        let kick_frames = (0.06 * sample_rate).round() as usize;
        let hat_frames = (0.015 * sample_rate).round() as usize;
        let mut out = vec![0.0f32; frames * 2];
        for i in 0..frames {
            let since_beat = i % beat_period;
            let mut sample = noise() * 0.005;
            if since_beat < kick_frames {
                sample += (2.0 * std::f64::consts::PI * 60.0 * since_beat as f64
                    / sample_rate)
                    .sin()
                    * 0.8
                    * (1.0 - since_beat as f64 / kick_frames as f64);
            }
            let since_hat = (since_beat + beat_period - half) % beat_period;
            if since_hat < hat_frames {
                sample += noise() * 0.9 * (1.0 - since_hat as f64 / hat_frames as f64);
            }
            out[2 * i] = sample as f32;
            out[2 * i + 1] = sample as f32;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    //! The behavioural contract, ported from `beat.test.ts` — same
    //! fixtures, same assertions, same tolerances.

    use super::fixtures::{click_track, kick_hat_track, noise_source};
    use super::*;

    const SAMPLE_RATE: f64 = 48_000.0;
    const CHUNK_SAMPLES: usize = 1920 * 2; // the deck wire chunk: 40 ms

    fn feed(tracker: &mut BeatTracker, samples: &[f32]) {
        for chunk in samples.chunks(CHUNK_SAMPLES) {
            tracker.push(chunk);
        }
    }

    fn clicks(bpm: f64, seconds: f64) -> Vec<f32> {
        click_track(bpm, seconds, SAMPLE_RATE, 1)
    }

    #[test]
    fn nails_click_trains_within_two_percent() {
        for bpm in [90.0, 120.0, 128.0, 150.0, 174.0] {
            let mut tracker = BeatTracker::new(SAMPLE_RATE);
            feed(&mut tracker, &clicks(bpm, 12.0));
            let estimate = tracker.estimate().expect("click train estimates");
            assert!(
                (estimate.bpm - bpm).abs() / bpm < 0.02,
                "{bpm} bpm read as {}",
                estimate.bpm
            );
            assert!(estimate.confidence > GATE_MIN_CONFIDENCE);
        }
    }

    #[test]
    fn returns_none_before_enough_audio() {
        let mut tracker = BeatTracker::new(SAMPLE_RATE);
        feed(&mut tracker, &clicks(128.0, 3.0));
        assert!(tracker.estimate().is_none());
    }

    #[test]
    fn low_confidence_on_beatless_noise() {
        let mut tracker = BeatTracker::new(SAMPLE_RATE);
        let mut noise = noise_source(7);
        let samples: Vec<f32> = (0..12 * SAMPLE_RATE as usize * 2)
            .map(|_| (noise() * 0.5) as f32)
            .collect();
        feed(&mut tracker, &samples);
        // Whatever lag wins on noise, it must not pass the gate.
        let estimate = tracker.estimate();
        assert!(estimate.is_none_or(|e| e.confidence < GATE_MIN_CONFIDENCE));
    }

    #[test]
    fn none_on_silence_and_low_confidence_on_a_steady_tone() {
        let mut silent = BeatTracker::new(SAMPLE_RATE);
        feed(&mut silent, &vec![0.0f32; 12 * SAMPLE_RATE as usize * 2]);
        assert!(silent.estimate().is_none());

        let mut tone_tracker = BeatTracker::new(SAMPLE_RATE);
        let mut tone = vec![0.0f32; 12 * SAMPLE_RATE as usize * 2];
        for i in 0..tone.len() / 2 {
            let sample =
                ((2.0 * std::f64::consts::PI * 220.0 * i as f64 / SAMPLE_RATE).sin() * 0.5) as f32;
            tone[2 * i] = sample;
            tone[2 * i + 1] = sample;
        }
        feed(&mut tone_tracker, &tone);
        let estimate = tone_tracker.estimate();
        assert!(estimate.is_none_or(|e| e.confidence < GATE_MIN_CONFIDENCE));
    }

    #[test]
    fn reset_drops_the_accumulated_stream() {
        let mut tracker = BeatTracker::new(SAMPLE_RATE);
        feed(&mut tracker, &clicks(128.0, 12.0));
        assert!(tracker.estimate().is_some());
        tracker.reset();
        assert!(tracker.estimate().is_none());
    }

    #[test]
    fn follows_a_tempo_change_once_the_window_turns_over() {
        let mut tracker = BeatTracker::new(SAMPLE_RATE);
        feed(&mut tracker, &clicks(100.0, 12.0));
        let first = tracker.estimate().expect("first tempo estimates");
        assert!((first.bpm - 100.0).abs() < 0.5);
        // 14 s of the new tempo flushes the 12 s window completely.
        feed(&mut tracker, &click_track(150.0, 14.0, SAMPLE_RATE, 2));
        let second = tracker.estimate().expect("second tempo estimates");
        assert!((second.bpm - 150.0).abs() / 150.0 < 0.02);
    }

    fn confident(bpm: f64) -> Option<BeatEstimate> {
        Some(BeatEstimate {
            bpm,
            confidence: 0.8,
            anchor_frame: None,
        })
    }

    #[test]
    fn gate_shows_only_after_consecutive_agreeing_estimates() {
        let mut gate = BeatGate::new();
        assert_eq!(gate.push(confident(128.0)), None);
        assert_eq!(gate.push(confident(128.5)), None);
        assert_eq!(gate.push(confident(127.8)), Some(128.0));
        assert_eq!(gate.current(), Some(128.0));
    }

    #[test]
    fn gate_rides_out_one_unconfident_estimate_drops_on_the_second() {
        // Deliberate: generative music breathes, and re-acquisition costs
        // 3+ s — one second of hold is not a lie, two misses in a row is.
        let mut gate = BeatGate::new();
        gate.push(confident(128.0));
        gate.push(confident(128.0));
        gate.push(confident(128.0));
        assert_eq!(gate.current(), Some(128.0));
        let weak = Some(BeatEstimate {
            bpm: 128.0,
            confidence: GATE_MIN_CONFIDENCE - 0.01,
            anchor_frame: None,
        });
        assert_eq!(gate.push(weak), Some(128.0));
        assert_eq!(gate.push(weak), None);
        assert_eq!(gate.current(), None);
    }

    #[test]
    fn gate_refuses_unstable_estimates_even_when_confident() {
        let mut gate = BeatGate::new();
        gate.push(confident(128.0));
        gate.push(confident(150.0));
        assert_eq!(gate.push(confident(100.0)), None);
    }

    #[test]
    fn gate_holds_through_a_tempo_change_then_locks_on() {
        let mut gate = BeatGate::new();
        gate.push(confident(128.0));
        gate.push(confident(128.0));
        gate.push(confident(128.0));
        // The window straddles old and new estimates: hold the old number.
        assert_eq!(gate.push(confident(150.0)), Some(128.0));
        assert_eq!(gate.push(confident(150.0)), Some(128.0));
        // Three new-tempo estimates agree: the display follows.
        assert_eq!(gate.push(confident(150.0)), Some(150.0));
    }

    #[test]
    fn gate_drops_a_held_readout_when_estimates_keep_quarrelling() {
        let mut gate = BeatGate::new();
        gate.push(confident(128.0));
        gate.push(confident(128.0));
        gate.push(confident(128.0));
        assert_eq!(gate.push(confident(150.0)), Some(128.0));
        assert_eq!(gate.push(confident(100.0)), Some(128.0));
        assert_eq!(gate.push(confident(170.0)), None);
    }

    #[test]
    fn gate_holds_still_while_estimates_jitter_within_tolerance() {
        let mut gate = BeatGate::new();
        gate.push(confident(128.0));
        gate.push(confident(128.0));
        gate.push(confident(128.0));
        assert_eq!(gate.current(), Some(128.0));
        // Successive windows never agree to the last float; the display
        // (and the synced echo's clock) must not chase the jitter.
        gate.push(confident(128.4));
        gate.push(confident(127.6));
        gate.push(confident(128.3));
        assert_eq!(gate.current(), Some(128.0));
        // A genuine move beyond tolerance still follows.
        gate.push(confident(140.0));
        gate.push(confident(140.2));
        gate.push(confident(139.8));
        let held = gate.current().expect("new tempo locks");
        assert!((held - 140.0).abs() < 0.5);
    }

    #[test]
    fn gate_folds_octave_flapping_onto_the_held_tempo() {
        // Half/double of the same beat structure is the same answer at
        // another metrical level; flapping must read as agreement.
        let mut gate = BeatGate::new();
        gate.push(confident(95.0));
        gate.push(confident(190.0));
        assert!(gate.push(confident(95.5)).is_some());
        gate.push(confident(190.0));
        gate.push(confident(95.0));
        assert!(gate.current().is_some());
    }

    #[test]
    fn gate_treats_none_estimates_like_unconfident_ones() {
        let mut gate = BeatGate::new();
        gate.push(confident(128.0));
        gate.push(confident(128.0));
        gate.push(confident(128.0));
        assert_eq!(gate.push(None), Some(128.0));
        assert_eq!(gate.push(None), None);
        assert_eq!(gate.current(), None);
    }

    fn deinterleave(samples: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let frames = samples.len() / 2;
        let mut left = vec![0.0f32; frames];
        let mut right = vec![0.0f32; frames];
        for i in 0..frames {
            left[i] = samples[2 * i];
            right[i] = samples[2 * i + 1];
        }
        (left, right)
    }

    #[test]
    fn track_bpm_finds_the_tempo_of_a_decoded_track_offline() {
        let (left, right) = deinterleave(&clicks(128.0, 24.0));
        let bpm = track_bpm(&left, &right, SAMPLE_RATE).expect("track estimates");
        assert!((bpm - 128.0).abs() <= 128.0 * 0.05);
    }

    #[test]
    fn track_bpm_stays_honest_on_a_beatless_track() {
        let silence = vec![0.0f32; SAMPLE_RATE as usize * 15];
        assert!(track_bpm(&silence, &silence, SAMPLE_RATE).is_none());
    }

    #[test]
    fn track_bpm_keeps_the_body_reading_through_a_beatless_outro() {
        let (mut left, mut right) = deinterleave(&clicks(128.0, 24.0));
        left.extend(std::iter::repeat_n(0.0f32, SAMPLE_RATE as usize * 8));
        right.extend(std::iter::repeat_n(0.0f32, SAMPLE_RATE as usize * 8));
        let bpm = track_bpm(&left, &right, SAMPLE_RATE).expect("body reading holds");
        assert!((bpm - 128.0).abs() <= 128.0 * 0.05);
    }

    #[test]
    fn anchors_the_most_recent_beat_on_the_click_lattice() {
        let mut tracker = BeatTracker::new(SAMPLE_RATE);
        feed(&mut tracker, &clicks(128.0, 16.0));
        let estimate = tracker.estimate().expect("click train estimates");
        let anchor = estimate.anchor_frame.expect("anchor reported");
        let period_frames = (60.0 / 128.0) * SAMPLE_RATE;
        // Clicks land on period multiples from stream start.
        let phase = (anchor % period_frames) / period_frames;
        assert!(phase.min(1.0 - phase) <= 0.12, "phase {phase}");
        // And the anchor is recent — the fold tracks now, not the window
        // average.
        assert!(anchor > 16.0 * SAMPLE_RATE - 3.0 * period_frames);
        assert!(anchor <= 16.0 * SAMPLE_RATE);
    }

    #[test]
    fn anchors_on_the_kicks_through_offbeat_hats() {
        let mut tracker = BeatTracker::new(SAMPLE_RATE);
        feed(&mut tracker, &kick_hat_track(128.0, 16.0, SAMPLE_RATE, 1));
        let estimate = tracker.estimate().expect("kick-hat estimates");
        let anchor = estimate.anchor_frame.expect("anchor reported");
        let period_frames = (60.0 / 128.0) * SAMPLE_RATE;
        let phase = (anchor % period_frames) / period_frames;
        // On the kick lattice — not half a period off on the louder hats.
        assert!(phase.min(1.0 - phase) <= 0.12, "phase {phase}");
    }

    #[test]
    fn withholds_the_anchor_when_the_fold_is_incoherent() {
        let mut tracker = BeatTracker::new(SAMPLE_RATE);
        let mut noise = noise_source(11);
        let samples: Vec<f32> = (0..SAMPLE_RATE as usize * 2 * 16)
            .map(|_| (noise() * 0.4) as f32)
            .collect();
        feed(&mut tracker, &samples);
        if let Some(estimate) = tracker.estimate() {
            assert!(estimate.anchor_frame.is_none());
        }
    }

    #[test]
    fn anchor_gate_publishes_after_two_agreeing_anchors() {
        let mut anchors = AnchorGate::new(SAMPLE_RATE);
        let period = (60.0 / 128.0) * SAMPLE_RATE;
        // First anchor is only a candidate — no previous to agree with.
        assert_eq!(anchors.push(Some(128.0), Some(period * 4.0)), None);
        let live = anchors
            .push(Some(128.0), Some(period * 5.0))
            .expect("agreeing anchors publish");
        assert_eq!(live.bpm, 128.0);
        assert_eq!(live.anchor_frame, period * 5.0);
    }

    #[test]
    fn anchor_gate_rides_out_one_miss_drops_on_the_second() {
        let mut anchors = AnchorGate::new(SAMPLE_RATE);
        let period = (60.0 / 128.0) * SAMPLE_RATE;
        anchors.push(Some(128.0), Some(period * 4.0));
        anchors.push(Some(128.0), Some(period * 5.0));
        assert!(anchors.current().is_some());
        // One incoherent fold rides out on the held clock.
        assert!(anchors.push(Some(128.0), None).is_some());
        // The second consecutive miss drops the meter.
        assert!(anchors.push(Some(128.0), None).is_none());
    }

    #[test]
    fn anchor_gate_treats_a_contradicting_anchor_as_a_miss() {
        let mut anchors = AnchorGate::new(SAMPLE_RATE);
        let period = (60.0 / 128.0) * SAMPLE_RATE;
        anchors.push(Some(128.0), Some(period * 4.0));
        anchors.push(Some(128.0), Some(period * 5.0));
        // Half a period off: a contradiction, not agreement.
        assert!(anchors.push(Some(128.0), Some(period * 6.5)).is_some());
        assert!(anchors.push(Some(128.0), Some(period * 7.0)).is_none());
    }

    #[test]
    fn anchor_gate_blanks_instantly_with_the_tempo_gate() {
        let mut anchors = AnchorGate::new(SAMPLE_RATE);
        let period = (60.0 / 128.0) * SAMPLE_RATE;
        anchors.push(Some(128.0), Some(period * 4.0));
        anchors.push(Some(128.0), Some(period * 5.0));
        assert!(anchors.current().is_some());
        assert_eq!(anchors.push(None, None), None);
        assert_eq!(anchors.current(), None);
    }
}

#[cfg(test)]
mod corpus {
    //! The ADR-0025 cutover gate: the SHIPPING estimator over the
    //! deterministic spike corpus, replayed exactly like the live feed —
    //! 40 ms chunks, one estimate through the gate per simulated second —
    //! against the locked librosa manifest. A port of
    //! `frontend/src/audio/beatCorpus.test.js`; the pass rule and metrical
    //! tolerance set are the measurement's, unchanged. Skips (loudly) when
    //! the corpus WAVs are absent.

    use std::path::{Path, PathBuf};

    use serde::Deserialize;

    use super::{BeatGate, BeatTracker};

    #[derive(Deserialize)]
    struct Entry {
        file: String,
        librosa_bpm: f64,
        expect: String,
    }

    fn corpus_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend/spike_corpus")
    }

    /// Interleaved stereo f32 from a 16-bit PCM WAV — the deck wire format
    /// (`readWav.js` semantics: mono duplicates, /32768).
    fn read_wav(path: &Path) -> (f64, Vec<f32>) {
        let mut reader = hound::WavReader::open(path)
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let spec = reader.spec();
        assert_eq!(spec.bits_per_sample, 16, "{}: not 16-bit", path.display());
        assert_eq!(
            spec.sample_format,
            hound::SampleFormat::Int,
            "{}: not PCM",
            path.display()
        );
        let raw: Vec<i16> = reader
            .samples::<i16>()
            .collect::<Result<_, _>>()
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let channels = spec.channels as usize;
        let frames = raw.len() / channels;
        let mut samples = vec![0.0f32; frames * 2];
        for i in 0..frames {
            let left = (raw[i * channels] as f64 / 32768.0) as f32;
            let right = if channels > 1 {
                (raw[i * channels + 1] as f64 / 32768.0) as f32
            } else {
                left
            };
            samples[2 * i] = left;
            samples[2 * i + 1] = right;
        }
        (spec.sample_rate as f64, samples)
    }

    /// Trackers disagree along standard metrical levels (the dnb clip's
    /// librosa tempogram has 89.3 and 119.7 nearly tied — a 4:3 relation),
    /// so accept the binary and ternary relatives, the usual tempo-eval
    /// practice. The hardware checklist's hand-count is the final arbiter.
    const METRICAL_LEVELS: [f64; 7] = [0.5, 2.0 / 3.0, 0.75, 1.0, 4.0 / 3.0, 1.5, 2.0];

    fn metrically_matches(estimate: f64, reference: f64) -> bool {
        METRICAL_LEVELS
            .iter()
            .any(|factor| (estimate * factor - reference).abs() / reference <= 0.08)
    }

    #[test]
    fn the_spike_corpus_verdicts_hold_in_rust() {
        let manifest = corpus_dir().join("manifest.json");
        if !manifest.exists() {
            eprintln!(
                "corpus not generated (backend/scripts/spike_beat_corpus.py) — skipping"
            );
            return;
        }
        let entries: Vec<Entry> = serde_json::from_str(
            &std::fs::read_to_string(&manifest).expect("manifest reads"),
        )
        .expect("manifest parses");
        assert!(!entries.is_empty(), "manifest is empty");

        for entry in &entries {
            let (sample_rate, samples) = read_wav(&corpus_dir().join(&entry.file));
            let mut tracker = BeatTracker::new(sample_rate);
            let mut gate = BeatGate::new();

            // Stream exactly like the live feed: 40 ms chunks, an estimate
            // through the gate once per second.
            let chunk = (0.04 * sample_rate).round() as usize * 2;
            let per_second = (sample_rate * 2.0).round() as usize;
            let mut since_estimate = 0usize;
            let mut displayed_seconds = 0u32;
            let mut total_seconds = 0u32;
            let mut first_shown_at: Option<u32> = None;
            let mut i = 0usize;
            while i < samples.len() {
                let end = (i + chunk).min(samples.len());
                tracker.push(&samples[i..end]);
                since_estimate += chunk;
                if since_estimate >= per_second {
                    since_estimate = 0;
                    total_seconds += 1;
                    let estimate = tracker.estimate();
                    if gate.push(estimate).is_some() {
                        displayed_seconds += 1;
                        first_shown_at.get_or_insert(total_seconds);
                    }
                }
                i += chunk;
            }

            let final_bpm = gate.current();
            println!(
                "{:<16} librosa {:>6} | shown {:>6} | displayed {}/{}s | first at {}",
                entry.file,
                entry.librosa_bpm,
                final_bpm.map_or("     —".into(), |b| format!("{b:.1}")),
                displayed_seconds,
                total_seconds,
                first_shown_at.map_or("—".into(), |s| s.to_string()),
            );

            match entry.expect.as_str() {
                "rhythmic" => {
                    let shown = final_bpm
                        .unwrap_or_else(|| panic!("{}: rhythmic style stayed blank", entry.file));
                    assert!(
                        metrically_matches(shown, entry.librosa_bpm),
                        "{}: shown {shown:.1} does not octave-match librosa {}",
                        entry.file,
                        entry.librosa_bpm
                    );
                }
                "beatless" => {
                    assert!(
                        final_bpm.is_none(),
                        "{}: beatless style displayed {:?}",
                        entry.file,
                        final_bpm
                    );
                }
                _ => {
                    // Ambiguous material: a blank is honest, a shown tempo
                    // must still sit on a metrical level of the reference.
                    if let Some(shown) = final_bpm {
                        assert!(
                            metrically_matches(shown, entry.librosa_bpm),
                            "{}: shown {shown:.1} does not octave-match librosa {}",
                            entry.file,
                            entry.librosa_bpm
                        );
                    }
                }
            }
        }
    }
}
