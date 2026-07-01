import { describe, expect, it, vi } from 'vitest'

import { ddj400Driver } from './ddj400'
import type { ControllerDriver } from './driver'
import { flx4Driver, FLX4_STATUS_QUERY } from './flx4'
import { createMidiLink, type MidiStatus } from './midi'

type FakePort = {
  name: string
  onmidimessage: ((event: { data: Uint8Array | null }) => void) | null
  send: ReturnType<typeof vi.fn>
}

function fakePort(name: string): FakePort {
  return { name, onmidimessage: null, send: vi.fn() }
}

function fakeAccess(inputs: FakePort[], outputs: FakePort[] = []) {
  return {
    inputs: new Map(inputs.map((port, index) => [`in-${index}`, port])),
    outputs: new Map(outputs.map((port, index) => [`out-${index}`, port])),
    onstatechange: null as (() => void) | null,
    sysexEnabled: true,
  }
}

function createLink(
  access: ReturnType<typeof fakeAccess>,
  drivers: ControllerDriver[] = [flx4Driver],
) {
  const statuses: Array<[MidiStatus, string | null]> = []
  const available: string[][] = []
  const onMessage = vi.fn()
  const requestAccess = vi.fn(() =>
    Promise.resolve(access as unknown as MIDIAccess),
  )
  const link = createMidiLink({
    drivers,
    onMessage,
    onStatus: (status, active, devices) => {
      statuses.push([status, active?.name ?? null])
      available.push(devices.map((device) => device.name))
    },
    requestAccess,
  })
  return { link, statuses, available, onMessage, requestAccess }
}

