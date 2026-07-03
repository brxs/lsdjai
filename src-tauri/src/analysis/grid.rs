//! Offline beatgrid for a decoded track (M20, ADR-0014/0030): BPM plus
//! first-beat phase under a constant-tempo model, behind the M14 honesty
//! rule — a track that won't fit a grid gets `None`, never a wrong grid.
//! A port of `beatgrid.ts`; the thresholds are measurements (synthetic
//! fixtures AND real renders) and port verbatim, arithmetic mirrored like
//! the estimator's (f32 envelope storage, f64 math).
//!
//! The estimator's coarse BPM is only good to ~±1–2 %, and folding a whole
//! track with a period that far off smears a full beat of phase every
//! ~50 s — so the period is refined here: a fine rate search around the
//! coarse BPM maximising fold concentration, with the fold's spread and a
//! half-split phase agreement as the drift check.

use serde::Serialize;

/// The grid verdict: tempo and where beat 0 falls (seconds from the start).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Beatgrid {
    pub bpm: f64,
    pub first_beat_seconds: f64,
}

const HOP_FRAMES: usize = 512;
const EPS: f64 = 1e-10;
// Honesty thresholds, measured against synthetic fixtures AND real renders:
// sterile clicks fold to ~0.95, real minimal techno hit 0.97, real rolling
// techno with basslines and ghost kicks lands 0.50–0.65 — texture spreads
// the fold without making the grid wrong. The floor only asks "is there a
// coherent phase at all"; drift and incoherence are the half-split check's
// job, and beatless material never gets past the coarse gate.
const MIN_ONSETS: usize = 16;
const MIN_RESULTANT: f64 = 0.35;
/// Fine search around the coarse BPM: ±2 % covers the estimator's tolerance
/// band, steps small enough that residual smear over a 6-minute track stays
/// under a tenth of a beat.
const RATE_SEARCH: f64 = 0.02;
const RATE_STEP: f64 = 0.0005;
/// First and second half of the track must agree on phase within this
/// fraction of a period, or the tempo drifted — no grid.
const HALF_AGREEMENT: f64 = 0.15;

/// Low-band onset cutoff: the phase question is "where is the kick". A
/// four-on-the-floor with offbeat hats puts full-band onsets at phase 0 AND
/// 0.5, and folding that by the beat period cancels — the low band carries
/// the beat alone. Matches the tracker's crossover.
const LOW_CROSSOVER_HZ: f64 = 200.0;

struct Onset {
    hop: usize,
    weight: f64,
}

/// Half-wave-rectified LINEAR energy rise of the LOW band per hop — the
/// kick detector, run offline. Log flux would rate a hat rising from the
/// quiet floor as highly as a kick (ratios, not amounts); linear rise keeps
/// the 60 Hz thump ~30× ahead.
fn onset_envelope(left: &[f32], right: &[f32], sample_rate: f64) -> Vec<f32> {
    let hops = left.len() / HOP_FRAMES;
    let mut envelope = vec![0.0f32; hops];
    let alpha = 1.0 - (-2.0 * std::f64::consts::PI * LOW_CROSSOVER_HZ / sample_rate).exp();
    let mut low_state = 0.0f64;
    let mut previous: Option<f64> = None;
    for (hop, rise) in envelope.iter_mut().enumerate() {
        let mut energy = 0.0f64;
        let start = hop * HOP_FRAMES;
        for i in start..start + HOP_FRAMES {
            let mono = (left[i] as f64 + right[i] as f64) / 2.0;
            low_state += alpha * (mono - low_state);
            energy += low_state * low_state;
        }
        let mean = energy / HOP_FRAMES as f64;
        if let Some(previous) = previous {
            *rise = (mean - previous).max(0.0) as f32;
        }
        previous = Some(mean);
    }
    envelope
}

/// Local maxima above an adaptive floor, weighted by their strength.
fn pick_onsets(envelope: &[f32]) -> Vec<Onset> {
    let mut sum = 0.0f64;
    for value in envelope {
        sum += *value as f64;
    }
    let mean = sum / (envelope.len().max(1) as f64);
    let mut variance = 0.0f64;
    for value in envelope {
        variance += (*value as f64 - mean).powi(2);
    }
    let floor = mean + (variance / envelope.len().max(1) as f64).sqrt();
    let mut onsets = Vec::new();
    for hop in 1..envelope.len().saturating_sub(1) {
        let value = envelope[hop] as f64;
        if value > floor
            && value >= envelope[hop - 1] as f64
            && value > envelope[hop + 1] as f64
        {
            onsets.push(Onset { hop, weight: value });
        }
    }
    onsets
}

/// Shortest circular distance between two phases, in turns.
fn circular_distance(a: f64, b: f64) -> f64 {
    let diff = (a - b).abs() % 1.0;
    diff.min(1.0 - diff)
}

struct Fold {
    resultant: f64,
    phase: f64,
}

