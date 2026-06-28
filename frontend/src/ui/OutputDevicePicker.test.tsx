import { Profiler } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    auditionPlay: vi.fn(async () => {}),
    auditionStop: vi.fn(),
    listOutputDevices: vi.fn(async () => DEVICES),
    setMainDevice: vi.fn(async () => {}),
    setCueDevice: vi.fn(async () => {}),
    startRecording: vi.fn(async () => '/Downloads/lsdj-take.wav'),
    stopRecording: vi.fn(async () => {}),
    getMasterLevel: vi.fn(() => 0),
    getMasterGainReduction: vi.fn(() => 0),
    ...overrides,
  }
}

function renderPicker(
  engine: AudioEngine,
  props: {
    mode?: 'main' | 'cue'
    value?: string
    onSelect?: (name: string) => void
    mainDeviceName?: string
  } = {},
) {
  return render(
    <AudioEngineProvider engine={engine}>
      <OutputDevicePicker
        mode={props.mode ?? 'main'}
        value={props.value ?? ''}
        onSelect={props.onSelect ?? (() => {})}
        mainDeviceName={props.mainDeviceName}
      />
    </AudioEngineProvider>,
  )
}

describe('OutputDevicePicker — main', () => {
  it('lists the engine devices by name on mount, under "System default"', async () => {
    const engine = makeEngine()
    renderPicker(engine, { mode: 'main' })

    await waitFor(() => expect(engine.listOutputDevices).toHaveBeenCalled())
    await screen.findByRole('option', { name: 'System default' })
    expect(screen.getByRole('option', { name: 'Built-in Output' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'DDJ-FLX4' })).toBeInTheDocument()
  })

  it('switches the main device and reports the choice up on success', async () => {
    const engine = makeEngine()
    const onSelect = vi.fn()
    renderPicker(engine, { mode: 'main', onSelect })
    await screen.findByRole('option', { name: 'DDJ-FLX4' })

    fireEvent.change(screen.getByLabelText('Main output'), {
      target: { value: 'DDJ-FLX4' },
    })

    expect(engine.setMainDevice).toHaveBeenCalledWith('DDJ-FLX4')
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('DDJ-FLX4'))
  })

  it('routes "System default" to the engine (empty name) and reports it up', async () => {
    // The default option is the empty-string sentinel; the engine reads that as
    // the system default device and reopens it — so it DOES reach setMainDevice
    // (no spurious "device '' not found"), and the cleared choice is reported up.
    const engine = makeEngine()
    const onSelect = vi.fn()
    renderPicker(engine, { mode: 'main', value: 'DDJ-FLX4', onSelect })
    await screen.findByRole('option', { name: 'DDJ-FLX4' })

    fireEvent.change(screen.getByLabelText('Main output'), { target: { value: '' } })

    expect(engine.setMainDevice).toHaveBeenCalledWith('')
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(''))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reverts and surfaces an error when the switch is rejected', async () => {
    const engine = makeEngine({
      setMainDevice: vi.fn(async () => {
        throw new Error('device busy')
      }),
    })
    const onSelect = vi.fn()
    renderPicker(engine, { mode: 'main', value: '', onSelect })
    await screen.findByRole('option', { name: 'DDJ-FLX4' })

    fireEvent.change(screen.getByLabelText('Main output'), {
      target: { value: 'DDJ-FLX4' },
    })

    // The choice is NOT reported up (so the displayed value reverts to ''), and
    // the failure is surfaced rather than swallowed.
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('device busy'),
    )
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Main output')).toHaveValue('')
  })

  it('refreshes the device list each time the menu reopens', async () => {
    const engine = makeEngine()
    renderPicker(engine, { mode: 'main' })
    await waitFor(() => expect(engine.listOutputDevices).toHaveBeenCalledTimes(1))

    fireEvent.mouseDown(screen.getByLabelText('Main output'))
    expect(engine.listOutputDevices).toHaveBeenCalledTimes(2)
  })

  it('does not re-commit the picker when a reopen returns an unchanged list', async () => {
    // Regression: the reopen refresh used to setDevices() unconditionally,
    // landing a fresh array while the native <select> was open. That re-commits
    // the controlled select's value, and WKWebView dismisses an open popup whose
    // value is re-synced — so the menu closed before a choice could be made. An
    // unchanged list (same hardware) must now bail the update with no re-commit.
    const engine = makeEngine({
      // A new array instance each call with identical contents — the realistic
      // reopen, which previously churned state purely on reference inequality.
      listOutputDevices: vi.fn(async () => DEVICES.map((device) => ({ ...device }))),
    })
    let commits = 0
    render(
      <AudioEngineProvider engine={engine}>
        <Profiler
          id="picker"
          onRender={() => {
            commits += 1
          }}
        >
          <OutputDevicePicker mode="main" value="" onSelect={() => {}} />
        </Profiler>
      </AudioEngineProvider>,
    )
    // Let mount + the mount-time refresh settle, then ignore those commits.
    await screen.findByRole('option', { name: 'DDJ-FLX4' })
    commits = 0

    fireEvent.mouseDown(screen.getByLabelText('Main output'))
    await waitFor(() => expect(engine.listOutputDevices).toHaveBeenCalledTimes(2))
    // Flush the refresh's resolution so its setDevices runs (and bails).
    await act(async () => {})

    expect(commits).toBe(0)
  })

  it('keeps a persisted-but-absent device visible as the current value', async () => {
    const engine = makeEngine()
    renderPicker(engine, { mode: 'main', value: 'Ghost Interface' })
    await screen.findByRole('option', { name: 'System default' })

    // The saved device is gone from the engine list but still shown by name,
    // so the selection doesn't silently snap to the default.
    expect(screen.getByRole('option', { name: 'Ghost Interface' })).toBeInTheDocument()
    expect(screen.getByLabelText('Main output')).toHaveValue('Ghost Interface')
  })
})

