/** useDeck behaviour over the native (Tauri) transport, with fake timers and
 * a fake audio engine. The deck is "open" the instant it mounts — there is no
 * socket handshake. Status arrives as `sidecar://status` events (a captured
 * `event.listen` callback), model PCM arrives over a Tauri `Channel`, and
 * control is forwarded as `core.invoke` deck_* commands. This harness mocks
 * `globalThis.__TAURI__` for all three. The real audio graph stays on the e2e
 * script. */

import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AudioEngineProvider } from '../audio/AudioEngineProvider'
import * as beatModule from '../audio/beat'
import { updateDeckSettings } from '../persistence'
import { clickTrack } from '../test/clickTrack'
import type { AudioEngine, DeckChannel } from '../audio/types'
import { useDeck } from './useDeck'

/** Wrap useDeck's beat tracker so a test can watch what reaches the live
 * analysis: spy on the factory, return the real tracker, and record every
 * `push`. The deck feeds the tracker only on the live (non-parked) PCM path,
 * so this is the direct observable for the parked-straggler guard. Install
 * before rendering the deck — the tracker is built at mount. */
function spyOnTrackerPush() {
  const realCreate = beatModule.createBeatTracker
  const push = vi.fn()
  vi.spyOn(beatModule, 'createBeatTracker').mockImplementation((sampleRate) => {
    const tracker = realCreate(sampleRate)
    const realPush = tracker.push
    tracker.push = (samples) => {
      push(samples)
      realPush(samples)
    }
    return tracker
  })
  return push
}

/** The captured native transport: the latest `sidecar://status` callback, the
 * latest PCM `Channel` instance, and the `core.invoke` spy recording every
 * native command. The deck (deck 'a' = index 0) is the only one under test. */
type NativeChannel = { onmessage: ((buffer: ArrayBuffer) => void) | null }

const native: {
  invoke: ReturnType<typeof vi.fn>
  statusCb: ((e: { payload: { deck: number; json: string } }) => void) | null
  pcmChannel: NativeChannel | null
} = { invoke: vi.fn(), statusCb: null, pcmChannel: null }

function installNativeTauri() {
  native.statusCb = null
  native.pcmChannel = null
  native.invoke = vi.fn((cmd: string) =>
    // app_info feeds getApiBaseUrl(); null port → '' (relative fetches).
    cmd === 'app_info'
      ? Promise.resolve({ generationPort: null })
      : Promise.resolve(undefined),
  )
  class Channel {
    onmessage: ((buffer: ArrayBuffer) => void) | null = null
    constructor() {
      native.pcmChannel = this
    }
  }
  const listen = vi.fn(
    (event: string, cb: (e: { payload: { deck: number; json: string } }) => void) => {
      if (event === 'sidecar://status') native.statusCb = cb
      return Promise.resolve(() => {})
    },
  )
  vi.stubGlobal('__TAURI__', {
    core: { invoke: native.invoke, Channel },
    event: { listen },
  })
  // /api/models — the deck_info fetch is irrelevant to these tests; keep it
  // benign so the deck-open effect never throws. Per-test stubs (stubFetchOk)
  // override this for the generated-pad suite.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
  )
}

/** The deck is open on mount (no handshake): serverOpen() is a no-op, kept so
 * existing call sites read clearly. serverEvent() fires the captured status
 * callback as that deck's status frame. The only deck under test is 'a'
 * (index 0); `socket(0)` reads like the old fake-WebSocket accessor. */
const socket = (deck: number) => ({
  serverOpen: () => {},
  serverEvent: (event: object) =>
    native.statusCb?.({ payload: { deck, json: JSON.stringify(event) } }),
})

/** Fire the captured PCM Channel's onmessage with one raw f32 frame buffer —
 * the native replacement for the old socket PCM feed. */
function feedPcm(buffer: ArrayBuffer) {
  native.pcmChannel?.onmessage?.(buffer)
}

function makeFakeEngine(overrides: Partial<AudioEngine> = {}) {
  // Captured so tests can feed worklet stats into the deck (M20).
  const captured: { onStats: Parameters<AudioEngine['createDeckChannel']>[2] | null } = {
    onStats: null,
  }
  const channel: DeckChannel = {
    postPcm: vi.fn(),
    reset: vi.fn(),
    setVolume: vi.fn(),
    setEq: vi.fn(),
    setCue: vi.fn(),
    setFx: vi.fn(),
    setFxAmount: vi.fn(),
    setBeatPeriod: vi.fn(),
    setTrim: vi.fn(),
    setOnAir: vi.fn(),
    captureLoop: vi.fn(async () => true),
    loadGeneratedLoop: vi.fn(async () => true),
    playLoop: vi.fn(() => true),
    stopLoop: vi.fn(),
    stopOneShot: vi.fn(),
    clearLoop: vi.fn(),
    captureSample: vi.fn(async () => new Float32Array(2)),
    loadTrack: vi.fn(async () => ({
      duration: 120,
      sampleRate: 48_000,
      left: new Float32Array(0),
      right: new Float32Array(0),
    })),
    playTrack: vi.fn(() => true),
    pauseTrack: vi.fn(),
    seekTrack: vi.fn(),
    setTrackLoop: vi.fn(),
    clearTrackLoop: vi.fn(),
    getTrackStatus: vi.fn(() => null),
    setTrackRate: vi.fn(),
    nudgeTrackPhase: vi.fn(),
    getTrackPeaks: vi.fn(() => null),
    unloadTrack: vi.fn(),
    getLevel: vi.fn(() => 0),
    dispose: vi.fn(),
  }
  const engine: AudioEngine = {
    // 0 keeps the engine's render clock and the played-frame domain consistent:
    // the de-branched useDeck anchors the live-beat origin at
    // getContextTime()·SR on each stream reset, and the M20 stats below report
    // playedFrames in the per-stream (origin-0) domain. A non-zero clock here
    // would offset the live-beat lattice by getContextTime() seconds and the
    // M20 beat-clock assertion would read a fractional beat (ADR-0014).
    getContextTime: vi.fn(() => 0),
    createDeckChannel: vi.fn(async (_deck, _initial, onStats) => {
      captured.onStats = onStats
      return channel
    }),
    resume: vi.fn(async () => {}),
    setCrossfade: vi.fn(),
    setCueMix: vi.fn(),
    listOutputDevices: vi.fn(async () => []),
    setOutputDevice: vi.fn(async () => {}),
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => new Blob()),
    getMasterLevel: vi.fn(() => 0),
    getMasterGainReduction: vi.fn(() => 0),
    ...overrides,
  }
  return { engine, channel, captured }
}

function renderDeck(engine: AudioEngine) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AudioEngineProvider engine={engine}>{children}</AudioEngineProvider>
  )
  return renderHook(() => useDeck('a'), { wrapper })
}

beforeEach(() => {
  vi.useFakeTimers()
  installNativeTauri()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  // Restore any vi.spyOn factories (e.g. the beat-tracker push spy) so they
  // never leak into the next test's real tracker.
  vi.restoreAllMocks()
})

