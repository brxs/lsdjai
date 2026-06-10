import { useEffect } from 'react'

import type { DeckId } from '../audio/engine'
import { DeckPanel } from './DeckPanel'
import type { RamInfo } from './deckState'
import { useDeck } from './useDeck'

type DeckProps = {
  id: DeckId
  onModelChange?: (deckId: DeckId, model: string | null, ramInfo: RamInfo | null) => void
}

export function Deck({ id, onModelChange }: DeckProps) {
  const { state, volume, play, stop, setStyle, setModel, restartWorker, setVolume } =
    useDeck(id)

  // Report the active model up so the app can warn about the combined RAM
  // footprint across both decks.
  useEffect(() => {
    onModelChange?.(id, state.model, state.ramInfo)
  }, [id, state.model, state.ramInfo, onModelChange])

  return (
    <DeckPanel
      deckId={id}
      state={state}
      volume={volume}
      onPlay={() => void play()}
      onStop={stop}
      onSetStyle={setStyle}
      onSetModel={setModel}
      onRestart={restartWorker}
      onSetVolume={setVolume}
    />
  )
}
