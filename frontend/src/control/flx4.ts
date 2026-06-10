/** DDJ-FLX4 → ControlIntent translation (docs/midi-ddj-flx4.md, ADR-0005).
 *
 * The translator is a pure function of the message stream apart from one
 * piece of state: faders and knobs arrive as 14-bit pairs (MSB on the listed
 * CC, LSB on CC+0x20), so the last MSB per control is cached and combined
 * with the LSB that follows. Each physical move therefore emits two intents
 * on the bus — a coarse one on the MSB, refined when the LSB lands —
 * inaudible at 14-bit resolution but visible to subscribers. Everything not
 * in the map — shift layers, jog wheels, releases — translates to null. */

import type { DeckId } from '../audio/engine'
import type { ControlIntent } from './bus'

/** Per-deck Note On status bytes, shared with the cue LEDs. */
export const NOTE_ON_STATUS_BY_DECK: Record<DeckId, number> = {
  a: 0x90,
  b: 0x91,
}
const NOTE_ON_DECK: Partial<Record<number, DeckId>> = {
  [NOTE_ON_STATUS_BY_DECK.a]: 'a',
  [NOTE_ON_STATUS_BY_DECK.b]: 'b',
}
/** Pad bank status bytes, shared with the LED echo (same status out). */
export const PAD_STATUS_BY_DECK: Record<DeckId, number> = { a: 0x97, b: 0x99 }
const PAD_DECK: Partial<Record<number, DeckId>> = {
  [PAD_STATUS_BY_DECK.a]: 'a',
  [PAD_STATUS_BY_DECK.b]: 'b',
}
const BEAT_FX_STATUSES = [0x94, 0x95]
const PLAY_NOTE = 0x0b
const RECORD_NOTE = 0x47
export const CHANNEL_CUE_NOTE = 0x54
export const TRANSPORT_CUE_NOTE = 0x0c
/** SHIFT is a software modifier (ADR-0008): the firmware reports press
 * and release as plain notes and the knobs keep their CCs, so held
 * state is tracked here per deck. */
export const SHIFT_NOTE = 0x3f
export const PAD_COUNT = 8
/** PAD FX1 bank. Interpolated from the firmware's 0x10-per-bank scheme
 * (HOT CUE 0x00, BEAT JUMP 0x20, SAMPLER 0x30, KEYBOARD 0x40, BEAT
 * LOOP 0x60 are all confirmed) — the monitor verifies it on hardware. */
export const PAD_FX_NOTE_BASE = 0x10

/** Pad-mode selector buttons (HOT CUE 0x1B, PAD FX1 0x1E, BEAT JUMP
 * 0x20, SAMPLER 0x22, KEYBOARD 0x69, PAD FX2 0x6B, BEAT LOOP 0x6D,
 * KEY SHIFT 0x6F). Switching modes clears the device's pad LEDs, so
 * these are the cue to repaint them. */
const PAD_MODE_NOTES = new Set([0x1b, 0x1e, 0x20, 0x22, 0x69, 0x6b, 0x6d, 0x6f])

export function isPadModeSwitch(data: ArrayLike<number>): boolean {
  if (data.length < 3) return false
  const [status, note, velocity] = [data[0], data[1], data[2]]
  return Boolean(NOTE_ON_DECK[status]) && PAD_MODE_NOTES.has(note) && velocity > 0
}

const CC_DECK: Partial<Record<number, DeckId>> = { 0xb0: 'a', 0xb1: 'b' }
const MIXER_STATUS = 0xb6
const LSB_OFFSET = 0x20
const MAX_14BIT = (127 << 7) | 127

/** Builders keyed by MSB CC number, per status byte. The LSB lives on
 * CC+0x20 and is resolved back to these entries. Resolved per message,
 * so the SMART CFX rows can read the live shift state (M12): bare knob
 * rides the Color FX amount, SHIFT + knob sweeps the style cursor. */