/** The recorded native deck CONTROL commands in order — the native analogue of
 * the old `socket.sent`. Excludes the transport-setup invokes (`app_info` for
 * getApiBaseUrl, `subscribe_deck_pcm`/`unsubscribe_deck_pcm` for the PCM tee),
 * which the deck-open effect fires regardless of what the user does. */
function deckInvokes() {
  return native.invoke.mock.calls.filter(([cmd]) => (cmd as string).startsWith('deck_'))
}

describe('useDeck connection', () => {
  it('is open on mount with no handshake', () => {
    const { result } = renderDeck(makeFakeEngine().engine)
    // The native transport has no socket: the deck is operable at once.
    expect(result.current.state.connection).toBe('open')
  })

  it('forwards set_style as a native deck command', () => {
    const { result } = renderDeck(makeFakeEngine().engine)

    const style = { prompts: [{ text: 'warm disco funk', weight: 1 }] }
    act(() => socket(0).serverOpen())
    act(() => result.current.setStyle(style))
    expect(native.invoke).toHaveBeenCalledWith('deck_set_style', {
      deck: 0,
      prompts: [{ text: 'warm disco funk', weight: 1 }],
    })
  })

  it('surfaces a play() audio failure instead of swallowing it', async () => {
    const { engine } = makeFakeEngine({
      createDeckChannel: vi.fn(async () => {
        throw new Error('worklet failed to load')
      }),
    })
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())

    await act(() => result.current.play())
    expect(result.current.state.error).toBe('worklet failed to load')
    expect(result.current.state.playing).toBe(false)
    // No play command without audio.
    expect(native.invoke).not.toHaveBeenCalledWith('deck_play', { deck: 0 })
  })

  it('plays through the shared engine and resets stale buffer first', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())

    await act(() => result.current.play())
    expect(engine.resume).toHaveBeenCalled()
    expect(channel.reset).toHaveBeenCalled()
    expect(deckInvokes()).toEqual([['deck_play', { deck: 0 }]])
    expect(result.current.state.playing).toBe(true)
  })

  it('flushes the ring buffer when a model switch starts', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())
    const resetsBefore = vi.mocked(channel.reset).mock.calls.length

    act(() => socket(0).serverEvent({ event: 'model_loading', model: 'mrt2_base' }))
    expect(vi.mocked(channel.reset).mock.calls.length).toBe(resetsBefore + 1)
    expect(result.current.state.switchingModel).toBe(true)
    expect(result.current.state.playing).toBe(false)
  })

  it('silences the ring buffer when the worker dies', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())
    const resetsBefore = vi.mocked(channel.reset).mock.calls.length

    act(() => socket(0).serverEvent({ event: 'worker_died', model: 'mrt2_small' }))
    expect(vi.mocked(channel.reset).mock.calls.length).toBe(resetsBefore + 1)
    expect(result.current.state.workerDied).toBe(true)
  })

  it('maps set_model and restart to native deck_set_model', () => {
    const { result } = renderDeck(makeFakeEngine().engine)
    act(() => socket(0).serverOpen())

    // The worker must report a model first, so restart carries one through.
    act(() => socket(0).serverEvent({ event: 'ready', deck: 'a', model: 'mrt2_base' }))
    act(() => result.current.setModel('mrt2_base'))
    act(() => result.current.restartWorker())
    // Both control gestures collapse to deck_set_model on the native path:
    // set_model with its target, restart re-using the current model.
    expect(deckInvokes()).toEqual([
      ['deck_set_model', { deck: 0, model: 'mrt2_base' }],
      ['deck_set_model', { deck: 0, model: 'mrt2_base' }],
    ])
  })

  it('restores persisted EQ and applies band changes to the channel', async () => {
    updateDeckSettings('a', { eq: { low: 0.2, mid: 0.5, high: 0.9 } })
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    expect(result.current.eq).toEqual({ low: 0.2, mid: 0.5, high: 0.9 })

    act(() => socket(0).serverOpen())
    await act(() => result.current.play())
    // The channel was built with the restored EQ…
    expect(vi.mocked(engine.createDeckChannel).mock.calls[0][1]).toMatchObject({
      eq: { low: 0.2, mid: 0.5, high: 0.9 },
    })
    // …and live band moves reach it.
    act(() => result.current.setEqBand('low', 0))
    expect(channel.setEq).toHaveBeenCalledWith('low', 0)
    expect(result.current.eq.low).toBe(0)
  })

  it('restores the persisted volume', () => {
    updateDeckSettings('a', { volume: 0.55 })
    const { result } = renderDeck(makeFakeEngine().engine)
    expect(result.current.volume).toBe(0.55)
  })

  it('primes off air and drops on air without flushing the prepped buffer', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())

    await act(() => result.current.prime())
    expect(channel.setOnAir).toHaveBeenLastCalledWith(false)
    expect(result.current.primed).toBe(true)
    expect(deckInvokes()).toEqual([['deck_play', { deck: 0 }]])

    vi.mocked(channel.reset).mockClear()
    await act(() => result.current.play())
    expect(channel.setOnAir).toHaveBeenLastCalledWith(true)
    expect(result.current.primed).toBe(false)
    // The drop must not flush the prepped audio or re-send play.
    expect(channel.reset).not.toHaveBeenCalled()
    expect(deckInvokes()).toEqual([['deck_play', { deck: 0 }]])
  })

  it('stop while primed flushes and puts the channel back on air', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())

    await act(() => result.current.prime())
    act(() => result.current.stop())
    expect(result.current.primed).toBe(false)
    expect(channel.reset).toHaveBeenCalled()
    expect(channel.setOnAir).toHaveBeenLastCalledWith(true)
  })

  it('restores persisted FX, routes changes, and parks the knob on switch', async () => {
    updateDeckSettings('a', { fx: { kind: 'dub_echo', amount: 0.6 } })
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    expect(result.current.fx).toEqual({ kind: 'dub_echo', amount: 0.6 })

    act(() => socket(0).serverOpen())
    await act(() => result.current.play())
    // The channel is built with the restored effect…
    expect(vi.mocked(engine.createDeckChannel).mock.calls[0][1]).toMatchObject({
      fx: { kind: 'dub_echo', amount: 0.6 },
    })

    // …live knob moves reach it…
    act(() => result.current.setFxAmount(0.8))
    expect(channel.setFxAmount).toHaveBeenCalledWith(0.8)

    // …and switching to the bipolar filter parks the knob at centre.
    act(() => result.current.setFx('filter'))
    expect(result.current.fx).toEqual({ kind: 'filter', amount: 0.5 })
    expect(channel.setFx).toHaveBeenCalledWith('filter')
    expect(channel.setFxAmount).toHaveBeenLastCalledWith(0.5)
  })

  it('seeds a pre-play cue toggle into the channel and routes live ones', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)

    // Toggled before the channel exists — must ride along at creation.
    act(() => result.current.setCue(true))
    expect(result.current.cue).toBe(true)

    act(() => socket(0).serverOpen())
    await act(() => result.current.play())
    expect(vi.mocked(engine.createDeckChannel).mock.calls[0][1]).toMatchObject({
      cue: true,
    })

    act(() => result.current.setCue(false))
    expect(channel.setCue).toHaveBeenCalledWith(false)
    expect(result.current.cue).toBe(false)
  })

  it('drops a malformed status frame without crashing', () => {
    const { result } = renderDeck(makeFakeEngine().engine)
    act(() => socket(0).serverOpen())

    // A malformed status line is dropped inside subscribeSidecarStatus, never
    // fatal; the deck stays operable.
    act(() => native.statusCb?.({ payload: { deck: 0, json: '{not json' } }))
    expect(result.current.state.connection).toBe('open')
  })
})

