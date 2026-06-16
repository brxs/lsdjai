/** Native (Tauri) analysis PCM feed — gap 1 of the native cutover.
 *
 * In the browser, `useDeck` fed the beat/loudness/band analysis from the model
 * PCM arriving over the `/ws/deck` WebSocket. In the native shell that PCM goes
 * sidecar → Rust engine directly and no longer transits the UI, so the analysis
 * (which ADR-0017 keeps in TypeScript) went dark. This module restores the feed:
 * the Rust sidecar reader tees each model PCM frame — the SAME raw interleaved-
 * stereo f32 LE bytes — over a Tauri `Channel`, and the webview reinterprets them
 * as the exact `Float32Array` the analysis consumed before.
 *
 * The tee fires on the non-RT sidecar reader thread, strictly after the engine's
 * ring `post_pcm`, so the audio path is untouched (see `src-tauri/src/sidecar.rs`).
 */

import type { DeckId } from '../audio/types'

const DECK_INDEX: Record<DeckId, number> = { a: 0, b: 1 }

/** The slice of the `withGlobalTauri` core API we use: `invoke` and the binary
 * streaming `Channel` (its `onmessage` receives a raw `ArrayBuffer`). */
type TauriChannel<T> = { onmessage: ((message: T) => void) | null }
type TauriCore = {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>
  Channel: new <T>() => TauriChannel<T>
}

function core(): TauriCore | null {
  const g = (globalThis as { __TAURI__?: { core?: TauriCore } }).__TAURI__
  return g?.core ?? null
}

/** Subscribe a deck's realtime model PCM and hand each frame to `onPcm` as a
 * `Float32Array` (interleaved stereo @ 48 kHz — the layout beat/loudness/band
 * `push` expect). Returns an unsubscribe fn; a no-op outside Tauri. */
export function subscribeDeckPcm(
  deckId: DeckId,
  onPcm: (samples: Float32Array) => void,
): () => void {
  const c = core()
  if (!c) return () => {}
  const deck = DECK_INDEX[deckId]
  const channel = new c.Channel<ArrayBuffer>()
  channel.onmessage = (buffer) => {
    // Whole f32 frames only — guard against a truncated payload (new Float32Array
    // throws on a non-multiple-of-4 length).
    if (buffer.byteLength % 4 !== 0) return
    onPcm(new Float32Array(buffer))
  }
  void c.invoke('subscribe_deck_pcm', { deck, channel })
  return () => {
    channel.onmessage = null
    void c.invoke('unsubscribe_deck_pcm', { deck })
  }
}
