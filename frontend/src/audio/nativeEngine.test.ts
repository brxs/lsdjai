import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SAMPLE_RATE } from './types'
import { createNativeEngine } from './nativeEngine'

// A controllable __TAURI__ global: records every invoke and serves a test
// snapshot for `engine_snapshot`. rAF is stubbed so the poller can be flushed
// deterministically.

type InvokeCall = { cmd: string; args: unknown }

let calls: InvokeCall[]
let snapshot: unknown
let rafQueue: FrameRequestCallback[]

function flushRaf() {
  const due = rafQueue
  rafQueue = []
  for (const cb of due) cb(performance.now())
}

/** Run the poller a few times so a cached snapshot is in place. */
async function settle() {
  for (let i = 0; i < 3; i++) {
    flushRaf()
    await Promise.resolve()
    await Promise.resolve()
  }
}

beforeEach(() => {
  calls = []
  snapshot = null
  rafQueue = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  const invoke = vi.fn((cmd: string, args?: unknown) => {
    calls.push({ cmd, args })
    if (cmd === 'engine_snapshot') return Promise.resolve(snapshot)
    if (cmd === 'stop_recording') return Promise.resolve(new ArrayBuffer(44)) // a WAV
    return Promise.resolve(undefined)
  })
  vi.stubGlobal('__TAURI__', { core: { invoke } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const SNAP = {
  health: {
    outputRingFrames: 3600,
    deckRingFrames: [48000, 0],
    deckUnderruns: 0,
    outputUnderruns: 0,
    masterPeak: 0.42,
    masterGainReductionDb: -1.5,
    deckLevels: [0.3, 0.0],
    contextFrames: SAMPLE_RATE * 2, // 2 s of clock
  },
  tracks: [
    {
      playhead: SAMPLE_RATE * 10, // 10 s in
      playing: true,
      durationFrames: SAMPLE_RATE * 100, // 100 s long
      rate: 1.0,
      ended: false,
      loopRegion: { start: SAMPLE_RATE * 4, end: SAMPLE_RATE * 8 },
    },
    null,
  ],
  loops: [
    [
      { filled: true, playing: false },
      { filled: false, playing: false },
    ],
    [{ filled: false, playing: false }],
  ],
}

describe('createNativeEngine — control contract', () => {
  it('createDeckChannel applies the initial config as invoke commands', async () => {
    const engine = createNativeEngine()
    await engine.createDeckChannel(
      'b',
      { volume: 0.8, eq: { low: 0.5, mid: 0.5, high: 0.5 }, cue: false, fx: { kind: null, amount: 0 }, trimDb: 3 },
      () => {},
    )
    const cmds = calls.map((c) => c.cmd)
    expect(cmds).toContain('set_volume')
    expect(cmds).toContain('set_eq')
    expect(cmds).toContain('clear_fx') // fx kind null → clear
    expect(cmds).toContain('set_trim')
    // deck 'b' → index 1
    expect(calls.find((c) => c.cmd === 'set_volume')?.args).toEqual({ deck: 1, gain: 0.8 })
    expect(calls.find((c) => c.cmd === 'set_trim')?.args).toEqual({ deck: 1, db: 3 })
  })

  it('maps deck ids and FX kinds (snake→camel) and routes null to clear_fx', async () => {
    const engine = createNativeEngine()
    const ch = await engine.createDeckChannel(
      'a',
      { volume: 1, eq: { low: 0.5, mid: 0.5, high: 0.5 }, cue: false, fx: { kind: null, amount: 0 }, trimDb: 0 },
      () => {},
    )
    calls.length = 0
    ch.setFx('dub_echo')
    ch.setFxAmount(0.7)
    ch.setOnAir(false)
    ch.setEq('high', 0.9)
    expect(calls).toContainEqual({ cmd: 'set_fx', args: { deck: 0, kind: 'dubEcho' } })
    expect(calls).toContainEqual({ cmd: 'set_fx_amount', args: { deck: 0, amount: 0.7 } })
    expect(calls).toContainEqual({ cmd: 'set_on_air', args: { deck: 0, on: false } })
    expect(calls).toContainEqual({ cmd: 'set_eq', args: { deck: 0, band: 'high', value: 0.9 } })

    calls.length = 0
    ch.setFx(null)
    expect(calls).toContainEqual({ cmd: 'clear_fx', args: { deck: 0 } })
  })

  it('converts transport units (seconds↔frames) at the boundary', async () => {
    const engine = createNativeEngine()
    const ch = await engine.createDeckChannel(
      'a',
      { volume: 1, eq: { low: 0.5, mid: 0.5, high: 0.5 }, cue: false, fx: { kind: null, amount: 0 }, trimDb: 0 },
      () => {},
    )
    calls.length = 0
    ch.seekTrack(2)
    ch.setTrackLoop(1, 1.5)
    expect(calls).toContainEqual({ cmd: 'seek_track', args: { deck: 0, frames: 2 * SAMPLE_RATE } })
    expect(calls).toContainEqual({
      cmd: 'set_track_loop',
      args: { deck: 0, start: 1 * SAMPLE_RATE, end: Math.round(1.5 * SAMPLE_RATE) },
    })
  })

  it('setCrossfade goes to the engine', async () => {
    const engine = createNativeEngine()
    await engine.createDeckChannel(
      'a',
      { volume: 1, eq: { low: 0.5, mid: 0.5, high: 0.5 }, cue: false, fx: { kind: null, amount: 0 }, trimDb: 0 },
      () => {},
    )
    calls.length = 0
    engine.setCrossfade(0.25)
    expect(calls).toContainEqual({ cmd: 'set_crossfade', args: { position: 0.25 } })
  })
})

describe('createNativeEngine — snapshot-backed getters', () => {
  it('serves synchronous getters from the cached snapshot', async () => {
    snapshot = SNAP
    const engine = createNativeEngine()
    const ch = await engine.createDeckChannel(
      'a',
      { volume: 1, eq: { low: 0.5, mid: 0.5, high: 0.5 }, cue: false, fx: { kind: null, amount: 0 }, trimDb: 0 },
      () => {},
    )
    await settle()

    expect(engine.getMasterLevel()).toBeCloseTo(0.42)
    expect(engine.getMasterGainReduction()).toBeCloseTo(-1.5)
    expect(engine.getContextTime()).toBeCloseTo(2)
    expect(ch.getLevel()).toBeCloseTo(0.3)

    const status = ch.getTrackStatus()
    expect(status).not.toBeNull()
    expect(status!.position).toBeCloseTo(10)
    expect(status!.duration).toBeCloseTo(100)
    expect(status!.playing).toBe(true)
    expect(status!.loop).toEqual({ start: 4, end: 8 })
    expect(status!.contextTime).toBeCloseTo(2)
  })

  it('playLoop reports the cached filled state and only fires when filled', async () => {
    snapshot = SNAP
    const engine = createNativeEngine()
    const ch = await engine.createDeckChannel(
      'a',
      { volume: 1, eq: { low: 0.5, mid: 0.5, high: 0.5 }, cue: false, fx: { kind: null, amount: 0 }, trimDb: 0 },
      () => {},
    )
    await settle()
    calls.length = 0

    expect(ch.playLoop(0)).toBe(true) // slot 0 filled
    expect(calls).toContainEqual({ cmd: 'play_loop', args: { deck: 0, slot: 0 } })

    calls.length = 0
    expect(ch.playLoop(1)).toBe(false) // slot 1 empty
    expect(calls.find((c) => c.cmd === 'play_loop')).toBeUndefined()
  })

  it('drives the per-deck stats handler from the snapshot', async () => {
    snapshot = SNAP
    const engine = createNativeEngine()
    const stats = vi.fn()
    await engine.createDeckChannel(
      'a',
      { volume: 1, eq: { low: 0.5, mid: 0.5, high: 0.5 }, cue: false, fx: { kind: null, amount: 0 }, trimDb: 0 },
      stats,
    )
    await settle()
    expect(stats).toHaveBeenCalled()
    const last = stats.mock.calls.at(-1)![0]
    expect(last.bufferedSeconds).toBeCloseTo(1) // 48000 frames / SR
    expect(last.contextTime).toBeCloseTo(2)
    expect(last.playing).toBe(true)
  })
})

describe('createNativeEngine — graceful native stubs', () => {
  it('recording drives the engine commands and returns a WAV blob', async () => {
    const engine = createNativeEngine()
    await engine.startRecording()
    const blob = await engine.stopRecording()
    const cmds = calls.map((c) => c.cmd)
    expect(cmds).toContain('start_recording')
    expect(cmds).toContain('stop_recording')
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('audio/wav')
  })

  it('resume resolves without throwing and cue-mix goes to the engine', async () => {
    const engine = createNativeEngine()
    await expect(engine.resume()).resolves.toBeUndefined()
    calls.length = 0
    engine.setCueMix(0.3)
    expect(calls).toContainEqual({ cmd: 'set_cue_mix', args: { position: 0.3 } })
  })
})
