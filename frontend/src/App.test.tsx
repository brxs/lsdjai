/** App-level wiring tests with fake sockets and a fake engine: the
 * crossfade chain (audio bus + persistence) is owned by App and must hold
 * from both the on-screen slider and the hardware intent path. */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { AudioEngineProvider } from './audio/AudioEngineProvider'
import type { AudioEngine } from './audio/engine'
import { createControlBus, type ControlBus } from './control/bus'
import { ControlBusProvider } from './control/ControlBusProvider'
import { loadAppSettings, updateAppSettings } from './persistence'

// The scan needs deterministic devices; startCueStream stays real so the
// routing logic runs against the fake socket below.
vi.mock('./audio/outputs', () => ({
  listAudioOutputs: vi.fn(async () => [
    { deviceId: 'bt', label: 'WH-1000XM4' },
  ]),
}))
vi.mock('./audio/cueStream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./audio/cueStream')>()
  return {
    ...actual,
    listCueJackOutputs: vi.fn(async () => [{ name: 'DDJ-FLX4' }]),
  }
})

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  url: string
  binaryType = ''
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event?: { reason: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

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
    setCueMix: vi.fn(),
    setCueDevice: vi.fn(async () => {}),
    startCueCapture: vi.fn(async () => {}),
    stopCueCapture: vi.fn(),
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

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
})
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

  it('a cue-mix move drives the engine and persists', () => {
    const engine = makeEngine()
    renderApp(engine)

    fireEvent.change(screen.getByLabelText('Cue mix'), {
      target: { value: '0.3' },
    })

    expect(engine.setCueMix).toHaveBeenLastCalledWith(0.3)
    expect(loadAppSettings().cueMix).toBe(0.3)
  })

  it('restores the persisted cue device into the engine on load', () => {
    updateAppSettings({ cueDevice: { deviceId: 'flx4', label: 'DDJ-FLX4' } })
    const engine = makeEngine()
    renderApp(engine)
    expect(engine.setCueDevice).toHaveBeenCalledWith('flx4')
    expect(screen.getByLabelText('Phones out')).toHaveValue('DDJ-FLX4')
  })

  it('does not persist a backend pick the backend refused', async () => {
    renderApp(makeEngine())
    fireEvent.click(screen.getByRole('button', { name: 'Find devices' }))
    const select = screen.getByLabelText('Phones out')
    await waitFor(() => expect(select).toContainHTML('phones jack'))

    fireEvent.change(select, { target: { value: 'DDJ-FLX4 — phones jack' } })
    const cueSocket = await waitFor(() => {
      const socket = FakeWebSocket.instances.find((candidate) =>
        candidate.url.includes('/ws/cue'),
      )
      expect(socket).toBeDefined()
      return socket!
    })
    act(() => cueSocket.onclose?.({ reason: 'cue already has a client' }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'cue already has a client',
      ),
    )
    // The failed pick must survive neither in state nor across a reload.
    expect(select).toHaveValue('Off')
    expect(loadAppSettings().cueDevice).toBeUndefined()
  })

  it('shows Off after a failed switch instead of the torn-down old route', async () => {
    updateAppSettings({ cueDevice: { deviceId: 'bt', label: 'WH-1000XM4' } })
    renderApp(makeEngine())
    const select = screen.getByLabelText('Phones out')
    expect(select).toHaveValue('WH-1000XM4')

    fireEvent.click(screen.getByRole('button', { name: 'Find devices' }))
    await waitFor(() => expect(select).toContainHTML('phones jack'))
    fireEvent.change(select, { target: { value: 'DDJ-FLX4 — phones jack' } })
    const cueSocket = await waitFor(() => {
      const socket = FakeWebSocket.instances.find((candidate) =>
        candidate.url.includes('/ws/cue'),
      )
      expect(socket).toBeDefined()
      return socket!
    })
    act(() => cueSocket.onclose?.({ reason: 'cue already has a client' }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('already has a client'),
    )
    // The old route was torn down before the failure, so Off is the
    // truth on screen…
    expect(select).toHaveValue('Off')
    // …while the last good route stays persisted for the next reload.
    expect(loadAppSettings().cueDevice).toEqual({
      deviceId: 'bt',
      label: 'WH-1000XM4',
    })
  })

  it('a stale backend pick stops itself instead of clobbering a newer one', async () => {
    renderApp(makeEngine())
    fireEvent.click(screen.getByRole('button', { name: 'Find devices' }))
    const select = screen.getByLabelText('Phones out')
    await waitFor(() => expect(select).toContainHTML('phones jack'))

    // Pick the jack (stream pending), then switch to Off before the
    // backend answers.
    fireEvent.change(select, { target: { value: 'DDJ-FLX4 — phones jack' } })
    fireEvent.change(select, { target: { value: 'Off' } })
    await waitFor(() => expect(loadAppSettings().cueDevice).toBeNull())

    // The late acceptance must shut its own stream down, not install it.
    const cueSocket = await waitFor(() => {
      const socket = FakeWebSocket.instances.find((candidate) =>
        candidate.url.includes('/ws/cue'),
      )
      expect(socket).toBeDefined()
      return socket!
    })
    act(() => {
      cueSocket.readyState = FakeWebSocket.OPEN
      cueSocket.onmessage?.({ data: JSON.stringify({ event: 'ready' }) })
    })
    await waitFor(() => expect(cueSocket.readyState).toBe(FakeWebSocket.CLOSED))
    expect(loadAppSettings().cueDevice).toBeNull()
    expect(select).toHaveValue('Off')
  })

  it('restores a backend cue device by opening the cue stream', () => {
    updateAppSettings({
      cueDevice: {
        deviceId: 'DDJ-FLX4',
        label: 'DDJ-FLX4 — phones jack',
        backend: true,
      },
    })
    const engine = makeEngine()
    renderApp(engine)
    expect(
      FakeWebSocket.instances.some((socket) =>
        socket.url.includes('/ws/cue?device=DDJ-FLX4'),
      ),
    ).toBe(true)
    expect(engine.setCueDevice).not.toHaveBeenCalled()
  })

  it('a hardware cue-mix intent flows through the same chain', () => {
    const engine = makeEngine()
    const bus = createControlBus()
    renderApp(engine, bus)

    act(() => bus.publish({ kind: 'cue_mix', value: 0.8 }))

    expect(engine.setCueMix).toHaveBeenLastCalledWith(0.8)
    expect(loadAppSettings().cueMix).toBe(0.8)
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
