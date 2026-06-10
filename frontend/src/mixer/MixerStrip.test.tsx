import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AudioEngineProvider } from '../audio/AudioEngineProvider'
import type { AudioEngine } from '../audio/engine'
import { createControlBus, type ControlBus } from '../control/bus'
import { ControlBusProvider } from '../control/ControlBusProvider'
import { MixerStrip, type ChannelControls } from './MixerStrip'

vi.mock('../audio/outputs', () => ({
  listAudioOutputs: vi.fn(async () => [
    { deviceId: 'flx4', label: 'DDJ-FLX4 (2b73:0045)' },
    { deviceId: 'mac', label: 'MacBook Pro Speakers' },
    { deviceId: 'bt', label: 'WH-1000XM4' },
  ]),
}))

function makeEngine(overrides: Partial<AudioEngine> = {}): AudioEngine {
  return {
    createDeckChannel: vi.fn(),
    resume: vi.fn(async () => {}),
    setCrossfade: vi.fn(),
    setCueMix: vi.fn(),
    setCueDevice: vi.fn(async () => {}),
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
    cue: false,
    onSetVolume: vi.fn(),
    onSetEqBand: vi.fn(),
    onSetCue: vi.fn(),
    getLevel: () => 0,
    ...overrides,
  }
}

type MixerOverrides = {
  channels?: Record<'a' | 'b', ChannelControls>
  bus?: ControlBus
  cueDevice?: { deviceId: string; label: string } | null
  onCueMixChange?: (position: number) => void
  onCueDeviceChange?: (device: { deviceId: string; label: string } | null) => Promise<void>
}

function renderMixer(engine: AudioEngine, overrides: MixerOverrides = {}) {
  return render(
    <AudioEngineProvider engine={engine}>
      <ControlBusProvider bus={overrides.bus ?? createControlBus()}>
        <MixerStrip
          channels={overrides.channels ?? { a: makeChannel(), b: makeChannel() }}
          crossfade={0.5}
          onCrossfadeChange={() => {}}
          cueMix={0.5}
          onCueMixChange={overrides.onCueMixChange ?? (() => {})}
          cueDevice={overrides.cueDevice ?? null}
          onCueDeviceChange={overrides.onCueDeviceChange ?? (async () => {})}
        />
      </ControlBusProvider>
    </AudioEngineProvider>,
  )
}

describe('MixerStrip channels', () => {
  it('routes EQ knob and fader moves to the right channel', () => {
    const a = makeChannel()
    const b = makeChannel()
    renderMixer(makeEngine(), { channels: { a, b } })

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
    renderMixer(engine, { bus })

    act(() => bus.publish({ kind: 'record_toggle' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Stop recording' })).toBeVisible(),
    )
    expect(engine.startRecording).toHaveBeenCalled()
  })
})

describe('MixerStrip headphone cue', () => {
  it('routes CUE toggles to the right channel and shows the lit state', () => {
    const a = makeChannel({ cue: true })
    const b = makeChannel()
    renderMixer(makeEngine(), { channels: { a, b } })

    const cueButtons = screen.getAllByRole('button', { name: 'Cue' })
    expect(cueButtons[0]).toHaveAttribute('aria-pressed', 'true')
    expect(cueButtons[1]).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(cueButtons[0])
    expect(a.onSetCue).toHaveBeenCalledWith(false)
    fireEvent.click(cueButtons[1])
    expect(b.onSetCue).toHaveBeenCalledWith(true)
  })

  it('reports cue-mix knob moves', () => {
    const onCueMixChange = vi.fn()
    renderMixer(makeEngine(), { onCueMixChange })
    fireEvent.change(screen.getByLabelText('Cue mix'), { target: { value: '0.2' } })
    expect(onCueMixChange).toHaveBeenCalledWith(0.2)
  })

  it('scans for outputs, hides the FLX4, and hands the picked device up', async () => {
    const onCueDeviceChange = vi.fn(async () => {})
    renderMixer(makeEngine(), { onCueDeviceChange })

    fireEvent.click(screen.getByRole('button', { name: 'Find devices' }))
    const select = screen.getByLabelText('Phones out')
    await waitFor(() => expect(select).toContainHTML('WH-1000XM4'))
    expect(select).toContainHTML('MacBook Pro Speakers')
    // Never offered: cue to the FLX4 would come out the MASTER RCA —
    // the room hearing the preview — since Chromium can't reach its
    // phones channels (ADR-0006).
    expect(select).not.toContainHTML('DDJ-FLX4')

    fireEvent.change(select, { target: { value: 'WH-1000XM4' } })
    expect(onCueDeviceChange).toHaveBeenCalledWith({
      deviceId: 'bt',
      label: 'WH-1000XM4',
    })
  })

  it('keeps the saved device pickable without a scan, and can switch off', () => {
    const onCueDeviceChange = vi.fn(async () => {})
    renderMixer(makeEngine(), {
      cueDevice: { deviceId: 'flx4', label: 'DDJ-FLX4' },
      onCueDeviceChange,
    })

    const select = screen.getByLabelText('Phones out')
    expect(select).toHaveValue('DDJ-FLX4')
    fireEvent.change(select, { target: { value: 'Off' } })
    expect(onCueDeviceChange).toHaveBeenCalledWith(null)
  })

  it('surfaces a failing cue output instead of swallowing it', async () => {
    const onCueDeviceChange = vi.fn(async () => {
      throw new Error('sink gone')
    })
    renderMixer(makeEngine(), {
      cueDevice: { deviceId: 'flx4', label: 'DDJ-FLX4' },
      onCueDeviceChange,
    })

    fireEvent.change(screen.getByLabelText('Phones out'), {
      target: { value: 'DDJ-FLX4' },
    })
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('sink gone'),
    )
  })
})
