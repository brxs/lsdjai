/** Beat detection (M14): a pure, incremental tempo estimator over a
 * deck's PCM feed, and the honesty gate in front of it. ADR-0004
 * stands — tempo is not a generation parameter; this only *measures*
 * the output. The estimator must say nothing rather than a wrong
 * number, so the gate demands both periodicity (confidence) and
 * stability across successive estimates before anything is shown.
 *
 * Shape: an onset envelope (half-wave-rectified log-energy flux per
 * hop) autocorrelated over the DJ tempo range; the best lag wins by a
 * comb score (a true beat period also correlates at its double) under
 * a mild log-normal prior centred near club tempo, which breaks the
 * octave ties a pure comb score leaves. Confidence is the raw
 * autocorrelation coefficient at the winning lag — periodicity, not
 * prior. Thresholds are measured, not guessed: see
 * docs/spike-beat-detection.md. */

export type BeatEstimate = { bpm: number; confidence: number }

export type BeatTracker = {
  /** Feed interleaved stereo float32 — the deck wire format. */
  push: (samples: Float32Array) => void
  /** Latest estimate, or null while there is too little signal. */
  estimate: () => BeatEstimate | null
  /** Drop accumulated signal (stream reset / model switch). */
  reset: () => void
}

const HOP_FRAMES = 512
const WINDOW_SECONDS = 12
const MIN_SECONDS = 6
const MIN_BPM = 60
const MAX_BPM = 200
/** Band-split flux (one-pole crossovers): drum onsets concentrate in
 * distinct bands — kick in the lows, hats in the highs — so per-band
 * log-flux keeps a beat visible against sustained content that masks
 * it at full bandwidth (measured on the spike corpus: full-band flux
 * left drum-and-bass at confidence ≤0.22 under its own bassline). */
const LOW_CROSSOVER_HZ = 200
const HIGH_CROSSOVER_HZ = 4000
/** Octave ties break toward this tempo (log-normal prior). */
const PRIOR_CENTER_BPM = 120
const PRIOR_OCTAVE_SIGMA = 0.7
const EPS = 1e-10
/** Envelope variance below this is not rhythm. Flux lives in
 * log-energy units, so the floor is volume-invariant: a kick onset
 * rises by whole nats; a steady tone's hop-quantisation ripple sits
 * orders of magnitude under this. */
const MIN_FLUX_VARIANCE = 1e-4
/** Sharp transients put a 1–2 hop spike in the envelope, which makes
 * a non-integer true lag (150 bpm = 37.5 hops) lose to its
 * integer-lag octave alias. Smoothing spreads each onset across
 * neighbouring hops so half-integer lags still correlate. */
const SMOOTHING = [0.25, 0.5, 1, 0.5, 0.25]

function tempoPrior(bpm: number): number {
  const octaves = Math.log2(bpm / PRIOR_CENTER_BPM)
  return Math.exp(-0.5 * (octaves / PRIOR_OCTAVE_SIGMA) ** 2)
}

