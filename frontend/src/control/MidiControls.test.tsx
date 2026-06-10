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
      onConnect={midi.connect}
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

  it('offers a retry when no FLX4 is plugged in', async () => {
    stubMidiAccess([{ name: 'Some Keyboard', onmidimessage: null }])
    renderControls()

    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('No DDJ-FLX4 found'),
    )
    expect(screen.getByRole('button', { name: 'Connect MIDI' })).toBeEnabled()
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
