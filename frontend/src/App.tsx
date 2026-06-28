import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { INITIAL_CROSSFADE, INITIAL_CUE_MIX, type DeckId } from './audio/types'
import { uploadStyleSample } from './audio/styleSample'
import { invoke } from './audio/nativeEngine'
import { useAudioEngine } from './audio/engineContext'
import { useInterfaceStore, useProjected } from './audio/interfaceStore'
import { getMcpInfo, type McpInfo } from './audio/nativeEngine'
import { FX_KINDS } from './audio/fx'
import { applyAppIntent } from './control/appIntents'
import { useControlBus } from './control/busContext'
import { MidiControls } from './control/MidiControls'
import { useMidi } from './control/useMidi'
import { MediaExplorer } from './media/MediaExplorer'
import {
  MEDIA_DEFAULT_HEIGHT,
  clampMediaHeight,
} from './media/mediaTray'
import { DeckColumn } from './deck/DeckColumn'
import { useDeck } from './deck/useDeck'
import { BeatView } from './mixer/BeatView'
import { MixerStrip, type ChannelControls } from './mixer/MixerStrip'
import { RecordControl } from './mixer/RecordControl'
import { AccentPicker } from './ui/AccentPicker'
import { OutputDevicePicker } from './ui/OutputDevicePicker'
import { BeatViewPicker } from './ui/BeatViewPicker'
import { Select } from './ui/Select'
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
import { Drawer } from './ui/Drawer'
import { Button } from './ui/Button'
import { ModelManager } from './models/ModelManager'
import type { StylePreset } from './presets'
import { combinedRamWarning } from './ramWarning'
import { phaseOffsetBeats } from './audio/track'
import { handleShortcutKey } from './shortcuts'
import { sameMask } from './selectionMask'

