import { describe, expect, it } from 'vitest'

import {
  createBeatGate,
  createBeatTracker,
  GATE_MIN_CONFIDENCE,
  trackBpm,
  type BeatEstimate,
} from './beat'
import {
  clickTrack as sharedClickTrack,
  kickHatTrack,
  noiseSource,
} from '../test/clickTrack'

const SAMPLE_RATE = 48_000
const CHUNK_FRAMES = 1920 // the deck wire chunk: 40 ms

function clickTrack(bpm: number, seconds: number, seed = 1): Float32Array {
  return sharedClickTrack(bpm, seconds, SAMPLE_RATE, seed)
}

function feed(tracker: ReturnType<typeof createBeatTracker>, samples: Float32Array) {
  for (let i = 0; i < samples.length; i += CHUNK_FRAMES * 2) {
    tracker.push(samples.subarray(i, i + CHUNK_FRAMES * 2))
  }
}

describe('createBeatTracker', () => {
  it.each([[90], [120], [128], [150], [174]])(
    'nails a %d bpm click train within 2%%',
    (bpm) => {
      const tracker = createBeatTracker(SAMPLE_RATE)
      feed(tracker, clickTrack(bpm, 12))
      const estimate = tracker.estimate()
      expect(estimate).not.toBeNull()
      expect(Math.abs(estimate!.bpm - bpm) / bpm).toBeLessThan(0.02)
      expect(estimate!.confidence).toBeGreaterThan(GATE_MIN_CONFIDENCE)
    },
  )

  it('returns null before enough audio has played', () => {
    const tracker = createBeatTracker(SAMPLE_RATE)
    feed(tracker, clickTrack(128, 3))
    expect(tracker.estimate()).toBeNull()
  })

  it('reports low confidence on beatless noise', () => {
    const tracker = createBeatTracker(SAMPLE_RATE)
    const noise = noiseSource(7)
    const samples = new Float32Array(12 * SAMPLE_RATE * 2)
    for (let i = 0; i < samples.length; i++) samples[i] = noise() * 0.5
    feed(tracker, samples)
    const estimate = tracker.estimate()
    // Whatever lag wins on noise, it must not pass the gate.
    expect(estimate === null || estimate.confidence < GATE_MIN_CONFIDENCE).toBe(
      true,
    )
  })

  it('returns null on silence and on a steady tone', () => {
    const silent = createBeatTracker(SAMPLE_RATE)
    feed(silent, new Float32Array(12 * SAMPLE_RATE * 2))
    expect(silent.estimate()).toBeNull()

    const toneTracker = createBeatTracker(SAMPLE_RATE)
    const tone = new Float32Array(12 * SAMPLE_RATE * 2)
    for (let i = 0; i < tone.length / 2; i++) {
      const sample = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * 0.5
      tone[2 * i] = sample
      tone[2 * i + 1] = sample
    }
    feed(toneTracker, tone)
    const estimate = toneTracker.estimate()
    expect(estimate === null || estimate.confidence < GATE_MIN_CONFIDENCE).toBe(
      true,
    )
  })

  it('reset drops the accumulated stream', () => {
    const tracker = createBeatTracker(SAMPLE_RATE)
    feed(tracker, clickTrack(128, 12))
    expect(tracker.estimate()).not.toBeNull()
    tracker.reset()
    expect(tracker.estimate()).toBeNull()
  })

  it('follows a tempo change once the window has turned over', () => {
    const tracker = createBeatTracker(SAMPLE_RATE)
    feed(tracker, clickTrack(100, 12))
    expect(tracker.estimate()!.bpm).toBeCloseTo(100, 0)
    // 14 s of the new tempo flushes the 12 s window completely.
    feed(tracker, clickTrack(150, 14, 2))
    expect(Math.abs(tracker.estimate()!.bpm - 150) / 150).toBeLessThan(0.02)
  })
})

