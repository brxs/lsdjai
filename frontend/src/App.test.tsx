/** App-level wiring tests with fake sockets and a fake engine: the
 * crossfade chain (audio bus + persistence) is owned by App and must hold
 * from both the on-screen slider and the hardware intent path. */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { AudioEngineProvider } from './audio/AudioEngineProvider'
import type { AudioEngine } from './audio/engine'
import { createControlBus, type ControlBus } from './control/bus'
import { ControlBusProvider } from './control/ControlBusProvider'
import { loadAppSettings } from './persistence'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3

  binaryType = ''
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }
}

function makeEngine(): AudioEngine {
  return {
    createDeckChannel: vi.fn(),
    resume: vi.fn(async () => {}),
    setCrossfade: vi.fn(),
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => new Blob()),
    getMasterLevel: vi.fn(() => 0),
  }
}

function renderApp(engine: AudioEngine, bus: ControlBus = createControlBus()) {
  return render(
    <AudioEngineProvider engine={engine}>
      <ControlBusProvider bus={bus}>
        <App />
      </ControlBusProvider>
    </AudioEngineProvider>,
  )
}

beforeEach(() => vi.stubGlobal('WebSocket', FakeWebSocket))
afterEach(() => vi.unstubAllGlobals())

describe('App crossfade ownership', () => {
  it('a slider move drives the audio bus and persists', () => {
    const engine = makeEngine()
    renderApp(engine)
    vi.mocked(engine.setCrossfade).mockClear() // drop the one-time restore

    fireEvent.change(screen.getByLabelText('Crossfade'), {
      target: { value: '0.2' },
    })

    expect(engine.setCrossfade).toHaveBeenCalledWith(0.2)
    expect(loadAppSettings().crossfade).toBe(0.2)
  })

  it('a hardware crossfade intent flows through the same chain', () => {
    const engine = makeEngine()
    const bus = createControlBus()
    renderApp(engine, bus)
    vi.mocked(engine.setCrossfade).mockClear()

    act(() => bus.publish({ kind: 'crossfade', value: 0.75 }))

    expect(engine.setCrossfade).toHaveBeenCalledWith(0.75)
    expect(loadAppSettings().crossfade).toBe(0.75)
    expect(screen.getByLabelText('Crossfade')).toHaveValue('0.75')
  })
})