describe('useDeck beat readout', () => {
  function streamClicks(bpm: number, seconds: number) {
    const samples = clickTrack(bpm, seconds, 48_000)
    const chunk = 1920 * 2 // the 40 ms wire chunk
    act(() => {
      for (let i = 0; i < samples.length; i += chunk) {
        feedPcm(samples.slice(i, i + chunk).buffer)
      }
    })
  }

  it('surfaces a gated BPM from the deck stream and drops it on stop', async () => {
    const { engine } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())

    streamClicks(128, 16)
    // Three 1 Hz gate ticks: strict acquisition needs three agreeing
    // confident estimates.
    act(() => void vi.advanceTimersByTime(3_000))
    expect(result.current.bpm).not.toBeNull()
    expect(Math.abs(result.current.bpm! - 128) / 128).toBeLessThan(0.02)

    act(() => result.current.stop())
    expect(result.current.bpm).toBeNull()
  })

  it('shows nothing for a beatless stream', async () => {
    const { engine } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())

    const silence = new Float32Array(16 * 48_000 * 2)
    const chunk = 1920 * 2
    act(() => {
      for (let i = 0; i < silence.length; i += chunk) {
        feedPcm(silence.slice(i, i + chunk).buffer)
      }
    })
    act(() => void vi.advanceTimersByTime(5_000))
    expect(result.current.bpm).toBeNull()
  })

  it('hands the beat period to the channel and clears it with the gate', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())

    streamClicks(128, 16)
    act(() => void vi.advanceTimersByTime(3_000))
    const bpm = result.current.bpm!
    expect(channel.setBeatPeriod).toHaveBeenLastCalledWith(60 / bpm)

    act(() => result.current.stop())
    expect(channel.setBeatPeriod).toHaveBeenLastCalledWith(null)
  })

  it('quantises a capture to whole beats when the gate is confident', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())

    streamClicks(128, 16)
    act(() => void vi.advanceTimersByTime(3_000))
    const bpm = result.current.bpm!

    await act(async () => result.current.toggleLoopPad(0))
    const seconds = vi.mocked(channel.captureLoop).mock.calls.at(-1)![1]
    const beats = (seconds * bpm) / 60
    expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-6)
    expect(seconds).not.toBe(4) // 4 s is off-grid at ~128 bpm
  })

  it('forgets the stream across a model switch', async () => {
    const { engine } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())
    streamClicks(128, 16)
    act(() => void vi.advanceTimersByTime(3_000))
    expect(result.current.bpm).not.toBeNull()

    act(() => socket(0).serverEvent({ event: 'model_loading', model: 'mrt2_base' }))
    expect(result.current.bpm).toBeNull()
    // The next tick has no accumulated audio: still nothing.
    act(() => void vi.advanceTimersByTime(1_000))
    expect(result.current.bpm).toBeNull()
  })
})

describe('useDeck trim (auto-gain)', () => {
  function streamConstant(amplitude: number, seconds: number) {
    const chunk = new Float32Array(1920 * 2).fill(amplitude)
    const chunks = Math.ceil((seconds * 48_000) / 1920)
    act(() => {
      for (let i = 0; i < chunks; i++) {
        feedPcm(chunk.slice().buffer)
      }
    })
  }

  it('auto-trims a quiet stream up toward the loudness target', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())

    // Constant 0.075 → RMS 0.075, half the 0.15 target → +6 dB.
    streamConstant(0.075, 12)
    act(() => void vi.advanceTimersByTime(1_000))
    expect(result.current.trim.mode).toBe('auto')
    expect(result.current.trim.db).toBeCloseTo(6, 0)
    expect(vi.mocked(channel.setTrim).mock.calls.at(-1)![0]).toBeCloseTo(6, 0)
  })

  it('holds the trim over silence instead of winding up', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())

    streamConstant(0, 12)
    act(() => void vi.advanceTimersByTime(2_000))
    expect(result.current.trim.db).toBe(0)
    expect(channel.setTrim).not.toHaveBeenCalled()
  })

  it('a manual move takes over until AUTO re-engages', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())

    act(() => result.current.setTrimDb(-3))
    expect(result.current.trim).toEqual({ mode: 'manual', db: -3 })
    expect(channel.setTrim).toHaveBeenLastCalledWith(-3)

    // Auto must not fight the manual value on the next tick.
    streamConstant(0.075, 12)
    act(() => void vi.advanceTimersByTime(1_000))
    expect(result.current.trim).toEqual({ mode: 'manual', db: -3 })

    act(() => result.current.enableAutoTrim())
    expect(result.current.trim.mode).toBe('auto')
    expect(result.current.trim.db).toBeCloseTo(6, 0)
  })

  it('restores the persisted trim and seeds the channel with it', async () => {
    updateDeckSettings('a', { trim: { mode: 'manual', db: -4.5 } })
    const { engine } = makeFakeEngine()
    const { result } = renderDeck(engine)
    expect(result.current.trim).toEqual({ mode: 'manual', db: -4.5 })

    act(() => socket(0).serverOpen())
    await act(() => result.current.play())
    expect(vi.mocked(engine.createDeckChannel).mock.calls[0][1]).toMatchObject({
      trimDb: -4.5,
    })
  })
})

