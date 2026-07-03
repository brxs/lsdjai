import { describe, expect, it } from 'vitest'

import {
  BAND_HOP_FRAMES,
  bandSourceFromArrays,
  createBandScroller,
  type BandWindowTarget,
} from './bands'

const SAMPLE_RATE = 48_000

function target(hops: number): BandWindowTarget {
  return {
    low: new Float32Array(hops),
    mid: new Float32Array(hops),
    high: new Float32Array(hops),
  }
}

/** Interleaved stereo of a pure tone. */
function tone(hz: number, seconds: number): Float32Array {
  const frames = Math.round(seconds * SAMPLE_RATE)
  const out = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    const sample = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * 0.5
    out[2 * i] = sample
    out[2 * i + 1] = sample
  }
  return out
}

function dominantBand(out: BandWindowTarget, hop: number) {
  const bands = { low: out.low[hop], mid: out.mid[hop], high: out.high[hop] }
  return (Object.keys(bands) as (keyof typeof bands)[]).reduce((a, b) =>
    bands[a] >= bands[b] ? a : b,
  )
}

// The offline band pass moved shell-side with the track load (ADR-0030,
// `analysis/bands.rs` carries its band-separation suite); what stays here is
// the window contract over the shipped arrays and the live scroller.

describe('bandSourceFromArrays', () => {
  it('serves the shipped lanes and zeroes outside the data', () => {
    const hops = 6
    const low = Float32Array.from({ length: hops }, (_, i) => i + 1)
    const source = bandSourceFromArrays(low, new Float32Array(hops), new Float32Array(hops))
    expect(source.baseHop).toBe(0)
    expect(source.endHop).toBe(hops)
    const out = target(4)
    source.copyWindow(hops - 2, out)
    expect(out.low[0]).toBe(hops - 1)
    expect(out.low[1]).toBe(hops)
    expect(out.low[2]).toBe(0)
    expect(out.low[3]).toBe(0)
  })
})

describe('createBandScroller', () => {
  it('separates a bass tone into the low band, fed in uneven chunks', () => {
    const samples = tone(60, 2)
    const scroller = createBandScroller(SAMPLE_RATE)
    // Feed in uneven chunks: hop accumulation must not care.
    let offset = 0
    for (const size of [12_344, 67_890, samples.length]) {
      const end = Math.min(size + offset, samples.length)
      scroller.push(samples.subarray(offset, end))
      offset = end
      if (offset >= samples.length) break
    }
    const live = target(16)
    scroller.source().copyWindow(50, live)
    expect(dominantBand(live, 0)).toBe('low')
    expect(live.low[0]).toBeGreaterThan(0)
  })

  it('separates a bright tone into the high band', () => {
    const scroller = createBandScroller(SAMPLE_RATE)
    scroller.push(tone(10_000, 1))
    const live = target(8)
    scroller.source().copyWindow(20, live)
    expect(dominantBand(live, 0)).toBe('high')
  })

  it('keeps absolute hop indexing across the ring wrap', () => {
    const scroller = createBandScroller(SAMPLE_RATE)
    // Push 70 seconds into a 60-second ring.
    const chunk = tone(60, 5)
    for (let i = 0; i < 14; i++) scroller.push(chunk)
    const source = scroller.source()
    const totalHops = Math.floor((70 * SAMPLE_RATE) / BAND_HOP_FRAMES)
    expect(source.endHop).toBe(totalHops)
    expect(source.baseHop).toBe(totalHops - Math.ceil((60 * SAMPLE_RATE) / BAND_HOP_FRAMES))
    // A window straddling the base: zeros before it, signal after.
    const out = target(4)
    source.copyWindow(source.baseHop - 2, out)
    expect(out.low[0]).toBe(0)
    expect(out.low[1]).toBe(0)
    expect(out.low[2]).toBeGreaterThan(0)
  })

  it('reset forgets the stream', () => {
    const scroller = createBandScroller(SAMPLE_RATE)
    scroller.push(tone(60, 2))
    scroller.reset()
    const source = scroller.source()
    expect(source.endHop).toBe(0)
  })
})
