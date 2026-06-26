import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { INITIAL_CROSSFADE, INITIAL_CUE_MIX, type DeckId } from './audio/types'
import { uploadStyleSample } from './audio/styleSample'
import { useAudioEngine } from './audio/engineContext'
import { FX_KINDS } from './audio/fx'
import { applyAppIntent } from './control/appIntents'
import { useControlBus } from './control/busContext'
import { MidiControls } from './control/MidiControls'
import { useMidi } from './control/useMidi'
import { MediaExplorer } from './media/MediaExplorer'
import { DeckColumn } from './deck/DeckColumn'
import { useDeck } from './deck/useDeck'
import { BeatView } from './mixer/BeatView'
import { MixerStrip, type ChannelControls } from './mixer/MixerStrip'
import { AccentPicker } from './ui/AccentPicker'
import { BeatViewPicker } from './ui/BeatViewPicker'
import {
  deletePreset,
  loadAppSettings,
  loadPresets,
  updateAppSettings,
  upsertPresets,
  type AccentTheme,
  type BeatViewLayout,
} from './persistence'
import { Logo } from './ui/Logo'
import type { StylePreset } from './presets'
import { combinedRamWarning } from './ramWarning'
import { phaseOffsetBeats } from './audio/track'
import { handleShortcutKey } from './shortcuts'

/** Two net selection masks are equal when same length and same flags, so the
 * LED state only churns on a real selection change. */
