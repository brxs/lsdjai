import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createControlBus, type ControlBus } from './bus'
import { ControlBusProvider } from './ControlBusProvider'
import { MidiControls } from './MidiControls'
import { useMidi } from './useMidi'

type FakeInput = {
  name: string
  onmidimessage: ((event: { data: Uint8Array | null }) => void) | null
}

function stubMidiAccess(inputs: FakeInput[]) {
  const access = {
    inputs: new Map(inputs.map((input, index) => [`in-${index}`, input])),
    outputs: new Map(),
    onstatechange: null,
  }
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: vi.fn(() => Promise.resolve(access)),
  })
}

function clearMidiAccess() {
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: undefined,
  })
}

/** App owns useMidi and passes the result down; mirror that here. */
function Harness() {
  const midi = useMidi()
  return (
    <MidiControls
      status={midi.status}
      deviceName={midi.deviceName}
      devices={midi.devices}
      onConnect={midi.connect}
      onSelectDevice={midi.selectDevice}
      readMonitor={midi.readMonitor}
    />
  )
}

function renderControls(bus: ControlBus = createControlBus()) {
  return render(
    <ControlBusProvider bus={bus}>
      <Harness />
    </ControlBusProvider>,
  )
}

afterEach(() => {
  clearMidiAccess()
  vi.restoreAllMocks()
})

describe('MidiControls', () => {
  it('reports MIDI as unavailable when the browser lacks Web MIDI', () => {
    clearMidiAccess()
    renderControls()
    expect(screen.getByRole('status')).toHaveTextContent('MIDI unavailable')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('connects on click and shows the device name', async () => {
    stubMidiAccess([{ name: 'DDJ-FLX4 MIDI 1', onmidimessage: null }])
    renderControls()

    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('DDJ-FLX4 MIDI 1'),
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers a retry when no supported controller is plugged in', async () => {
    stubMidiAccess([{ name: 'Some Keyboard', onmidimessage: null }])
    renderControls()

    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI' }))
    // The chip itself surfaces the failure and stays clickable to retry.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'No supported controller found' }),
      ).toBeEnabled(),
    )
  })

  it('shows no picker for a single controller, one to switch between two', async () => {
    stubMidiAccess([{ name: 'DDJ-FLX4 MIDI 1', onmidimessage: null }])
    const { unmount } = renderControls()
    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('DDJ-FLX4 MIDI 1'),
    )
    // One device: nothing to pick.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    unmount()

    stubMidiAccess([
      { name: 'DDJ-FLX4 MIDI 1', onmidimessage: null },
      { name: 'DDJ-400 MIDI 1', onmidimessage: null },
    ])
    renderControls()
    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI' }))
    // First match (the FLX4) binds; the picker offers both.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('DDJ-FLX4 MIDI 1'),
    )
    const picker = screen.getByRole('combobox', { name: 'Controller' })
    expect(picker).toBeInTheDocument()

    // Choosing the DDJ-400 re-binds onto it.
    fireEvent.change(picker, { target: { value: 'DDJ-400 MIDI 1' } })
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('DDJ-400 MIDI 1'),
    )
  })

  it('publishes translated intents and shows raw bytes in the monitor', async () => {
    const input: FakeInput = { name: 'DDJ-FLX4', onmidimessage: null }
    stubMidiAccess([input])
    const bus = createControlBus()
    const seen = vi.fn()
    bus.subscribe(seen)
    renderControls(bus)

    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI' }))
    await waitFor(() => expect(input.onmidimessage).not.toBeNull())

    input.onmidimessage?.({ data: new Uint8Array([0x90, 0x0b, 0x7f]) })
    expect(seen).toHaveBeenCalledWith({ kind: 'play_toggle', deck: 'a' })

    const monitor = await screen.findByLabelText('MIDI monitor')
    await waitFor(() => expect(monitor).toHaveTextContent('90 0B 7F'))
  })
})