describe('createBeatGate', () => {
  const confident = (bpm: number): BeatEstimate => ({ bpm, confidence: 0.8 })

  it('shows a tempo only after consecutive agreeing estimates', () => {
    const gate = createBeatGate()
    expect(gate.push(confident(128))).toBeNull()
    expect(gate.push(confident(128.5))).toBeNull()
    expect(gate.push(confident(127.8))).toBe(128)
    expect(gate.current()).toBe(128)
  })

  it('rides out one unconfident estimate, drops on the second', () => {
    // Deliberate: generative music breathes, and re-acquisition costs
    // 3+ s — one second of hold is not a lie, two misses in a row is.
    const gate = createBeatGate()
    gate.push(confident(128))
    gate.push(confident(128))
    gate.push(confident(128))
    expect(gate.current()).toBe(128)
    const weak = { bpm: 128, confidence: GATE_MIN_CONFIDENCE - 0.01 }
    expect(gate.push(weak)).toBe(128)
    expect(gate.push(weak)).toBeNull()
    expect(gate.current()).toBeNull()
  })

  it('refuses unstable estimates even when each is confident', () => {
    const gate = createBeatGate()
    gate.push(confident(128))
    gate.push(confident(150))
    expect(gate.push(confident(100))).toBeNull()
  })

  it('holds through a tempo change, then locks onto the new tempo', () => {
    const gate = createBeatGate()
    gate.push(confident(128))
    gate.push(confident(128))
    gate.push(confident(128))
    // The window straddles old and new estimates: hold the old number.
    expect(gate.push(confident(150))).toBe(128)
    expect(gate.push(confident(150))).toBe(128)
    // Three new-tempo estimates agree: the display follows.
    expect(gate.push(confident(150))).toBe(150)
  })

  it('drops a held readout when confident estimates keep quarrelling', () => {
    const gate = createBeatGate()
    gate.push(confident(128))
    gate.push(confident(128))
    gate.push(confident(128))
    expect(gate.push(confident(150))).toBe(128)
    expect(gate.push(confident(100))).toBe(128)
    expect(gate.push(confident(170))).toBeNull()
  })

  it('holds a locked readout still while estimates jitter within tolerance', () => {
    const gate = createBeatGate()
    gate.push(confident(128))
    gate.push(confident(128))
    gate.push(confident(128))
    expect(gate.current()).toBe(128)
    // Successive windows never agree to the last float; the display
    // (and the synced echo's clock) must not chase the jitter.
    gate.push(confident(128.4))
    gate.push(confident(127.6))
    gate.push(confident(128.3))
    expect(gate.current()).toBe(128)
    // A genuine move beyond tolerance still follows.
    gate.push(confident(140))
    gate.push(confident(140.2))
    gate.push(confident(139.8))
    expect(gate.current()).toBeCloseTo(140, 0)
  })

  it('folds octave-flapping estimates onto the held tempo', () => {
    // Half/double of the same beat structure is the same answer at
    // another metrical level (the corpus hip hop clip alternates
    // ~95/~190); flapping must read as agreement, not as a quarrel.
    const gate = createBeatGate()
    gate.push(confident(95))
    gate.push(confident(190))
    expect(gate.push(confident(95.5))).not.toBeNull()
    gate.push(confident(190))
    gate.push(confident(95))
    expect(gate.current()).not.toBeNull()
  })

  it('treats null estimates like unconfident ones', () => {
    const gate = createBeatGate()
    gate.push(confident(128))
    gate.push(confident(128))
    gate.push(confident(128))
    expect(gate.push(null)).toBe(128)
    expect(gate.push(null)).toBeNull()
    expect(gate.current()).toBeNull()
  })
})

describe('trackBpm', () => {
  function deinterleave(samples: Float32Array): [Float32Array, Float32Array] {
    const frames = samples.length / 2
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      left[i] = samples[2 * i]
      right[i] = samples[2 * i + 1]
    }
    return [left, right]
  }

  it('finds the tempo of a decoded track offline', () => {
    const [left, right] = deinterleave(clickTrack(128, 24))
    const bpm = trackBpm(left, right, SAMPLE_RATE)
    expect(bpm).not.toBeNull()
    expect(Math.abs(bpm! - 128)).toBeLessThanOrEqual(128 * 0.05)
  })

  it('stays honest on a beatless track', () => {
    const silence = new Float32Array(SAMPLE_RATE * 15)
    expect(trackBpm(silence, silence, SAMPLE_RATE)).toBeNull()
  })

  it('keeps the body reading when the outro goes beatless', () => {
    const [left, right] = deinterleave(clickTrack(128, 24))
    const tailFrames = SAMPLE_RATE * 8
    const paddedLeft = new Float32Array(left.length + tailFrames)
    const paddedRight = new Float32Array(right.length + tailFrames)
    paddedLeft.set(left)
    paddedRight.set(right)
    const bpm = trackBpm(paddedLeft, paddedRight, SAMPLE_RATE)
    expect(bpm).not.toBeNull()
    expect(Math.abs(bpm! - 128)).toBeLessThanOrEqual(128 * 0.05)
  })
})

describe('beat anchor (M20)', () => {
  it('anchors the most recent beat on the click lattice', () => {
    const tracker = createBeatTracker(SAMPLE_RATE)
    feed(tracker, clickTrack(128, 16))
    const estimate = tracker.estimate()!
    expect(estimate.anchorFrame).toBeDefined()
    const periodFrames = (60 / 128) * SAMPLE_RATE
    // Clicks land on period multiples from stream start.
    const phase = (estimate.anchorFrame! % periodFrames) / periodFrames
    expect(Math.min(phase, 1 - phase)).toBeLessThanOrEqual(0.12)
    // And the anchor is recent — the fold tracks now, not the window
    // average.
    expect(estimate.anchorFrame!).toBeGreaterThan(
      16 * SAMPLE_RATE - 3 * periodFrames,
    )
    expect(estimate.anchorFrame!).toBeLessThanOrEqual(16 * SAMPLE_RATE)
  })

  it('anchors on the kicks through offbeat hats (M20)', () => {
    const tracker = createBeatTracker(SAMPLE_RATE)
    feed(tracker, kickHatTrack(128, 16, SAMPLE_RATE))
    const estimate = tracker.estimate()!
    expect(estimate.anchorFrame).toBeDefined()
    const periodFrames = (60 / 128) * SAMPLE_RATE
    const phase = (estimate.anchorFrame! % periodFrames) / periodFrames
    // On the kick lattice — not half a period off on the louder hats.
    expect(Math.min(phase, 1 - phase)).toBeLessThanOrEqual(0.12)
  })

  it('withholds the anchor when the fold is incoherent', () => {
    const tracker = createBeatTracker(SAMPLE_RATE)
    const noise = noiseSource(11)
    const samples = new Float32Array(SAMPLE_RATE * 2 * 16)
    for (let i = 0; i < samples.length; i++) samples[i] = noise() * 0.4
    feed(tracker, samples)
    const estimate = tracker.estimate()
    if (estimate !== null) {
      expect(estimate.anchorFrame).toBeUndefined()
    }
  })
})
