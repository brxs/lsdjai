/** Master housekeeping (M17): the pure math behind the limiter's
 * ceiling and the per-deck auto-gain. The graph side lives in the
 * native Rust engine (`src-tauri/engine/src/graph.rs`); the loudness
 * feed comes from the deck PCM chunks (the same main-thread tap the
 * beat tracker uses, ADR-0010).
 *
 * The limiter is a DynamicsCompressorNode doing the musical work plus
 * a WaveShaper clip guard doing the mathematical work: the compressor
 * tames level, the guard makes the ceiling a hard guarantee the e2e
 * can assert against. Auto-gain compensates SOURCE loudness only —
 * it reads the raw stream (pre-EQ/FX), so a kill or an effect stays
 * the performer's move instead of being fought by the trim. */

/** The hard ceiling the clip guard enforces, in linear amplitude
 * (~−0.6 dBFS). Binary-exact (119/128) so the float32 curve stores it
 * without rounding above itself — the e2e asserts against this number.
 * The recorded master can never exceed it. */
export const LIMITER_CEILING = 0.9296875

/** Compressor-as-limiter settings: hard knee, high ratio, fast
 * attack; the threshold sits under the ceiling so the guard only
 * catches what the attack lets through. */
export const LIMITER_THRESHOLD_DB = -6
export const LIMITER_KNEE_DB = 0
export const LIMITER_RATIO = 20
export const LIMITER_ATTACK_SECONDS = 0.002
export const LIMITER_RELEASE_SECONDS = 0.25

/** DynamicsCompressorNode applies an implicit makeup gain of
 * (1/fullScaleGain)^0.6 (the Web Audio spec) — at these settings
 * ~+3.4 dB on EVERYTHING, including signal that never crosses the
 * threshold. The engine compensates with the inverse so inserting the
 * limiter is level-transparent until it actually works, and the
 * gain-reduction readout stays an honest account of net level change.
 * The full-scale-gain formula below is the HARD-KNEE case — it holds
 * only while LIMITER_KNEE_DB is 0. */
const FULL_SCALE_GAIN_DB = LIMITER_THRESHOLD_DB - LIMITER_THRESHOLD_DB / LIMITER_RATIO
export const LIMITER_MAKEUP_DB = -0.6 * FULL_SCALE_GAIN_DB

/** WaveShaper curve: linear (transparent) up to the ceiling, hard
 * ceiling beyond — residual overshoot the compressor's attack lets
 * through gets clamped, never the body of the signal. */
export function clipGuardCurve(samples = 4096): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples)
  for (let i = 0; i < samples; i++) {
    const x = (2 * i) / (samples - 1) - 1
    curve[i] = Math.max(-LIMITER_CEILING, Math.min(LIMITER_CEILING, x))
  }
  return curve
}

/** Auto-gain target: where a deck's raw stream should sit (~−16.5
 * dBFS RMS), leaving fader/EQ headroom below the limiter. */
export const TRIM_TARGET_RMS = 0.15
export const TRIM_RANGE_DB = 12
/** Raw RMS below this is silence/lead-in — the trim holds rather
 * than winding up +12 dB on nothing. */
export const TRIM_SILENCE_RMS = 0.005

/** The trim knob's mapping, shared by the on-screen Knob and the hardware TRIM
 * intent: a normalised 0..1 position spans ±TRIM_RANGE_DB, centre = 0 dB. */
export function trimDbFromKnob(knob: number): number {
  return knob * 2 * TRIM_RANGE_DB - TRIM_RANGE_DB
}

export function knobFromTrimDb(db: number): number {
  return (db + TRIM_RANGE_DB) / (2 * TRIM_RANGE_DB)
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(gain)
}

/** The trim that lands `measuredRms` on the target, clamped to the
 * knob's range; null when the measurement is too quiet to trust. */
export function trimDbFor(measuredRms: number): number | null {
  if (!(measuredRms > TRIM_SILENCE_RMS)) return null
  const db = gainToDb(TRIM_TARGET_RMS / measuredRms)
  return Math.max(-TRIM_RANGE_DB, Math.min(TRIM_RANGE_DB, db))
}

export type LoudnessTracker = {
  /** Feed interleaved stereo float32 (the deck wire format). */
  push: (samples: Float32Array) => void
  /** Slow running RMS of the mono mix, 0 while nothing has played. */
  rms: () => number
  reset: () => void
}

/** Exponential moving average of mean-square with a time constant of
 * `windowSeconds` — slow on purpose: trim is gain-staging, not a
 * compressor. */
export function createLoudnessTracker(
  sampleRate: number,
  windowSeconds = 10,
): LoudnessTracker {
  let meanSquare = 0
  let warmedFrames = 0
  const windowFrames = windowSeconds * sampleRate
  return {
    push(samples) {
      const frames = Math.floor(samples.length / 2)
      if (frames === 0) return
      let sum = 0
      for (let i = 0; i < frames; i++) {
        const mono = (samples[2 * i] + samples[2 * i + 1]) / 2
        sum += mono * mono
      }
      const chunkMean = sum / frames
      // EMA weight for this chunk relative to the window; while still
      // warming up, weight by what has actually been seen so the
      // early estimate is a plain average, not biased toward zero.
      warmedFrames = Math.min(warmedFrames + frames, windowFrames)
      const alpha = frames / Math.max(warmedFrames, frames)
      meanSquare += alpha * (chunkMean - meanSquare)
    },
    rms() {
      return Math.sqrt(meanSquare)
    },
    reset() {
      meanSquare = 0
      warmedFrames = 0
    },
  }
}
