import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { ControlBusProvider } from './ControlBusProvider'
import { useMidi } from './useMidi'

function stubMidiAccess(outputSend: ReturnType<typeof vi.fn>) {
  const access = {
    inputs: new Map([['in-0', { name: 'DDJ-FLX4', onmidimessage: null }]]),
    outputs: new Map([['out-0', { name: 'DDJ-FLX4', send: outputSend }]]),
    onstatechange: null,
  }
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: vi.fn(() => Promise.resolve(access)),
  })
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
})
