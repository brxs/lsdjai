import { describe, expect, it, vi } from 'vitest'

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
  }
}

function createLink(access: ReturnType<typeof fakeAccess>) {
  const statuses: Array<[MidiStatus, string | null]> = []
  const onMessage = vi.fn()
  const requestAccess = vi.fn(() =>
    Promise.resolve(access as unknown as MIDIAccess),
  )
  const link = createMidiLink({
    onMessage,
    onStatus: (status, deviceName) => statuses.push([status, deviceName]),
    requestAccess,
  })
  return { link, statuses, onMessage, requestAccess }
}

describe('createMidiLink', () => {
  it('reports unsupported when Web MIDI is unavailable', async () => {
    const statuses: MidiStatus[] = []
    const link = createMidiLink({
      onMessage: vi.fn(),
      onStatus: (status) => statuses.push(status),
    })
    await link.connect()
    expect(statuses).toEqual(['unsupported'])
  })

  it('connects to an input whose name contains DDJ-FLX4', async () => {
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

  it('reports no-device when nothing matches', async () => {
    const { link, statuses } = createLink(fakeAccess([fakePort('Some Keyboard')]))
    await link.connect()
    expect(statuses.at(-1)).toEqual(['no-device', null])
  })

  it('reports denied when the permission request rejects', async () => {
    const statuses: MidiStatus[] = []
    const link = createMidiLink({
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
})
