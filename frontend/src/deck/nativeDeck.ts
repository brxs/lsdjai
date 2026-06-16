/** Native (Tauri) deck transport — the cutover (Phase 2 part 7) of the per-deck
 * control + status path off the FastAPI WebSocket.
 *
 * In the browser, `useDeck` opens `/ws/deck/{id}`: it SENDS control as JSON text
 * frames and RECEIVES PCM + status. In the native shell the model PCM goes
 * sidecar → Rust engine directly (part 4), so the UI no longer transits audio;
 * control is forwarded to the sidecar over IPC (`deck_*` commands) and status
 * arrives as `sidecar://status` events. This module is that mapping. */

import type { DeckId } from '../audio/types'

const DECK_INDEX: Record<DeckId, number> = { a: 0, b: 1 }

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

/** A deck control command (the same `{ type, … }` shapes `useDeck` sends over the
 * WebSocket in the browser). */
export type DeckCommand = { type: string; [key: string]: unknown }

/** Forward a deck command to the sidecar over IPC. play/stop/set_style map to the
 * `deck_*` commands; set_model and restart both map to `deck_set_model` (a model
 * switch restarts the sidecar with the new model, reusing the deck ring; restart
 * re-uses the deck's current model, which `useDeck` passes through). A command
 * with no model is dropped (the Rust side rejects an empty model). */
export function sendNativeDeckCommand(deckId: DeckId, command: DeckCommand): void {
  const core = tauri()?.core
  if (!core) return
  const deck = DECK_INDEX[deckId]
  switch (command.type) {
    case 'play':
      void core.invoke('deck_play', { deck })
      break
    case 'stop':
      void core.invoke('deck_stop', { deck })
      break
    case 'set_style':
      void core.invoke('deck_set_style', { deck, prompts: command.prompts })
      break
    case 'set_model':
    case 'restart':
      if (typeof command.model === 'string' && command.model) {
        void core.invoke('deck_set_model', { deck, model: command.model })
      }
      break
    default:
      break
  }
}

/** A worker status payload (the worker's `('status', dict)` output, e.g.
 * `{ event: 'ready' | 'chunk' | 'style_applied' | 'error', … }`). */
export type SidecarStatusEvent = { event: string; [key: string]: unknown }

/** Subscribe to this deck's sidecar status events (filtered by deck index from
 * the global `sidecar://status` event). Returns an unsubscribe fn; safe to call
 * before the async `listen` resolves (it tears down on resolve). A no-op outside
 * Tauri. */
export function subscribeSidecarStatus(
  deckId: DeckId,
  onStatus: (event: SidecarStatusEvent) => void,
): () => void {
  const event = tauri()?.event
  if (!event) return () => {}
  const idx = DECK_INDEX[deckId]
  let unlisten: (() => void) | null = null
  let cancelled = false
  void event
    .listen('sidecar://status', (e) => {
      const payload = e.payload as { deck?: number; json?: string }
      if (payload.deck !== idx || typeof payload.json !== 'string') return
      try {
        onStatus(JSON.parse(payload.json) as SidecarStatusEvent)
      } catch {
        // A malformed status line is dropped, not fatal.
      }
    })
    .then((un) => {
      if (cancelled) un()
      else unlisten = un
    })
  return () => {
    cancelled = true
    unlisten?.()
  }
}
