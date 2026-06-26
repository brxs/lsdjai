import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { ControlBusProvider } from './ControlBusProvider'
import { useMidi } from './useMidi'

type FakeInput = {
  name: string
  onmidimessage: ((event: { data: Uint8Array }) => void) | null
}

function stubMidiAccess(outputSend: ReturnType<typeof vi.fn>) {
  const input: FakeInput = { name: 'DDJ-FLX4', onmidimessage: null }
  const access = {
    inputs: new Map([['in-0', input]]),
    outputs: new Map([['out-0', { name: 'DDJ-FLX4', send: outputSend }]]),
    onstatechange: null,
    sysexEnabled: true,
  }
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: vi.fn(() => Promise.resolve(access)),
  })
  return { input }
}

afterEach(() => {
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: undefined,
  })
  vi.restoreAllMocks()
})

function wrapper({ children }: { children: ReactNode }) {
  return <ControlBusProvider>{children}</ControlBusProvider>
}

describe('useMidi pad LEDs', () => {
  it('lights pads 1–N for a deck and switches the rest off', async () => {
    const send = vi.fn()
    stubMidiAccess(send)
    const { result } = renderHook(() => useMidi(), { wrapper })

    act(() => result.current.connect())
    await waitFor(() => expect(result.current.status).toBe('connected'))
    send.mockClear() // drop the bind-time position query

    act(() => result.current.setPadLeds('a', 2))
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      [0x97, 0, 0x7f],
      [0x97, 1, 0x7f],
      [0x97, 2, 0x00],
      [0x97, 3, 0x00],
      [0x97, 4, 0x00],
      [0x97, 5, 0x00],
      [0x97, 6, 0x00],
      [0x97, 7, 0x00],
    ])

    send.mockClear()
    act(() => result.current.setPadLeds('b', 1))
    expect(send.mock.calls[0][0]).toEqual([0x99, 0, 0x7f])
    expect(send.mock.calls.slice(1).every(([bytes]) => bytes[2] === 0)).toBe(true)
  })

  it('burns selected target pads bright and dims the unselected ones', async () => {
    const send = vi.fn()
    stubMidiAccess(send)
    const { result } = renderHook(() => useMidi(), { wrapper })
    act(() => result.current.connect())
    await waitFor(() => expect(result.current.status).toBe('connected'))
    send.mockClear()

    // Three targets, the middle one selected in the net.
    act(() => result.current.setPadLeds('a', 3, [false, true, false]))
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      [0x97, 0, 0x20], // available → dim
      [0x97, 1, 0x7f], // selected → bright
      [0x97, 2, 0x20], // available → dim
      [0x97, 3, 0x00],
      [0x97, 4, 0x00],
      [0x97, 5, 0x00],
      [0x97, 6, 0x00],
      [0x97, 7, 0x00],
    ])
  })

  it('is a safe no-op before any device is connected', () => {
    const { result } = renderHook(() => useMidi(), { wrapper })
    expect(() => result.current.setPadLeds('a', 3)).not.toThrow()
  })

  it('lights only the active effect pad in the PAD FX bank', async () => {
    const send = vi.fn()
    stubMidiAccess(send)
    const { result } = renderHook(() => useMidi(), { wrapper })
    act(() => result.current.connect())
    await waitFor(() => expect(result.current.status).toBe('connected'))

    send.mockClear()
    result.current.setFxPadLeds('a', 1)
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      [0x97, 0x10, 0x00],
      [0x97, 0x11, 0x7f],
      [0x97, 0x12, 0x00],
      [0x97, 0x13, 0x00],
      [0x97, 0x14, 0x00],
      [0x97, 0x15, 0x00],
      [0x97, 0x16, 0x00],
      [0x97, 0x17, 0x00],
    ])

    send.mockClear()
    result.current.setFxPadLeds('b', null)
    expect(send.mock.calls.every(([bytes]) => bytes[2] === 0)).toBe(true)
    expect(send.mock.calls[0][0][0]).toBe(0x99)
  })

  it('lights the filled loop slots in the SAMPLER bank', async () => {
    const send = vi.fn()
    stubMidiAccess(send)
    const { result } = renderHook(() => useMidi(), { wrapper })
    act(() => result.current.connect())
    await waitFor(() => expect(result.current.status).toBe('connected'))

    send.mockClear()
    result.current.setLoopPadLeds('a', [true, false, true, false])
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      [0x97, 0x30, 0x7f],
      [0x97, 0x31, 0x00],
      [0x97, 0x32, 0x7f],
      [0x97, 0x33, 0x00],
      [0x97, 0x34, 0x00],
      [0x97, 0x35, 0x00],
      [0x97, 0x36, 0x00],
      [0x97, 0x37, 0x00],
    ])
  })

  it('bumps the LED epoch when the controller switches pad modes', async () => {
    const send = vi.fn()
    const { input } = stubMidiAccess(send)
    const { result } = renderHook(() => useMidi(), { wrapper })
    act(() => result.current.connect())
    await waitFor(() => expect(result.current.status).toBe('connected'))
    const before = result.current.ledEpoch

    act(() => input.onmidimessage?.({ data: new Uint8Array([0x90, 0x1b, 0x7f]) }))
    expect(result.current.ledEpoch).toBe(before + 1)

    // Ordinary traffic doesn't trigger repaints.
    act(() => input.onmidimessage?.({ data: new Uint8Array([0xb6, 0x1f, 0x40]) }))
    expect(result.current.ledEpoch).toBe(before + 1)
  })

  it('bumps the LED epoch when the bound controller switches', async () => {
    const send = vi.fn()
    const access = {
      inputs: new Map([
        ['in-0', { name: 'DDJ-FLX4 MIDI 1', onmidimessage: null }],
        ['in-1', { name: 'DDJ-400 MIDI 1', onmidimessage: null }],
      ]),
      outputs: new Map([
        ['out-0', { name: 'DDJ-FLX4 MIDI 1', send }],
        ['out-1', { name: 'DDJ-400 MIDI 1', send }],
      ]),
      onstatechange: null,
      sysexEnabled: true,
    }
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: vi.fn(() => Promise.resolve(access)),
    })
    const { result } = renderHook(() => useMidi(), { wrapper })
    act(() => result.current.connect())
    // First match by registry order (the FLX4) binds; the initial paint rides
    // the status change, so the epoch hasn't bumped yet.
    await waitFor(() =>
      expect(result.current.deviceName).toBe('DDJ-FLX4 MIDI 1'),
    )
    // The first connect repaints via the status change, not the epoch.
    const before = result.current.ledEpoch
    expect(before).toBe(0)

    // Picking the other controller re-binds with the status still 'connected' —
    // the epoch must bump so the newly-bound device repaints.
    act(() => result.current.selectDevice('DDJ-400 MIDI 1'))
    expect(result.current.deviceName).toBe('DDJ-400 MIDI 1')
    expect(result.current.ledEpoch).toBe(before + 1)
  })

  it('echoes the cue button LEDs through the active driver', async () => {
    const send = vi.fn()
    stubMidiAccess(send)
    const { result } = renderHook(() => useMidi(), { wrapper })
    act(() => result.current.connect())
    await waitFor(() => expect(result.current.status).toBe('connected'))

    // App speaks deck + on/off; the FLX4 driver maps to the channel-cue
    // (0x54) and transport-cue (0x0C) bytes, velocity on/off.
    result.current.setChannelCueLed('a', true)
    expect(send).toHaveBeenLastCalledWith([0x90, 0x54, 0x7f])
    result.current.setTransportCueLed('b', false)
    expect(send).toHaveBeenLastCalledWith([0x91, 0x0c, 0x00])
  })
})