function App() {
  const { t } = useTranslation()
  const engine = useAudioEngine()
  // The authoritative interface-state store (ADR-0020): the webview projects it.
  const store = useInterfaceStore()
  const deckA = useDeck('a')
  const deckB = useDeck('b')
  // Crossfade / cue-mix are projections of the store, rendered optimistically
  // during a drag and reconciled to the store (a MIDI move arrives the same way).
  const [crossfade, setCrossfade] = useProjected(
    store?.crossfade,
    loadAppSettings().crossfade ?? INITIAL_CROSSFADE,
    (position) => engine.setCrossfade(position),
  )
  const [cueMix, setCueMix] = useProjected(
    store?.cueMix,
    loadAppSettings().cueMix ?? INITIAL_CUE_MIX,
    (position) => engine.setCueMix(position),
  )
  // Stable per-deck model-option arrays so the memoised Settings <Select> isn't
  // re-committed — and dismissed by WKWebView — on App's ~10 Hz re-render churn.
  // The fallback (a deck with no available list yet) must not be rebuilt each render.
  const deckAModelOptions = useMemo(
    () =>
      deckA.state.availableModels.length
        ? deckA.state.availableModels
        : [deckA.state.model ?? ''],
    [deckA.state.availableModels, deckA.state.model],
  )
  const deckBModelOptions = useMemo(
    () =>
      deckB.state.availableModels.length
        ? deckB.state.availableModels
        : [deckB.state.model ?? ''],
    [deckB.state.availableModels, deckB.state.model],
  )
  // The chosen native MAIN output device by name (empty = system default;
  // master → its ch 1/2) and the headphone CUE device (empty = "same as main",
  // the FLX4 phones on ch 3/4; a different name routes cue to a second device).
  // App owns the persisted choices; each picker owns its live list and switch.
  const [mainDevice, setMainDevice] = useState(
    () => loadAppSettings().outputDevice ?? '',
  )
  const [cueDevice, setCueDevice] = useState(
    () => loadAppSettings().cueDevice ?? '',
  )
  // The beat view's home (M22): centre stacked, top bar, or off.
  const [beatView, setBeatView] = useState<BeatViewLayout>(
    () => loadAppSettings().beatView ?? 'center',
  )
  const handleBeatView = useCallback((layout: BeatViewLayout) => {
    setBeatView(layout)
    updateAppSettings({ beatView: layout })
  }, [])

  // The media tray's drawer state (open + height): App owns it so the in-panel
  // toggle and the Cmd/Ctrl+M shortcut share one source of truth, and both
  // persist across reloads.
  const [mediaOpen, setMediaOpen] = useState(
    () => loadAppSettings().mediaOpen ?? true,
  )
  const [mediaHeight, setMediaHeight] = useState(
    () => loadAppSettings().mediaHeight ?? MEDIA_DEFAULT_HEIGHT,
  )
  const handleMediaToggle = useCallback(() => {
    setMediaOpen((open) => {
      const next = !open
      updateAppSettings({ mediaOpen: next })
      return next
    })
  }, [])
  // Live during a resize drag (state only); `commit` persists once on release.
  const handleMediaResize = useCallback((height: number, commit: boolean) => {
    const clamped = clampMediaHeight(height)
    setMediaHeight(clamped)
    if (commit) updateAppSettings({ mediaHeight: clamped })
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

  // Where master-bus recordings are saved (empty = the OS Downloads folder, the
  // default). App owns the persisted choice; RecordControl reads it to save the
  // take, the Rust side recreates the folder and falls back to Downloads.
  const [recordingsFolder, setRecordingsFolder] = useState(
    () => loadAppSettings().recordingsFolder ?? '',
  )
  const [recordingsFolderError, setRecordingsFolderError] = useState<string | null>(
    null,
  )
  const handleRecordingsFolder = useCallback((path: string) => {
    setRecordingsFolder(path)
    updateAppSettings({ recordingsFolder: path })
  }, [])
  const chooseRecordingsFolder = useCallback(async () => {
    setRecordingsFolderError(null)
    // The native folder picker (dialog plugin); WKWebView has no File System
    // Access API, so the chosen path comes back from Rust.
    try {
      const dir = await invoke<string | null>('plugin:dialog|open', {
        options: { directory: true, multiple: false },
      })
      if (dir) handleRecordingsFolder(dir) // null = the user dismissed it
    } catch (error) {
      setRecordingsFolderError(error instanceof Error ? error.message : String(error))
    }
  }, [handleRecordingsFolder])
  const openRecordingsFolder = useCallback(async () => {
    setRecordingsFolderError(null)
    try {
      await invoke('open_recordings_folder', { folder: recordingsFolder })
    } catch (error) {
      setRecordingsFolderError(error instanceof Error ? error.message : String(error))
    }
  }, [recordingsFolder])

  // The settings drawer (issue #43): the appearance pickers + the model manager.
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The native MCP server's endpoint + token (ADR-0020 Phase 2), shown in Settings
  // so a Claude Desktop / Code client can connect. Fetched once; null until app_info
  // resolves (and `port` stays null when LSDJ_MCP is unset).
  const [mcpInfo, setMcpInfo] = useState<McpInfo | null>(null)
  useEffect(() => {
    void getMcpInfo().then(setMcpInfo)
  }, [])

  // Hand the restored mix positions to the engine once — it holds them
  // until the bus is built on first play. Later moves go through the
  // handlers, so this deliberately ignores state updates. The persisted
  // output device is applied best-effort: it may be gone since last run,
  // and a failure must leave the engine's default routing undisturbed.
  useEffect(() => {
    engine.setCrossfade(crossfade)
    engine.setCueMix(cueMix)
    // Apply persisted device choices best-effort (either may be gone since last
    // run). Main first, so a "same as main" cue resolves against the right
    // device on the engine side.
    if (mainDevice) void engine.setMainDevice(mainDevice).catch(() => {})
    if (cueDevice) void engine.setCueDevice(cueDevice).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine])

  // The one place a successful device switch lands: state + persist. The picker
  // has already performed the switch on the engine; we only record the choice
  // (so a rejected switch never reaches here and the selection reverts to the
  // last good value). Main persists under the legacy `outputDevice` key.
  const handleMainDevice = useCallback((name: string) => {
    setMainDevice(name)
    updateAppSettings({ outputDevice: name })
  }, [])
  const handleCueDevice = useCallback((name: string) => {
    setCueDevice(name)
    updateAppSettings({ cueDevice: name })
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleShortcutKey)
    return () => window.removeEventListener('keydown', handleShortcutKey)
  }, [])

  // Cmd/Ctrl+M toggles the media tray. Separate from handleShortcutKey, which
  // is a bare-letter focus router that bails on modifiers. preventDefault also
  // suppresses the macOS Cmd+M window-minimize default.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'm'
      ) {
        event.preventDefault()
        handleMediaToggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleMediaToggle])

  // The one place a crossfade move is defined: audio bus + state + persist.
  // Every source — slider, keyboard, hardware — lands here.
  const handleCrossfade = useCallback(
    (position: number) => {
      // The projected setter renders optimistically and emits engine.setCrossfade,
      // which records the move into the store (the single source of truth).
      setCrossfade(position)
      updateAppSettings({ crossfade: position })
    },
    [setCrossfade],
  )

  // The one place a cue-mix move is defined, mirroring handleCrossfade.
  const handleCueMix = useCallback(
    (position: number) => {
      setCueMix(position)
      updateAppSettings({ cueMix: position })
    },
    [setCueMix],
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
        shiftedDeck,
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

  // Track items flip the deck to playback; the way back lives on the deck
  // itself ("Back to live", ADR-0013: loading decides the mode).
  const handleLoadTrack = useCallback(
    (deck: DeckId, wav: ArrayBuffer, title: string) =>
      (deck === 'a' ? deckA : deckB).loadTrack(wav, title),
    [deckA, deckB],
  )
  // Load a saved sample into a deck's loop-slot bank (ADR-0022) — the Samples-tab
  // counterpart of handleLoadTrack, routed to the deck's `loadSampleToSlot`.
  const handleLoadSample = useCallback(
    (deck: DeckId, wav: ArrayBuffer, oneShot: boolean, label: string) =>
      (deck === 'a' ? deckA : deckB).loadSampleToSlot(wav, oneShot, label),
    [deckA, deckB],
  )
  // Preview a library item in the phones before committing it to a deck
  // (ADR-0027): the engine routes it to the cue feed only, never the master.
  const handlePreview = useCallback(
    (wav: ArrayBuffer) => engine.auditionPlay(wav),
    [engine],
  )
  const handleStopPreview = useCallback(() => engine.auditionStop(), [engine])

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
          <MidiControls
            status={midi.status}
            deviceName={midi.deviceName}
            devices={midi.devices}
            onConnect={midi.connect}
            onSelectDevice={midi.selectDevice}
            readMonitor={midi.readMonitor}
          />
          <RecordControl recordingsFolder={recordingsFolder} />
          <Button onClick={() => setSettingsOpen(true)}>{t('settings.open')}</Button>
        </div>
      </header>
      <Drawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={t('settings.title')}
        closeLabel={t('settings.close')}
      >
        <section className="modelmgr__section">
          <h3 className="modelmgr__heading">{t('settings.appearance')}</h3>
          <div className="settings-appearance">
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
          </div>
        </section>
        <section className="modelmgr__section">
          <h3 className="modelmgr__heading">{t('settings.audio')}</h3>
          <div className="settings-audio">
            <OutputDevicePicker
              mode="main"
              value={mainDevice}
              onSelect={handleMainDevice}
            />
            <OutputDevicePicker
              mode="cue"
              value={cueDevice}
              onSelect={handleCueDevice}
              mainDeviceName={mainDevice}
            />
          </div>
        </section>
        {/* The native MCP server (ADR-0020 Phase 2): point a Claude Desktop /
            Code client at the loopback endpoint with the bearer token. Shown only
            when the server is up (LSDJ_MCP=1); otherwise a hint to enable it. */}
        <section className="modelmgr__section">
          <h3 className="modelmgr__heading">{t('settings.mcp')}</h3>
          <div className="settings-mcp">
            {mcpInfo?.port ? (
              <>
                <p className="settings-mcp__hint">{t('settings.mcpHint')}</p>
                <div className="settings-mcp__field">
                  <span className="ui-field__label">{t('settings.mcpEndpoint')}</span>
                  <code className="settings-mcp__value">{`http://127.0.0.1:${mcpInfo.port}/mcp`}</code>
                </div>
                <div className="settings-mcp__field">
                  <span className="ui-field__label">{t('settings.mcpToken')}</span>
                  <code className="settings-mcp__value">{mcpInfo.token}</code>
                </div>
              </>
            ) : (
              <p className="settings-mcp__hint">{t('settings.mcpDisabled')}</p>
            )}
          </div>
        </section>
        {/* Where master-bus recordings are saved. Empty = the OS Downloads
            folder (the default); choosing a folder routes takes there. */}
        <section className="modelmgr__section">
          <h3 className="modelmgr__heading">{t('settings.recording')}</h3>
          <div className="settings-recording">
            <div className="settings-recording__folder">
              <span className="settings-recording__label">
                {t('settings.recordingFolder')}
              </span>
              <span
                className="settings-recording__path"
                title={recordingsFolder || undefined}
              >
                {recordingsFolder || t('settings.recordingFolderDefault')}
              </span>
            </div>
            <div className="settings-recording__actions">
              <Button onClick={() => void chooseRecordingsFolder()}>
                {t('media.folder.choose')}
              </Button>
              {recordingsFolder && (
                <Button onClick={() => handleRecordingsFolder('')}>
                  {t('settings.useDownloads')}
                </Button>
              )}
              <Button onClick={() => void openRecordingsFolder()}>
                {t('modelManager.openFolder')}
              </Button>
            </div>
            {recordingsFolderError && (
              <p className="settings-recording__error" role="alert">
                {t('settings.recordingFolderError', { message: recordingsFolderError })}
              </p>
            )}
          </div>
        </section>
        {/* Which model each deck runs live — a once-per-session setup choice,
            moved out of the deck column so it stops competing with the style pad
            for height. A crashed worker still offers its own picker in the
            recovery block (the "switch to a model that fits" path). */}
        <section className="modelmgr__section">
          <h3 className="modelmgr__heading">{t('settings.models')}</h3>
          <div className="settings-models">
            {([
              { id: 'a' as const, deck: deckA, modelOptions: deckAModelOptions },
              { id: 'b' as const, deck: deckB, modelOptions: deckBModelOptions },
            ]).map(({ id, deck, modelOptions }) => (
              <Select
                key={id}
                label={t('settings.modelDeck', { id: id.toUpperCase() })}
                value={deck.state.model ?? ''}
                options={modelOptions}
                disabled={deck.state.connection !== 'open' || deck.state.switchingModel}
                onChange={deck.setModel}
              />
            ))}
          </div>
        </section>
        {/* The model library: install / manage the realtime (Magenta) and
            generation (Stable Audio 3) weights on disk. The umbrella section
            keeps the install families grouped under one heading and restores the
            inter-section rhythm across the ModelManager boundary. */}
        <section className="modelmgr__section settings-model-library">
          <h3 className="modelmgr__heading">{t('settings.modelLibrary')}</h3>
          <ModelManager />
        </section>
      </Drawer>
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
        onLoadSample={handleLoadSample}
        onPreview={handlePreview}
        onStopPreview={handleStopPreview}
        open={mediaOpen}
        onToggle={handleMediaToggle}
        height={mediaHeight}
        onResize={handleMediaResize}
      />
    </main>
  )
}

export default App
