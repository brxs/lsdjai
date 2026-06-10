import type { DeckId } from '../audio/engine'
import { isDeckOperable } from '../deck/deckState'
import type { DeckControls } from '../deck/useDeck'
import type { ControlIntent } from './bus'

/** The App-owned slice of the intent union: transport, channel volume/EQ,
 * and the crossfader. Style and record intents are handled where that state
 * lives (DeckColumn, MixerStrip). Pure dispatch so the mapping is testable
 * without rendering the app. */
export function applyAppIntent(
  intent: ControlIntent,
  decks: Record<DeckId, DeckControls>,
  onCrossfade: (position: number) => void,
): void {
  switch (intent.kind) {
    case 'play_toggle': {
      const deck = decks[intent.deck]
      // Same gating as the transport button: hardware must not start a
      // deck the UI would refuse to.
      if (!isDeckOperable(deck.state)) return
      if (deck.state.playing) deck.stop()
      else void deck.play()
      return
    }
    case 'volume':
      decks[intent.deck].setVolume(intent.value)
      return
    case 'eq':
      decks[intent.deck].setEqBand(intent.band, intent.value)
      return
    case 'crossfade':
      onCrossfade(intent.value)
      return
  }
}
