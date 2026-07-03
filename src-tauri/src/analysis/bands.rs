//! Offline band profile for a decoded track (M22/M20, ADR-0030): per hop of
//! audio, three RMS band energies — lows, mids, highs — using the beat
//! tracker's one-pole crossovers, so a kick and a hat read as colour. The
//! offline half of `bands.ts`, computed at load in the shell; the arrays
//! ship to the webview once (~340 KB for a 6:20 track) and the canvas
//! scroller reads them per frame exactly as before. The LIVE scroller (the
//! realtime wire's incremental sibling) stays in TypeScript — ADR-0017's
//! clause, narrowed to live visuals.

const BAND_HOP_FRAMES: usize = 512;
const LOW_CROSSOVER_HZ: f64 = 200.0;
const HIGH_CROSSOVER_HZ: f64 = 4000.0;

/// Hop-indexed band energies, hop = 512 frames (the tracker's hop).
pub struct TrackBands {
    pub low: Vec<f32>,
    pub mid: Vec<f32>,
    pub high: Vec<f32>,
}

impl TrackBands {
    pub fn hops(&self) -> usize {
        self.low.len()
    }
}

/// Offline band pass over a decoded track — computed once at load
/// (`trackBands`, `bands.ts`; f32 storage, f64 math like the estimator).
pub fn track_bands(left: &[f32], right: &[f32], sample_rate: f64) -> TrackBands {
    let hops = left.len() / BAND_HOP_FRAMES;
    let mut low = vec![0.0f32; hops];
    let mut mid = vec![0.0f32; hops];
    let mut high = vec![0.0f32; hops];
    let low_alpha = 1.0 - (-2.0 * std::f64::consts::PI * LOW_CROSSOVER_HZ / sample_rate).exp();
    let high_alpha = 1.0 - (-2.0 * std::f64::consts::PI * HIGH_CROSSOVER_HZ / sample_rate).exp();
    let mut low_state = 0.0f64;
    let mut high_state = 0.0f64;
    for hop in 0..hops {
        let mut low_sum = 0.0f64;
        let mut mid_sum = 0.0f64;
        let mut high_sum = 0.0f64;
        let start = hop * BAND_HOP_FRAMES;
        for i in start..start + BAND_HOP_FRAMES {
            let mono = (left[i] as f64 + right[i] as f64) / 2.0;
            low_state += low_alpha * (mono - low_state);
            high_state += high_alpha * (mono - high_state);
            let low_band = low_state;
            let mid_band = high_state - low_state;
            let high_band = mono - high_state;
            low_sum += low_band * low_band;
            mid_sum += mid_band * mid_band;
            high_sum += high_band * high_band;
        }
        low[hop] = (low_sum / BAND_HOP_FRAMES as f64).sqrt() as f32;
        mid[hop] = (mid_sum / BAND_HOP_FRAMES as f64).sqrt() as f32;
        high[hop] = (high_sum / BAND_HOP_FRAMES as f64).sqrt() as f32;
    }
    TrackBands { low, mid, high }
}

#[cfg(test)]
mod tests {
    //! The band-separation contract from `bands.test.ts` (offline half):
    //! a tone lands in its own band, decisively.

    use super::*;

    const SAMPLE_RATE: f64 = 48_000.0;

    fn tone(hz: f64, seconds: f64) -> (Vec<f32>, Vec<f32>) {
        let frames = (seconds * SAMPLE_RATE) as usize;
        let samples: Vec<f32> = (0..frames)
            .map(|i| {
                ((2.0 * std::f64::consts::PI * hz * i as f64 / SAMPLE_RATE).sin() * 0.5) as f32
            })
            .collect();
        (samples.clone(), samples)
    }

    /// Which band a settled hop reads strongest in — the `bands.test.ts`
    /// `dominantBand` assertion (dominance, not a margin: the one-pole
    /// crossovers are gentle by design).
    fn dominant_at(bands: &TrackBands, hop: usize) -> &'static str {
        let (low, mid, high) = (bands.low[hop], bands.mid[hop], bands.high[hop]);
        if low >= mid && low >= high {
            "low"
        } else if mid >= high {
            "mid"
        } else {
            "high"
        }
    }

    #[test]
    fn a_60_hz_tone_lands_in_the_low_band() {
        let (left, right) = tone(60.0, 1.0);
        let bands = track_bands(&left, &right, SAMPLE_RATE);
        assert_eq!(dominant_at(&bands, 20), "low");
    }

    #[test]
    fn a_1_khz_tone_lands_in_the_mid_band() {
        let (left, right) = tone(1_000.0, 1.0);
        let bands = track_bands(&left, &right, SAMPLE_RATE);
        assert_eq!(dominant_at(&bands, 30), "mid");
    }

    #[test]
    fn a_10_khz_tone_lands_in_the_high_band() {
        let (left, right) = tone(10_000.0, 1.0);
        let bands = track_bands(&left, &right, SAMPLE_RATE);
        assert_eq!(dominant_at(&bands, 20), "high");
    }

    #[test]
    fn hops_cover_the_whole_track() {
        let (left, right) = tone(440.0, 1.0);
        let bands = track_bands(&left, &right, SAMPLE_RATE);
        assert_eq!(bands.hops(), left.len() / 512);
    }
}