/// Fold the onsets by a candidate period: the weighted resultant length
/// (0 = incoherent, 1 = every onset on one phase) and the mean phase.
fn fold_resultant(onsets: &[&Onset], period_hops: f64) -> Option<Fold> {
    let mut x = 0.0f64;
    let mut y = 0.0f64;
    let mut total = 0.0f64;
    for onset in onsets {
        let angle = 2.0 * std::f64::consts::PI * ((onset.hop as f64 / period_hops) % 1.0);
        x += angle.cos() * onset.weight;
        y += angle.sin() * onset.weight;
        total += onset.weight;
    }
    if total < EPS {
        return None;
    }
    let turns = y.atan2(x) / (2.0 * std::f64::consts::PI);
    Some(Fold {
        resultant: x.hypot(y) / total,
        phase: (turns + 1.0) % 1.0,
    })
}

/// Refine `coarse` (the tempo pass's verdict — `None` refuses immediately,
/// beatless material never grows a grid) into a constant-tempo grid, or
/// refuse. The refusal numbers are logged per load, so "why no ticks?"
/// answers itself from the shell's stderr (the webview logs the verdict).
pub fn track_beatgrid(
    left: &[f32],
    right: &[f32],
    sample_rate: f64,
    coarse: Option<f64>,
) -> Option<Beatgrid> {
    let coarse_bpm = coarse?;
    let envelope = onset_envelope(left, right, sample_rate);
    let onsets = pick_onsets(&envelope);
    eprintln!("lsdj-app: beatgrid onsets {}", onsets.len());
    if onsets.len() < MIN_ONSETS {
        return None;
    }

    let hop_seconds = HOP_FRAMES as f64 / sample_rate;
    let coarse_period_hops = 60.0 / coarse_bpm / hop_seconds;
    let all: Vec<&Onset> = onsets.iter().collect();
    let mut best: Option<(f64, Fold)> = None;
    let mut rate = 1.0 - RATE_SEARCH;
    while rate <= 1.0 + RATE_SEARCH + EPS {
        let period_hops = coarse_period_hops / rate;
        if let Some(fold) = fold_resultant(&all, period_hops) {
            if best
                .as_ref()
                .is_none_or(|(_, held)| fold.resultant > held.resultant)
            {
                best = Some((period_hops, fold));
            }
        }
        rate += RATE_STEP;
    }
    let (period_hops, fold) = best?;
    eprintln!("lsdj-app: beatgrid resultant {:.3}", fold.resultant);
    if fold.resultant < MIN_RESULTANT {
        return None;
    }

    // The drift check: both halves must fold coherently ON THEIR OWN and put
    // beat 0 in the same place. A spliced tempo can satisfy the combined
    // fold (one half carries the average) and its incoherent half still
    // yields a — meaningless — mean phase, so each half owes its own
    // resultant before agreement counts.
    let midpoint = onsets[onsets.len() / 2].hop;
    let first_half: Vec<&Onset> = onsets.iter().filter(|o| o.hop < midpoint).collect();
    let second_half: Vec<&Onset> = onsets.iter().filter(|o| o.hop >= midpoint).collect();
    let first = fold_resultant(&first_half, period_hops);
    let second = fold_resultant(&second_half, period_hops);
    match (&first, &second) {
        (Some(first), Some(second)) => {
            eprintln!(
                "lsdj-app: beatgrid halves {:.3}@{:.3} {:.3}@{:.3}",
                first.resultant, first.phase, second.resultant, second.phase
            );
            if first.resultant < MIN_RESULTANT
                || second.resultant < MIN_RESULTANT
                || circular_distance(first.phase, second.phase) > HALF_AGREEMENT
            {
                return None;
            }
        }
        _ => return None,
    }

    let period_seconds = period_hops * hop_seconds;
    Some(Beatgrid {
        bpm: 60.0 / period_seconds,
        first_beat_seconds: fold.phase * period_seconds,
    })
}

#[cfg(test)]
mod tests {
    //! The behavioural contract, ported from `beatgrid.test.ts` — same
    //! fixtures, same assertions, same tolerances.

    use super::*;
    use crate::analysis::beat::fixtures::{
        click_track, deinterleave, kick_hat_track, noise_source,
    };
    use crate::analysis::beat::track_bpm;

    const SAMPLE_RATE: f64 = 48_000.0;

    /// The production call shape: the load path always has the coarse pass.
    fn grid_of(left: &[f32], right: &[f32]) -> Option<Beatgrid> {
        let coarse = track_bpm(left, right, SAMPLE_RATE);
        track_beatgrid(left, right, SAMPLE_RATE, coarse)
    }

    fn circular_gap(a: f64, b: f64) -> f64 {
        let diff = (a - b).abs() % 1.0;
        diff.min(1.0 - diff)
    }

