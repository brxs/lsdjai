/** React projection of the Rust interface-state store (ADR-0020, issue #37 Phase 1).
 *
 * Rust is authoritative for the semantic/audio-param interface state; these hooks
 * turn the webview into a unidirectional projection of it. `useInterfaceStore`
 * follows the live snapshot; `useProjected` renders one value optimistically during
 * a local gesture while reconciling to the store as the truth — so a fader/jog drag
 * stays responsive yet an external change (MIDI, or a future MCP agent) is adopted.
 *
 * View state stays in React (the ADR-0020 narrowing) and never flows through here. */

import { useEffect, useRef, useState } from 'react'

import type { FxKind } from './fx'
import {
  storeSnapshot,
  subscribeStoreChanged,
  type FxKindSnap,
  type InterfaceState,
} from './nativeEngine'

/** Map a store FX kind (camelCase wire value) back to the TS `FxKind` (snake) —
 * the inverse of `nativeEngine`'s `FX_ARG`, for adopting an external FX change. */
const FX_KIND_FROM_SNAP: Record<FxKindSnap, FxKind> = {
  filter: 'filter',
  dubEcho: 'dub_echo',
  space: 'space',
  crush: 'crush',
  noise: 'noise',
  sweep: 'sweep',
}

export function fxKindFromSnap(kind: FxKindSnap | null): FxKind | null {
  return kind === null ? null : FX_KIND_FROM_SNAP[kind]
}

/** Follow the authoritative store: hydrate from `store_snapshot` on mount, then
 * track `store://changed`. Null until the first snapshot resolves. */
export function useInterfaceStore(): InterfaceState | null {
  const [snapshot, setSnapshot] = useState<InterfaceState | null>(null)
  useEffect(() => {
    let alive = true
    void storeSnapshot()
      .then((state) => {
        // A `store://changed` may have already landed a fresher snapshot; don't let
        // the initial fetch clobber it.
        if (alive) setSnapshot((current) => current ?? state)
      })
      .catch(() => {})
    const unsubscribe = subscribeStoreChanged((state) => {
      if (alive) setSnapshot(state)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])
  return snapshot
}

/** Project one authoritative store value with optimistic local rendering.
 *
 * A local gesture calls the returned setter, which updates the rendered value
 * immediately and emits the intent (`emit`) — the knob never waits on the Rust
 * round-trip. When the store reports a value that differs from our own last write
 * (an EXTERNAL change — MIDI, MCP, another controller), it is adopted; our own
 * echoes are ignored, so the optimistic value is never fought by its own
 * confirmation. The store stays the reconciliation truth.
 *
 * `external` is the projected store value (e.g. `snapshot?.crossfade`); `initial`
 * seeds the first render before the store has reported (typically the persisted
 * value, so there is no flash). Use a primitive `T` (number/boolean/string): an
 * object would never compare equal across snapshots and would fight the gesture. */
export function useProjected<T>(
  external: T | undefined,
  initial: T,
  emit: (value: T) => void,
): [T, (value: T) => void] {
  const [local, setLocal] = useState<T>(initial)
  const lastWrite = useRef<T>(initial)
  // Until the store confirms our seed (boot hydration replays the persisted value),
  // ignore a differing store value — it's the pre-hydration Rust default, not an
  // external change. Once the store echoes our value we are synced, and every later
  // differing value is a genuine external move (MIDI / MCP) to adopt.
  const synced = useRef(false)
  useEffect(() => {
    if (external === undefined) return
    if (external === lastWrite.current) {
      synced.current = true
      return
    }
    if (!synced.current) return
    lastWrite.current = external
    setLocal(external)
  }, [external])
  const set = (value: T) => {
    lastWrite.current = value
    synced.current = true
    setLocal(value)
    emit(value)
  }
  return [local, set]
}
