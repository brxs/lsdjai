/** useDeck behaviour with a fake WebSocket, fake timers, and a fake audio
 * engine: reconnect after a server-side close, command gating while the
 * socket is not open, play() failure surfacing, and ring-buffer hygiene on
 * model switches. The real audio graph stays on the e2e script. */

import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AudioEngineProvider } from '../audio/AudioEngineProvider'
import { updateDeckSettings } from '../persistence'
import { clickTrack } from '../test/clickTrack'
import type { AudioEngine, DeckChannel } from '../audio/engine'
import { useDeck } from './useDeck'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  url: string
  binaryType = ''
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    // The app closing its own socket on unmount; no onclose echo needed.
    this.readyState = FakeWebSocket.CLOSED
  }

  serverOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  serverClose() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  serverEvent(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

function makeFakeEngine(overrides: Partial<AudioEngine> = {}) {
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
    getTrackStatus: vi.fn(() => null),
    getTrackPeaks: vi.fn(() => null),
    unloadTrack: vi.fn(),
    getLevel: vi.fn(() => 0),
    getWaveformRange: vi.fn(() => [0, 0] as [number, number]),
    dispose: vi.fn(),
  }
  const engine: AudioEngine = {
    createDeckChannel: vi.fn(async () => channel),
    resume: vi.fn(async () => {}),
    setCrossfade: vi.fn(),
    setCueMix: vi.fn(),
    setCueDevice: vi.fn(async () => {}),
    startCueCapture: vi.fn(async () => {}),
    stopCueCapture: vi.fn(),
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => new Blob()),
    getMasterLevel: vi.fn(() => 0),
    getMasterGainReduction: vi.fn(() => 0),
    ...overrides,
  }
  return { engine, channel }
}

function renderDeck(engine: AudioEngine) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AudioEngineProvider engine={engine}>{children}</AudioEngineProvider>
  )
  return renderHook(() => useDeck('a'), { wrapper })
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const socket = (index: number) => FakeWebSocket.instances[index]

