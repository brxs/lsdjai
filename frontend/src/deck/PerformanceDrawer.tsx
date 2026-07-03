import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useInterfaceStore } from '../audio/interfaceStore'
import { setDeckPerformance, type DeckSnap } from '../audio/nativeEngine'
import type { DeckId } from '../audio/types'
import { Select } from '../ui/Select'

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
 * the deck's accent. THE DOOR IS THE ARM STATE — opening it arms the deck
 * (FLX4 KEYBOARD pads and MIDI keys steer its harmony; generation tightens
 * to ~200 ms chunks), closing it disarms. A pure projection of the store's
 * performance config: the shell note-steering service owns the state, and
 * hardware arms it too (the FLX4's KEYBOARD pad-mode button slides the door
 * from the controller), so this renders whatever the store says, whoever
 * wrote it. The covered pad is the point: while the door is open the deck
 * plays notes, not prompt edits. */
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

  const write = useCallback(
    (next: Performance) => setDeckPerformance(deckIndex, next),
    [deckIndex],
  )
  const open = useCallback(() => write({ ...perf, armed: true }), [write, perf])
  const close = useCallback(() => write({ ...perf, armed: false }), [write, perf])
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
    <>
      <button
        type="button"
        className={`deck__perform-handle deck__perform-handle--${deckId}`}
        onClick={open}
        aria-expanded={perf.armed}
      >
        {t('deck.perform.open')}
      </button>
      <section
        className={`deck__perform-door deck__perform-door--${deckId}${
          perf.armed ? ' deck__perform-door--open' : ''
        }`}
        role="group"
        aria-label={t('deck.perform.title')}
        aria-hidden={!perf.armed}
      >
        <header className="deck__perform-head">
          <h3 className="deck__perform-title">{t('deck.perform.title')}</h3>
          <button
            type="button"
            className="deck__perform-close"
            onClick={close}
            aria-label={t('deck.perform.close')}
          >
            ✕
          </button>
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
          <Select
            label={t('deck.perform.mode')}
            value={perf.mode}
            options={modeOptions}
            onChange={onMode}
          />
        </div>
        <p className="deck__perform-live" role="status">
          {held.length
            ? t('deck.perform.held', { notes: held.map(pitchName).join(' ') })
            : t('deck.perform.live')}
        </p>
      </section>
    </>
  )
}
