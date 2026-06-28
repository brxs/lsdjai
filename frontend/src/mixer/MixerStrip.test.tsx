import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AudioEngineProvider } from '../audio/AudioEngineProvider'
import type { AudioEngine } from '../audio/types'
import { MixerStrip, type ChannelControls } from './MixerStrip'

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
    startRecording: vi.fn(async () => '/Downloads/lsdj-take.wav'),
    stopRecording: vi.fn(async () => {}),
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
  onCueMixChange?: (position: number) => void
}

function renderMixer(engine: AudioEngine, overrides: MixerOverrides = {}) {
  return render(
    <AudioEngineProvider engine={engine}>
      <MixerStrip
        channels={overrides.channels ?? { a: makeChannel(), b: makeChannel() }}
        crossfade={0.5}
        onCrossfadeChange={() => {}}
        cueMix={0.5}
        onCueMixChange={overrides.onCueMixChange ?? (() => {})}
        getPhaseOffset={() => null}
      />
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
})
