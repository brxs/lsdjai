/** useDeck behaviour with a fake WebSocket, fake timers, and a fake audio
 * engine: reconnect after a server-side close, command gating while the
 * socket is not open, play() failure surfacing, and ring-buffer hygiene on
 * model switches. The real audio graph stays on the e2e script. */

import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AudioEngineProvider } from '../audio/AudioEngineProvider'
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
    dispose: vi.fn(),
  }
  const engine: AudioEngine = {
    createDeckChannel: vi.fn(async () => channel),
    resume: vi.fn(async () => {}),
    setCrossfade: vi.fn(),
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

    act(() => result.current.setPrompt('too early'))
    expect(socket(0).sent).toHaveLength(0)

    act(() => socket(0).serverOpen())
    act(() => result.current.setPrompt('warm disco funk'))
    expect(socket(0).sent).toEqual([
      JSON.stringify({ type: 'set_prompt', prompt: 'warm disco funk' }),
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