export function createBeatTracker(sampleRate: number): BeatTracker {
  const hopSeconds = HOP_FRAMES / sampleRate
  const capacity = Math.max(16, Math.round(WINDOW_SECONDS / hopSeconds))
  const flux = new Float32Array(capacity)
  let head = 0
  let filled = 0
  const lowAlpha = 1 - Math.exp((-2 * Math.PI * LOW_CROSSOVER_HZ) / sampleRate)
  const highAlpha = 1 - Math.exp((-2 * Math.PI * HIGH_CROSSOVER_HZ) / sampleRate)
  let lowState = 0
  let highState = 0
  const hopEnergy = [0, 0, 0]
  let hopFill = 0
  let previousLogEnergy: number[] | null = null

  function pushHop() {
    const logEnergy = hopEnergy.map((energy) =>
      Math.log(energy / HOP_FRAMES + EPS),
    )
    if (previousLogEnergy !== null) {
      let rise = 0
      for (let band = 0; band < logEnergy.length; band++) {
        rise += Math.max(0, logEnergy[band] - previousLogEnergy[band])
      }
      flux[head] = rise
      head = (head + 1) % capacity
      filled = Math.min(filled + 1, capacity)
    }
    previousLogEnergy = logEnergy
  }

  return {
    push(samples) {
      for (let i = 0; i + 1 < samples.length; i += 2) {
        const mono = (samples[i] + samples[i + 1]) / 2
        lowState += lowAlpha * (mono - lowState)
        highState += highAlpha * (mono - highState)
        const low = lowState
        const mid = highState - lowState
        const high = mono - highState
        hopEnergy[0] += low * low
        hopEnergy[1] += mid * mid
        hopEnergy[2] += high * high
        hopFill += 1
        if (hopFill === HOP_FRAMES) {
          pushHop()
          hopEnergy[0] = 0
          hopEnergy[1] = 0
          hopEnergy[2] = 0
          hopFill = 0
        }
      }
    },

    estimate() {
      if (filled * hopSeconds < MIN_SECONDS) return null
      // Linearise the ring oldest-first, smooth, then remove the mean.
      const n = filled
      const raw = new Float32Array(n)
      const start = (head - filled + capacity) % capacity
      for (let i = 0; i < n; i++) raw[i] = flux[(start + i) % capacity]
      const x = new Float32Array(n)
      const half = (SMOOTHING.length - 1) / 2
      let mean = 0
      for (let i = 0; i < n; i++) {
        let sum = 0
        let weight = 0
        for (let k = 0; k < SMOOTHING.length; k++) {
          const j = i + k - half
          if (j < 0 || j >= n) continue
          sum += raw[j] * SMOOTHING[k]
          weight += SMOOTHING[k]
        }
        x[i] = sum / weight
        mean += x[i]
      }
      mean /= n
      let r0 = 0
      for (let i = 0; i < n; i++) {
        x[i] -= mean
        r0 += x[i] * x[i]
      }
      // A flat envelope (silence, a steady tone, a beatless pad) has
      // no rhythm worth reporting.
      if (r0 / n < MIN_FLUX_VARIANCE) return null

      const lagMin = Math.max(2, Math.floor(60 / (MAX_BPM * hopSeconds)))
      const lagMax = Math.min(n - 2, Math.ceil(60 / (MIN_BPM * hopSeconds)))
      if (lagMax <= lagMin) return null
      // Coefficients run to 2×lagMax so every candidate can consult
      // its harmonic; unbiased normalisation keeps long lags honest.
      const lagTop = Math.min(2 * lagMax, n - 2)
      const coeff = new Float32Array(lagTop + 1)
      for (let lag = lagMin; lag <= lagTop; lag++) {
        let sum = 0
        for (let i = 0; i + lag < n; i++) sum += x[i] * x[i + lag]
        coeff[lag] = sum / (n - lag) / (r0 / n)
      }

      let bestLag = 0
      let bestScore = -Infinity
      for (let lag = lagMin; lag <= lagMax; lag++) {
        const harmonic = 2 * lag <= lagTop ? coeff[2 * lag] : 0
        // A candidate whose HALF lag also correlates is the octave-down
        // alias of a faster beat — penalise it so the true tempo wins
        // (the prior alone can't break this tie).
        const lower = Math.floor(lag / 2)
        const subharmonic =
          lower >= lagMin
            ? (coeff[lower] + coeff[Math.min(lower + 1, lagTop)]) / 2
            : 0
        const score =
          (coeff[lag] + 0.5 * harmonic - 0.5 * subharmonic) *
          tempoPrior(60 / (lag * hopSeconds))
        if (score > bestScore) {
          bestScore = score
          bestLag = lag
        }
      }
      if (bestLag === 0) return null

      // Parabolic interpolation for sub-hop lag resolution (±5% per
      // hop at club tempo would otherwise swamp the ±2% target).
      const alpha = coeff[bestLag - 1]
      const beta = coeff[bestLag]
      const gamma = coeff[bestLag + 1]
      const denominator = alpha - 2 * beta + gamma
      const shift =
        denominator === 0
          ? 0
          : Math.max(-0.5, Math.min(0.5, (0.5 * (alpha - gamma)) / denominator))
      const bpm = 60 / ((bestLag + shift) * hopSeconds)
      const confidence = Math.max(0, Math.min(1, beta))
      return { bpm, confidence }
    },

    reset() {
      head = 0
      filled = 0
      lowState = 0
      highState = 0
      hopEnergy[0] = 0
      hopEnergy[1] = 0
      hopEnergy[2] = 0
      hopFill = 0
      previousLogEnergy = null
    },
  }
}

/** The honesty gate: a BPM is shown only after `GATE_STABLE_COUNT`
 * consecutive confident estimates agreeing within `GATE_TOLERANCE`.
 * Acquisition is strict; once showing, a single unconfident estimate
 * is ridden out (generative music breathes, and re-acquiring costs
 * 3+ s) — the second consecutive miss drops the readout. */
export const GATE_MIN_CONFIDENCE = 0.4
export const GATE_STABLE_COUNT = 3
export const GATE_TOLERANCE = 0.04
export const GATE_GRACE_MISSES = 1

export type BeatGate = {
  /** Feed the latest estimate; returns what may be displayed now. */
  push: (estimate: BeatEstimate | null) => number | null
  current: () => number | null
  /** Back to blank instantly (stream reset). */
  reset: () => void
}

/** A confident estimate at a near-exact half or double of the anchor
 * is the same rhythm read at another metrical level — fold it onto
 * the anchor so octave-flapping (hip hop alternating ~95/~190 on the
 * corpus) reads as the agreement it is. */
function foldOctave(bpm: number, anchor: number): number {
  for (const factor of [0.5, 2]) {
    if (Math.abs(bpm * factor - anchor) <= anchor * GATE_TOLERANCE) {
      return bpm * factor
    }
  }
  return bpm
}

export function createBeatGate(): BeatGate {
  const recent: number[] = []
  let displayed: number | null = null
  let misses = 0
  let unstable = 0
  return {
    push(estimate) {
      if (!estimate || estimate.confidence < GATE_MIN_CONFIDENCE) {
        recent.length = 0
        misses += 1
        if (misses > GATE_GRACE_MISSES) displayed = null
        return displayed
      }
      misses = 0
      const anchor = displayed ?? recent.at(-1) ?? null
      recent.push(anchor === null ? estimate.bpm : foldOctave(estimate.bpm, anchor))
      if (recent.length > GATE_STABLE_COUNT) recent.shift()
      if (recent.length < GATE_STABLE_COUNT) return displayed
      const sorted = [...recent].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]
      const stable = sorted[sorted.length - 1] - sorted[0] <= median * GATE_TOLERANCE
      if (stable) {
        // Hysteresis: successive windows jitter by fractions of a bpm;
        // a locked readout holds still (and the synced echo's delay
        // stays put) until the median genuinely moves.
        if (
          displayed === null ||
          Math.abs(median - displayed) > displayed * GATE_TOLERANCE
        ) {
          displayed = median
        }
        unstable = 0
      } else {
        // Confident but disagreeing: hold briefly (a tempo change is
        // locking in), but a persistent quarrel means we no longer
        // know the tempo — showing the old number would be a lie.
        unstable += 1
        if (unstable >= GATE_STABLE_COUNT) displayed = null
      }
      return displayed
    },
    current: () => displayed,
    reset() {
      recent.length = 0
      displayed = null
      misses = 0
      unstable = 0
    },
  }
}
