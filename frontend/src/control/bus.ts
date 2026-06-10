/** ControlBus (ADR-0005): typed control intents as a small pub/sub, so
 * control sources (MIDI now, anything later) are decoupled from the React
 * components that own the state. Keyboard/mouse paths don't go through it. */

import type { EqBand } from '../audio/eq'
import type { DeckId } from '../audio/engine'

export type ControlIntent =
  | { kind: 'play_toggle'; deck: DeckId }
  | { kind: 'volume'; deck: DeckId; value: number }
  | { kind: 'eq'; deck: DeckId; band: EqBand; value: number }
  | { kind: 'crossfade'; value: number }
  | { kind: 'style_target'; deck: DeckId; index: number }
  | { kind: 'style_sweep'; deck: DeckId; value: number }
  | { kind: 'record_toggle' }

export type ControlBus = {
  publish: (intent: ControlIntent) => void
  /** Returns the unsubscribe function. */
  subscribe: (handler: (intent: ControlIntent) => void) => () => void
}

export function createControlBus(): ControlBus {
  const handlers = new Set<(intent: ControlIntent) => void>()
  return {
    publish(intent) {
      for (const handler of handlers) handler(intent)
    },
    subscribe(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}
