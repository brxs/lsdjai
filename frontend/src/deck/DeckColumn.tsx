import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { DeckId } from '../audio/engine'
import { FX_KINDS, fxRestPosition, type FxKind } from '../audio/fx'
import { LOOP_LENGTH_OPTIONS, LOOP_SLOT_COUNT } from '../audio/loops'
import { useControlBus } from '../control/busContext'
import { Button } from '../ui/Button'
import { Knob } from '../ui/Knob'
import { Meter } from '../ui/Meter'
import { Panel } from '../ui/Panel'
import { Select } from '../ui/Select'
import { Stat } from '../ui/Stat'
import { TextField } from '../ui/TextField'
import { TrackOverview, TRACK_OVERVIEW_BUCKETS } from '../ui/TrackOverview'
import { TransportButton } from '../ui/TransportButton'
import { WaveformStrip } from '../ui/WaveformStrip'
import { XYPad } from '../ui/XYPad'
import { isDeckOperable, type ActiveStyle, type DeckState } from './deckState'
import { padWeights, spawnPosition, sweepPosition, type PadPoint } from './padWeights'
import {
  MAX_PRESET_NAME_LENGTH,
  MAX_PRESET_TARGETS,
  type StylePreset,
} from '../presets'
import {
  GENERATE_PROMPT_MAX_LENGTH,
  type DeckMode,
  type GenerateEngine,
  type LoopState,
  type TrackState,
} from './useDeck'
import { loadDeckSettings, updateDeckSettings } from '../persistence'
import './deck.css'

// The worker holds ~3s of lead (see backend worker pacing); the meter shows
// health relative to that target.
const BUFFER_TARGET_SECONDS = 3
// One source for the pad cap (mirrors the backend's MAX_STYLE_PROMPTS).
const MAX_TARGETS = MAX_PRESET_TARGETS
// Cursor drags re-blend cached embeddings server-side; ~7/s is plenty when
// styles land at chunk boundaries anyway.
const STYLE_SEND_INTERVAL_MS = 150

/** Leading+trailing throttle where an immediate send is the chokepoint:
 * it cancels any pending trailing send, so a stale gesture frame queued
 * before an add/remove can never overwrite it. */
function createSendThrottle(intervalMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0
  function fire(send: () => void) {
    clearTimeout(timer)
    timer = undefined
    last = Date.now()
    send()
  }
  return {
    immediate: fire,
    throttled(send: () => void) {
      const elapsed = Date.now() - last
      if (elapsed >= intervalMs) {
        fire(send)
      } else {
        // Trailing send so the gesture's resting place always lands.
        clearTimeout(timer)
        timer = setTimeout(() => fire(send), intervalMs - elapsed)
      }
    },
    cancel() {
      clearTimeout(timer)
    },
  }
}

