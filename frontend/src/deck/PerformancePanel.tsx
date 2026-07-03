import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useInterfaceStore } from '../audio/interfaceStore'
import { setDeckPerformance, type DeckSnap } from '../audio/nativeEngine'
import { Button } from '../ui/Button'
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

/** The issue-48 performance surface controls (ADR-0031): arm the deck so the
 * FLX4 KEYBOARD pads / an external MIDI keyboard steer its harmony, pick the
 * key/scale the notes snap to, and choose chord-follow vs on-grid onset. A
 * pure projection of the store's performance config — the shell note-steering
 * service owns the state (arming also shrinks the worker chunk, ADR-0023),
 * and hardware can arm/disarm it too (the KEYBOARD pad-mode selector), so
 * this panel renders whatever the store says, whoever wrote it. */
export function PerformancePanel({ deckIndex }: { deckIndex: number }) {
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
  const toggleArm = useCallback(
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
    <div className="deck__perform" role="group" aria-label={t('deck.perform.title')}>
      <div className="deck__perform-row">
        <Button onClick={toggleArm} aria-pressed={perf.armed} lit={perf.armed}>
          {perf.armed ? t('deck.perform.disarm') : t('deck.perform.arm')}
        </Button>
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
      <p className="deck__perform-held" role="status">
        {perf.armed
          ? held.length
            ? t('deck.perform.held', { notes: held.map(pitchName).join(' ') })
            : t('deck.perform.armedIdle')
          : t('deck.perform.disarmed')}
      </p>
    </div>
  )
}
