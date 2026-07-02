import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import { useInterfaceStore, useProjected } from './interfaceStore'
import {
  storeSnapshot,
  subscribeStoreChanged,
  type DeckSnap,
  type InterfaceState,
} from './nativeEngine'

// The store hooks read the Rust store through these two primitives; mock them so we
// can drive the snapshot + change events deterministically.
vi.mock('./nativeEngine', () => ({
  storeSnapshot: vi.fn(),
  subscribeStoreChanged: vi.fn(),
}))

const deck = (): DeckSnap => ({
  volume: 1,
  eq: { low: 0.5, mid: 0.5, high: 0.5 },
  trimDb: 0,
  cue: false,
  onAir: true,
  fx: { kind: null, amount: 0 },
  model: null,
  playing: false,
  cues: [],
  track: null,
  transport: null,
  loopLabels: [],
  styleTargets: [],
  cursor: { x: 0.5, y: 0.5 },
  notes: null,
  drums: null,
})

const sample = (over: Partial<InterfaceState> = {}): InterfaceState => ({
  decks: [deck(), deck()],
  crossfade: 0.3,
  cueMix: 0.4,
  ...over,
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useProjected', () => {
  it('renders the seed and emits on a local gesture', () => {
    const emit = vi.fn()
    const { result } = renderHook(() =>
      useProjected<number>(undefined, 0.7, emit),
    )
    expect(result.current[0]).toBe(0.7)

    act(() => result.current[1](0.9))
    expect(result.current[0]).toBe(0.9) // optimistic local render
    expect(emit).toHaveBeenCalledWith(0.9)
  })

  it('ignores the pre-hydration default, then adopts genuine external moves', () => {
    const { result, rerender } = renderHook(
      ({ ext }: { ext: number | undefined }) =>
        useProjected<number>(ext, 0.7, vi.fn()),
      { initialProps: { ext: undefined as number | undefined } },
    )
    expect(result.current[0]).toBe(0.7)

    // A store value that differs from our seed before sync is the Rust default,
    // not an external move — ignore it (no flash).
    rerender({ ext: 0.5 })
    expect(result.current[0]).toBe(0.7)

    // Boot hydration echoes our seed back → synced.
    rerender({ ext: 0.7 })
    expect(result.current[0]).toBe(0.7)

    // A later differing value is a real external move (MIDI / MCP) → adopt it.
    rerender({ ext: 0.2 })
    expect(result.current[0]).toBe(0.2)
  })

  it('suppresses a lagging echo mid-gesture, then adopts a settled external move', () => {
    vi.useFakeTimers()
    try {
      const emit = vi.fn()
      const { result, rerender } = renderHook(
        ({ ext }: { ext: number | undefined }) =>
          useProjected<number>(ext, 0.5, emit),
        { initialProps: { ext: undefined as number | undefined } },
      )
      act(() => result.current[1](0.8)) // our gesture → synced + lastWrite 0.8

      // A differing value within the settle window is a lagging coalesced echo,
      // not an external move — adopting it would snap the control back a frame.
      rerender({ ext: 0.1 })
      expect(result.current[0]).toBe(0.8)

      // Once the gesture settles, a genuine external move (MIDI / MCP) is adopted.
      act(() => {
        vi.advanceTimersByTime(200)
      })
      rerender({ ext: 0.3 })
      expect(result.current[0]).toBe(0.3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useInterfaceStore', () => {
  it('hydrates from the snapshot and follows store changes', async () => {
    const initial = sample({ crossfade: 0.3 })
    ;(storeSnapshot as Mock).mockResolvedValue(initial)
    let emitChange: (state: InterfaceState) => void = () => {}
    ;(subscribeStoreChanged as Mock).mockImplementation(
      (fn: (state: InterfaceState) => void) => {
        emitChange = fn
        return () => {}
      },
    )

    const { result } = renderHook(() => useInterfaceStore())
    expect(result.current).toBeNull()

    await waitFor(() => expect(result.current).toEqual(initial))

    const next = sample({ crossfade: 0.9 })
    act(() => emitChange(next))
    expect(result.current?.crossfade).toBe(0.9)
  })

  it('lets a change event that beat the initial fetch win', async () => {
    // The initial fetch resolves AFTER a change event already landed a fresher
    // snapshot; the stale fetch must not clobber it.
    let resolveFetch: (state: InterfaceState) => void = () => {}
    ;(storeSnapshot as Mock).mockReturnValue(
      new Promise<InterfaceState>((resolve) => {
        resolveFetch = resolve
      }),
    )
    let emitChange: (state: InterfaceState) => void = () => {}
    ;(subscribeStoreChanged as Mock).mockImplementation(
      (fn: (state: InterfaceState) => void) => {
        emitChange = fn
        return () => {}
      },
    )

    const { result } = renderHook(() => useInterfaceStore())
    const fresh = sample({ crossfade: 0.6 })
    act(() => emitChange(fresh))
    expect(result.current?.crossfade).toBe(0.6)

    // The late, stale initial fetch resolves — it must be ignored.
    await act(async () => {
      resolveFetch(sample({ crossfade: 0.1 }))
    })
    expect(result.current?.crossfade).toBe(0.6)
  })
})
