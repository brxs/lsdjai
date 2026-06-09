import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { INITIAL_CROSSFADE, type DeckId } from './audio/engine'
import { Deck } from './deck/Deck'
import type { RamInfo } from './deck/deckState'
import { Mixer } from './mixer/Mixer'
import { combinedRamWarning } from './ramWarning'

function App() {
  const { t } = useTranslation()
  const [crossfade, setCrossfade] = useState(INITIAL_CROSSFADE)
  const [deckModels, setDeckModels] = useState<Record<DeckId, string | null>>({
    a: null,
    b: null,
  })
  const [ramInfo, setRamInfo] = useState<RamInfo | null>(null)

  const handleModelChange = useCallback(
    (deckId: DeckId, model: string | null, info: RamInfo | null) => {
      setDeckModels((previous) =>
        previous[deckId] === model ? previous : { ...previous, [deckId]: model },
      )
      // RAM info is machine-level and identical from both decks' hellos;
      // first one wins.
      if (info) setRamInfo((previous) => previous ?? info)
    },
    [],
  )

  const ramWarning = combinedRamWarning(deckModels, ramInfo)

  return (
    <main className="app">
      <h1 className="app__title">{t('app.title')}</h1>
      {ramWarning && (
        <p className="app__warning" role="status">
          {t('app.ramWarning', ramWarning)}
        </p>
      )}
      <div className="app__decks">
        <Deck id="a" onModelChange={handleModelChange} />
        <Deck id="b" onModelChange={handleModelChange} />
      </div>
      <Mixer crossfade={crossfade} onCrossfadeChange={setCrossfade} />
    </main>
  )
}

export default App
