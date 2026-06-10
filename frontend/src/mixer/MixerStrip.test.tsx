import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AudioEngineProvider } from '../audio/AudioEngineProvider'
import type { AudioEngine } from '../audio/engine'
import { createControlBus, type ControlBus } from '../control/bus'
import { ControlBusProvider } from '../control/ControlBusProvider'
import { MixerStrip, type ChannelControls } from './MixerStrip'

function makeEngine(overrides: Partial<AudioEngine> = {}): AudioEngine {
  return {
    createDeckChannel: vi.fn(),
    resume: vi.fn(async () => {}),
    setCrossfade: vi.fn(),
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => new Blob(['x'], { type: 'audio/wav' })),
    getMasterLevel: vi.fn(() => 0),
    ...overrides,
  }
}

function makeChannel(overrides: Partial<ChannelControls> = {}): ChannelControls {
  return {
    volume: 0.8,
    eq: { low: 0.5, mid: 0.5, high: 0.5 },
    onSetVolume: vi.fn(),
    onSetEqBand: vi.fn(),
    getLevel: () => 0,
    ...overrides,
  }
}

function renderMixer(
  engine: AudioEngine,
  channels: Record<'a' | 'b', ChannelControls> = { a: makeChannel(), b: makeChannel() },
  bus: ControlBus = createControlBus(),
) {
  return render(
    <AudioEngineProvider engine={engine}>
      <ControlBusProvider bus={bus}>
        <MixerStrip channels={channels} crossfade={0.5} onCrossfadeChange={() => {}} />
      </ControlBusProvider>
    </AudioEngineProvider>,
  )
}

describe('MixerStrip channels', () => {
  it('routes EQ knob and fader moves to the right channel', () => {
    const a = makeChannel()
    const b = makeChannel()
    renderMixer(makeEngine(), { a, b })

    fireEvent.change(screen.getAllByLabelText('EQ Low')[0], { target: { value: '0' } })
    expect(a.onSetEqBand).toHaveBeenCalledWith('low', 0)
    expect(b.onSetEqBand).not.toHaveBeenCalled()

    fireEvent.change(screen.getAllByLabelText('Volume')[1], { target: { value: '0.3' } })
    expect(b.onSetVolume).toHaveBeenCalledWith(0.3)
    expect(a.onSetVolume).not.toHaveBeenCalled()
  })
})

describe('MixerStrip recording', () => {
  it('records the master bus and downloads the WAV on stop', async () => {
    const engine = makeEngine()
    const objectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:fake')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    try {
      renderMixer(engine)

      fireEvent.click(screen.getByRole('button', { name: 'Record' }))
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Stop recording' })).toBeVisible(),
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
    renderMixer(engine)
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('no audio context'),
    )
  })

  it('toggles recording from the control bus', async () => {
    const engine = makeEngine()
    const bus = createControlBus()
    renderMixer(engine, undefined, bus)

    act(() => bus.publish({ kind: 'record_toggle' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Stop recording' })).toBeVisible(),
    )
    expect(engine.startRecording).toHaveBeenCalled()
  })
})
