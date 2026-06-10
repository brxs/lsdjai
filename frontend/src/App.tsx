import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { INITIAL_CROSSFADE, type DeckId } from './audio/engine'
import { useAudioEngine } from './audio/engineContext'
import { applyAppIntent } from './control/appIntents'
import { useControlBus } from './control/busContext'
import { MidiControls } from './control/MidiControls'
import { useMidi } from './control/useMidi'
import { DeckColumn } from './deck/DeckColumn'
import { useDeck } from './deck/useDeck'
import { MixerStrip, type ChannelControls } from './mixer/MixerStrip'
import { loadAppSettings, updateAppSettings } from './persistence'
import { combinedRamWarning } from './ramWarning'
import { handleShortcutKey } from './shortcuts'

function App() {
  const { t } = useTranslation()
  const engine = useAudioEngine()
  const deckA = useDeck('a')
  const deckB = useDeck('b')
  const [crossfade, setCrossfade] = useState(
    () => loadAppSettings().crossfade ?? INITIAL_CROSSFADE,
  )

  // Hand the restored crossfade to the engine once — it holds the position
  // until the bus is built on first play. Later moves go through
  // handleCrossfade, so this deliberately ignores `crossfade` updates.
  useEffect(() => {
    engine.setCrossfade(crossfade)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine])

  useEffect(() => {
    window.addEventListener('keydown', handleShortcutKey)
    return () => window.removeEventListener('keydown', handleShortcutKey)
  }, [])

  // The one place a crossfade move is defined: audio bus + state + persist.
  // Every source — slider, keyboard, hardware — lands here.
  const handleCrossfade = useCallback(
    (position: number) => {
      engine.setCrossfade(position)
      setCrossfade(position)
      updateAppSettings({ crossfade: position })
    },
    [engine],
  )

  // Hardware intents (ADR-0005) for the state this component owns.
  // Resubscribes every render so the handler always reads current deck
  // state; the bus itself is a stable singleton.
  const bus = useControlBus()
  useEffect(() =>
    bus.subscribe((intent) =>
      applyAppIntent(intent, { a: deckA, b: deckB }, handleCrossfade),
    ),
  )

  const midi = useMidi()
  const { status: midiStatus, setPadLeds } = midi
  const [padCounts, setPadCounts] = useState<Record<DeckId, number>>({
    a: 0,
    b: 0,
  })
  const handleTargetCount = useCallback((deck: DeckId, count: number) => {
    setPadCounts((previous) =>
      previous[deck] === count ? previous : { ...previous, [deck]: count },
    )
  }, [])
  const handleTargetCountA = useCallback(
    (count: number) => handleTargetCount('a', count),
    [handleTargetCount],
  )
  const handleTargetCountB = useCallback(
    (count: number) => handleTargetCount('b', count),
    [handleTargetCount],
  )

  // LED feedback (M7 stretch): pads 1–N lit for the N style targets, re-sent
  // on reconnect so a hot-plugged controller picks the state back up.
  useEffect(() => {
    if (midiStatus !== 'connected') return
    setPadLeds('a', padCounts.a)
    setPadLeds('b', padCounts.b)
  }, [midiStatus, setPadLeds, padCounts])

  const ramWarning = combinedRamWarning(
    { a: deckA.state.model, b: deckB.state.model },
    deckA.state.ramInfo ?? deckB.state.ramInfo,
  )

  const channels: Record<'a' | 'b', ChannelControls> = {
    a: {
      volume: deckA.volume,
      eq: deckA.eq,
      onSetVolume: deckA.setVolume,
      onSetEqBand: deckA.setEqBand,
      getLevel: deckA.getChannelLevel,
    },
    b: {
      volume: deckB.volume,
      eq: deckB.eq,
      onSetVolume: deckB.setVolume,
      onSetEqBand: deckB.setEqBand,
      getLevel: deckB.getChannelLevel,
    },
  }

  return (
    <main className="app">
      <header className="app__statusbar">
        <h1 className="app__title">{t('app.title')}</h1>
        {ramWarning && (
          <p className="app__warning" role="status">
            {t('app.ramWarning', ramWarning)}
          </p>
        )}
        <p className="app__hint">{t('app.shortcutsHint')}</p>
        <MidiControls
          status={midi.status}
          deviceName={midi.deviceName}
          onConnect={midi.connect}
          readMonitor={midi.readMonitor}
        />
      </header>
      <div className="app__booth">
        <DeckColumn
          deckId="a"
          state={deckA.state}
          getWaveformRange={deckA.getChannelWaveformRange}
          onPlay={() => void deckA.play()}
          onStop={deckA.stop}
          onSetStyle={deckA.setStyle}
          onSetModel={deckA.setModel}
          onRestart={deckA.restartWorker}
          onTargetCount={handleTargetCountA}
        />
        <MixerStrip
          channels={channels}
          crossfade={crossfade}
          onCrossfadeChange={handleCrossfade}
        />
        <DeckColumn
          deckId="b"
          state={deckB.state}
          getWaveformRange={deckB.getChannelWaveformRange}
          onPlay={() => void deckB.play()}
          onStop={deckB.stop}
          onSetStyle={deckB.setStyle}
          onSetModel={deckB.setModel}
          onRestart={deckB.restartWorker}
          onTargetCount={handleTargetCountB}
        />
      </div>
    </main>
  )
}

export default App
