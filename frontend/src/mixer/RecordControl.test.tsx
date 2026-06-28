import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AudioEngineProvider } from '../audio/AudioEngineProvider'
import type { AudioEngine } from '../audio/types'
import { createControlBus, type ControlBus } from '../control/bus'
import { ControlBusProvider } from '../control/ControlBusProvider'
import { RecordControl } from './RecordControl'

function makeEngine(overrides: Partial<AudioEngine> = {}): AudioEngine {
  return {
    getContextTime: vi.fn(() => 0),
    createDeckChannel: vi.fn(),
    resume: vi.fn(async () => {}),
    setCrossfade: vi.fn(),
    setCueMix: vi.fn(),
    auditionPlay: vi.fn(async () => {}),
    auditionStop: vi.fn(),
    listOutputDevices: vi.fn(async () => []),
    setMainDevice: vi.fn(async () => {}),
    setCueDevice: vi.fn(async () => {}),
    startRecording: vi.fn(async () => '/Users/dj/Downloads/lsdj-take.wav'),
    stopRecording: vi.fn(async () => {}),
    getMasterLevel: vi.fn(() => 0),
    getMasterGainReduction: vi.fn(() => 0),
    ...overrides,
  }
}

function renderRecord(
  engine: AudioEngine,
  bus: ControlBus = createControlBus(),
  recordingsFolder = '',
) {
  return render(
    <AudioEngineProvider engine={engine}>
      <ControlBusProvider bus={bus}>
        <RecordControl recordingsFolder={recordingsFolder} />
      </ControlBusProvider>
    </AudioEngineProvider>,
  )
}

describe('RecordControl', () => {
  it('opens the take in the chosen folder on start and confirms it on stop', async () => {
    const engine = makeEngine()
    renderRecord(engine, createControlBus(), '/Users/dj/Sets')

    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Stop recording' }),
      ).toBeVisible(),
    )
    // The take streams to disk, so the file is opened at start: the configured
    // folder and a timestamped stem reach the engine right away.
    expect(engine.startRecording).toHaveBeenCalledWith(
      '/Users/dj/Sets',
      expect.stringMatching(/^lsdj-/),
    )
    expect(engine.resume).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
    expect(engine.stopRecording).toHaveBeenCalled()
    // The basename of the path returned at start is surfaced as reassurance.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('lsdj-take.wav'),
    )
    expect(screen.getByRole('button', { name: 'Record' })).toBeVisible()
  })

  it('opens in the default (empty folder = Downloads) when none is chosen', async () => {
    const engine = makeEngine()
    renderRecord(engine)

    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await waitFor(() =>
      expect(engine.startRecording).toHaveBeenCalledWith(
        '',
        expect.stringMatching(/^lsdj-/),
      ),
    )
  })

  it('surfaces a recording failure instead of swallowing it', async () => {
    const engine = makeEngine({
      startRecording: vi.fn(async () => {
        throw new Error('no audio context')
      }),
    })
    renderRecord(engine)
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('no audio context'),
    )
  })

  it('toggles recording from the control bus', async () => {
    const engine = makeEngine()
    const bus = createControlBus()
    renderRecord(engine, bus)

    act(() => bus.publish({ kind: 'record_toggle' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Stop recording' }),
      ).toBeVisible(),
    )
    expect(engine.startRecording).toHaveBeenCalled()
  })
})
