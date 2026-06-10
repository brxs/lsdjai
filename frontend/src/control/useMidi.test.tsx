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

  it('echoes single-button LEDs with on/off velocities', async () => {
    const send = vi.fn()
    stubMidiAccess(send)
    const { result } = renderHook(() => useMidi(), { wrapper })
    act(() => result.current.connect())
    await waitFor(() => expect(result.current.status).toBe('connected'))

    result.current.setLed(0x90, 0x54, true)
    expect(send).toHaveBeenLastCalledWith([0x90, 0x54, 0x7f])
    result.current.setLed(0x91, 0x0c, false)
    expect(send).toHaveBeenLastCalledWith([0x91, 0x0c, 0x00])
  })
})