describe('useDeck freeze loops', () => {
  async function playingDeck(engine: AudioEngine) {
    const rendered = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => rendered.result.current.play())
    return rendered
  }

  it('captures into an empty slot and freezes onto it in one press', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)

    await act(async () => result.current.toggleLoopPad(1))
    expect(channel.captureLoop).toHaveBeenCalledWith(1, 4)
    expect(channel.playLoop).toHaveBeenCalledWith(1)
    expect(result.current.loop.slots[1].state).toBe('filled')
    expect(result.current.loop.active).toBe(1)
  })

  it('returns to live on a second press, keeping the capture', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)
    await act(async () => result.current.toggleLoopPad(0))

    await act(async () => result.current.toggleLoopPad(0))
    expect(channel.stopLoop).toHaveBeenCalled()
    expect(result.current.loop.active).toBeNull()
    expect(result.current.loop.slots[0].state).toBe('filled')
  })

  it('swaps onto a filled slot without recapturing', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)
    await act(async () => result.current.toggleLoopPad(0))
    await act(async () => result.current.toggleLoopPad(1))
    vi.mocked(channel.captureLoop).mockClear()

    await act(async () => result.current.toggleLoopPad(0))
    expect(channel.captureLoop).not.toHaveBeenCalled()
    expect(channel.playLoop).toHaveBeenLastCalledWith(0)
    expect(result.current.loop.active).toBe(0)
  })

  it('refuses the press when too little has played to loop', async () => {
    const { engine, channel } = makeFakeEngine()
    vi.mocked(channel.captureLoop).mockResolvedValue(false)
    const { result } = await playingDeck(engine)

    await act(async () => result.current.toggleLoopPad(0))
    expect(channel.playLoop).not.toHaveBeenCalled()
    expect(result.current.loop.slots[0].state).toBe('empty')
    expect(result.current.loop.active).toBeNull()
  })

  it('is a safe no-op before the channel exists', () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)

    act(() => result.current.toggleLoopPad(0))
    expect(channel.captureLoop).not.toHaveBeenCalled()
    expect(result.current.loop.slots[0].state).toBe('empty')
  })

  it('stop() drops the loop but keeps the capture', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)
    await act(async () => result.current.toggleLoopPad(2))

    act(() => result.current.stop())
    expect(channel.stopLoop).toHaveBeenCalled()
    expect(result.current.loop.active).toBeNull()
    expect(result.current.loop.slots[2].state).toBe('filled')
  })

  it('clears a slot, stopping it first when it is the active one', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)
    await act(async () => result.current.toggleLoopPad(3))

    act(() => result.current.clearLoopPad(3))
    expect(channel.stopLoop).toHaveBeenCalled()
    expect(channel.clearLoop).toHaveBeenCalledWith(3)
    expect(result.current.loop.slots[3].state).toBe('empty')
    expect(result.current.loop.active).toBeNull()
  })

  it('a STOP during the capture round-trip wins over the stale capture', async () => {
    const { engine, channel } = makeFakeEngine()
    let finishCapture!: (captured: boolean) => void
    vi.mocked(channel.captureLoop).mockImplementation(
      () => new Promise((resolve) => (finishCapture = resolve)),
    )
    const { result } = await playingDeck(engine)

    act(() => result.current.toggleLoopPad(0))
    act(() => result.current.stop())
    await act(async () => finishCapture(true))

    expect(channel.playLoop).not.toHaveBeenCalled()
    expect(result.current.loop.slots[0].state).toBe('empty')
    expect(result.current.loop.active).toBeNull()
  })

  it('restores the persisted loop length and captures with it', async () => {
    updateDeckSettings('a', { loopSeconds: 8 })
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)
    expect(result.current.loop.seconds).toBe(8)

    await act(async () => result.current.toggleLoopPad(0))
    expect(channel.captureLoop).toHaveBeenCalledWith(0, 8)
  })

  it('routes a live length change into the next capture', async () => {
    updateDeckSettings('a', { loopSeconds: 4 })
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)

    act(() => result.current.setLoopSeconds(2))
    await act(async () => result.current.toggleLoopPad(0))
    expect(channel.captureLoop).toHaveBeenCalledWith(0, 2)
  })
})

describe('useDeck generated pads', () => {
  async function playingDeck(engine: AudioEngine) {
    const rendered = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => rendered.result.current.play())
    return rendered
  }

  function streamClicks(bpm: number, seconds: number) {
    const samples = clickTrack(bpm, seconds, 48_000)
    const chunk = 1920 * 2 // the 40 ms wire chunk
    act(() => {
      for (let i = 0; i < samples.length; i += chunk) {
        feedPcm(samples.slice(i, i + chunk).buffer)
      }
    })
  }

  function stubFetchOk() {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(16),
      json: async () => ({}),
    }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function requestBody(fetchMock: ReturnType<typeof vi.fn>) {
    const [, init] = fetchMock.mock.calls.at(-1)! as [string, { body: string }]
    return JSON.parse(init.body) as {
      prompt: string
      seconds: number
      kind: string
    }
  }

  /** The generation requests only — the deck-open effect's `/api/models` fetch
   * (native: no `hello` carries the model list) shares this `fetch` mock. */
  function generateCalls(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.filter(([url]) =>
      /\/api\/(generate|render)$/.test(url as string),
    )
  }

  it('generates an sfx one-shot into the first empty slot', async () => {
    const fetchMock = stubFetchOk()
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)

    act(() => result.current.generateToPad('  vinyl spinback  ', 'sfx', true))
    expect(result.current.loop.slots[0]).toEqual({
      state: 'pending',
      label: 'vinyl spinback',
      oneShot: true,
    })

    await act(async () => {})
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generate',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(requestBody(fetchMock)).toEqual({
      prompt: 'vinyl spinback',
      seconds: 4,
      kind: 'sfx',
    })
    expect(channel.loadGeneratedLoop).toHaveBeenCalledWith(
      0,
      expect.any(ArrayBuffer),
      true,
    )
    expect(result.current.loop.slots[0]).toEqual({
      state: 'filled',
      label: 'vinyl spinback',
      oneShot: true,
    })
    expect(result.current.loop.active).toBeNull()
  })

  it('shapes a loop by the locked tempo: whole bars, BPM in the prompt', async () => {
    const fetchMock = stubFetchOk()
    const { engine } = makeFakeEngine()
    const { result } = await playingDeck(engine)
    streamClicks(128, 16)
    act(() => void vi.advanceTimersByTime(3_000))
    const bpm = result.current.bpm!

    act(() => result.current.generateToPad('deep house groove', 'music', false))
    await act(async () => {})
    const body = requestBody(fetchMock)
    expect(body.kind).toBe('music')
    expect(body.prompt).toBe(`deep house groove, ${Math.round(bpm)} BPM`)
    // The request carries the seam surplus on top of a whole-bar length
    // that clears the model's quality floor.
    const bars = ((body.seconds - 0.03) * bpm) / 60 / 4
    expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-6)
    expect(body.seconds).toBeGreaterThanOrEqual(7)
  })

  it('renders through the third Magenta engine', async () => {
    const fetchMock = stubFetchOk()
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)
    streamClicks(128, 16)
    act(() => void vi.advanceTimersByTime(3_000))

    act(() => result.current.generateToPad('dub chords', 'magenta', false))
    await act(async () => {})
    const [url] = fetchMock.mock.calls.at(-1)! as unknown as [string]
    expect(url).toBe('/api/render')
    const body = requestBody(fetchMock)
    // No kind field, no BPM stamp (Magenta ignores tempo text by
    // design), no sm-music quality floor — the picker's length plus
    // the seam surplus.
    expect(body).toEqual({ prompt: 'dub chords', seconds: 4.03 })
    expect(channel.loadGeneratedLoop).toHaveBeenCalledWith(
      0,
      expect.any(ArrayBuffer),
      false,
    )
  })

  it('an sfx-model loop keeps the picker length without the music floor', async () => {
    const fetchMock = stubFetchOk()
    const { engine } = makeFakeEngine()
    const { result } = await playingDeck(engine)

    act(() => result.current.generateToPad('crackle texture', 'sfx', false))
    await act(async () => {})
    const body = requestBody(fetchMock)
    expect(body.kind).toBe('sfx')
    expect(body.seconds).toBeCloseTo(4 + 0.03, 6)
  })

  it('floors the length and keeps the bare prompt while the gate is blank', async () => {
    const fetchMock = stubFetchOk()
    const { engine } = makeFakeEngine()
    const { result } = await playingDeck(engine)

    act(() => result.current.generateToPad('dub siren', 'music', false))
    await act(async () => {})
    const body = requestBody(fetchMock)
    expect(body.prompt).toBe('dub siren')
    // 4 s from the picker would come back garbled (the measured floor).
    expect(body.seconds).toBeCloseTo(7 + 0.03, 6)
  })

  it('fires a filled one-shot as an overlay, never as the active loop', async () => {
    stubFetchOk()
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)
    act(() => result.current.generateToPad('air horn', 'sfx', true))
    await act(async () => {})

    await act(async () => result.current.toggleLoopPad(0))
    expect(channel.playLoop).toHaveBeenCalledWith(0)
    expect(result.current.loop.active).toBeNull()
  })

  it('a clear during the flight wins over the result', async () => {
    let finish!: (response: unknown) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((resolve) => (finish = resolve))),
    )
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)

    act(() => result.current.generateToPad('riser', 'sfx', true))
    act(() => result.current.clearLoopPad(0))
    await act(async () =>
      finish({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(16),
        json: async () => ({}),
      }),
    )

    expect(channel.loadGeneratedLoop).not.toHaveBeenCalled()
    expect(result.current.loop.slots[0].state).toBe('empty')
  })

  it('reverts the slot and surfaces the backend detail on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ detail: 'sa3_mlx checkout not found' }),
      })),
    )
    const { engine } = makeFakeEngine()
    const { result } = await playingDeck(engine)

    act(() => result.current.generateToPad('riser', 'sfx', true))
    await act(async () => {})
    expect(result.current.loop.slots[0].state).toBe('empty')
    expect(result.current.generateError).toBe('sa3_mlx checkout not found')

    // The next attempt starts clean.
    stubFetchOk()
    act(() => result.current.generateToPad('riser', 'sfx', true))
    expect(result.current.generateError).toBeNull()
  })

  it('an undecodable body is a failure, not a filled slot', async () => {
    stubFetchOk()
    const { engine, channel } = makeFakeEngine()
    vi.mocked(channel.loadGeneratedLoop).mockResolvedValue(false)
    const { result } = await playingDeck(engine)

    act(() => result.current.generateToPad('riser', 'sfx', true))
    await act(async () => {})
    expect(result.current.loop.slots[0].state).toBe('empty')
    expect(result.current.generateError).toMatch(/decoded/)
  })

  it('does nothing without an empty slot or a prompt', async () => {
    const fetchMock = stubFetchOk()
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)

    act(() => result.current.generateToPad('   ', 'sfx', true))
    expect(generateCalls(fetchMock)).toHaveLength(0)

    for (let slot = 0; slot < 4; slot++) {
      await act(async () => result.current.toggleLoopPad(slot))
    }
    vi.mocked(channel.captureLoop).mockClear()
    act(() => result.current.generateToPad('riser', 'sfx', true))
    expect(generateCalls(fetchMock)).toHaveLength(0)
  })

  it('stop() cuts a ringing one-shot', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = await playingDeck(engine)

    act(() => result.current.stop())
    expect(channel.stopOneShot).toHaveBeenCalled()
  })

  it('creates the channel on demand: pads fill before the deck plays', async () => {
    stubFetchOk()
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())

    act(() => result.current.generateToPad('air horn', 'sfx', true))
    await act(async () => {})
    expect(engine.createDeckChannel).toHaveBeenCalled()
    expect(channel.loadGeneratedLoop).toHaveBeenCalled()
    expect(result.current.loop.slots[0].state).toBe('filled')
  })
})

