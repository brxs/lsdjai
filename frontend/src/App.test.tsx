/** App-level wiring tests with a fake engine: the crossfade and cue-mix
 * chains (audio bus + persistence) are owned by App and must hold from
 * both the on-screen control and the hardware intent path. */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import App from './App'
import { AudioEngineProvider } from './audio/AudioEngineProvider'
import type { AudioEngine } from './audio/types'
import { createControlBus, type ControlBus } from './control/bus'
import { ControlBusProvider } from './control/ControlBusProvider'
import { loadAppSettings } from './persistence'

function makeEngine(): AudioEngine {
  return {
    createDeckChannel: vi.fn(),
    resume: vi.fn(async () => {}),
    getContextTime: vi.fn(() => 0),
    setCrossfade: vi.fn(),
    setCueMix: vi.fn(),
    listOutputDevices: vi.fn(async () => []),
    setOutputDevice: vi.fn(async () => {}),
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => new Blob()),
    getMasterLevel: vi.fn(() => 0),
    getMasterGainReduction: vi.fn(() => 0),
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
