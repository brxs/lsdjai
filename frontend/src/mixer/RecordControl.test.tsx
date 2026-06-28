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
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => new Blob(['x'], { type: 'audio/wav' })),
    getMasterLevel: vi.fn(() => 0),
    getMasterGainReduction: vi.fn(() => 0),
    ...overrides,
  }
}

function renderRecord(engine: AudioEngine, bus: ControlBus = createControlBus()) {
  return render(
    <AudioEngineProvider engine={engine}>
      <ControlBusProvider bus={bus}>
        <RecordControl />
      </ControlBusProvider>
    </AudioEngineProvider>,
  )
}

describe('RecordControl', () => {
  it('records the master bus and downloads the WAV on stop', async () => {
    const engine = makeEngine()
    const objectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:fake')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    try {
      renderRecord(engine)

      fireEvent.click(screen.getByRole('button', { name: 'Record' }))
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Stop recording' }),
        ).toBeVisible(),
      )
      expect(engine.startRecording).toHaveBeenCalled()
      expect(engine.resume).toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
      await waitFor(() => expect(engine.stopRecording).toHaveBeenCalled())
      await waitFor(() => expect(objectUrl).toHaveBeenCalled())
      expect(screen.getByRole('button', { name: 'Record' })).toBeVisible()
    } finally {
      vi.restoreAllMocks()
    }
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