function sameMask(a: boolean[], b: boolean[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

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
  // The chosen native output device by name (empty = system default); the
  // engine routes the headphone cue to its channels 3/4. App owns the
  // persisted choice; the picker owns the live device list and switch.
  const [outputDevice, setOutputDevice] = useState(
    () => loadAppSettings().outputDevice ?? '',
  )
  // The beat view's home (M22): centre stacked, top bar, or off.
  const [beatView, setBeatView] = useState<BeatViewLayout>(
    () => loadAppSettings().beatView ?? 'center',
  )
  const handleBeatView = useCallback((layout: BeatViewLayout) => {
    setBeatView(layout)
    updateAppSettings({ beatView: layout })
  }, [])

  // Master accent (LSDJai): the chosen hue rides on <html data-accent>,
  // where the theme blocks in tokens.css pick it up. Persisted like the
  // other app settings; default Acid Lime.
  const [accent, setAccent] = useState<AccentTheme>(
    () => loadAppSettings().accent ?? 'cyan',
  )
  useEffect(() => {
    document.documentElement.dataset.accent = accent
  }, [accent])
  const handleAccent = useCallback((value: AccentTheme) => {
    setAccent(value)
    updateAppSettings({ accent: value })
  }, [])

  // Hand the restored mix positions to the engine once — it holds them
  // until the bus is built on first play. Later moves go through the
  // handlers, so this deliberately ignores state updates. The persisted
  // output device is applied best-effort: it may be gone since last run,
  // and a failure must leave the engine's default routing undisturbed.
  useEffect(() => {
    engine.setCrossfade(crossfade)
    engine.setCueMix(cueMix)
    if (outputDevice) void engine.setOutputDevice(outputDevice).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine])

  // The one place a successful output-device switch lands: state + persist.
  // The picker has already performed the switch on the engine; we only record
  // the choice (so a rejected switch never reaches here and the selection
  // reverts to the last good value).
  const handleOutputDevice = useCallback((name: string) => {
    setOutputDevice(name)
    updateAppSettings({ outputDevice: name })
  }, [])

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

  // Deck-to-deck style sampling (M15): capture the OTHER deck's tail,
  // register the embedding on the target deck's worker, hand the new
  // pad target back to the column. Ids are session-unique; embeddings
  // are session-only (ADR-0011).
  const sampleCounter = useRef(0)
  const sampleFromOtherDeck = useCallback(
    async (target: DeckId) => {
      const sourceId: DeckId = target === 'a' ? 'b' : 'a'
      const source = sourceId === 'a' ? deckA : deckB
      const samples = await source.captureStyleSample()
      if (!samples) return null
      const count = ++sampleCounter.current
      const sample = `sample:${sourceId}:${count}`
      await uploadStyleSample(target, sample, samples)
      return {
        label: t('deck.style.sampleLabel', {
          deck: sourceId.toUpperCase(),
          n: count,
        }),
        sample,
      }
    },
    [deckA, deckB, t],
  )
  const handleSampleForA = useCallback(
    () => sampleFromOtherDeck('a'),
    [sampleFromOtherDeck],
  )
  const handleSampleForB = useCallback(
    () => sampleFromOtherDeck('b'),
    [sampleFromOtherDeck],
  )

  // Crates (M16): the preset list is App state so the browser, the
  // per-deck save buttons, and the hardware intents all see one truth.
  const [presets, setPresets] = useState<StylePreset[]>(loadPresets)
  const handleSavePreset = useCallback((preset: StylePreset) => {
    setPresets(upsertPresets([preset]))
  }, [])
  const handleImportPresets = useCallback((imported: StylePreset[]) => {
    setPresets(upsertPresets(imported))
  }, [])
  const handleDeletePreset = useCallback((name: string) => {
    setPresets(deletePreset(name))
  }, [])

  // Hardware intents (ADR-0005) for the state this component owns.
  // Resubscribes every render so the handler always reads current deck
  // state; the bus itself is a stable singleton.
  const bus = useControlBus()
  // Which deck's SHIFT is down, for the cross-deck SHIFT+jog cursor steering
  // (the steered deck takes one axis from each jog). Both down → deck A wins.
  const [shiftHeld, setShiftHeld] = useState<Record<DeckId, boolean>>({
    a: false,
    b: false,
  })
  const shiftedDeck: DeckId | null = shiftHeld.a ? 'a' : shiftHeld.b ? 'b' : null
  useEffect(() =>
    bus.subscribe((intent) => {
      if (intent.kind === 'shift') {
        setShiftHeld((previous) =>
          previous[intent.deck] === intent.held
            ? previous
            : { ...previous, [intent.deck]: intent.held },
        )
        return
      }
      applyAppIntent(
        intent,
        { a: deckA, b: deckB },
        { onCrossfade: handleCrossfade, onCueMix: handleCueMix },
      )
    }),
  )

  // Loading a preset: this component owns the FX half (via the deck
  // controls); the pad half rides the bus to the owning DeckColumn,
  // which applies targets + cursor and sends the style. A crate is a
  // realtime item, so loading one exits playback mode (ADR-0013).
  const handleLoadPreset = useCallback(
    (deck: DeckId, preset: StylePreset) => {
      const controls = deck === 'a' ? deckA : deckB
      controls.leavePlayback()
      controls.setFx(preset.fx.kind)
      controls.setFxAmount(preset.fx.amount)
      bus.publish({ kind: 'preset_load', deck, preset })
    },
    [deckA, deckB, bus],
  )

  // Track items flip the deck to playback; the live-stream item is the
  // way back (ADR-0013: loading decides the mode).
  const handleLoadTrack = useCallback(
    (deck: DeckId, wav: ArrayBuffer, title: string) =>
      (deck === 'a' ? deckA : deckB).loadTrack(wav, title),
    [deckA, deckB],
  )
  const handleLoadLive = useCallback(
    (deck: DeckId) => (deck === 'a' ? deckA : deckB).leavePlayback(),
    [deckA, deckB],
  )

  // Beat-matching (M20, ADR-0014): SYNC matches a track deck to the
  // other deck's effective tempo — gated stream BPM, or grid BPM ×
  // rate when the other side is a track too. Phase is read for the
  // meter from whichever clock each deck honestly has.
  const effectiveBpm = useCallback(
    (deck: typeof deckA) =>
      deck.mode === 'playback'
        ? deck.track?.bpm != null
          ? deck.track.bpm * deck.track.rate
          : null
        : deck.bpm,
    [],
  )
  const handleSyncA = useCallback(
    () => deckA.syncTrack(effectiveBpm(deckB)),
    [deckA, deckB, effectiveBpm],
  )
  const handleSyncB = useCallback(
    () => deckB.syncTrack(effectiveBpm(deckA)),
    [deckA, deckB, effectiveBpm],
  )
  const getPhaseOffset = useCallback(() => {
    const aPlayback = deckA.mode === 'playback'
    const bPlayback = deckB.mode === 'playback'
    if (!aPlayback && !bPlayback) return null
    const clockOf = (deck: typeof deckA) =>
      deck.mode === 'playback' ? deck.getTrackBeat() : deck.getLiveBeat()
    const a = clockOf(deckA)
    const b = clockOf(deckB)
    if (!a || !b) return null
    // The track side reads against the other deck; A wins ties.
    return aPlayback ? phaseOffsetBeats(a, b) : phaseOffsetBeats(b, a)
  }, [deckA, deckB])

  const midi = useMidi()
  const {
    status: midiStatus,
    setPadLeds,
    setFxPadLeds,
    setLoopPadLeds,
    setCuePadLeds,
    setChannelCueLed,
    setTransportCueLed,
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
  const [padSelections, setPadSelections] = useState<Record<DeckId, boolean[]>>(
    { a: [], b: [] },
  )
  const handleSelectionChange = useCallback(
    (deck: DeckId, selected: boolean[]) => {
      setPadSelections((previous) =>
        sameMask(previous[deck], selected)
          ? previous
          : { ...previous, [deck]: selected },
      )
    },
    [],
  )
  const handleSelectionChangeA = useCallback(
    (selected: boolean[]) => handleSelectionChange('a', selected),
    [handleSelectionChange],
  )
  const handleSelectionChangeB = useCallback(
    (selected: boolean[]) => handleSelectionChange('b', selected),
    [handleSelectionChange],
  )

  // LED feedback (M7 stretch): the HOT CUE bank's meaning follows the
  // deck mode (M21, ADR-0015) — pads 1–N lit for N style targets on a
  // realtime deck, filled hot cues lit on a playback deck. Re-sent on
  // reconnect so a hot-plugged controller picks the state back up, and
  // on every ledEpoch bump — a pad-mode switch clears the device's pad
  // LEDs, so each bank repaints. Exactly one painter per deck.
  const cueLedsA = deckA.mode === 'playback' ? deckA.track?.cues : undefined
  const cueLedsB = deckB.mode === 'playback' ? deckB.track?.cues : undefined
  useEffect(() => {
    if (midiStatus !== 'connected') return
    if (cueLedsA) setCuePadLeds('a', cueLedsA.map((cue) => cue !== null))
    else setPadLeds('a', padCounts.a, padSelections.a)
    if (cueLedsB) setCuePadLeds('b', cueLedsB.map((cue) => cue !== null))
    else setPadLeds('b', padCounts.b, padSelections.b)
  }, [
    midiStatus,
    setPadLeds,
    setCuePadLeds,
    padCounts,
    padSelections,
    cueLedsA,
    cueLedsB,
    ledEpoch,
  ])

  // PAD FX bank LEDs (M12): the active effect's pad lit per deck.
  useEffect(() => {
    if (midiStatus !== 'connected') return
    setFxPadLeds('a', deckA.fx.kind ? FX_KINDS.indexOf(deckA.fx.kind) : null)
    setFxPadLeds('b', deckB.fx.kind ? FX_KINDS.indexOf(deckB.fx.kind) : null)
  }, [midiStatus, setFxPadLeds, deckA.fx.kind, deckB.fx.kind, ledEpoch])

  // SAMPLER bank LEDs (M13): filled pad slots lit per deck — captures
  // and generated slots alike (M18); a pending generation stays dark
  // until it's actually playable.
  const loopLedsA = useMemo(
    () => deckA.loop.slots.map((slot) => slot.state === 'filled'),
    [deckA.loop.slots],
  )
  const loopLedsB = useMemo(
    () => deckB.loop.slots.map((slot) => slot.state === 'filled'),
    [deckB.loop.slots],
  )
  useEffect(() => {
    if (midiStatus !== 'connected') return
    setLoopPadLeds('a', loopLedsA)
    setLoopPadLeds('b', loopLedsB)
  }, [midiStatus, setLoopPadLeds, loopLedsA, loopLedsB, ledEpoch])

  // Cue LEDs (M10): channel CUE mirrors the headphone-cue toggles,
  // transport CUE lights while a deck is primed off air. The active driver
  // owns the bytes (issue #30) — App speaks deck + on/off, not status/note.
  useEffect(() => {
    if (midiStatus !== 'connected') return
    setChannelCueLed('a', deckA.cue)
    setChannelCueLed('b', deckB.cue)
    setTransportCueLed('a', deckA.primed)
    setTransportCueLed('b', deckB.primed)
  }, [
    midiStatus,
    setChannelCueLed,
    setTransportCueLed,
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
      trim: deckA.trim,
      onSetVolume: deckA.setVolume,
      onSetEqBand: deckA.setEqBand,
      onSetCue: deckA.setCue,
      onSetTrimDb: deckA.setTrimDb,
      onEnableAutoTrim: deckA.enableAutoTrim,
      getLevel: deckA.getChannelLevel,
    },
    b: {
      volume: deckB.volume,
      eq: deckB.eq,
      cue: deckB.cue,
      trim: deckB.trim,
      onSetVolume: deckB.setVolume,
      onSetEqBand: deckB.setEqBand,
      onSetCue: deckB.setCue,
      onSetTrimDb: deckB.setTrimDb,
      onEnableAutoTrim: deckB.enableAutoTrim,
      getLevel: deckB.getChannelLevel,
    },
  }

  return (
    <main className="app">
      {/* The frameless title-bar strip behind the macOS traffic lights. With
          titleBarStyle Overlay the webview covers the native title bar, so that
          top strip is webview content and needs its OWN drag region — an empty,
          transparent surface over the top inset. */}
      <div className="app__titlebar" data-tauri-drag-region aria-hidden="true" />
      {/* Drag the window by the header too. `deep` makes the whole subtree a drag
          surface (logo, gaps, status text); Tauri auto-excludes clickable
          elements (the native selects, the MIDI button) so they stay clickable. */}
      <header className="app__statusbar" data-tauri-drag-region="deep">
        <Logo />
        <div className="app__statusbar-right">
          {ramWarning && (
            <p className="app__warning" role="status">
              {t('app.ramWarning', ramWarning)}
            </p>
          )}
          <BeatViewPicker
            label={t('beatview.layout')}
            value={beatView}
            options={(['center', 'vertical', 'top', 'off'] as const).map((layout) => ({
              value: layout,
              label: t(`beatview.layouts.${layout}`),
            }))}
            onChange={handleBeatView}
          />
          <AccentPicker
            label={t('accent.label')}
            value={accent}
            options={(['lime', 'violet', 'cyan'] as const).map((option) => ({
              value: option,
              label: t(`accent.options.${option}`),
            }))}
            onChange={handleAccent}
          />
          <MidiControls
            status={midi.status}
            deviceName={midi.deviceName}
            devices={midi.devices}
            onConnect={midi.connect}
            onSelectDevice={midi.selectDevice}
            readMonitor={midi.readMonitor}
          />
        </div>
      </header>
      {beatView === 'top' && (
        <BeatView
          getSourceA={deckA.getZoomSource}
          getSourceB={deckB.getZoomSource}
        />
      )}
      <div className="app__booth">
        <DeckColumn
          deckId="a"
          state={deckA.state}
          onPlay={() => void deckA.play()}
          onStop={deckA.stop}
          onSetStyle={deckA.setStyle}
          onSetModel={deckA.setModel}
          onRestart={deckA.restartWorker}
          onTargetCount={handleTargetCountA}
          onSelectionChange={handleSelectionChangeA}
          shiftedDeck={shiftedDeck}
          primed={deckA.primed}
          fx={deckA.fx}
          onSetFx={deckA.setFx}
          onSetFxAmount={deckA.setFxAmount}
          loop={deckA.loop}
          onLoopPad={deckA.toggleLoopPad}
          onClearLoopPad={deckA.clearLoopPad}
          onSetLoopSeconds={deckA.setLoopSeconds}
          onGenerateToPad={deckA.generateToPad}
          generateError={deckA.generateError}
          bpm={deckA.bpm}
          onSampleOtherDeck={handleSampleForA}
          canSample={deckB.state.playing}
          onSavePreset={handleSavePreset}
          mode={deckA.mode}
          track={deckA.track}
          onLeavePlayback={deckA.leavePlayback}
          onSeekTrack={deckA.seekTrack}
          onSetTrackRate={deckA.setTrackRate}
          onSyncTrack={handleSyncA}
          onHotCuePad={deckA.hotCuePad}
          onClearHotCue={deckA.clearHotCue}
          onLoopIn={deckA.loopIn}
          onLoopOut={deckA.loopOut}
          onLoopExit={deckA.loopExit}
          onBeatLoop={deckA.beatLoop}
          onHalveLoop={deckA.halveLoop}
          onDoubleLoop={deckA.doubleLoop}
          getTrackPeaks={deckA.getTrackPeaks}
        />
        <div className="app__center">
          {(beatView === 'center' || beatView === 'vertical') && (
            <BeatView
              vertical={beatView === 'vertical'}
              getSourceA={deckA.getZoomSource}
              getSourceB={deckB.getZoomSource}
            />
          )}
          <MixerStrip
            channels={channels}
            crossfade={crossfade}
            onCrossfadeChange={handleCrossfade}
            cueMix={cueMix}
            onCueMixChange={handleCueMix}
            outputDevice={outputDevice}
            onOutputDeviceChange={handleOutputDevice}
            getPhaseOffset={getPhaseOffset}
          />
        </div>
        <DeckColumn
          deckId="b"
          state={deckB.state}
          onPlay={() => void deckB.play()}
          onStop={deckB.stop}
          onSetStyle={deckB.setStyle}
          onSetModel={deckB.setModel}
          onRestart={deckB.restartWorker}
          onTargetCount={handleTargetCountB}
          onSelectionChange={handleSelectionChangeB}
          shiftedDeck={shiftedDeck}
          primed={deckB.primed}
          fx={deckB.fx}
          onSetFx={deckB.setFx}
          onSetFxAmount={deckB.setFxAmount}
          loop={deckB.loop}
          onLoopPad={deckB.toggleLoopPad}
          onClearLoopPad={deckB.clearLoopPad}
          onSetLoopSeconds={deckB.setLoopSeconds}
          onGenerateToPad={deckB.generateToPad}
          generateError={deckB.generateError}
          bpm={deckB.bpm}
          onSampleOtherDeck={handleSampleForB}
          canSample={deckA.state.playing}
          onSavePreset={handleSavePreset}
          mode={deckB.mode}
          track={deckB.track}
          onLeavePlayback={deckB.leavePlayback}
          onSeekTrack={deckB.seekTrack}
          onSetTrackRate={deckB.setTrackRate}
          onSyncTrack={handleSyncB}
          onHotCuePad={deckB.hotCuePad}
          onClearHotCue={deckB.clearHotCue}
          onLoopIn={deckB.loopIn}
          onLoopOut={deckB.loopOut}
          onLoopExit={deckB.loopExit}
          onBeatLoop={deckB.beatLoop}
          onHalveLoop={deckB.halveLoop}
          onDoubleLoop={deckB.doubleLoop}
          getTrackPeaks={deckB.getTrackPeaks}
        />
      </div>
      <MediaExplorer
        presets={presets}
        onLoadPreset={handleLoadPreset}
        onDeletePreset={handleDeletePreset}
        onImportPresets={handleImportPresets}
        onLoadTrack={handleLoadTrack}
        onLoadLive={handleLoadLive}
      />
    </main>
  )
}

export default App
