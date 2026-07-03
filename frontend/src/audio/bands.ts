/** Band-coloured waveform sources (M22, pulled into the M20 workflow:
 * beat-matching is hard to test without seeing the beats). Per hop of
 * audio, three RMS band energies — lows, mids, highs — using the beat
 * tracker's one-pole crossovers, so a kick and a hat read as colour.
 * Two producers, one shape: an offline pass over a decoded track and
 * an incremental scroller fed by the live wire, both consumed through
 * `copyWindow` so the renderer never cares which deck it draws. */

export const BAND_HOP_FRAMES = 512
const LOW_CROSSOVER_HZ = 200
const HIGH_CROSSOVER_HZ = 4000
/** The live scroller's memory: a minute of hops (~67 KB of floats). */
const SCROLLER_SECONDS = 60

export type BandWindowTarget = {
  low: Float32Array
  mid: Float32Array
  high: Float32Array
}

/** Hop-indexed band energies. `copyWindow` fills the target arrays for
 * hops [fromHop, fromHop + target length), zeroing outside the data. */
export type BandSource = {
  baseHop: number
  endHop: number
  copyWindow: (fromHop: number, target: BandWindowTarget) => void
}

type FilterState = { low: number; high: number }

function bandKernel(sampleRate: number) {
  const lowAlpha = 1 - Math.exp((-2 * Math.PI * LOW_CROSSOVER_HZ) / sampleRate)
  const highAlpha = 1 - Math.exp((-2 * Math.PI * HIGH_CROSSOVER_HZ) / sampleRate)
  return (state: FilterState, mono: number) => {
    state.low += lowAlpha * (mono - state.low)
    state.high += highAlpha * (mono - state.high)
    const low = state.low
    const mid = state.high - state.low
    const high = mono - state.high
    return { low: low * low, mid: mid * mid, high: high * high }
  }
}

function windowCopier(
  low: Float32Array,
  mid: Float32Array,
  high: Float32Array,
  baseHop: number,
  endHop: number,
  ring: boolean,
) {
  const capacity = low.length
  return (fromHop: number, target: BandWindowTarget) => {
    for (let i = 0; i < target.low.length; i++) {
      const hop = fromHop + i
      if (hop < baseHop || hop >= endHop) {
        target.low[i] = 0
        target.mid[i] = 0
        target.high[i] = 0
        continue
      }
      const index = ring ? hop % capacity : hop
      target.low[i] = low[index]
      target.mid[i] = mid[index]
      target.high[i] = high[index]
    }
  }
}

/** A `BandSource` over a loaded track's band lanes. The offline pass itself
 * runs shell-side at load (ADR-0030, `analysis/bands.rs` — the port of the
 * `trackBands` that lived here); the arrays ship once and the zoom strip
 * reads them through the same window contract as the live scroller. */
export function bandSourceFromArrays(
  low: Float32Array,
  mid: Float32Array,
  high: Float32Array,
): BandSource {
  const hops = Math.min(low.length, mid.length, high.length)
  return {
    baseHop: 0,
    endHop: hops,
    copyWindow: windowCopier(low, mid, high, 0, hops, false),
  }
}

export type BandScroller = {
  /** Feed interleaved stereo float32 — the deck wire format. */
  push: (samples: Float32Array) => void
  /** A view of what's held right now (hops are pushed-frame/512). */
  source: () => BandSource
  /** Stream discontinuity: forget everything (the tracker's rule). */
  reset: () => void
}

/** Incremental band envelopes for the live wire, hop-indexed in the
 * pushed-frame domain — the same clock the worklet's consumed-frames
 * counter and the beat anchor live in (M20). */
export function createBandScroller(sampleRate: number): BandScroller {
  const capacity = Math.ceil((SCROLLER_SECONDS * sampleRate) / BAND_HOP_FRAMES)
  const low = new Float32Array(capacity)
  const mid = new Float32Array(capacity)
  const high = new Float32Array(capacity)
  const kernel = bandKernel(sampleRate)
  let state: FilterState = { low: 0, high: 0 }
  let hopsPushed = 0
  let lowSum = 0
  let midSum = 0
  let highSum = 0
  let hopFill = 0
  return {
    push(samples) {
      for (let i = 0; i + 1 < samples.length; i += 2) {
        const energies = kernel(state, (samples[i] + samples[i + 1]) / 2)
        lowSum += energies.low
        midSum += energies.mid
        highSum += energies.high
        hopFill += 1
        if (hopFill === BAND_HOP_FRAMES) {
          const index = hopsPushed % capacity
          low[index] = Math.sqrt(lowSum / BAND_HOP_FRAMES)
          mid[index] = Math.sqrt(midSum / BAND_HOP_FRAMES)
          high[index] = Math.sqrt(highSum / BAND_HOP_FRAMES)
          hopsPushed += 1
          lowSum = 0
          midSum = 0
          highSum = 0
          hopFill = 0
        }
      }
    },
    source() {
      const baseHop = Math.max(0, hopsPushed - capacity)
      return {
        baseHop,
        endHop: hopsPushed,
        copyWindow: windowCopier(low, mid, high, baseHop, hopsPushed, true),
      }
    },
    reset() {
      hopsPushed = 0
      hopFill = 0
      lowSum = 0
      midSum = 0
      highSum = 0
      state = { low: 0, high: 0 }
      low.fill(0)
      mid.fill(0)
      high.fill(0)
    },
  }
}
