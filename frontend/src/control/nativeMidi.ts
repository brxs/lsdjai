/** The webview side of the native MIDI service (ADR-0031).
 *
 * MIDI I/O lives in the Rust shell now — enumeration, hot-plug, the FLX4/
 * DDJ-400 translation, LEDs, and the issue-48 performance input. The webview
 * keeps two projections: the connection status (statusbar + picker) and the
 * raw-byte monitor (the firmware-verification loop), plus the `midi://intent`
 * event that carries translated control-surface intents onto the ControlBus —
 * the deck-control semantics those intents trigger still live in React.
 * Framework-free (the useMidi hook is the React side), Tauri-guarded like
 * nativeDeck.ts so tests and a plain browser get safe no-ops. */

import type { ControlIntent } from './bus'

type TauriCore = { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
type TauriEvent = {
  listen: (
    event: string,
    handler: (e: { payload: unknown }) => void,
  ) => Promise<() => void>
}
type TauriGlobal = { core?: TauriCore; event?: TauriEvent }

function tauri(): TauriGlobal | null {
  return (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null
}

/** The native connection status (mirrors Rust `MidiStatusDto`). The Web MIDI
 * permission states are gone — native access needs no gesture, so the whole
 * story is "bound to a controller or not". */
export type NativeMidiStatus = {
  connected: boolean
  deviceName: string | null
  driverId: string | null
  devices: string[]
}

export const DISCONNECTED_STATUS: NativeMidiStatus = {
  connected: false,
  deviceName: null,
  driverId: null,
  devices: [],
}

/** One raw message for the hex monitor (mirrors Rust `MonitorEntryDto`). */
export type MidiMonitorEntry = { id: number; bytes: number[] }

/** The current connection status (initial hydration; changes arrive via
 * subscribeMidiStatus). Resolves to disconnected outside Tauri. */
export async function midiStatus(): Promise<NativeMidiStatus> {
  const core = tauri()?.core
  if (!core) return DISCONNECTED_STATUS
  try {
    return (await core.invoke('midi_status')) as NativeMidiStatus
  } catch {
    return DISCONNECTED_STATUS
  }
}

/** The last few raw controller messages (the monitor poll). */
export async function midiMonitor(): Promise<MidiMonitorEntry[]> {
  const core = tauri()?.core
  if (!core) return []
  try {
    return (await core.invoke('midi_monitor')) as MidiMonitorEntry[]
  } catch {
    return []
  }
}

/** Pick which matched controller drives the app (by raw port name). */
export function midiSelect(name: string): void {
  void tauri()?.core?.invoke('midi_select', { name })
}

function listenTo<T>(event: string, handler: (payload: T) => void): () => void {
  const tauriEvent = tauri()?.event
  if (!tauriEvent) return () => {}
  let unlisten: (() => void) | null = null
  let cancelled = false
  void tauriEvent
    .listen(event, (e) => handler(e.payload as T))
    .then((un) => {
      if (cancelled) un()
      else unlisten = un
    })
  return () => {
    cancelled = true
    unlisten?.()
  }
}

/** Subscribe to connection-status changes (`midi://status`). */
export function subscribeMidiStatus(
  onStatus: (status: NativeMidiStatus) => void,
): () => void {
  return listenTo('midi://status', onStatus)
}

/** Subscribe to translated control-surface intents (`midi://intent`) — the
 * Rust translator's output, payload-compatible with the ControlBus. */
export function subscribeMidiIntent(
  onIntent: (intent: ControlIntent) => void,
): () => void {
  return listenTo('midi://intent', onIntent)
}
