/** ControlBus (ADR-0005): typed control intents as a small pub/sub, so
 * control sources (MIDI now, anything later) are decoupled from the React
 * components that own the state. Keyboard/mouse paths don't go through it. */

import type { EqBand } from '../audio/eq'
import type { DeckId } from '../audio/engine'
import type { StylePreset } from '../presets'

export type ControlIntent =
  | { kind: 'play_toggle'; deck: DeckId }
  | { kind: 'volume'; deck: DeckId; value: number }
  | { kind: 'eq'; deck: DeckId; band: EqBand; value: number }
  | { kind: 'crossfade'; value: number }
  // The HOT CUE bank, named for the physical gesture (M21): the pure
  // translator cannot know a deck's mode, so consumers decide what a
  // pad means — realtime decks snap the style cursor (DeckColumn),
  // playback decks set/jump hot cues (applyAppIntent, ADR-0015).
  | { kind: 'hot_cue_pad'; deck: DeckId; index: number }
  // SHIFT + HOT CUE pad (the shift pad layer): clears the cue on a
  // playback deck; realtime decks have no per-pad clear and ignore it.
  | { kind: 'hot_cue_clear'; deck: DeckId; index: number }
  | { kind: 'style_sweep'; deck: DeckId; value: number }
  | { kind: 'record_toggle' }
  | { kind: 'cue_toggle'; deck: DeckId }
  | { kind: 'cue_mix'; value: number }
  | { kind: 'deck_prep'; deck: DeckId }
  | { kind: 'fx_amount'; deck: DeckId; value: number }
  | { kind: 'fx_select'; deck: DeckId; index: number }
  | { kind: 'loop_pad'; deck: DeckId; index: number }
  | { kind: 'loop_clear'; deck: DeckId; index: number }
  // Media browsing (M16 crates, widened by M19): the rotary moves the
  // visible explorer tab's highlight and LOAD loads the highlighted
  // item — crate or track, the item type decides what loading means
  // (ADR-0013). A chosen preset's pad portion rides the bus to the
  // owning deck column.
  | { kind: 'browse_scroll'; steps: number }
  | { kind: 'browse_load'; deck: DeckId }
  // Rotary press (M19): cycle the explorer's visible tab.
  | { kind: 'browse_tab' }
  // Jog wheel ticks (M19): relative seek on a playback deck; a
  // realtime deck ignores them (ADR-0004 — no scratch concept).
  // While the track plays, plain ticks become phase nudges and
  // SHIFT+jog keeps scrubbing (M20, the CDJ search convention).
  | { kind: 'track_seek'; deck: DeckId; steps: number; shifted: boolean }
  // Tempo sliders (M20, ADR-0014): varispeed on a playback deck,
  // ignored on a realtime deck — ADR-0004 still bars generation tempo.
  | { kind: 'track_rate'; deck: DeckId; value: number }
  // The LOOP section (M21, ADR-0015): in/out/exit on a playback deck;
  // the track_ prefix keeps them clear of ADR-0009's freeze-loop pads.
  | { kind: 'track_loop_in'; deck: DeckId }
  | { kind: 'track_loop_out'; deck: DeckId }
  | { kind: 'track_loop_exit'; deck: DeckId }
  | { kind: 'preset_load'; deck: DeckId; preset: StylePreset }

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