function formatTrackTime(seconds: number): string {
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

type DeckColumnProps = {
  deckId: DeckId
  state: DeckState
  getWaveformRange: () => [number, number]
  onPlay: () => void
  onStop: () => void
  onSetStyle: (style: ActiveStyle) => void
  onSetModel: (model: string) => void
  onRestart: () => void
  /** Reports how many style targets exist (for the pad LED echo). */
  onTargetCount?: (count: number) => void
  /** Generating off air (M10 deck prep) — surfaced in the status line. */
  primed?: boolean
  /** Color FX insert state and controls (M12). */
  fx: { kind: FxKind | null; amount: number }
  onSetFx: (kind: FxKind | null) => void
  onSetFxAmount: (amount: number) => void
  /** Freeze pads (M13): slot state and the pad/clear/length actions. */
  loop: LoopState
  onLoopPad: (slot: number) => void
  onClearLoopPad: (slot: number) => void
  onSetLoopSeconds: (seconds: number) => void
  /** Generated pads (M18): fill the first empty slot from a prompt,
   * with the chosen engine and one-shot/loop behaviour. */
  onGenerateToPad: (prompt: string, engine: GenerateEngine, oneShot: boolean) => void
  generateError: string | null
  /** Gated tempo readout (M14): null shows an honest dash. */
  bpm: number | null
  /** Style sampling (M15): capture the OTHER deck and register the
   * embedding on this one; resolves to the new target, or null when
   * the other deck has not played enough. */
  onSampleOtherDeck: () => Promise<{ label: string; sample: string } | null>
  /** Whether the other deck is currently producing something to sample. */
  canSample: boolean
  /** Crates (M16): save this deck's pad + FX as a named preset. */
  onSavePreset: (preset: StylePreset) => void
  /** Playback mode (M19, ADR-0013): in 'playback' the style pane swaps
   * for the loaded track's overview and the transport drives it. */
  mode: DeckMode
  track: TrackState | null
  /** The deck-local exit from playback — back to the live stream
   * without a trip to the Media Explorer. */
  onLeavePlayback: () => void
  onSeekTrack: (seconds: number) => void
  getTrackPeaks: (
    buckets: number,
  ) => { min: Float32Array; max: Float32Array } | null
}

export function DeckColumn({
  deckId,
  state,
  getWaveformRange,
  onPlay,
  onStop,
  onSetStyle,
  onSetModel,
  onRestart,
  onTargetCount,
  primed = false,
  fx,
  onSetFx,
  onSetFxAmount,
  loop,
  onLoopPad,
  onClearLoopPad,
  onSetLoopSeconds,
  onGenerateToPad,
  generateError,
  bpm,
  onSampleOtherDeck,
  canSample,
  onSavePreset,
  mode,
  track,
  onLeavePlayback,
  onSeekTrack,
  getTrackPeaks,
}: DeckColumnProps) {
  const { t } = useTranslation()
  const [targets, setTargets] = useState<
    (PadPoint & { text: string; sample?: string })[]
  >(() => loadDeckSettings(deckId).targets ?? [])
  const [sampling, setSampling] = useState(false)
  const [sampleError, setSampleError] = useState<string | null>(null)
  // Generated pads (M18): the prompt, engine, and behaviour for the
  // next generation.
  const [generateDraft, setGenerateDraft] = useState('')
  const [generateEngine, setGenerateEngine] = useState<GenerateEngine>('sfx')
  const [generateOneShot, setGenerateOneShot] = useState(true)
  // Mirrors the latest committed targets for reads after an await —
  // the async sample flow must not go stale, and must not smuggle
  // side effects into a state updater (StrictMode replays those).
  const targetsRef = useRef(targets)
  useEffect(() => {
    targetsRef.current = targets
  }, [targets])
  const [cursor, setCursor] = useState<PadPoint>(
    () => loadDeckSettings(deckId).cursor ?? { x: 0.5, y: 0.5 },
  )
  const [targetDraft, setTargetDraft] = useState('')
  // In-place prompt editing: which row is open and its draft text.
  const [editing, setEditing] = useState<{ text: string; draft: string } | null>(
    null,
  )
  // After a keyboard-driven commit/cancel, focus returns to this
  // row's ✎ (the input unmounts, which would otherwise drop focus to
  // the body). A ref, not state: the commit/cancel itself re-renders
  // via setEditing, and focusing is imperative — no render to drive.
  const focusAfterEditRef = useRef<string | null>(null)
  const editButtons = useRef(new Map<string, HTMLButtonElement>())
  useEffect(() => {
    if (focusAfterEditRef.current === null) return
    editButtons.current.get(focusAfterEditRef.current)?.focus()
    focusAfterEditRef.current = null
  })
  const [presetDraft, setPresetDraft] = useState('')
  const [throttle] = useState(() => createSendThrottle(STYLE_SEND_INTERVAL_MS))

  const connected = state.connection === 'open'
  const operable = isDeckOperable(state)
  const canGenerate =
    connected &&
    Boolean(generateDraft.trim()) &&
    loop.slots.some((slot) => slot.state === 'empty')
  const fireGenerate = () => {
    if (!canGenerate) return
    onGenerateToPad(generateDraft, generateEngine, generateOneShot)
  }
  const statusKey =
    mode === 'playback'
      ? track?.ended
        ? 'deck.status.trackEnded'
        : track?.playing
          ? 'deck.status.trackPlaying'
          : 'deck.status.trackPaused'
      : state.switchingModel
    ? 'deck.status.loadingModel'
    : loop.active !== null && connected
      ? 'deck.status.frozen'
      : primed && connected
        ? 'deck.status.primed'
        : {
            connecting: 'deck.status.connecting',
            open: 'deck.status.connected',
            closed: 'deck.status.disconnected',
          }[state.connection]
  const bufferFraction = state.bufferedSeconds / BUFFER_TARGET_SECONDS
  const bufferTone =
    !state.playing || bufferFraction >= 0.5 ? 'ok' : bufferFraction >= 0.25 ? 'warn' : 'danger'

  // The overview envelope is static per track — recompute only when a
  // different load lands (the monotonic id; titles can repeat), not on
  // every playhead tick.
  const trackKey = track ? track.loadId : null
  const trackPeaksData = useMemo(
    () => (trackKey === null ? null : getTrackPeaks(TRACK_OVERVIEW_BUCKETS)),
    [trackKey, getTrackPeaks],
  )

  type Target = PadPoint & { text: string; sample?: string }

  function styleFor(nextTargets: Target[], nextCursor: PadPoint): ActiveStyle | null {
    if (nextTargets.length === 0) return null
    const weights = padWeights(nextTargets, nextCursor)
    return {
      prompts: nextTargets.map((target, index) => ({
        text: target.text,
        weight: weights[index],
        ...(target.sample ? { sample: target.sample } : {}),
      })),
    }
  }

  function sendStyle(nextTargets: Target[], nextCursor: PadPoint) {
    throttle.immediate(() => {
      const style = styleFor(nextTargets, nextCursor)
      if (style) onSetStyle(style)
    })
  }

  function sendStyleThrottled(nextTargets: Target[], nextCursor: PadPoint) {
    throttle.throttled(() => {
      const style = styleFor(nextTargets, nextCursor)
      if (style) onSetStyle(style)
    })
  }

  useEffect(() => () => throttle.cancel(), [throttle])

  // Persist the pad arrangement so a reload picks the session back up.
  // Sampled targets stay out: their embeddings are session-only
  // (ADR-0011), so persisting the chip would persist a dead reference.
  useEffect(() => {
    updateDeckSettings(deckId, {
      targets: targets.filter((target) => !target.sample),
      cursor,
    })
  }, [deckId, targets, cursor])

  // A worker restart (crash or model switch) drops its sample cache;
  // the chips die with it rather than poisoning every style send.
  // Render-time adjustment (the React "derived state" pattern), so the
  // stripped pad is what this very render shows.
  const workerGone = state.workerDied || state.switchingModel
  if (workerGone && targets.some((target) => target.sample)) {
    setTargets(targets.filter((target) => !target.sample))
  }

  // An open edit whose target vanished (preset load, removal, the
  // strip above) must not linger — its input unmounts without a blur,
  // and a later same-named target would render pre-opened with the
  // stale draft. Same render-time pattern as the strip above.
  if (editing && !targets.some((target) => target.text === editing.text)) {
    setEditing(null)
  }

  useEffect(() => {
    onTargetCount?.(targets.length)
  }, [targets.length, onTargetCount])

  // The worker has no style after a reload, a model switch, or a crash
  // restart — re-apply the pad's arrangement once per such episode, as soon
  // as the deck can take it. Ref-gated so the in-flight server echo doesn't
  // trigger duplicate sends on every render.
  const resentRef = useRef(false)
  useEffect(() => {
    const needsStyle =
      isDeckOperable(state) && !state.activeStyle && targets.length > 0
    if (!needsStyle) {
      resentRef.current = false
      return
    }
    if (resentRef.current) return
    resentRef.current = true
    throttle.immediate(() => {
      const style = styleFor(targets, cursor)
      if (style) onSetStyle(style)
    })
  })

  function addTarget() {
    const text = targetDraft.trim()
    if (
      !text ||
      targets.some((target) => target.text === text) ||
      targets.length >= MAX_TARGETS
    ) {
      return
    }
    const next = [...targets, { text, ...spawnPosition(targets) }]
    setTargets(next)
    setTargetDraft('')
    sendStyle(next, cursor)
  }

  function savePreset() {
    const name = presetDraft.trim().slice(0, MAX_PRESET_NAME_LENGTH)
    const textTargets = targets
      .filter((target) => !target.sample)
      .map(({ text, x, y }) => ({ text, x, y }))
    if (!name || textTargets.length === 0) return
    onSavePreset({ name, targets: textTargets, cursor, fx })
    setPresetDraft('')
  }

  // One action (M15): capture the other deck, register the embedding,
  // land it on the pad as a blendable target. The upload resolves once
  // the embed command is queued ahead of any style send (FIFO).
  async function sampleOtherDeck() {
    if (sampling || targets.length >= MAX_TARGETS) return
    setSampling(true)
    setSampleError(null)
    try {
      const result = await onSampleOtherDeck()
      if (!result) {
        // The other deck is playing but hasn't produced the minimum
        // capture yet — say so instead of silently doing nothing.
        setSampleError(t('deck.style.sampleTooSoon'))
        return
      }
      const current = targetsRef.current
      if (current.length >= MAX_TARGETS) return
      const next = [
        ...current,
        { text: result.label, sample: result.sample, ...spawnPosition(current) },
      ]
      setTargets(next)
      sendStyle(next, cursor)
    } catch (error) {
      setSampleError(error instanceof Error ? error.message : String(error))
    } finally {
      setSampling(false)
    }
  }

  /** Commit an in-place prompt edit: the target keeps its position
   * and weight, only the prompt changes — re-embedded like typing it.
   * A rename that collides with another chip (or empties) cancels,
   * the same quiet rule the Add button applies to duplicates.
   * `restoreFocus` is set for keyboard outcomes (Enter/Escape) so
   * focus returns to the row's ✎ instead of falling to <body>; a
   * blur-commit means the user already clicked elsewhere, and yanking
   * focus back would fight them. */
  function commitEdit(restoreFocus = false) {
    if (!editing) return
    const text = editing.draft.trim()
    const original = editing.text
    setEditing(null)
    // The deck may have become untouchable mid-edit (disconnect, model
    // switch); every other mutation path is gated by a disabled
    // control, so the open input cancels rather than committing.
    if (!operable) return
    const renamed = text && text !== original && !targets.some((target) => target.text === text)
    const finalText = renamed ? text : original
    if (restoreFocus) focusAfterEditRef.current = finalText
    if (!renamed) return
    const next = targets.map((target) =>
      target.text === original ? { ...target, text } : target,
    )
    setTargets(next)
    sendStyle(next, cursor)
  }

  function cancelEdit() {
    if (!editing) return
    focusAfterEditRef.current = editing.text
    setEditing(null)
  }

  function removeTarget(text: string) {
    const next = targets.filter((target) => target.text !== text)
    setTargets(next)
    sendStyle(next, cursor)
  }

  function handleCursor(x: number, y: number) {
    const next = { x, y }
    setCursor(next)
    sendStyleThrottled(targets, next)
  }

  // Loading a preset (M16) replaces the pad wholesale: targets,
  // cursor, and an immediate style send — exactly like typing the
  // prompts (cached embeddings make repeats cheap). Sampled chips are
  // gone by construction: presets never contain them.
  function applyPreset(preset: StylePreset) {
    setTargets(preset.targets)
    setCursor(preset.cursor)
    sendStyle(preset.targets, preset.cursor)
  }

  // Hardware style intents (ADR-0005) mirror the pointer paths and the
  // pad's gating: HOT CUE pad N snaps the cursor onto target N (immediate
  // send, like add/remove), the CFX knob sweeps the cursor with the same
  // throttle as a drag. Resubscribes per render to read fresh state.
  const bus = useControlBus()
  useEffect(() =>
    bus.subscribe((intent) => {
      if (intent.kind === 'preset_load' && intent.deck === deckId) {
        applyPreset(intent.preset)
        return
      }
      if (!operable || targets.length === 0) return
      if (intent.kind === 'style_target' && intent.deck === deckId) {
        const target = targets[intent.index]
        if (!target) return
        const next = { x: target.x, y: target.y }
        setCursor(next)
        sendStyle(targets, next)
      } else if (intent.kind === 'style_sweep' && intent.deck === deckId) {
        const next = sweepPosition(intent.value)
        handleCursor(next.x, next.y)
      }
    }),
  )

  function handleTargetMove(id: string, x: number, y: number) {
    const next = targets.map((target) =>
      target.text === id ? { ...target, x, y } : target,
    )
    setTargets(next)
    sendStyleThrottled(next, cursor)
  }

  const activeSummary = state.activeStyle
    ? t('deck.style.active', {
        summary: state.activeStyle.prompts
          .filter((prompt) => prompt.weight >= 0.005)
          .sort((a, b) => b.weight - a.weight)
          .map((prompt) =>
            t('deck.style.blendItem', {
              percent: Math.round(prompt.weight * 100),
              text: prompt.text,
            }),
          )
          .join(t('deck.style.blendSeparator')),
      })
    : ''

  const padTargets = targets.map((target) => ({
    id: target.text,
    label: target.text,
    x: target.x,
    y: target.y,
  }))

  return (
    <section
      className={`deck deck--${deckId}`}
      aria-label={t('deck.title', { id: deckId })}
    >
      <WaveformStrip
        label={t('deck.waveform', { id: deckId })}
        getRange={getWaveformRange}
        traceToken={`--color-deck-${deckId}`}
      />

      <header className="deck__header">
        <h2 className="deck__title">{t('deck.title', { id: deckId })}</h2>
        <span
          className={`deck__status${connected ? '' : ' deck__status--disconnected'}`}
        >
          <span
            className={`deck__status-led${connected && !state.workerDied ? ' deck__status-led--on' : ''}`}
          />
          {t(statusKey)}
        </span>
      </header>

      {/* Deliberately usable while the worker is dead: switching to a model
          that fits is the recovery path when the chosen one cannot load.
          Hidden in playback — the worker is parked (ADR-0013). */}
      {mode !== 'playback' && (
        <Select
          label={t('deck.model.label')}
          value={state.model ?? ''}
          options={state.availableModels.length ? state.availableModels : [state.model ?? '']}
          disabled={!connected || state.switchingModel}
          onChange={onSetModel}
        />
      )}

      {/* Playback mode (M19, ADR-0013): the style pane gives way to the
          loaded track — its envelope is the deck's seekable surface. */}
      {mode === 'playback' && track ? (
        <Panel className="deck__style">
          <TrackOverview
            label={t('deck.track.overview', { id: deckId })}
            peaks={trackPeaksData}
            position={track.position}
            duration={track.duration}
            accent={deckId}
            onSeek={onSeekTrack}
          />
          <div className="deck__track-row">
            <p className="deck__active-prompt">{track.title}</p>
            <Button onClick={onLeavePlayback}>
              {t('deck.track.backToLive')}
            </Button>
          </div>
        </Panel>
      ) : (
      <Panel className="deck__style">
        <div className="deck__prompt-row">
          <TextField
            label={t('deck.style.target')}
            placeholder={t('deck.style.targetPlaceholder')}
            data-shortcut={`deck-${deckId}-prompt`}
            value={targetDraft}
            onChange={(event) => setTargetDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addTarget()
            }}
          />
          <Button
            onClick={addTarget}
            disabled={
              !operable ||
              !targetDraft.trim() ||
              targets.length >= MAX_TARGETS ||
              targets.some((target) => target.text === targetDraft.trim())
            }
          >
            {t('deck.style.addTarget')}
          </Button>
          <Button
            onClick={() => void sampleOtherDeck()}
            lit={sampling}
            disabled={
              !operable || !canSample || sampling || targets.length >= MAX_TARGETS
            }
          >
            {t('deck.style.sampleOther', {
              deck: (deckId === 'a' ? 'b' : 'a').toUpperCase(),
            })}
          </Button>
        </div>

        <XYPad
          label={t('deck.style.pad')}
          targets={padTargets}
          cursor={cursor}
          disabled={!operable || targets.length === 0}
          onChange={handleCursor}
          onTargetMove={handleTargetMove}
        />

        {targets.length > 0 && (
          <ul className="deck__targets">
            {targets.map((target) => (
              <li key={target.text} className="deck__target-row">
                {editing?.text === target.text ? (
                  <input
                    className="deck__target-edit"
                    value={editing.draft}
                    autoFocus
                    aria-label={t('deck.style.editTarget', { prompt: target.text })}
                    onChange={(event) =>
                      setEditing({ text: target.text, draft: event.target.value })
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitEdit(true)
                      if (event.key === 'Escape') cancelEdit()
                    }}
                    onBlur={() => commitEdit()}
                  />
                ) : (
                  <>
                    <span className="deck__target-text">{target.text}</span>
                    <button
                      ref={(element) => {
                        if (element) editButtons.current.set(target.text, element)
                        else editButtons.current.delete(target.text)
                      }}
                      className="deck__target-action"
                      onClick={() => {
                        // Sampled chips (M15) have no text to edit —
                        // their label names a captured moment, not a
                        // prompt. aria-disabled (not disabled) keeps
                        // the button focusable so that reasoning is
                        // announced rather than skipped.
                        if (target.sample) return
                        setEditing({ text: target.text, draft: target.text })
                      }}
                      disabled={!operable}
                      aria-disabled={!operable || Boolean(target.sample)}
                      aria-label={t('deck.style.editTarget', {
                        prompt: target.text,
                      })}
                    >
                      ✎
                    </button>
                    <button
                      className="deck__target-action"
                      onClick={() => removeTarget(target.text)}
                      disabled={!operable}
                      aria-label={t('deck.style.removeTarget', {
                        prompt: target.text,
                      })}
                    >
                      ✕
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="deck__active-prompt">{activeSummary}</p>
        {sampleError && (
          <p className="deck__error" role="alert">
            {t('deck.style.sampleFailed', { message: sampleError })}
          </p>
        )}

        {/* Crates (M16): the pad's text targets + FX become a named
            preset; sampled chips are excluded (session-only, M15). */}
        <div className="deck__preset-row">
          <TextField
            label={t('deck.style.presetName')}
            value={presetDraft}
            onChange={(event) => setPresetDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') savePreset()
            }}
          />
          <Button
            onClick={savePreset}
            disabled={
              !presetDraft.trim() || targets.every((target) => target.sample)
            }
          >
            {t('deck.style.savePreset')}
          </Button>
        </div>
      </Panel>
      )}

      <div className="deck__fx" role="group" aria-label={t('deck.fx.title')}>
        <div className="deck__fx-select">
          <Select
            label={t('deck.fx.effect')}
            value={fx.kind ?? ''}
            options={[
              { value: '', label: t('deck.fx.off') },
              ...FX_KINDS.map((kind) => ({
                value: kind,
                label: t(`deck.fx.names.${kind}`),
              })),
            ]}
            onChange={(value) =>
              onSetFx(FX_KINDS.find((kind) => kind === value) ?? null)
            }
          />
        </div>
        <Knob
          label={t('deck.fx.amount')}
          accent={deckId}
          value={fx.amount}
          disabled={!fx.kind}
          resetValue={fx.kind ? fxRestPosition(fx.kind) : 0}
          onChange={onSetFxAmount}
        />
      </div>

      {/* Freeze pads (M13): lit = slot filled, accented = looping on
          air, ellipsis = a generation in flight (M18). Shift+click
          clears a slot — the same chord as SHIFT+pad on the hardware
          bank. */}
      <div className="deck__loop" role="group" aria-label={t('deck.loop.title')}>
        <div className="deck__loop-slots">
          {Array.from({ length: LOOP_SLOT_COUNT }, (_, slot) => {
            const slotState = loop.slots[slot]
            return (
              <Button
                key={slot}
                lit={slotState.state === 'filled'}
                variant={loop.active === slot ? 'primary' : 'default'}
                aria-label={
                  slotState.state === 'pending'
                    ? t('deck.loop.slotPending', { n: slot + 1 })
                    : t('deck.loop.slot', { n: slot + 1 })
                }
                aria-pressed={loop.active === slot}
                disabled={!operable || slotState.state === 'pending'}
                title={
                  slotState.state === 'empty'
                    ? undefined
                    : (slotState.label ?? undefined)
                }
                onClick={(event) =>
                  event.shiftKey ? onClearLoopPad(slot) : onLoopPad(slot)
                }
              >
                {slotState.state === 'pending' ? '…' : slot + 1}
              </Button>
            )
          })}
        </div>
        <Select
          label={t('deck.loop.length')}
          value={String(loop.seconds)}
          options={LOOP_LENGTH_OPTIONS.map((seconds) => ({
            value: String(seconds),
            label: t('deck.loop.lengthOption', { seconds }),
          }))}
          onChange={(value) => onSetLoopSeconds(Number(value))}
        />
      </div>

      {/* Generated pads (M18, ADR-0012): a prompt fills the first empty
          slot — one-shots overlay the deck, loops replace it like a
          capture and share the length picker above. The engine picks
          the sound world: Stable Audio's models, or the booth's own
          third Magenta engine (its first use pays the model load
          inside the pending state). */}
      <div
        className="deck__generate"
        role="group"
        aria-label={t('deck.generate.title')}
      >
        <div className="deck__generate-options">
          <Select
            label={t('deck.generate.engine')}
            value={generateEngine}
            options={[
              { value: 'sfx', label: t('deck.generate.engineSfx') },
              { value: 'music', label: t('deck.generate.engineMusic') },
              { value: 'magenta', label: t('deck.generate.engineMagenta') },
            ]}
            onChange={(value) => setGenerateEngine(value as GenerateEngine)}
          />
          <Select
            label={t('deck.generate.kind')}
            value={generateOneShot ? 'oneshot' : 'loop'}
            options={[
              { value: 'oneshot', label: t('deck.generate.kindOneShot') },
              { value: 'loop', label: t('deck.generate.kindLoop') },
            ]}
            onChange={(value) => setGenerateOneShot(value === 'oneshot')}
          />
        </div>
        <div className="deck__generate-row">
          <div className="deck__generate-prompt">
            <TextField
              label={t('deck.generate.prompt')}
              value={generateDraft}
              maxLength={GENERATE_PROMPT_MAX_LENGTH}
              disabled={!connected}
              onChange={(event) => setGenerateDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') fireGenerate()
              }}
            />
          </div>
          <Button disabled={!canGenerate} onClick={fireGenerate}>
            {t('deck.generate.action')}
          </Button>
        </div>
      </div>
      {generateError && (
        <p className="deck__error" role="alert">
          {t('deck.generate.failed', { message: generateError })}
        </p>
      )}

      <div className="deck__transport">
        {(mode === 'playback' ? (track?.playing ?? false) : state.playing) ? (
          <TransportButton
            kind="stop"
            accent={deckId}
            lit
            label={t('deck.stop')}
            disabled={mode === 'playback' ? track === null : !operable}
            onClick={onStop}
          />
        ) : (
          <TransportButton
            kind="play"
            accent={deckId}
            label={t('deck.play')}
            disabled={mode === 'playback' ? track === null : !operable}
            onClick={onPlay}
          />
        )}
        {mode === 'playback' && track ? (
          /* A track's health is its clock, not the stream's plumbing. */
          <div className="deck__health">
            <Stat
              label={t('deck.health.position')}
              value={t('deck.track.time', {
                position: formatTrackTime(track.position),
                duration: formatTrackTime(track.duration),
              })}
            />
            <Stat
              label={t('deck.health.bpm')}
              value={
                track.bpm === null
                  ? t('deck.health.noData')
                  : track.bpm.toFixed(1)
              }
            />
          </div>
        ) : (
        <div className="deck__health">
          <Meter
            label={t('deck.health.buffer')}
            valueLabel={t('deck.health.bufferSeconds', {
              seconds: state.bufferedSeconds.toFixed(1),
            })}
            fraction={bufferFraction}
            tone={bufferTone}
          />
          <Stat
            label={t('deck.health.bpm')}
            value={bpm === null ? t('deck.health.noData') : bpm.toFixed(1)}
          />
          <Stat
            label={t('deck.health.underruns')}
            value={String(state.underruns)}
            tone={state.underruns > 0 ? 'danger' : 'default'}
          />
          <Stat
            label={t('deck.health.generationSpeed')}
            value={
              state.generationSpeed === null
                ? t('deck.health.noData')
                : t('deck.health.generationSpeedValue', {
                    rtf: state.generationSpeed.toFixed(2),
                  })
            }
            tone={
              state.generationSpeed !== null && state.generationSpeed < 1
                ? 'danger'
                : 'default'
            }
          />
        </div>
        )}
      </div>

      {state.workerDied && (
        <div className="deck__recovery" role="alert">
          <p className="deck__error">{t('deck.worker.died')}</p>
          <Button onClick={onRestart} disabled={!connected}>
            {t('deck.worker.restart')}
          </Button>
        </div>
      )}

      {state.error && !state.workerDied && (
        <p className="deck__error" role="alert">
          {t('deck.error.message', { message: state.error })}
        </p>
      )}
    </section>
  )
}