describe('useDeck playback mode (M19)', () => {
  async function loadedDeck() {
    const { engine, channel } = makeFakeEngine()
    const rendered = renderDeck(engine)
    act(() => socket(0).serverOpen())
    let loaded = false
    await act(async () => {
      loaded = await rendered.result.current.loadTrack(
        new ArrayBuffer(8),
        'Test Pressing',
      )
    })
    expect(loaded).toBe(true)
    return { ...rendered, channel }
  }

  it('loadTrack parks the stream and enters playback with the offline verdict', async () => {
    const { result, channel } = await loadedDeck()
    expect(channel.loadTrack).toHaveBeenCalled()
    // The worker parks warm: a stop went over IPC (ADR-0013).
    expect(native.invoke).toHaveBeenCalledWith('deck_stop', { deck: 0 })
    expect(result.current.mode).toBe('playback')
    expect(result.current.track).toMatchObject({
      title: 'Test Pressing',
      duration: 120,
      position: 0,
      playing: false,
      ended: false,
      bpm: null, // silence in, honesty out (M14)
    })
    expect(channel.setBeatPeriod).toHaveBeenLastCalledWith(null)
  })

  it('PLAY and STOP drive the track, not the worker', async () => {
    const { result, channel } = await loadedDeck()
    const sentBefore = deckInvokes().length
    await act(async () => result.current.play())
    expect(channel.playTrack).toHaveBeenCalled()
    act(() => result.current.stop())
    expect(channel.pauseTrack).toHaveBeenCalled()
    expect(deckInvokes()).toHaveLength(sentBefore)
  })

  it('CUE returns the track to the top, parked', async () => {
    const { result, channel } = await loadedDeck()
    await act(async () => result.current.prime())
    expect(channel.pauseTrack).toHaveBeenCalled()
    expect(channel.seekTrack).toHaveBeenCalledWith(0)
    expect(result.current.primed).toBe(false)
  })

  it('refuses an empty-pad capture — the worklet history holds the dead stream', async () => {
    const { result, channel } = await loadedDeck()
    act(() => result.current.toggleLoopPad(0))
    expect(channel.captureLoop).not.toHaveBeenCalled()
  })

  it('refuses a style sample for the same reason', async () => {
    const { result, channel } = await loadedDeck()
    let sample: Float32Array | null = new Float32Array(2)
    await act(async () => {
      sample = await result.current.captureStyleSample()
    })
    expect(sample).toBeNull()
    expect(channel.captureSample).not.toHaveBeenCalled()
  })

  it('drops a straggler PCM chunk while parked — the analysis never sees it', async () => {
    // A parked (playback) deck must NOT feed a late model chunk into the beat
    // tracker, or the straggler would pollute the track's clock. The guard in
    // useDeck's PCM callback (`if mode === 'playback' return`) is the only thing
    // stopping it — `result.current.bpm` is double-gated by the per-tick
    // playback guard and so cannot observe this, but the tracker push can.
    const trackerPush = spyOnTrackerPush()
    const { engine, channel } = makeFakeEngine()
    const rendered = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(async () => {
      await rendered.result.current.loadTrack(new ArrayBuffer(8), 'Test Pressing')
    })
    expect(channel.loadTrack).toHaveBeenCalled()

    act(() => feedPcm(new ArrayBuffer(16)))
    expect(trackerPush).not.toHaveBeenCalled()
  })

  it('a live (non-parked) deck DOES feed fed PCM into the analysis', async () => {
    // The positive counterpart: the same feed on a realtime, playing deck
    // reaches the beat tracker, so the parked test above guards a real,
    // exercised path rather than asserting on dead code.
    const trackerPush = spyOnTrackerPush()
    const { engine } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())

    act(() => feedPcm(new ArrayBuffer(16)))
    expect(trackerPush).toHaveBeenCalled()
  })

  it('follows the channel playhead while a track is loaded', async () => {
    const { result, channel } = await loadedDeck()
    vi.mocked(channel.getTrackStatus).mockReturnValue({
      position: 42.5,
      duration: 120,
      playing: true,
      ended: false,
      rate: 1,
      loop: null,
      contextTime: 100,
    })
    act(() => void vi.advanceTimersByTime(250))
    expect(result.current.track).toMatchObject({
      position: 42.5,
      playing: true,
    })
  })

  it('leavePlayback unloads the track and returns to realtime, parked staying parked', async () => {
    const { result, channel } = await loadedDeck()
    const sentBefore = deckInvokes().length
    act(() => result.current.leavePlayback())
    expect(channel.unloadTrack).toHaveBeenCalled()
    expect(result.current.mode).toBe('realtime')
    expect(result.current.track).toBeNull()
    // The track was parked, so the deck comes back stopped.
    expect(deckInvokes()).toHaveLength(sentBefore)
  })

  it('a primed deck loads a track parked — prep audio never hits the master', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.prime())
    expect(result.current.state.playing).toBe(true) // rolling, but off air

    await act(async () => {
      await result.current.loadTrack(new ArrayBuffer(8), 'Headphone Special')
    })
    expect(channel.playTrack).not.toHaveBeenCalled()
    expect(result.current.track).toMatchObject({ playing: false })
  })

  it('a streaming deck keeps playing through a track load', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())
    expect(result.current.state.playing).toBe(true)

    await act(async () => {
      await result.current.loadTrack(new ArrayBuffer(8), 'Hot Swap')
    })
    expect(channel.playTrack).toHaveBeenCalled()
    expect(result.current.track).toMatchObject({
      title: 'Hot Swap',
      playing: true,
    })
  })

  it('nudgeTrack seeks relative to the channel playhead, not the polled state', async () => {
    const { result, channel } = await loadedDeck()
    vi.mocked(channel.getTrackStatus).mockReturnValue({
      position: 10,
      duration: 120,
      playing: true,
      ended: false,
      rate: 1,
      loop: null,
      contextTime: 100,
    })
    act(() => result.current.nudgeTrack(2.5))
    expect(channel.seekTrack).toHaveBeenCalledWith(12.5)
  })

  it('a rolling track hands straight back to the stream on leaving', async () => {
    const { result, channel } = await loadedDeck()
    vi.mocked(channel.getTrackStatus).mockReturnValue({
      position: 10,
      duration: 120,
      playing: true,
      ended: false,
      rate: 1,
      loop: null,
      contextTime: 100,
    })
    const sentBefore = deckInvokes().length
    await act(async () => result.current.leavePlayback())
    expect(channel.unloadTrack).toHaveBeenCalled()
    expect(result.current.mode).toBe('realtime')
    expect(deckInvokes().slice(sentBefore)).toContainEqual(['deck_play', { deck: 0 }])
    expect(result.current.state.playing).toBe(true)
  })
})