function ccBuilder(
  status: number,
  cc: number,
  shift: Record<DeckId, boolean>,
): ((value: number) => ControlIntent) | null {
  const deck = CC_DECK[status]
  if (deck) {
    switch (cc) {
      case 0x13:
        return (value) => ({ kind: 'volume', deck, value })
      case 0x07:
        return (value) => ({ kind: 'eq', deck, band: 'high', value })
      case 0x0b:
        return (value) => ({ kind: 'eq', deck, band: 'mid', value })
      case 0x0f:
        return (value) => ({ kind: 'eq', deck, band: 'low', value })
    }
    return null
  }
  if (status === MIXER_STATUS) {
    switch (cc) {
      case 0x1f:
        return (value) => ({ kind: 'crossfade', value })
      case 0x17:
        return shift.a
          ? (value) => ({ kind: 'style_sweep', deck: 'a', value })
          : (value) => ({ kind: 'fx_amount', deck: 'a', value })
      case 0x18:
        return shift.b
          ? (value) => ({ kind: 'style_sweep', deck: 'b', value })
          : (value) => ({ kind: 'fx_amount', deck: 'b', value })
      case 0x0c:
        return (value) => ({ kind: 'cue_mix', value })
    }
  }
  return null
}

function buttonIntent(status: number, note: number): ControlIntent | null {
  const playDeck = NOTE_ON_DECK[status]
  if (playDeck && note === PLAY_NOTE) return { kind: 'play_toggle', deck: playDeck }
  if (playDeck && note === CHANNEL_CUE_NOTE) {
    return { kind: 'cue_toggle', deck: playDeck }
  }
  if (playDeck && note === TRANSPORT_CUE_NOTE) {
    return { kind: 'deck_prep', deck: playDeck }
  }
  const padDeck = PAD_DECK[status]
  if (padDeck && note < PAD_COUNT) {
    return { kind: 'style_target', deck: padDeck, index: note }
  }
  if (
    padDeck &&
    note >= PAD_FX_NOTE_BASE &&
    note < PAD_FX_NOTE_BASE + PAD_COUNT
  ) {
    return { kind: 'fx_select', deck: padDeck, index: note - PAD_FX_NOTE_BASE }
  }
  if (BEAT_FX_STATUSES.includes(status) && note === RECORD_NOTE) {
    return { kind: 'record_toggle' }
  }
  return null
}

export type Flx4Translator = (data: ArrayLike<number>) => ControlIntent | null

export function createFlx4Translator(): Flx4Translator {
  const msbByControl = new Map<number, number>()
  const shiftHeld: Record<DeckId, boolean> = { a: false, b: false }
  return (data) => {
    if (data.length < 3) return null
    const [status, number, value] = [data[0], data[1], data[2]]

    // SHIFT held-state, tracked from press AND release — so this must
    // run before the velocity-0 drop below.
    const shiftDeck = NOTE_ON_DECK[status]
    if (shiftDeck && number === SHIFT_NOTE) {
      shiftHeld[shiftDeck] = value > 0
      return null
    }

    const msbBuild = ccBuilder(status, number, shiftHeld)
    if (msbBuild) {
      msbByControl.set((status << 8) | number, value)
      return msbBuild((value << 7) / MAX_14BIT)
    }
    const lsbBuild = ccBuilder(status, number - LSB_OFFSET, shiftHeld)
    if (lsbBuild) {
      const msb = msbByControl.get((status << 8) | (number - LSB_OFFSET))
      // An LSB with no MSB seen yet would jump the control to near zero;
      // the FLX4 always sends the pair MSB-first, so just wait for it.
      if (msb === undefined) return null
      return lsbBuild(((msb << 7) | value) / MAX_14BIT)
    }

    // Buttons are Note On: velocity 0x7F on press, 0x00 on release.
    if (value === 0) return null
    return buttonIntent(status, number)
  }
}
