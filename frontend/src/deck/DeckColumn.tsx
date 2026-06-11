import { useEffect, useRef, useState } from 'react'
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
import { TransportButton } from '../ui/TransportButton'
import { WaveformStrip } from '../ui/WaveformStrip'
import { XYPad } from '../ui/XYPad'
import { isDeckOperable, type ActiveStyle, type DeckState } from './deckState'
import { padWeights, spawnPosition, sweepPosition, type PadPoint } from './padWeights'
import type { LoopState } from './useDeck'
import { loadDeckSettings, updateDeckSettings } from '../persistence'
import './deck.css'

// The worker holds ~3s of lead (see backend worker pacing); the meter shows
// health relative to that target.
const BUFFER_TARGET_SECONDS = 3
// Matches the backend's MAX_STYLE_PROMPTS.
const MAX_TARGETS = 8
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
  /** Gated tempo readout (M14): null shows an honest dash. */
  bpm: number | null
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
  bpm,
}: DeckColumnProps) {
  const { t } = useTranslation()
  const [targets, setTargets] = useState<(PadPoint & { text: string })[]>(
    () => loadDeckSettings(deckId).targets ?? [],
  )
  const [cursor, setCursor] = useState<PadPoint>(
    () => loadDeckSettings(deckId).cursor ?? { x: 0.5, y: 0.5 },
  )
  const [targetDraft, setTargetDraft] = useState('')
  const [throttle] = useState(() => createSendThrottle(STYLE_SEND_INTERVAL_MS))

  const connected = state.connection === 'open'
  const operable = isDeckOperable(state)
  const statusKey = state.switchingModel
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

  type Target = PadPoint & { text: string }

  function styleFor(nextTargets: Target[], nextCursor: PadPoint): ActiveStyle | null {
    if (nextTargets.length === 0) return null
    const weights = padWeights(nextTargets, nextCursor)
    return {
      prompts: nextTargets.map((target, index) => ({
        text: target.text,
        weight: weights[index],
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
  useEffect(() => {
    updateDeckSettings(deckId, { targets, cursor })
  }, [deckId, targets, cursor])

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

  // Hardware style intents (ADR-0005) mirror the pointer paths and the
  // pad's gating: HOT CUE pad N snaps the cursor onto target N (immediate
  // send, like add/remove), the CFX knob sweeps the cursor with the same
  // throttle as a drag. Resubscribes per render to read fresh state.
  const bus = useControlBus()
  useEffect(() =>
    bus.subscribe((intent) => {
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
          that fits is the recovery path when the chosen one cannot load. */}
      <Select
        label={t('deck.model.label')}
        value={state.model ?? ''}
        options={state.availableModels.length ? state.availableModels : [state.model ?? '']}
        disabled={!connected || state.switchingModel}
        onChange={onSetModel}
      />

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
        </div>

        {targets.length > 0 && (
          <ul className="deck__targets">
            {targets.map((target) => (
              <li key={target.text}>
                <button
                  className="deck__target-chip"
                  onClick={() => removeTarget(target.text)}
                  disabled={!operable}
                  aria-label={t('deck.style.removeTarget', { prompt: target.text })}
                >
                  {target.text} ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <XYPad
          label={t('deck.style.pad')}
          targets={padTargets}
          cursor={cursor}
          disabled={!operable || targets.length === 0}
          onChange={handleCursor}
          onTargetMove={handleTargetMove}
        />
        <p className="deck__active-prompt">{activeSummary}</p>
      </Panel>

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
          air. Shift+click clears a slot — the same chord as SHIFT+pad
          on the hardware bank. */}
      <div className="deck__loop" role="group" aria-label={t('deck.loop.title')}>
        <div className="deck__loop-slots">
          {Array.from({ length: LOOP_SLOT_COUNT }, (_, slot) => (
            <Button
              key={slot}
              lit={loop.filled[slot]}
              variant={loop.active === slot ? 'primary' : 'default'}
              aria-label={t('deck.loop.slot', { n: slot + 1 })}
              aria-pressed={loop.active === slot}
              disabled={!operable}
              onClick={(event) =>
                event.shiftKey ? onClearLoopPad(slot) : onLoopPad(slot)
              }
            >
              {slot + 1}
            </Button>
          ))}
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

      <div className="deck__transport">
        {state.playing ? (
          <TransportButton
            kind="stop"
            accent={deckId}
            lit
            label={t('deck.stop')}
            disabled={!operable}
            onClick={onStop}
          />
        ) : (
          <TransportButton
            kind="play"
            accent={deckId}
            label={t('deck.play')}
            disabled={!operable}
            onClick={onPlay}
          />
        )}
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
