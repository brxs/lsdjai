import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AudioEngineProvider } from '../audio/AudioEngineProvider'
import type { AudioEngine } from '../audio/types'
import { createControlBus, type ControlBus } from '../control/bus'
import { ControlBusProvider } from '../control/ControlBusProvider'
import { MixerStrip, type ChannelControls } from './MixerStrip'

function makeEngine(overrides: Partial<AudioEngine> = {}): AudioEngine {
  return {
    getContextTime: vi.fn(() => 0),
    createDeckChannel: vi.fn(),
    resume: vi.fn(async () => {}),
    setCrossfade: vi.fn(),
    setCueMix: vi.fn(),
    listOutputDevices: vi.fn(async () => []),
    setOutputDevice: vi.fn(async () => {}),
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => new Blob(['x'], { type: 'audio/wav' })),
    getMasterLevel: vi.fn(() => 0),
    getMasterGainReduction: vi.fn(() => 0),
    ...overrides,
  }
}

function makeChannel(overrides: Partial<ChannelControls> = {}): ChannelControls {
  return {
    volume: 0.8,
    eq: { low: 0.5, mid: 0.5, high: 0.5 },
    cue: false,
    trim: { mode: 'auto' as const, db: 0 },
    onSetVolume: vi.fn(),
    onSetEqBand: vi.fn(),
    onSetCue: vi.fn(),
    onSetTrimDb: vi.fn(),
    onEnableAutoTrim: vi.fn(),
    getLevel: () => 0,
    ...overrides,
  }
}

type MixerOverrides = {
  channels?: Record<'a' | 'b', ChannelControls>
  bus?: ControlBus
  onCueMixChange?: (position: number) => void
  outputDevice?: string
  onOutputDeviceChange?: (name: string) => void
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
          outputDevice={overrides.outputDevice ?? ''}
          onOutputDeviceChange={overrides.onOutputDeviceChange ?? (() => {})}
          getPhaseOffset={() => null}
        />
      </ControlBusProvider>
    </AudioEngineProvider>,
  )
}

describe('MixerStrip channels', () => {
  it('stacks the EQ knobs hardware-style: Hi on top, Low at the bottom', () => {
    renderMixer(makeEngine())
    const channel = screen.getByRole('group', { name: 'Channel a' })
    const labels = within(channel)
      .getAllByText(/^EQ (Hi|Mid|Low)$/)
      .map((node) => node.textContent)
    expect(labels).toEqual(['EQ Hi', 'EQ Mid', 'EQ Low'])
  })

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

  it('moves a channel trim manually and re-engages auto', () => {
    const a = makeChannel({ trim: { mode: 'manual', db: 0 } })
    renderMixer(makeEngine(), { channels: { a, b: makeChannel() } })
    const channelA = screen.getByRole('group', { name: 'Channel a' })

    const trim = within(channelA).getByLabelText('Trim')
    // Knob is a native range input under the dial: 0.75 of the sweep
    // maps to +6 dB on the ±12 dB trim range.
    fireEvent.change(trim, { target: { value: '0.75' } })
    expect(a.onSetTrimDb).toHaveBeenCalledWith(6)

    fireEvent.click(within(channelA).getByRole('button', { name: 'Auto' }))
    expect(a.onEnableAutoTrim).toHaveBeenCalled()
  })

  it('lights AUTO while the trim follows the source', () => {
    renderMixer(makeEngine(), {
      channels: {
        a: makeChannel({ trim: { mode: 'auto', db: 3 } }),
        b: makeChannel({ trim: { mode: 'manual', db: 0 } }),
      },
    })
    const [autoA, autoB] = screen.getAllByRole('button', { name: 'Auto' })
    expect(autoA).toHaveAttribute('aria-pressed', 'true')
    expect(autoB).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows the limiter gain reduction only while it is working', () => {
    vi.useFakeTimers()
    try {
      const engine = makeEngine({ getMasterGainReduction: vi.fn(() => -3.2) })
      renderMixer(engine)
      const stat = screen.getByText('Limiter').parentElement!
      expect(stat).toHaveTextContent('—')
      act(() => void vi.advanceTimersByTime(300))
      expect(stat).toHaveTextContent('-3.2 dB')
    } finally {
      vi.useRealTimers()
    }
  })

})
