import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useInterfaceStore } from '../audio/interfaceStore'
import { setDeckPerformance, type DeckSnap } from '../audio/nativeEngine'
import type { DeckId } from '../audio/types'
import { Select } from '../ui/Select'
import { Switch } from '../ui/Switch'

/** Pitch-class names for the key picker and the held-note readout. */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const SCALES = ['major', 'minor', 'pentatonicMinor', 'chromatic'] as const
const MODES = ['chord', 'onset'] as const

type Performance = DeckSnap['performance']

function pitchName(pitch: number): string {
  // MIDI 60 = C4, the octave convention the FLX4 pads land in.
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`
}

/** The issue-48 performance surface as a sliding door over the 2D prompt pad
 * (ADR-0031): deck A's slides in from the left, deck B's from the right, in
 * the deck's accent. The door is the CONFIG surface (view state, local per
 * ADR-0020's narrowing); the MIDI STEER toggle inside it is the semantic arm
 * (`performance.armed` in the store): while on, FLX4 KEYBOARD pads and MIDI
 * keys steer the deck at ~200 ms chunks — door open or closed. Hardware arms
 * it too (the KEYBOARD pad-mode selector), so a steering rising edge slides
 * the door open to surface the config, and the handle burns in the deck
 * accent while steering so the state reads with the door shut. */
export function PerformanceDrawer({
  deckId,
  deckIndex,
}: {
  deckId: DeckId
  deckIndex: number
}) {
  const { t } = useTranslation()
  const storeState = useInterfaceStore()
  const snap = storeState?.decks[deckIndex]
  const snapPerf = snap?.performance
  const perf: Performance = useMemo(
    () => snapPerf ?? { armed: false, key: 0, scale: 'major', mode: 'chord' },
    [snapPerf],
  )
  const held = snap?.notes?.pitches ?? []

  // Door visibility is ephemeral view state (ADR-0020 narrowing): closing it
  // does NOT stop steering. It auto-opens on a steering rising edge so an arm
  // from the hardware selector (or a first pad press) surfaces the config.
  const [open, setOpen] = useState(false)
  const wasArmedRef = useRef(perf.armed)
  useEffect(() => {
    if (perf.armed && !wasArmedRef.current) setOpen(true)
    wasArmedRef.current = perf.armed
  }, [perf.armed])

  const write = useCallback(
    (next: Performance) => setDeckPerformance(deckIndex, next),
    [deckIndex],
  )
  const toggleSteer = useCallback(
    () => write({ ...perf, armed: !perf.armed }),
    [write, perf],
  )
  const onKey = useCallback(
    (value: string) => write({ ...perf, key: NOTE_NAMES.indexOf(value) }),
    [write, perf],
  )
  const onScale = useCallback(
    (value: string) => write({ ...perf, scale: value as Performance['scale'] }),
    [write, perf],
  )
  const onMode = useCallback(
    (value: string) => write({ ...perf, mode: value as Performance['mode'] }),
    [write, perf],
  )

  const scaleOptions = useMemo(
    () => SCALES.map((scale) => ({ value: scale, label: t(`deck.perform.scales.${scale}`) })),
    [t],
  )
  const modeOptions = useMemo(
    () => MODES.map((mode) => ({ value: mode, label: t(`deck.perform.modes.${mode}`) })),
    [t],
  )

  return (
    // One rigid assembly, like a real sliding door: the rail is PART of the
    // door, so the tab you grab travels with it — closed, only the rail
    // peeks out at the pad edge as the CTA; open, the same rail sits at the
    // opposite edge as the push-back chevron. Its LED is the steering tell.
    <section
      className={`deck__perform-door deck__perform-door--${deckId}${
        open ? ' deck__perform-door--open' : ''
      }`}
      role="group"
      aria-label={t('deck.perform.title')}
    >
      <div className="deck__perform-content" aria-hidden={!open}>
        <header className="deck__perform-head">
          <h3 className="deck__perform-title">{t('deck.perform.title')}</h3>
          <Switch
            label={t('deck.perform.steer')}
            on={perf.armed}
            accent={deckId}
            onClick={toggleSteer}
          />
        </header>
        <p className="deck__perform-hint">{t('deck.perform.hint')}</p>
        <div className="deck__perform-row">
          <Select
            label={t('deck.perform.key')}
            value={NOTE_NAMES[perf.key] ?? 'C'}
            options={NOTE_NAMES}
            onChange={onKey}
          />
          <Select
            label={t('deck.perform.scale')}
            value={perf.scale}
            options={scaleOptions}
            onChange={onScale}
          />
        </div>
        <div className="deck__perform-row">
          <Select
            label={t('deck.perform.mode')}
            value={perf.mode}
            options={modeOptions}
            onChange={onMode}
          />
        </div>
        <p className="deck__perform-live" role="status">
          {!perf.armed
            ? t('deck.perform.off')
            : held.length
              ? t('deck.perform.held', { notes: held.map(pitchName).join(' ') })
              : t('deck.perform.live')}
        </p>
      </div>
      <button
        type="button"
        className="deck__perform-rail"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-label={open ? t('deck.perform.close') : t('deck.perform.open')}
      >
        <span
          className={`deck__perform-rail-led${
            perf.armed ? ' deck__perform-rail-led--on' : ''
          }`}
          aria-hidden="true"
        />
        <span className="deck__perform-rail-label" aria-hidden="true">
          {t('deck.perform.open')}
        </span>
        <span className="deck__perform-rail-chevron" aria-hidden="true">
          {deckId === 'a' ? '<' : '>'}
        </span>
      </button>
    </section>
  )
}