describe('OutputDevicePicker — cue', () => {
  it('offers "Phones on main (ch 3/4)" when the main device can carry combined cue', async () => {
    const engine = makeEngine()
    renderPicker(engine, { mode: 'cue', mainDeviceName: 'DDJ-FLX4' })

    await screen.findByRole('option', { name: 'Phones on main (ch 3/4)' })
    // Any device is selectable as a separate cue device, by plain name.
    expect(screen.getByRole('option', { name: 'Built-in Output' })).toBeInTheDocument()
  })

  it('flags "needs a 4-ch main" when the main device is stereo', async () => {
    const engine = makeEngine()
    renderPicker(engine, { mode: 'cue', mainDeviceName: 'Built-in Output' })

    await screen.findByRole('option', {
      name: 'Phones on main — needs a 4-ch main',
    })
  })

  it('switches the cue device and reports the choice up on success', async () => {
    const engine = makeEngine()
    const onSelect = vi.fn()
    renderPicker(engine, { mode: 'cue', mainDeviceName: 'DDJ-FLX4', onSelect })
    await screen.findByRole('option', { name: 'Built-in Output' })

    fireEvent.change(screen.getByLabelText('Cue output'), {
      target: { value: 'Built-in Output' },
    })

    expect(engine.setCueDevice).toHaveBeenCalledWith('Built-in Output')
    expect(engine.setMainDevice).not.toHaveBeenCalled()
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('Built-in Output'))
  })

  it('routes "same as main" to the engine as the empty sentinel', async () => {
    const engine = makeEngine()
    const onSelect = vi.fn()
    renderPicker(engine, {
      mode: 'cue',
      value: 'Built-in Output',
      mainDeviceName: 'DDJ-FLX4',
      onSelect,
    })
    await screen.findByRole('option', { name: 'Phones on main (ch 3/4)' })

    fireEvent.change(screen.getByLabelText('Cue output'), { target: { value: '' } })

    expect(engine.setCueDevice).toHaveBeenCalledWith('')
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(''))
  })
})
