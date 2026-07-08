import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { deckKeyboardNote } from '../audio/nativeEngine'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import './PianoWindow.css'

/** Pitch-class names for the per-key accessible label. MIDI 60 = C4, the octave
 * convention the shell tonic (`TONIC_BASE`) lands in. */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function pitchName(pitch: number): string {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`
}

/** The base tonic (MIDI C4), matching the shell's `TONIC_BASE`, so octave 0
 * plays in the model's comfortable melodic register. */
const BASE_TONIC = 60
const OCTAVE_MIN = -3
const OCTAVE_MAX = 3

type PianoKey = { semitone: number; code: string; letter: string; black: boolean }

/** One playable octave, C→C, mapped to the QWERTY home row (the Ableton layout)
 * by physical `event.code` so it is independent of the OS keyboard layout:
 * white keys A S D F G H J K, black keys W E T Y U. */
const KEYS: PianoKey[] = [
  { semitone: 0, code: 'KeyA', letter: 'A', black: false },
  { semitone: 1, code: 'KeyW', letter: 'W', black: true },
  { semitone: 2, code: 'KeyS', letter: 'S', black: false },
  { semitone: 3, code: 'KeyE', letter: 'E', black: true },
  { semitone: 4, code: 'KeyD', letter: 'D', black: false },
  { semitone: 5, code: 'KeyF', letter: 'F', black: false },
  { semitone: 6, code: 'KeyT', letter: 'T', black: true },
  { semitone: 7, code: 'KeyG', letter: 'G', black: false },
  { semitone: 8, code: 'KeyY', letter: 'Y', black: true },
  { semitone: 9, code: 'KeyH', letter: 'H', black: false },
  { semitone: 10, code: 'KeyU', letter: 'U', black: true },
  { semitone: 11, code: 'KeyJ', letter: 'J', black: false },
  { semitone: 12, code: 'KeyK', letter: 'K', black: false },
]

const CODE_TO_SEMITONE: Record<string, number> = Object.fromEntries(
  KEYS.map((key) => [key.code, key.semitone]),
)

const WHITE_KEYS = KEYS.filter((key) => !key.black)

/** A black key sits on the boundary above the white key a semitone below it; as
 * a fraction of the white-key row it centres on `(index + 1) / count`. */
function blackKeyLeft(semitone: number): string {
  const below = WHITE_KEYS.findIndex((key) => key.semitone === semitone - 1)
  return `${((below + 1) / WHITE_KEYS.length) * 100}%`
}

function clampPitch(pitch: number): number {
  return Math.max(0, Math.min(127, pitch))
}

/** A held key: the raw pitch sent on press, and the decks it was routed to at
 * press time — so the release reaches exactly those, even if a toggle changed. */
type Held = { pitch: number; decks: number[] }

/** The standalone MIDI keyboard (issue #49): one app-wide instrument in its own
 * window. It captures the computer keyboard at the window level — the whole
 * window IS the instrument, so there is no focus to hunt — and the two routing
 * toggles (A / B) decide which decks each note is sent to, independent of either
 * deck's MIDI-steering switch. Each routed deck snaps the raw pitch to its own
 * key/scale in the shell (`deckKeyboardNote` → `NoteSteering`). Keys are also
 * clickable for pointer/touch. */
export function PianoWindow() {
  const { t } = useTranslation()
  const [octave, setOctave] = useState(0)
  // Route A on by default so the window plays something the moment it opens.
  const [routeA, setRouteA] = useState(true)
  const [routeB, setRouteB] = useState(false)
  const [held, setHeld] = useState<Map<number, Held>>(() => new Map())
  // Refs mirror the state so the window-level key listeners (bound once) and the
  // handlers read current values and dedupe synchronously, and never do the
  // fire-and-forget send inside a setState updater. Every mutation writes the
  // ref and the state together, in a handler — never during render.
  const octaveRef = useRef(octave)
  const routeARef = useRef(routeA)
  const routeBRef = useRef(routeB)
  const heldRef = useRef(held)

  const routedDecks = useCallback(() => {
    const decks: number[] = []
    if (routeARef.current) decks.push(0)
    if (routeBRef.current) decks.push(1)
    return decks
  }, [])

  const press = useCallback(
    (semitone: number) => {
      if (heldRef.current.has(semitone)) return
      const pitch = clampPitch(BASE_TONIC + octaveRef.current * 12 + semitone)
      const decks = routedDecks()
      for (const deck of decks) deckKeyboardNote(deck, pitch, true)
      const next = new Map(heldRef.current).set(semitone, { pitch, decks })
      heldRef.current = next
      setHeld(next)
    },
    [routedDecks],
  )

  const release = useCallback((semitone: number) => {
    const entry = heldRef.current.get(semitone)
    if (!entry) return
    for (const deck of entry.decks) deckKeyboardNote(deck, entry.pitch, false)
    const next = new Map(heldRef.current)
    next.delete(semitone)
    heldRef.current = next
    setHeld(next)
  }, [])

  const releaseAll = useCallback(() => {
    if (heldRef.current.size === 0) return
    for (const entry of heldRef.current.values()) {
      for (const deck of entry.decks) deckKeyboardNote(deck, entry.pitch, false)
    }
    const empty = new Map<number, Held>()
    heldRef.current = empty
    setHeld(empty)
  }, [])

  // The window IS the instrument: capture the computer keyboard globally (no
  // input fields live here to guard against). Bound once; releases all on unmount.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const semitone = CODE_TO_SEMITONE[event.code]
      if (semitone === undefined) return
      event.preventDefault()
      if (event.repeat) return
      press(semitone)
    }
    function onKeyUp(event: KeyboardEvent) {
      const semitone = CODE_TO_SEMITONE[event.code]
      if (semitone === undefined) return
      event.preventDefault()
      release(semitone)
    }
    // Losing window focus (Cmd-Tab away mid-hold) or being hidden delivers no
    // key-up, so release everything — otherwise a held pitch drones on in the
    // shell until the performer returns and re-presses that exact key.
    function onBlur() {
      releaseAll()
    }
    function onVisibility() {
      if (document.hidden) releaseAll()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      releaseAll()
    }
  }, [press, release, releaseAll])

  const shiftOctave = useCallback((delta: number) => {
    const next = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, octaveRef.current + delta))
    octaveRef.current = next
    setOctave(next)
  }, [])

  const toggleRoute = useCallback((deck: number) => {
    const ref = deck === 0 ? routeARef : routeBRef
    const setRoute = deck === 0 ? setRouteA : setRouteB
    const next = !ref.current
    ref.current = next
    setRoute(next)
    if (next) return
    // Turning a route off releases any notes currently held on that deck, so a
    // held pitch can't stick in the shell after it stops being routed.
    let changed = false
    const updated = new Map(heldRef.current)
    for (const [semitone, entry] of heldRef.current) {
      if (!entry.decks.includes(deck)) continue
      deckKeyboardNote(deck, entry.pitch, false)
      updated.set(semitone, { ...entry, decks: entry.decks.filter((d) => d !== deck) })
      changed = true
    }
    if (changed) {
      heldRef.current = updated
      setHeld(updated)
    }
  }, [])

  const renderKey = (key: PianoKey) => {
    const pitch = clampPitch(BASE_TONIC + octave * 12 + key.semitone)
    const isHeld = held.has(key.semitone)
    return (
      <button
        key={key.code}
        type="button"
        // The computer keyboard is the instrument (captured at the window
        // level), so the on-screen keys are pointer/AT affordances, not 13 tab
        // stops — kept out of the tab order deliberately.
        tabIndex={-1}
        className={`piano__key piano__key--${key.black ? 'black' : 'white'}${
          isHeld ? ' piano__key--held' : ''
        }`}
        style={key.black ? { left: blackKeyLeft(key.semitone) } : undefined}
        aria-label={t('piano.key', { note: pitchName(pitch) })}
        aria-pressed={isHeld}
        onPointerDown={() => press(key.semitone)}
        onPointerUp={() => release(key.semitone)}
        onPointerLeave={() => release(key.semitone)}
        onPointerCancel={() => release(key.semitone)}
      >
        <span className="piano__key-hint" aria-hidden="true">
          {key.letter}
        </span>
      </button>
    )
  }

  return (
    <div className="piano">
      <header className="piano__head">
        <h1 className="piano__title">{t('piano.heading')}</h1>
        <div className="piano__routes">
          <span className="piano__routes-label">{t('piano.routeLabel')}</span>
          <Switch
            label={t('piano.routeDeck', { deck: 'A' })}
            on={routeA}
            accent="a"
            onClick={() => toggleRoute(0)}
          />
          <Switch
            label={t('piano.routeDeck', { deck: 'B' })}
            on={routeB}
            accent="b"
            onClick={() => toggleRoute(1)}
          />
        </div>
      </header>
      <div className="piano__controls">
        <Button
          type="button"
          aria-label={t('piano.octaveDown')}
          onClick={() => shiftOctave(-1)}
          disabled={octave <= OCTAVE_MIN}
        >
          −
        </Button>
        <span className="piano__octave" aria-live="polite">
          {t('piano.octave', { n: 4 + octave })}
        </span>
        <Button
          type="button"
          aria-label={t('piano.octaveUp')}
          onClick={() => shiftOctave(1)}
          disabled={octave >= OCTAVE_MAX}
        >
          ＋
        </Button>
      </div>
      <div className="piano__keys" role="group" aria-label={t('piano.heading')}>
        <div className="piano__whites">{WHITE_KEYS.map(renderKey)}</div>
        {KEYS.filter((key) => key.black).map(renderKey)}
      </div>
      <p className="piano__hint">{t('piano.hint')}</p>
    </div>
  )
}
