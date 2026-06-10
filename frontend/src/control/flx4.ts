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

const NOTE_ON_DECK: Partial<Record<number, DeckId>> = { 0x90: 'a', 0x91: 'b' }
/** Pad bank status bytes, shared with the LED echo (same status out). */
export const PAD_STATUS_BY_DECK: Record<DeckId, number> = { a: 0x97, b: 0x99 }
const PAD_DECK: Partial<Record<number, DeckId>> = {
  [PAD_STATUS_BY_DECK.a]: 'a',
  [PAD_STATUS_BY_DECK.b]: 'b',
}
const BEAT_FX_STATUSES = [0x94, 0x95]
const PLAY_NOTE = 0x0b
const RECORD_NOTE = 0x47
export const PAD_COUNT = 8

const CC_DECK: Partial<Record<number, DeckId>> = { 0xb0: 'a', 0xb1: 'b' }
const MIXER_STATUS = 0xb6
const LSB_OFFSET = 0x20
const MAX_14BIT = (127 << 7) | 127

/** Builders keyed by MSB CC number, per status byte. The LSB lives on
 * CC+0x20 and is resolved back to these entries. */
function ccBuilder(
  status: number,
  cc: number,
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
        return (value) => ({ kind: 'style_sweep', deck: 'a', value })
      case 0x18:
        return (value) => ({ kind: 'style_sweep', deck: 'b', value })
    }
  }
  return null
}

function buttonIntent(status: number, note: number): ControlIntent | null {
  const playDeck = NOTE_ON_DECK[status]
  if (playDeck && note === PLAY_NOTE) return { kind: 'play_toggle', deck: playDeck }
  const padDeck = PAD_DECK[status]
  if (padDeck && note < PAD_COUNT) {
    return { kind: 'style_target', deck: padDeck, index: note }
  }
  if (BEAT_FX_STATUSES.includes(status) && note === RECORD_NOTE) {
    return { kind: 'record_toggle' }
  }
  return null
}

export type Flx4Translator = (data: ArrayLike<number>) => ControlIntent | null

export function createFlx4Translator(): Flx4Translator {
  const msbByControl = new Map<number, number>()
  return (data) => {
    if (data.length < 3) return null
    const [status, number, value] = [data[0], data[1], data[2]]

    const msbBuild = ccBuilder(status, number)
    if (msbBuild) {
      msbByControl.set((status << 8) | number, value)
      return msbBuild((value << 7) / MAX_14BIT)
    }
    const lsbBuild = ccBuilder(status, number - LSB_OFFSET)
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
