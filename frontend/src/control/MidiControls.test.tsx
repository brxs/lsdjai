import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createControlBus, type ControlBus } from './bus'
import { ControlBusProvider } from './ControlBusProvider'
import { MidiControls } from './MidiControls'
import { useMidi } from './useMidi'
import {
  midiMonitor,
  midiSelect,
  midiStatus,
  subscribeMidiIntent,
  subscribeMidiStatus,
  type NativeMidiStatus,
} from './nativeMidi'

// The shell owns the MIDI transport (ADR-0031); the webview sees only the
// status/monitor commands and the midi://intent / midi://status events.
vi.mock('./nativeMidi', async (importOriginal) => {
  const original = await importOriginal<typeof import('./nativeMidi')>()
  return {
    ...original,
    midiStatus: vi.fn(async () => original.DISCONNECTED_STATUS),
    midiMonitor: vi.fn(async () => []),
    midiSelect: vi.fn(),
    subscribeMidiStatus: vi.fn(() => () => {}),
    subscribeMidiIntent: vi.fn(() => () => {}),
  }
})

const connectedStatus = (over: Partial<NativeMidiStatus> = {}): NativeMidiStatus => ({
  connected: true,
  deviceName: 'DDJ-FLX4 MIDI 1',
  driverId: 'flx4',
  devices: ['DDJ-FLX4 MIDI 1'],
  ...over,
})

/** App owns useMidi and passes the result down; mirror that here. */
function Harness() {
  const midi = useMidi()
  return (
    <MidiControls
      connected={midi.connected}
      deviceName={midi.deviceName}
      devices={midi.devices}
      onSelectDevice={midi.selectDevice}
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

beforeEach(() => {
  vi.mocked(midiStatus).mockResolvedValue({
    connected: false,
    deviceName: null,
    driverId: null,
    devices: [],
  })
  vi.mocked(midiMonitor).mockResolvedValue([])
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('MidiControls', () => {
  it('shows a passive no-controller status while nothing is bound', async () => {
    renderControls()
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'No supported controller found',
      ),
    )
    // Native binding is automatic — there is no connect button any more.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows the bound device name from the initial status hydrate', async () => {
    vi.mocked(midiStatus).mockResolvedValue(connectedStatus())
    renderControls()
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('DDJ-FLX4 MIDI 1'),
    )
    // One device: nothing to pick.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('follows midi://status changes (hot-plug lands without a gesture)', async () => {
    let announce: ((status: NativeMidiStatus) => void) | null = null
    vi.mocked(subscribeMidiStatus).mockImplementation((onStatus) => {
      announce = onStatus
      return () => {}
    })
    renderControls()
    await waitFor(() => expect(announce).not.toBeNull())

    announce!(connectedStatus())
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('DDJ-FLX4 MIDI 1'),
    )
  })

  it('offers a picker for two controllers and selects through the shell', async () => {
    vi.mocked(midiStatus).mockResolvedValue(
      connectedStatus({ devices: ['DDJ-FLX4 MIDI 1', 'DDJ-400 MIDI 1'] }),
    )
    renderControls()
    const picker = await screen.findByRole('combobox', { name: 'Controller' })
    fireEvent.change(picker, { target: { value: 'DDJ-400 MIDI 1' } })
    expect(midiSelect).toHaveBeenCalledWith('DDJ-400 MIDI 1')
  })

  it('bridges midi://intent onto the ControlBus', async () => {
    let deliver: ((intent: { kind: string }) => void) | null = null
    vi.mocked(subscribeMidiIntent).mockImplementation((onIntent) => {
      deliver = onIntent as (intent: { kind: string }) => void
      return () => {}
    })
    const bus = createControlBus()
    const seen = vi.fn()
    bus.subscribe(seen)
    renderControls(bus)
    await waitFor(() => expect(deliver).not.toBeNull())

    deliver!({ kind: 'play_toggle', deck: 'a' } as never)
    expect(seen).toHaveBeenCalledWith({ kind: 'play_toggle', deck: 'a' })
  })

  it('shows raw bytes from the native monitor while connected', async () => {
    vi.mocked(midiStatus).mockResolvedValue(connectedStatus())
    vi.mocked(midiMonitor).mockResolvedValue([
      { id: 0, bytes: [0x90, 0x0b, 0x7f] },
    ])
    renderControls()
    const monitor = await screen.findByLabelText('MIDI monitor')
    await waitFor(() => expect(monitor).toHaveTextContent('90 0B 7F'))
  })
})
