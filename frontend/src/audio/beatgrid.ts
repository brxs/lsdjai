/** Offline beatgrid for a decoded track (M20, ADR-0014): BPM plus
 * first-beat phase under a constant-tempo model, behind the M14
 * honesty rule — a track that won't fit a grid gets null, never a
 * wrong grid. Pure math over the decoded channels, unit-tested
 * against click tracks and drifting fixtures.
 *
 * The estimator's coarse BPM is only good to ~±1–2 %, and folding a
 * whole track with a period that far off smears a full beat of phase
 * every ~50 s — so the period is refined here: a fine rate search
 * around the coarse BPM maximising fold concentration, with the
 * fold's spread and a half-split phase agreement as the drift check
 * (the regression-residual idea from ADR-0014 in search form). */

import { trackBpm } from './beat'

export type Beatgrid = {
  bpm: number
  /** Where beat 0 falls, in seconds from the start of the track. */
  firstBeatSeconds: number
}

const HOP_FRAMES = 512
const EPS = 1e-10
// Honesty thresholds, measured against synthetic fixtures AND real
// renders: sterile clicks fold to ~0.95, real minimal techno hit
// 0.97, real rolling techno with basslines and ghost kicks lands
// 0.50–0.65 — texture spreads the fold without making the grid
// wrong. The floor only asks "is there a coherent phase at all";
// drift and incoherence are the half-split check's job, and beatless
// material never gets past the coarse gate. The resultant (mean
// unit-vector length) is the search metric because it peaks exactly
// at the true period — a windowed-mass count plateaus across nearby
// periods and lets the search pick a drifting edge.
const MIN_ONSETS = 16
const MIN_RESULTANT = 0.35
/** Fine search around the coarse BPM: ±2 % covers the estimator's
 * tolerance band, steps small enough that residual smear over a
 * 6-minute track stays under a tenth of a beat. */
const RATE_SEARCH = 0.02
const RATE_STEP = 0.0005
/** First and second half of the track must agree on phase within
 * this fraction of a period, or the tempo drifted — no grid. */
const HALF_AGREEMENT = 0.15

type Onset = { hop: number; weight: number }

/** Low-band onset cutoff: the phase question is "where is the kick".
 * A four-on-the-floor with offbeat hats puts full-band onsets at
 * phase 0 AND 0.5, and folding that by the beat period cancels — the
 * low band carries the beat alone. Matches the tracker's crossover. */
const LOW_CROSSOVER_HZ = 200

/** Half-wave-rectified LINEAR energy rise of the LOW band per hop —
 * the kick detector, run offline. Log flux would rate a hat rising
 * from the quiet floor as highly as a kick (ratios, not amounts);
 * linear rise keeps the 60 Hz thump ~30× ahead. */
function onsetEnvelope(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): Float32Array {
  const hops = Math.floor(left.length / HOP_FRAMES)
  const envelope = new Float32Array(hops)
  const alpha = 1 - Math.exp((-2 * Math.PI * LOW_CROSSOVER_HZ) / sampleRate)
  let lowState = 0
  let previous: number | null = null
  for (let hop = 0; hop < hops; hop++) {
    let energy = 0
    const start = hop * HOP_FRAMES
    for (let i = start; i < start + HOP_FRAMES; i++) {
      const mono = (left[i] + right[i]) / 2
      lowState += alpha * (mono - lowState)
      energy += lowState * lowState
    }
    const mean = energy / HOP_FRAMES
    if (previous !== null) {
      envelope[hop] = Math.max(0, mean - previous)
    }
    previous = mean
  }
  return envelope
}

/** Local maxima above an adaptive floor, weighted by their strength. */
function pickOnsets(envelope: Float32Array): Onset[] {
  let sum = 0
  for (const value of envelope) sum += value
  const mean = sum / Math.max(1, envelope.length)
  let variance = 0
  for (const value of envelope) variance += (value - mean) ** 2
  const floor = mean + Math.sqrt(variance / Math.max(1, envelope.length))
  const onsets: Onset[] = []
  for (let hop = 1; hop < envelope.length - 1; hop++) {
    const value = envelope[hop]
    if (
      value > floor &&
      value >= envelope[hop - 1] &&
      value > envelope[hop + 1]
    ) {
      onsets.push({ hop, weight: value })
    }
  }
  return onsets
}

/** Shortest circular distance between two phases, in turns. */
function circularDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 1
  return Math.min(diff, 1 - diff)
}

/** Fold the onsets by a candidate period: the weighted resultant
 * length (0 = incoherent, 1 = every onset on one phase) and the mean
 * phase. */
function foldResultant(
  onsets: Onset[],
  periodHops: number,
): { resultant: number; phase: number } | null {
  let x = 0
  let y = 0
  let total = 0
  for (const onset of onsets) {
    const angle = 2 * Math.PI * ((onset.hop / periodHops) % 1)
    x += Math.cos(angle) * onset.weight
    y += Math.sin(angle) * onset.weight
    total += onset.weight
  }
  if (total < EPS) return null
  const turns = Math.atan2(y, x) / (2 * Math.PI)
  return { resultant: Math.hypot(x, y) / total, phase: (turns + 1) % 1 }
}

export function trackBeatgrid(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  // The caller usually has the coarse pass already (loadTrack runs
  // trackBpm for the readout) — accept it so the track is analysed
  // once, not twice.
  coarse?: number | null,
): Beatgrid | null {
  const coarseBpm = coarse ?? trackBpm(left, right, sampleRate)
  if (coarseBpm === null) return null
  const envelope = onsetEnvelope(left, right, sampleRate)
  const onsets = pickOnsets(envelope)
  console.debug('[beatgrid] onsets', onsets.length)
  if (onsets.length < MIN_ONSETS) return null

  const hopSeconds = HOP_FRAMES / sampleRate
  const coarsePeriodHops = 60 / coarseBpm / hopSeconds
  let best: { periodHops: number; resultant: number; phase: number } | null =
    null
  for (
    let rate = 1 - RATE_SEARCH;
    rate <= 1 + RATE_SEARCH + EPS;
    rate += RATE_STEP
  ) {
    const periodHops = coarsePeriodHops / rate
    const fold = foldResultant(onsets, periodHops)
    if (fold && (best === null || fold.resultant > best.resultant)) {
      best = { periodHops, ...fold }
    }
  }
  console.debug('[beatgrid] resultant', best?.resultant)
  if (best === null || best.resultant < MIN_RESULTANT) return null

  // The drift check: both halves must fold coherently ON THEIR OWN
  // and put beat 0 in the same place. A spliced tempo can satisfy
  // the combined fold (one half carries the average) and its
  // incoherent half still yields a — meaningless — mean phase, so
  // each half owes its own resultant before agreement counts.
  const midpoint = onsets[Math.floor(onsets.length / 2)].hop
  const firstHalf = onsets.filter((onset) => onset.hop < midpoint)
  const secondHalf = onsets.filter((onset) => onset.hop >= midpoint)
  const first = foldResultant(firstHalf, best.periodHops)
  const second = foldResultant(secondHalf, best.periodHops)
  console.debug('[beatgrid] halves', first, second)
  if (
    first === null ||
    second === null ||
    first.resultant < MIN_RESULTANT ||
    second.resultant < MIN_RESULTANT ||
    circularDistance(first.phase, second.phase) > HALF_AGREEMENT
  ) {
    return null
  }

  const periodSeconds = best.periodHops * hopSeconds
  return {
    bpm: 60 / periodSeconds,
    firstBeatSeconds: best.phase * periodSeconds,
  }
}