describe('useDeck connection', () => {
  it('reconnects after the server closes the socket', () => {
    const { result } = renderDeck(makeFakeEngine().engine)
    expect(FakeWebSocket.instances).toHaveLength(1)

    act(() => socket(0).serverOpen())
    expect(result.current.state.connection).toBe('open')

    act(() => socket(0).serverClose())
    expect(result.current.state.connection).toBe('closed')

    act(() => void vi.advanceTimersByTime(2_000))
    expect(FakeWebSocket.instances).toHaveLength(2)

    act(() => socket(1).serverOpen())
    expect(result.current.state.connection).toBe('open')
  })

  it('drops commands while the socket is not open', () => {
    const { result } = renderDeck(makeFakeEngine().engine)

    const style = { prompts: [{ text: 'warm disco funk', weight: 1 }] }
    act(() => result.current.setStyle(style))
    expect(socket(0).sent).toHaveLength(0)

    act(() => socket(0).serverOpen())
    act(() => result.current.setStyle(style))
    expect(socket(0).sent).toEqual([
      JSON.stringify({
        type: 'set_style',
        prompts: [{ text: 'warm disco funk', weight: 1 }],
      }),
    ])
  })

  it('does not reconnect after unmount', () => {
    const { unmount } = renderDeck(makeFakeEngine().engine)
    act(() => socket(0).serverOpen())

    unmount()
    act(() => socket(0).serverClose())
    act(() => void vi.advanceTimersByTime(10_000))
    expect(FakeWebSocket.instances).toHaveLength(1)
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
    expect(socket(0).sent).toHaveLength(0) // no play command without audio
  })

  it('plays through the shared engine and resets stale buffer first', async () => {
    const { engine, channel } = makeFakeEngine()
    const { result } = renderDeck(engine)
    act(() => socket(0).serverOpen())

    await act(() => result.current.play())
    expect(engine.resume).toHaveBeenCalled()
    expect(channel.reset).toHaveBeenCalled()
    expect(socket(0).sent).toEqual([JSON.stringify({ type: 'play' })])
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

  it('sends set_model and restart commands', () => {
    const { result } = renderDeck(makeFakeEngine().engine)
    act(() => socket(0).serverOpen())

    act(() => result.current.setModel('mrt2_base'))
    act(() => result.current.restartWorker())
    expect(socket(0).sent).toEqual([
      JSON.stringify({ type: 'set_model', model: 'mrt2_base' }),
      JSON.stringify({ type: 'restart' }),
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
    expect(socket(0).sent).toEqual([JSON.stringify({ type: 'play' })])

    vi.mocked(channel.reset).mockClear()
    await act(() => result.current.play())
    expect(channel.setOnAir).toHaveBeenLastCalledWith(true)
    expect(result.current.primed).toBe(false)
    // The drop must not flush the prepped audio or re-send play.
    expect(channel.reset).not.toHaveBeenCalled()
    expect(socket(0).sent).toEqual([JSON.stringify({ type: 'play' })])
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

  it('surfaces malformed frames as dropped, not crashes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderDeck(makeFakeEngine().engine)
    act(() => socket(0).serverOpen())

    act(() => socket(0).onmessage?.({ data: '{not json' }))
    expect(result.current.state.connection).toBe('open')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('useDeck beat readout', () => {
  function streamClicks(bpm: number, seconds: number) {
    const samples = clickTrack(bpm, seconds, 48_000)
    const chunk = 1920 * 2 // the 40 ms wire chunk
    act(() => {
      for (let i = 0; i < samples.length; i += chunk) {
        socket(0).onmessage?.({ data: samples.slice(i, i + chunk).buffer })
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
        socket(0).onmessage?.({ data: silence.slice(i, i + chunk).buffer })
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
        socket(0).onmessage?.({ data: chunk.slice().buffer })
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
        socket(0).onmessage?.({ data: samples.slice(i, i + chunk).buffer })
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
    expect(fetchMock).not.toHaveBeenCalled()

    for (let slot = 0; slot < 4; slot++) {
      await act(async () => result.current.toggleLoopPad(slot))
    }
    vi.mocked(channel.captureLoop).mockClear()
    act(() => result.current.generateToPad('riser', 'sfx', true))
    expect(fetchMock).not.toHaveBeenCalled()
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
    // The worker parks warm: a stop went over the wire (ADR-0013).
    expect(socket(0).sent).toContain(JSON.stringify({ type: 'stop' }))
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
    const sentBefore = socket(0).sent.length
    await act(async () => result.current.play())
    expect(channel.playTrack).toHaveBeenCalled()
    act(() => result.current.stop())
    expect(channel.pauseTrack).toHaveBeenCalled()
    expect(socket(0).sent).toHaveLength(sentBefore)
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

  it('drops a straggler PCM chunk while parked', async () => {
    const { channel } = await loadedDeck()
    act(() => socket(0).onmessage?.({ data: new ArrayBuffer(16) }))
    expect(channel.postPcm).not.toHaveBeenCalled()
  })

  it('follows the channel playhead while a track is loaded', async () => {
    const { result, channel } = await loadedDeck()
    vi.mocked(channel.getTrackStatus).mockReturnValue({
      position: 42.5,
      duration: 120,
      playing: true,
      ended: false,
    })
    act(() => void vi.advanceTimersByTime(250))
    expect(result.current.track).toMatchObject({
      position: 42.5,
      playing: true,
    })
  })

  it('leavePlayback unloads the track and returns to realtime, parked staying parked', async () => {
    const { result, channel } = await loadedDeck()
    const sentBefore = socket(0).sent.length
    act(() => result.current.leavePlayback())
    expect(channel.unloadTrack).toHaveBeenCalled()
    expect(result.current.mode).toBe('realtime')
    expect(result.current.track).toBeNull()
    // The track was parked, so the deck comes back stopped.
    expect(socket(0).sent).toHaveLength(sentBefore)
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
    })
    const sentBefore = socket(0).sent.length
    await act(async () => result.current.leavePlayback())
    expect(channel.unloadTrack).toHaveBeenCalled()
    expect(result.current.mode).toBe('realtime')
    expect(socket(0).sent.slice(sentBefore)).toContain(
      JSON.stringify({ type: 'play' }),
    )
    expect(result.current.state.playing).toBe(true)
  })
})
