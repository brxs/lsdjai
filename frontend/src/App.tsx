import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { INITIAL_CROSSFADE, INITIAL_CUE_MIX, type DeckId } from './audio/engine'
import { startCueStream } from './audio/cueStream'
import { useAudioEngine } from './audio/engineContext'
import { FX_KINDS } from './audio/fx'
import type { AudioOutputDevice } from './audio/outputs'
import { applyAppIntent } from './control/appIntents'
import { useControlBus } from './control/busContext'
import {
  CHANNEL_CUE_NOTE,
  NOTE_ON_STATUS_BY_DECK,
  TRANSPORT_CUE_NOTE,
} from './control/flx4'
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
  const [cueMix, setCueMix] = useState(
    () => loadAppSettings().cueMix ?? INITIAL_CUE_MIX,
  )
  const [cueDevice, setCueDevice] = useState<AudioOutputDevice | null>(
    () => loadAppSettings().cueDevice ?? null,
  )

  // A live backend cue stream's stop function (ADR-0007); null while the
  // cue rides a browser sink or is off. The token guards the async hops:
  // only the latest routing attempt may install its stream — a stale one
  // stops itself instead of overwriting a newer pick.
  const cueStreamStop = useRef<(() => void) | null>(null)
  const cueRouteToken = useRef(0)

  // Hand the restored mix positions and cue device to the engine once —
  // it holds them until the bus is built on first play. Later moves go
  // through the handlers, so this deliberately ignores state updates.
  // A vanished cue device fails silently here; re-picking recovers.
  useEffect(() => {
    engine.setCrossfade(crossfade)
    engine.setCueMix(cueMix)
    if (cueDevice?.backend) {
      const token = ++cueRouteToken.current
      void startCueStream(engine, cueDevice.deviceId)
        .then((stop) => {
          if (token === cueRouteToken.current) cueStreamStop.current = stop
          else stop()
        })
        .catch(() => {})
    } else if (cueDevice) {
      void engine.setCueDevice(cueDevice.deviceId).catch(() => {})
    }
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

  // The one place a cue-mix move is defined, mirroring handleCrossfade.
  const handleCueMix = useCallback(
    (position: number) => {
      engine.setCueMix(position)
      setCueMix(position)
      updateAppSettings({ cueMix: position })
    },
    [engine],
  )

  const handleCueDevice = useCallback(
    async (device: AudioOutputDevice | null) => {
      const token = ++cueRouteToken.current
      // The previous stream stops eagerly — the backend sink takes one
      // client, so a jack-to-jack switch must free it first.
      cueStreamStop.current?.()
      cueStreamStop.current = null
      if (device?.backend) {
        await engine.setCueDevice(null)
        let stop: () => void
        try {
          stop = await startCueStream(engine, device.deviceId)
        } catch (cause) {
          // The old route is already torn down, so show reality (Off) —
          // but don't persist it: a reload restores the last good route.
          if (token === cueRouteToken.current) setCueDevice(null)
          throw cause
        }
        if (token !== cueRouteToken.current) {
          stop()
          return
        }
        cueStreamStop.current = stop
      } else {
        await engine.setCueDevice(device?.deviceId ?? null)
        if (token !== cueRouteToken.current) return
      }
      // State and persistence reflect only routes that actually took:
      // a failed pick must not survive a reload.
      setCueDevice(device)
      updateAppSettings({ cueDevice: device })
    },
    [engine],
  )

  // Hardware intents (ADR-0005) for the state this component owns.
  // Resubscribes every render so the handler always reads current deck
  // state; the bus itself is a stable singleton.
  const bus = useControlBus()
  useEffect(() =>
    bus.subscribe((intent) =>
      applyAppIntent(
        intent,
        { a: deckA, b: deckB },
        { onCrossfade: handleCrossfade, onCueMix: handleCueMix },
      ),
    ),
  )

  const midi = useMidi()
  const {
    status: midiStatus,
    setLed,
    setPadLeds,
    setFxPadLeds,
    setLoopPadLeds,
    ledEpoch,
  } = midi
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

  // LED feedback (M7 stretch): pads 1–N lit for the N style targets,
  // re-sent on reconnect so a hot-plugged controller picks the state
  // back up, and on every ledEpoch bump — a pad-mode switch clears the
  // device's pad LEDs, so each bank repaints.
  useEffect(() => {
    if (midiStatus !== 'connected') return
    setPadLeds('a', padCounts.a)
    setPadLeds('b', padCounts.b)
  }, [midiStatus, setPadLeds, padCounts, ledEpoch])

  // PAD FX bank LEDs (M12): the active effect's pad lit per deck.
  useEffect(() => {
    if (midiStatus !== 'connected') return
    setFxPadLeds('a', deckA.fx.kind ? FX_KINDS.indexOf(deckA.fx.kind) : null)
    setFxPadLeds('b', deckB.fx.kind ? FX_KINDS.indexOf(deckB.fx.kind) : null)
  }, [midiStatus, setFxPadLeds, deckA.fx.kind, deckB.fx.kind, ledEpoch])

  // SAMPLER bank LEDs (M13): filled freeze-loop slots lit per deck.
  useEffect(() => {
    if (midiStatus !== 'connected') return
    setLoopPadLeds('a', deckA.loop.filled)
    setLoopPadLeds('b', deckB.loop.filled)
  }, [midiStatus, setLoopPadLeds, deckA.loop.filled, deckB.loop.filled, ledEpoch])

  // Cue LEDs (M10): channel CUE mirrors the headphone-cue toggles,
  // transport CUE lights while a deck is primed off air.
  useEffect(() => {
    if (midiStatus !== 'connected') return
    setLed(NOTE_ON_STATUS_BY_DECK.a, CHANNEL_CUE_NOTE, deckA.cue)
    setLed(NOTE_ON_STATUS_BY_DECK.b, CHANNEL_CUE_NOTE, deckB.cue)
    setLed(NOTE_ON_STATUS_BY_DECK.a, TRANSPORT_CUE_NOTE, deckA.primed)
    setLed(NOTE_ON_STATUS_BY_DECK.b, TRANSPORT_CUE_NOTE, deckB.primed)
  }, [
    midiStatus,
    setLed,
    deckA.cue,
    deckB.cue,
    deckA.primed,
    deckB.primed,
  ])

  const ramWarning = combinedRamWarning(
    { a: deckA.state.model, b: deckB.state.model },
    deckA.state.ramInfo ?? deckB.state.ramInfo,
  )

  const channels: Record<'a' | 'b', ChannelControls> = {
    a: {
      volume: deckA.volume,
      eq: deckA.eq,
      cue: deckA.cue,
      onSetVolume: deckA.setVolume,
      onSetEqBand: deckA.setEqBand,
      onSetCue: deckA.setCue,
      getLevel: deckA.getChannelLevel,
    },
    b: {
      volume: deckB.volume,
      eq: deckB.eq,
      cue: deckB.cue,
      onSetVolume: deckB.setVolume,
      onSetEqBand: deckB.setEqBand,
      onSetCue: deckB.setCue,
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
          primed={deckA.primed}
          fx={deckA.fx}
          onSetFx={deckA.setFx}
          onSetFxAmount={deckA.setFxAmount}
          loop={deckA.loop}
          onLoopPad={deckA.toggleLoopPad}
          onClearLoopPad={deckA.clearLoopPad}
          onSetLoopSeconds={deckA.setLoopSeconds}
          bpm={deckA.bpm}
        />
        <MixerStrip
          channels={channels}
          crossfade={crossfade}
          onCrossfadeChange={handleCrossfade}
          cueMix={cueMix}
          onCueMixChange={handleCueMix}
          cueDevice={cueDevice}
          onCueDeviceChange={handleCueDevice}
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
          primed={deckB.primed}
          fx={deckB.fx}
          onSetFx={deckB.setFx}
          onSetFxAmount={deckB.setFxAmount}
          loop={deckB.loop}
          onLoopPad={deckB.toggleLoopPad}
          onClearLoopPad={deckB.clearLoopPad}
          onSetLoopSeconds={deckB.setLoopSeconds}
          bpm={deckB.bpm}
        />
      </div>
    </main>
  )
}

export default App