    #[test]
    fn finds_the_tempo_and_phase_of_a_steady_click_track() {
        let (left, right) = deinterleave(&click_track(128.0, 30.0, SAMPLE_RATE, 1));
        let grid = grid_of(&left, &right).expect("steady clicks grid");
        // Refined well past the estimator's ±2% — under half a percent.
        assert!((grid.bpm - 128.0).abs() <= 128.0 * 0.005, "bpm {}", grid.bpm);
        // Beat 0 is at t=0; the grid may report it anywhere on the lattice.
        let period = 60.0 / grid.bpm;
        let phase = (grid.first_beat_seconds / period) % 1.0;
        assert!(phase.min(1.0 - phase) <= 0.06, "phase {phase}");
    }

    #[test]
    fn places_the_first_beat_at_a_lead_in_offset() {
        let (raw_left, raw_right) = deinterleave(&click_track(120.0, 30.0, SAMPLE_RATE, 1));
        // Prepend stereo silence so the first beat lands at a known offset.
        let lead = (0.25 * SAMPLE_RATE).round() as usize;
        let mut left = vec![0.0f32; lead];
        left.extend_from_slice(&raw_left);
        let mut right = vec![0.0f32; lead];
        right.extend_from_slice(&raw_right);
        let grid = grid_of(&left, &right).expect("lead-in grid");
        let period = 60.0 / grid.bpm;
        // 0.25s into a 0.5s period = half a period off the lattice.
        let expected = (0.25 % period) / period;
        let phase = (grid.first_beat_seconds / period) % 1.0;
        assert!(circular_gap(phase, expected) <= 0.06);
    }

    #[test]
    fn refines_a_tempo_that_sits_off_the_estimator_lag_grid() {
        let (left, right) = deinterleave(&click_track(127.3, 40.0, SAMPLE_RATE, 1));
        let grid = grid_of(&left, &right).expect("off-grid tempo grid");
        assert!((grid.bpm - 127.3).abs() <= 127.3 * 0.005, "bpm {}", grid.bpm);
    }

    #[test]
    fn refuses_beatless_material() {
        let mut noise = noise_source(7);
        let frames = SAMPLE_RATE as usize * 20;
        let left: Vec<f32> = (0..frames).map(|_| (noise() * 0.3) as f32).collect();
        let right: Vec<f32> = (0..frames).map(|_| (noise() * 0.3) as f32).collect();
        assert!(grid_of(&left, &right).is_none());
    }

    #[test]
    fn refuses_a_track_whose_tempo_drifts() {
        // Two steady halves at different tempi: each folds tightly on its
        // own, but they cannot share one constant grid — no grid beats a
        // wrong grid.
        let mut joined = click_track(120.0, 20.0, SAMPLE_RATE, 1);
        joined.extend_from_slice(&click_track(126.0, 20.0, SAMPLE_RATE, 2));
        let (left, right) = deinterleave(&joined);
        assert!(grid_of(&left, &right).is_none());
    }

    #[test]
    fn grids_textured_material_with_ghost_kicks() {
        // Real renders measured 0.50-0.65 resultants: kicks plus a busy low
        // end. Caricature: ghost low bumps on the off-eighths.
        let mut base = kick_hat_track(128.0, 30.0, SAMPLE_RATE, 1);
        let frames = base.len() / 2;
        let period = ((60.0 / 128.0) * SAMPLE_RATE).round();
        let mut ghost = noise_source(5);
        for i in 0..frames {
            let since_eighth = ((i as f64 + period / 4.0) as usize) % ((period / 2.0).round() as usize);
            if (since_eighth as f64) < 0.04 * SAMPLE_RATE {
                let bump = (2.0 * std::f64::consts::PI * 70.0 * since_eighth as f64
                    / SAMPLE_RATE)
                    .sin()
                    * 0.35
                    * (0.5 + 0.5 * ghost().abs())
                    * (1.0 - since_eighth as f64 / (0.04 * SAMPLE_RATE));
                base[2 * i] += bump as f32;
                base[2 * i + 1] += bump as f32;
            }
        }
        let (left, right) = deinterleave(&base);
        let grid = grid_of(&left, &right).expect("textured material grids");
        let period_seconds = 60.0 / grid.bpm;
        let phase = (grid.first_beat_seconds / period_seconds) % 1.0;
        assert!(phase.min(1.0 - phase) <= 0.12, "phase {phase}");
    }

    #[test]
    fn puts_the_phase_on_the_kicks_never_the_hats() {
        let (left, right) = deinterleave(&kick_hat_track(128.0, 30.0, SAMPLE_RATE, 1));
        let grid = grid_of(&left, &right).expect("kick-hat grid");
        let period = 60.0 / grid.bpm;
        let phase = (grid.first_beat_seconds / period) % 1.0;
        // Kicks sit on the lattice (phase ~0); hats at 0.5 — a full-band
        // fold either cancels (no grid) or lands on the louder hats.
        assert!(phase.min(1.0 - phase) <= 0.1, "phase {phase}");
    }
}
