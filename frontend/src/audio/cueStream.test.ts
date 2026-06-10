import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { listCueJackOutputs, startCueStream } from './cueStream'
import type { AudioEngine } from './engine'

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  url: string
  binaryType = ''
  readyState = 0
  sent: unknown[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { reason: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: unknown) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }

  serverReady() {
    this.readyState = FakeWebSocket.OPEN
    this.onmessage?.({ data: JSON.stringify({ event: 'ready' }) })
  }

  serverClose(reason = '') {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ reason })
  }
}

function fakeEngine() {
  let capture: ((samples: Float32Array) => void) | null = null
  const engine = {
    startCueCapture: vi.fn(async (onChunk: (samples: Float32Array) => void) => {
      capture = onChunk
    }),
    stopCueCapture: vi.fn(() => {
      capture = null
    }),
  } as unknown as AudioEngine
  return { engine, emitChunk: (samples: Float32Array) => capture?.(samples) }
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => vi.unstubAllGlobals())

const socket = () => FakeWebSocket.instances[0]

describe('startCueStream', () => {
  it('streams captured chunks once the backend accepts', async () => {
    const { engine, emitChunk } = fakeEngine()
    const streaming = startCueStream(engine, 'DDJ-FLX4')
    expect(socket().url).toContain('/ws/cue?device=DDJ-FLX4')

    socket().serverReady()
    await streaming
    const samples = new Float32Array([0.1, -0.1])
    emitChunk(samples)
    expect(socket().sent).toEqual([samples])
  })

  it('only the ready event counts as acceptance', async () => {
    const { engine } = fakeEngine()
    const streaming = startCueStream(engine, 'DDJ-FLX4')

    // A pre-ready error frame (or noise) must not start the capture.
    socket().onmessage?.({ data: JSON.stringify({ event: 'error' }) })
    socket().onmessage?.({ data: 'not json' })
    expect(engine.startCueCapture).not.toHaveBeenCalled()

    socket().serverReady()
    await streaming
    expect(engine.startCueCapture).toHaveBeenCalled()
  })

  it('rejects with the backend reason when refused', async () => {
    const { engine } = fakeEngine()
    const streaming = startCueStream(engine, 'Nope')
    socket().serverClose("no phones-capable output named 'Nope'")
    await expect(streaming).rejects.toThrow('no phones-capable output')
    expect(engine.startCueCapture).not.toHaveBeenCalled()
  })

  it('stop() ends the capture and closes the socket', async () => {
    const { engine, emitChunk } = fakeEngine()
    const streaming = startCueStream(engine, 'DDJ-FLX4')
    socket().serverReady()
    const stop = await streaming

    stop()
    expect(engine.stopCueCapture).toHaveBeenCalled()
    expect(socket().readyState).toBe(FakeWebSocket.CLOSED)
    emitChunk(new Float32Array([1]))
    expect(socket().sent).toEqual([])
  })

  it('stops the capture when the backend drops mid-stream', async () => {
    const { engine } = fakeEngine()
    const streaming = startCueStream(engine, 'DDJ-FLX4')
    socket().serverReady()
    await streaming

    socket().serverClose('backend restarted')
    expect(engine.stopCueCapture).toHaveBeenCalled()
  })
})

describe('listCueJackOutputs', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists named outputs from the backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => [{ id: 1, name: 'DDJ-FLX4' }, { id: 2 }],
      })),
    )
    expect(await listCueJackOutputs()).toEqual([{ name: 'DDJ-FLX4' }])
  })

  it('degrades to an empty list when the backend is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused')
      }),
    )
    expect(await listCueJackOutputs()).toEqual([])
  })
})