describe('createMidiLink', () => {
  it('reports unsupported when Web MIDI is unavailable', async () => {
    const statuses: MidiStatus[] = []
    const link = createMidiLink({
      drivers: [flx4Driver],
      onMessage: vi.fn(),
      onStatus: (status) => statuses.push(status),
    })
    await link.connect()
    expect(statuses).toEqual(['unsupported'])
  })

  it('connects to an input whose name matches a registered controller', async () => {
    const { link, statuses } = createLink(
      fakeAccess([fakePort('Some Keyboard'), fakePort('DDJ-FLX4 MIDI 1')]),
    )
    await link.connect()
    expect(statuses).toEqual([
      ['requesting', null],
      ['connected', 'DDJ-FLX4 MIDI 1'],
    ])
  })

  it('forwards incoming message bytes', async () => {
    const flx4 = fakePort('DDJ-FLX4')
    const { link, onMessage } = createLink(fakeAccess([flx4]))
    await link.connect()
    const data = new Uint8Array([0x90, 0x0b, 0x7f])
    flx4.onmidimessage?.({ data })
    expect(onMessage).toHaveBeenCalledWith(data)
    flx4.onmidimessage?.({ data: null })
    expect(onMessage).toHaveBeenCalledTimes(1)
  })

  it('reports no-device when nothing matches a registered controller', async () => {
    const { link, statuses } = createLink(fakeAccess([fakePort('Some Keyboard')]))
    await link.connect()
    expect(statuses.at(-1)).toEqual(['no-device', null])
  })

  it('reports denied when the permission request rejects', async () => {
    const statuses: MidiStatus[] = []
    const link = createMidiLink({
      drivers: [flx4Driver],
      onMessage: vi.fn(),
      onStatus: (status) => statuses.push(status),
      requestAccess: () => Promise.reject(new Error('NotAllowedError')),
    })
    await link.connect()
    expect(statuses).toEqual(['requesting', 'denied'])
  })

  it('reuses the granted access on a retry instead of re-requesting', async () => {
    const access = fakeAccess([])
    const { link, statuses, requestAccess } = createLink(access)
    await link.connect()
    expect(statuses.at(-1)).toEqual(['no-device', null])

    access.inputs.set('in-late', fakePort('DDJ-FLX4'))
    await link.connect()
    expect(requestAccess).toHaveBeenCalledTimes(1)
    expect(statuses.at(-1)).toEqual(['connected', 'DDJ-FLX4'])
  })

  it('picks up a device hot-plugged after connect', async () => {
    const access = fakeAccess([])
    const { link, statuses, onMessage } = createLink(access)
    await link.connect()
    expect(statuses.at(-1)).toEqual(['no-device', null])

    const flx4 = fakePort('DDJ-FLX4')
    access.inputs.set('in-late', flx4)
    access.onstatechange?.()
    expect(statuses.at(-1)).toEqual(['connected', 'DDJ-FLX4'])
    flx4.onmidimessage?.({ data: new Uint8Array([0xb6, 0x1f, 0x40]) })
    expect(onMessage).toHaveBeenCalled()
  })

  it('detaches and reports no-device when the deck is unplugged', async () => {
    const flx4 = fakePort('DDJ-FLX4')
    const access = fakeAccess([flx4])
    const { link, statuses } = createLink(access)
    await link.connect()

    access.inputs.clear()
    access.onstatechange?.()
    expect(statuses.at(-1)).toEqual(['no-device', null])
    expect(flx4.onmidimessage).toBeNull()
  })

  it('queries current control positions when the device first binds', async () => {
    const flx4Out = fakePort('DDJ-FLX4')
    const access = fakeAccess([fakePort('DDJ-FLX4')], [flx4Out])
    const { link } = createLink(access)
    await link.connect()
    // Knobs only report when moved; the query makes the controller dump
    // its current positions so the app syncs on connect.
    expect(flx4Out.send).toHaveBeenCalledWith(FLX4_STATUS_QUERY)
  })

  it('does not re-query on a rescan that keeps the same device bound', async () => {
    // tauri-plugin-midi re-enumerates ports ~1 Hz for hot-plug, each firing
    // onstatechange → bind. A rescan that does NOT change the bound input must not
    // re-send the position query: it would re-assert the controller's physical
    // knob/fader positions and clobber a software / MCP mixer move.
    const flx4Out = fakePort('DDJ-FLX4')
    const access = fakeAccess([fakePort('DDJ-FLX4')], [flx4Out])
    const { link } = createLink(access)
    await link.connect()
    flx4Out.send.mockClear()
    access.onstatechange?.() // same device still present — a no-op rebind
    expect(flx4Out.send).not.toHaveBeenCalled()
  })

  it('re-queries when the device is replugged', async () => {
    const flx4Out = fakePort('DDJ-FLX4')
    const access = fakeAccess([fakePort('DDJ-FLX4')], [flx4Out])
    const { link } = createLink(access)
    await link.connect()
    expect(flx4Out.send).toHaveBeenCalledWith(FLX4_STATUS_QUERY)

    // Unplug (no device → nothing to query), then replug: the input changes, so the
    // app re-syncs to the freshly bound hardware.
    flx4Out.send.mockClear()
    access.inputs.clear()
    access.onstatechange?.()
    expect(flx4Out.send).not.toHaveBeenCalled()
    access.inputs.set('in-replug', fakePort('DDJ-FLX4'))
    access.onstatechange?.()
    expect(flx4Out.send).toHaveBeenCalledWith(FLX4_STATUS_QUERY)
  })

  it('connects without the query when the grant has no SysEx', async () => {
    const flx4Out = fakePort('DDJ-FLX4')
    const access = fakeAccess([fakePort('DDJ-FLX4')], [flx4Out])
    access.sysexEnabled = false
    const { link, statuses } = createLink(access)
    await link.connect()
    expect(statuses.at(-1)).toEqual(['connected', 'DDJ-FLX4'])
    expect(flx4Out.send).not.toHaveBeenCalled()
  })

  it('falls back to plain MIDI when the SysEx request is refused', async () => {
    const access = fakeAccess([fakePort('DDJ-FLX4')])
    access.sysexEnabled = false
    const requestMIDIAccess = vi.fn((options?: { sysex?: boolean }) =>
      options?.sysex
        ? Promise.reject(new Error('SecurityError'))
        : Promise.resolve(access as unknown as MIDIAccess),
    )
    const original = Object.getOwnPropertyDescriptor(
      navigator,
      'requestMIDIAccess',
    )
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: requestMIDIAccess,
    })
    try {
      const statuses: MidiStatus[] = []
      const link = createMidiLink({
        drivers: [flx4Driver],
        onMessage: vi.fn(),
        onStatus: (status) => statuses.push(status),
      })
      await link.connect()
      expect(statuses.at(-1)).toBe('connected')
      expect(requestMIDIAccess).toHaveBeenCalledTimes(2)
    } finally {
      if (original) {
        Object.defineProperty(navigator, 'requestMIDIAccess', original)
      } else {
        delete (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess
      }
    }
  })

  it('skips the position query when only an input is present', async () => {
    const { link, statuses } = createLink(fakeAccess([fakePort('DDJ-FLX4')]))
    await expect(link.connect()).resolves.toBeUndefined()
    expect(statuses.at(-1)).toEqual(['connected', 'DDJ-FLX4'])
  })

  it('sends LED bytes to the matching output only', async () => {
    const other = fakePort('Some Synth')
    const flx4Out = fakePort('DDJ-FLX4')
    const { link } = createLink(fakeAccess([fakePort('DDJ-FLX4')], [other, flx4Out]))
    await link.connect()
    link.send([0x97, 0x00, 0x7f])
    expect(flx4Out.send).toHaveBeenCalledWith([0x97, 0x00, 0x7f])
    expect(other.send).not.toHaveBeenCalled()
  })

  it('sending without a device is a no-op', async () => {
    const { link } = createLink(fakeAccess([]))
    await link.connect()
    expect(() => link.send([0x97, 0x00, 0x7f])).not.toThrow()
  })

  describe('multiple controllers', () => {
    const drivers = [flx4Driver, ddj400Driver]

    it('binds the first match and lists every connected controller', async () => {
      const { link, statuses, available } = createLink(
        fakeAccess([fakePort('DDJ-400'), fakePort('DDJ-FLX4')]),
        drivers,
      )
      await link.connect()
      // First match by registry order — the FLX4 leads CONTROLLER_DRIVERS.
      expect(statuses.at(-1)).toEqual(['connected', 'DDJ-FLX4'])
      expect(available.at(-1)).toEqual(['DDJ-400', 'DDJ-FLX4'])
    })

    it('switches to a selected controller and sends its own SysEx', async () => {
      const flx4Out = fakePort('DDJ-FLX4')
      const ddj400Out = fakePort('DDJ-400')
      const access = fakeAccess(
        [fakePort('DDJ-FLX4'), fakePort('DDJ-400')],
        [flx4Out, ddj400Out],
      )
      const { link, statuses } = createLink(access, drivers)
      await link.connect()
      expect(statuses.at(-1)).toEqual(['connected', 'DDJ-FLX4'])

      ddj400Out.send.mockClear()
      link.select('DDJ-400')
      expect(statuses.at(-1)).toEqual(['connected', 'DDJ-400'])
      // The DDJ-400's own position query goes to its output, not the FLX4's.
      expect(ddj400Out.send).toHaveBeenCalledWith(ddj400Driver.initSysex)
    })

    it('keeps a chosen controller selected across a re-bind', async () => {
      const access = fakeAccess([fakePort('DDJ-FLX4'), fakePort('DDJ-400')])
      const { link, statuses } = createLink(access, drivers)
      await link.connect()
      link.select('DDJ-400')
      expect(statuses.at(-1)).toEqual(['connected', 'DDJ-400'])

      // A hot-plug statechange re-binds; the explicit choice survives.
      access.onstatechange?.()
      expect(statuses.at(-1)).toEqual(['connected', 'DDJ-400'])
    })
  })
})
