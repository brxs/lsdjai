import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AudioEngineProvider } from '../audio/AudioEngineProvider'
import type { AudioEngine, OutputDevice } from '../audio/types'
import { OutputDevicePicker } from './OutputDevicePicker'

const DEVICES: OutputDevice[] = [
  { name: 'Built-in Output', channels: 2, cueCapable: false },
  { name: 'DDJ-FLX4', channels: 4, cueCapable: true },
]

// Only the device methods matter here; the rest of the engine is unused by the
// picker, so they're left as no-op stubs to satisfy the interface.
function makeEngine(overrides: Partial<AudioEngine> = {}): AudioEngine {
  return {
    getContextTime: vi.fn(() => 0),
    createDeckChannel: vi.fn(),
    resume: vi.fn(async () => {}),
    setCrossfade: vi.fn(),
    setCueMix: vi.fn(),
    listOutputDevices: vi.fn(async () => DEVICES),
    setOutputDevice: vi.fn(async () => {}),
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async () => new Blob()),
    getMasterLevel: vi.fn(() => 0),
    getMasterGainReduction: vi.fn(() => 0),
    ...overrides,
  }
}

function renderPicker(
  engine: AudioEngine,
  props: { value?: string; onSelect?: (name: string) => void } = {},
) {
  return render(
    <AudioEngineProvider engine={engine}>
      <OutputDevicePicker value={props.value ?? ''} onSelect={props.onSelect ?? (() => {})} />
    </AudioEngineProvider>,
  )
}

describe('OutputDevicePicker', () => {
  it('lists the engine devices on mount, flagging cue-capable ones', async () => {
    const engine = makeEngine()
    renderPicker(engine)

    await waitFor(() => expect(engine.listOutputDevices).toHaveBeenCalled())
    // System default plus both devices, the 4-channel one marked cue-ready.
    await screen.findByRole('option', { name: 'System default' })
    expect(screen.getByRole('option', { name: 'Built-in Output — no cue (needs 4ch)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'DDJ-FLX4 — cue ready' })).toBeInTheDocument()
  })

  it('switches the engine and reports the choice up on a successful select', async () => {
    const engine = makeEngine()
    const onSelect = vi.fn()
    renderPicker(engine, { onSelect })
    await screen.findByRole('option', { name: 'DDJ-FLX4 — cue ready' })

    fireEvent.change(screen.getByLabelText('Output device'), {
      target: { value: 'DDJ-FLX4' },
    })

    expect(engine.setOutputDevice).toHaveBeenCalledWith('DDJ-FLX4')
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('DDJ-FLX4'))
  })

  it('routes "System default" to the engine (empty name) and reports it up', async () => {
    // The default option is the empty-string sentinel; the engine reads that as
    // the system default device and reopens it — so it DOES reach setOutputDevice
    // (no spurious "device '' not found"), and the cleared choice is reported up.
    const engine = makeEngine()
    const onSelect = vi.fn()
    renderPicker(engine, { value: 'DDJ-FLX4', onSelect })
    await screen.findByRole('option', { name: 'DDJ-FLX4 — cue ready' })

    fireEvent.change(screen.getByLabelText('Output device'), {
      target: { value: '' },
    })

    expect(engine.setOutputDevice).toHaveBeenCalledWith('')
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(''))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reverts and surfaces an error when the switch is rejected', async () => {
    const engine = makeEngine({
      setOutputDevice: vi.fn(async () => {
        throw new Error('device busy')
      }),
    })
    const onSelect = vi.fn()
    renderPicker(engine, { value: '', onSelect })
    await screen.findByRole('option', { name: 'DDJ-FLX4 — cue ready' })

    fireEvent.change(screen.getByLabelText('Output device'), {
      target: { value: 'DDJ-FLX4' },
    })

    // The choice is NOT reported up (so the displayed value reverts to ''), and
    // the failure is surfaced rather than swallowed.
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('device busy'),
    )
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Output device')).toHaveValue('')
  })

  it('refreshes the device list each time the menu reopens', async () => {
    const engine = makeEngine()
    renderPicker(engine)
    await waitFor(() => expect(engine.listOutputDevices).toHaveBeenCalledTimes(1))

    fireEvent.mouseDown(screen.getByLabelText('Output device'))
    expect(engine.listOutputDevices).toHaveBeenCalledTimes(2)
  })

  it('keeps a persisted-but-absent device visible as the current value', async () => {
    const engine = makeEngine()
    renderPicker(engine, { value: 'Ghost Interface' })
    await screen.findByRole('option', { name: 'System default' })

    // The saved device is gone from the engine list but still shown by name,
    // so the selection doesn't silently snap to the default.
    expect(screen.getByRole('option', { name: 'Ghost Interface' })).toBeInTheDocument()
    expect(screen.getByLabelText('Output device')).toHaveValue('Ghost Interface')
  })
})