describe('useDeck beat clocks (M20)', () => {
  function clickChannels(bpm: number, seconds: number) {
    const samples = clickTrack(bpm, seconds, 48_000)
    const frames = samples.length / 2
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      left[i] = samples[2 * i]
      right[i] = samples[2 * i + 1]
    }
    return { left, right, samples }
  }

  it('exposes the live beat clock at the speakers once gated and continuous', async () => {
    const { engine, captured } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())

    // Stream a steady click track one wire-second at a time, phase
    // continuous, with the estimator ticking between chunks.
    const { samples } = clickChannels(128, 14)
    const frameStride = 48_000 * 2
    for (let second = 0; second < 14; second++) {
      const chunk = samples.slice(second * frameStride, (second + 1) * frameStride)
      act(() => feedPcm(chunk.buffer))
      act(() => void vi.advanceTimersByTime(1_000))
    }
    expect(result.current.bpm).not.toBeNull()

    // No stats yet: the clock must stay blank rather than guess.
    expect(result.current.getLiveBeat()).toBeNull()

    act(() =>
      captured.onStats?.({
        underruns: 0,
        bufferedSeconds: 2,
        playing: true,
        playedFrames: 10 * 48_000,
        contextTime: 100,
      }),
    )
    const clock = result.current.getLiveBeat()
    expect(clock).not.toBeNull()
    expect(clock!.periodSeconds).toBeCloseTo(60 / 128, 2)
    // The reported beat sits on the click lattice: beats play at
    // contextTime + (k·period − played)/rate for integer k.
    const beatsFromStart = ((clock!.beatAtContext - 100) * 48_000 + 10 * 48_000) / 48_000 / (60 / 128)
    const gap = Math.abs(beatsFromStart - Math.round(beatsFromStart))
    expect(gap).toBeLessThanOrEqual(0.15)

    // Stale stats blank the clock — never a confident lie.
    act(() => void vi.advanceTimersByTime(3_000))
    expect(result.current.getLiveBeat()).toBeNull()
  })

  it('rides out one breathing estimate without blanking the clock', async () => {
    const { engine, captured } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(() => result.current.play())

    const { samples } = clickChannels(128, 14)
    const frameStride = 48_000 * 2
    for (let second = 0; second < 14; second++) {
      const chunk = samples.slice(second * frameStride, (second + 1) * frameStride)
      act(() => feedPcm(chunk.buffer))
      act(() => void vi.advanceTimersByTime(1_000))
    }
    act(() =>
      captured.onStats?.({
        underruns: 0,
        bufferedSeconds: 2,
        playing: true,
        playedFrames: 10 * 48_000,
        contextTime: 100,
      }),
    )
    expect(result.current.getLiveBeat()).not.toBeNull()

    // One second of half-period-shifted clicks: the anchor measurement
    // misses (contradiction or incoherence) — the held clock must ride
    // it out rather than strobe the meter.
    const shifted = clickChannels(128, 3).samples
    const halfPeriod = Math.round(((60 / 128) * 48_000) / 2) * 2
    const slice = shifted.slice(halfPeriod, halfPeriod + frameStride)
    act(() => feedPcm(slice.buffer))
    act(() => void vi.advanceTimersByTime(1_000))
    act(() =>
      captured.onStats?.({
        underruns: 0,
        bufferedSeconds: 2,
        playing: true,
        playedFrames: 11 * 48_000,
        contextTime: 101,
      }),
    )
    expect(result.current.getLiveBeat()).not.toBeNull()
  })

  it('subtracts the native global render origin so the beat lands on the lattice', async () => {
    // The native engine reports a GLOBAL, never-reset render count, while the
    // beat tracker's anchorFrame resets to 0 with the stream (ADR-0014). useDeck
    // captures getContextTime()·SR at each stream reset and subtracts it so the
    // two share a frame domain. The rest of the M20 suite runs getContextTime
    // () => 0, leaving that origin at 0 and the subtraction unexercised; here it
    // is non-zero, so the subtraction carries weight and a dropped/wrong-sign
    // origin would push the reported beat off the click lattice.
    const ORIGIN_SECONDS = 5 // 5 s = 10.666… periods at 128 BPM: NOT a whole beat
    const ORIGIN_FRAMES = ORIGIN_SECONDS * 48_000
    const { engine, captured } = makeFakeEngine({
      getContextTime: vi.fn(() => ORIGIN_SECONDS),
    })
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    // play() anchors playedFramesOriginRef at getContextTime()·SR = ORIGIN_FRAMES.
    await act(() => result.current.play())

    const { samples } = clickChannels(128, 14)
    const frameStride = 48_000 * 2
    for (let second = 0; second < 14; second++) {
      const chunk = samples.slice(second * frameStride, (second + 1) * frameStride)
      act(() => feedPcm(chunk.buffer))
      act(() => void vi.advanceTimersByTime(1_000))
    }
    expect(result.current.bpm).not.toBeNull()

    // playedFrames is in the GLOBAL render domain: the per-stream position
    // (10 s) plus the never-reset origin.
    const perStreamPlayed = 10 * 48_000
    act(() =>
      captured.onStats?.({
        underruns: 0,
        bufferedSeconds: 2,
        playing: true,
        playedFrames: ORIGIN_FRAMES + perStreamPlayed,
        contextTime: 100,
      }),
    )
    const clock = result.current.getLiveBeat()
    expect(clock).not.toBeNull()
    expect(clock!.periodSeconds).toBeCloseTo(60 / 128, 2)
    // Reconstruct the played position in the per-stream domain (subtract the
    // origin ourselves) and assert the beat sits on the lattice. If production
    // dropped the origin subtraction, beatAtContext would be off by
    // ORIGIN_FRAMES — 10.666… periods — pushing the gap well past 0.15.
    const beatsFromStart =
      ((clock!.beatAtContext - 100) * 48_000 + perStreamPlayed) / 48_000 / (60 / 128)
    const gap = Math.abs(beatsFromStart - Math.round(beatsFromStart))
    expect(gap).toBeLessThanOrEqual(0.15)
  })

  it('derives the track beat clock from the grid, rate-aware', async () => {
    const { engine, channel } = makeFakeEngine()
    const { left, right } = clickChannels(120, 24)
    vi.mocked(channel.loadTrack).mockResolvedValue({
      duration: 24,
      sampleRate: 48_000,
      left,
      right,
    })
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(async () => {
      await result.current.loadTrack(new ArrayBuffer(8), 'Gridded')
    })
    const grid = result.current.track!.grid
    expect(grid).not.toBeNull()
    expect(Math.abs(grid!.bpm - 120)).toBeLessThanOrEqual(120 * 0.005)
    // One number: the readout BPM is the grid's refined verdict.
    expect(result.current.track!.bpm).toBe(grid!.bpm)

    vi.mocked(channel.getTrackStatus).mockReturnValue({
      position: 10,
      duration: 24,
      playing: true,
      ended: false,
      rate: 1.05,
      loop: null,
      contextTime: 200,
    })
    const clock = result.current.getTrackBeat()
    expect(clock).not.toBeNull()
    // Varispeed shortens the beat period in context time.
    expect(clock!.periodSeconds).toBeCloseTo(60 / grid!.bpm / 1.05, 4)
    const periodTrack = 60 / grid!.bpm
    const phase =
      ((((10 - grid!.firstBeatSeconds) / periodTrack) % 1) + 1) % 1
    expect(clock!.beatAtContext).toBeCloseTo(200 - phase * clock!.periodSeconds, 4)
  })

  it('SYNC matches tempo within the envelope and refuses outside it', async () => {
    const { engine, channel } = makeFakeEngine()
    const { left, right } = clickChannels(120, 24)
    vi.mocked(channel.loadTrack).mockResolvedValue({
      duration: 24,
      sampleRate: 48_000,
      left,
      right,
    })
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(async () => {
      await result.current.loadTrack(new ArrayBuffer(8), 'Syncable')
    })
    const bpm = result.current.track!.bpm!

    let synced = ''
    act(() => {
      synced = result.current.syncTrack(bpm * 1.05)
    })
    expect(synced).toBe('synced')
    expect(channel.setTrackRate).toHaveBeenCalledWith(expect.closeTo(1.05, 5))
    expect(result.current.track!.rate).toBeCloseTo(1.05, 5)
    // The synced echo's clock follows the new effective tempo.
    expect(channel.setBeatPeriod).toHaveBeenLastCalledWith(
      expect.closeTo(60 / (bpm * 1.05), 5),
    )

    act(() => {
      synced = result.current.syncTrack(bpm * 1.2)
    })
    expect(synced).toBe('out_of_range')
    act(() => {
      synced = result.current.syncTrack(null)
    })
    expect(synced).toBe('no_tempo')
  })

  // ── Hot cues and track loops (M21, ADR-0015) ─────────────────────

  async function griddedDeck(position: number) {
    const { engine, channel } = makeFakeEngine()
    const { left, right } = clickChannels(120, 24)
    vi.mocked(channel.loadTrack).mockResolvedValue({
      duration: 24,
      sampleRate: 48_000,
      left,
      right,
    })
    // The engine mock holds a loop like the real boundary would, so
    // the hook's mirror-from-the-engine path is what's under test.
    let engineLoop: { start: number; end: number } | null = null
    vi.mocked(channel.setTrackLoop).mockImplementation((start, end) => {
      engineLoop = { start, end }
    })
    vi.mocked(channel.clearTrackLoop).mockImplementation(() => {
      engineLoop = null
    })
    // The real boundary exits the loop on any seek (ADR-0015).
    vi.mocked(channel.seekTrack).mockImplementation(() => {
      engineLoop = null
    })
    const status = { position }
    vi.mocked(channel.getTrackStatus).mockImplementation(() => ({
      position: status.position,
      duration: 24,
      playing: true,
      ended: false,
      rate: 1,
      loop: engineLoop,
      contextTime: 200,
    }))
    const rendered = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(async () => {
      await rendered.result.current.loadTrack(new ArrayBuffer(8), 'Cueable')
    })
    expect(rendered.result.current.track!.grid).not.toBeNull()
    return { ...rendered, channel, status }
  }

  it('an empty hot cue pad captures the playhead on the grid; a filled one jumps', async () => {
    const { result, channel, status } = await griddedDeck(10.1)
    const grid = result.current.track!.grid!
    const period = 60 / grid.bpm

    act(() => result.current.hotCuePad(2))
    const cue = result.current.track!.cues[2]!
    // Snapped onto the lattice, within half a beat of the press.
    const phase = ((cue - grid.firstBeatSeconds) / period) % 1
    expect(Math.min(phase, 1 - phase)).toBeLessThan(1e-6)
    expect(Math.abs(cue - 10.1)).toBeLessThanOrEqual(period / 2)

    status.position = 20
    act(() => result.current.hotCuePad(2))
    expect(channel.seekTrack).toHaveBeenCalledWith(cue)
    // The jump must not overwrite the slot.
    expect(result.current.track!.cues[2]).toBe(cue)

    act(() => result.current.clearHotCue(2))
    expect(result.current.track!.cues[2]).toBeNull()
  })

  it('the zoom source carries filled hot cues in the playhead’s hop domain (M21)', async () => {
    const { result } = await griddedDeck(10.1)
    // Nothing captured yet: the close-up has no cues to draw.
    expect(result.current.getZoomSource()!.cues).toEqual([])

    act(() => result.current.hotCuePad(2))
    const cue = result.current.track!.cues[2]!
    const source = result.current.getZoomSource()!
    // Only the one filled slot, and in the same hop units as the
    // playhead — so the strip lines the marker up against the centre.
    expect(source.cues).toHaveLength(1)
    expect(source.cues[0] / source.playheadHop).toBeCloseTo(cue / 10.1, 6)
  })

  it('cue capture runs free without a grid — no fabricated lattice', async () => {
    const { engine, channel } = makeFakeEngine()
    vi.mocked(channel.getTrackStatus).mockReturnValue({
      position: 10.1,
      duration: 120,
      playing: true,
      ended: false,
      rate: 1,
      loop: null,
      contextTime: 200,
    })
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(async () => {
      await result.current.loadTrack(new ArrayBuffer(8), 'Gridless')
    })
    expect(result.current.track!.grid).toBeNull()
    act(() => result.current.hotCuePad(0))
    expect(result.current.track!.cues[0]).toBe(10.1)
  })

  it('IN and OUT close a whole-beat loop on the engine; EXIT releases it', async () => {
    const { result, channel, status } = await griddedDeck(8.1)
    const period = 60 / result.current.track!.grid!.bpm

    act(() => result.current.loopIn())
    const armed = result.current.track!.pendingLoopIn!
    expect(Math.abs(armed - 8.1)).toBeLessThanOrEqual(period / 2)

    status.position = 10.2
    act(() => result.current.loopOut())
    expect(channel.setTrackLoop).toHaveBeenCalled()
    const loop = result.current.track!.loop!
    expect(loop.start).toBe(armed)
    // A whole number of beats — 4 at 120 BPM across ~2.1s.
    const beats = (loop.end - loop.start) / period
    expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-6)
    expect(Math.round(beats)).toBe(4)
    expect(result.current.track!.pendingLoopIn).toBeNull()

    act(() => result.current.loopExit())
    expect(channel.clearTrackLoop).toHaveBeenCalled()
    expect(result.current.track!.loop).toBeNull()
  })

  it('a beat loop sets N beats; halve and double scale it, anchored on the IN (M23)', async () => {
    const { result, channel } = await griddedDeck(8.1)
    const period = 60 / result.current.track!.grid!.bpm

    act(() => result.current.beatLoop(4))
    const set = result.current.track!.loop!
    expect((set.end - set.start) / period).toBeCloseTo(4)
    expect(channel.setTrackLoop).toHaveBeenLastCalledWith(set.start, set.end)

    act(() => result.current.halveLoop())
    const halved = result.current.track!.loop!
    expect(halved.start).toBe(set.start) // the IN holds
    expect((halved.end - halved.start) / period).toBeCloseTo(2)

    act(() => result.current.doubleLoop())
    const doubled = result.current.track!.loop!
    expect(doubled.start).toBe(set.start)
    expect((doubled.end - doubled.start) / period).toBeCloseTo(4)
  })

  it('halve and double are no-ops with no active loop (M23)', async () => {
    const { result, channel } = await griddedDeck(8.1)
    act(() => result.current.halveLoop())
    act(() => result.current.doubleLoop())
    expect(channel.setTrackLoop).not.toHaveBeenCalled()
    expect(result.current.track!.loop).toBeNull()
  })

  it('a beat loop is a no-op without a confident grid — inert, not guessed (M23)', async () => {
    const { engine, channel } = makeFakeEngine()
    vi.mocked(channel.getTrackStatus).mockReturnValue({
      position: 10.1,
      duration: 120,
      playing: true,
      ended: false,
      rate: 1,
      loop: null,
      contextTime: 200,
    })
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())
    await act(async () => {
      await result.current.loadTrack(new ArrayBuffer(8), 'Gridless')
    })
    expect(result.current.track!.grid).toBeNull()
    act(() => result.current.beatLoop(4))
    expect(channel.setTrackLoop).not.toHaveBeenCalled()
    expect(result.current.track!.loop).toBeNull()
  })

  it('the zoom source carries the active loop region in hop units (M21)', async () => {
    const { result, status } = await griddedDeck(8.1)
    // Not looping yet: the close-up has no region to wash.
    expect(result.current.getZoomSource()!.loop).toBeNull()

    act(() => result.current.loopIn())
    status.position = 10.2
    act(() => result.current.loopOut())
    const loop = result.current.track!.loop!
    const source = result.current.getZoomSource()!
    // The region in the playhead's hop units, so the wash and the
    // entry/exit caps land where the audio actually wraps.
    expect(source.loop).not.toBeNull()
    expect(source.loop!.startHop / source.playheadHop).toBeCloseTo(
      loop.start / 10.2,
      6,
    )
    expect(source.loop!.endHop / source.playheadHop).toBeCloseTo(
      loop.end / 10.2,
      6,
    )

    act(() => result.current.loopExit())
    expect(result.current.getZoomSource()!.loop).toBeNull()
  })

  it('OUT with no IN armed is a no-op, and a seek drops loop and pending IN', async () => {
    const { result, channel, status } = await griddedDeck(8.1)
    act(() => result.current.loopOut())
    expect(channel.setTrackLoop).not.toHaveBeenCalled()

    act(() => result.current.loopIn())
    status.position = 10.2
    act(() => result.current.loopOut())
    expect(result.current.track!.loop).not.toBeNull()

    // The engine clears its loop on seek (ADR-0015, mirrored by the
    // helper's mock); the hook must follow, not show a ghost region.
    act(() => result.current.loopIn())
    act(() => result.current.seekTrack(2))
    expect(result.current.track!.loop).toBeNull()
    expect(result.current.track!.pendingLoopIn).toBeNull()
  })

  it('transport CUE drops the loop everywhere — engine, mirror, pending IN', async () => {
    // CUE's back-to-top is a seek (ADR-0013 + ADR-0015): the loop
    // must not survive on screen while playback runs linear.
    const { result, status } = await griddedDeck(8.1)
    act(() => result.current.loopIn())
    status.position = 10.2
    act(() => result.current.loopOut())
    expect(result.current.track!.loop).not.toBeNull()

    act(() => result.current.loopIn())
    await act(() => result.current.prime())
    expect(result.current.track!.loop).toBeNull()
    expect(result.current.track!.pendingLoopIn).toBeNull()
  })

  it('the position poll mirrors an engine-side loop drop within a tick', async () => {
    const { result, channel, status } = await griddedDeck(8.1)
    act(() => result.current.loopIn())
    status.position = 10.2
    act(() => result.current.loopOut())
    expect(result.current.track!.loop).not.toBeNull()

    // The engine drops the loop behind the hook's back (any internal
    // seek path); the 250 ms poll must catch up without help.
    vi.mocked(channel.clearTrackLoop).getMockImplementation()?.()
    act(() => void vi.advanceTimersByTime(250))
    expect(result.current.track!.loop).toBeNull()
  })
})
