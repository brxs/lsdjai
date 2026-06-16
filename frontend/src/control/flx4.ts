/** DDJ-FLX4 → ControlIntent translation (docs/midi-ddj-flx4.md, ADR-0005).
 *
 * The translator is a pure function of the message stream apart from one
 * piece of state: faders and knobs arrive as 14-bit pairs (MSB on the listed
 * CC, LSB on CC+0x20), so the last MSB per control is cached and combined
 * with the LSB that follows. Each physical move therefore emits two intents
 * on the bus — a coarse one on the MSB, refined when the LSB lands —
 * inaudible at 14-bit resolution but visible to subscribers. Everything not
 * in the map — shift layers, jog wheels, releases — translates to null. */

import type { DeckId } from '../audio/types'
import { LOOP_SLOT_COUNT } from '../audio/loops'
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
/** Held SHIFT moves the pads onto their own status bytes (the shift
 * pad layer from the Mixxx mapping) — pads are NOT soft-shifted like
 * the CFX knob, so the clear chord listens on this layer too. */
const SHIFT_PAD_DECK: Partial<Record<number, DeckId>> = { 0x98: 'a', 0x9a: 'b' }
const BEAT_FX_STATUSES = [0x94, 0x95]
const PLAY_NOTE = 0x0b
const RECORD_NOTE = 0x47
/** The LOOP section, measured on the device (the monitor is the arbiter
 * — the tempo slider taught us charts lie). IN / OUT arm and close a
 * manual loop (M21). The button the panel labels "4 BEAT/EXIT" sends
 * note 0x4D — the very byte the M21 chart had read as RELOOP/EXIT — so
 * it becomes the M23 beat-loop toggle (set when idle, exit when a loop
 * runs; the toggle lives in dispatch, ADR-0016), which still releases a
 * running loop exactly as before. CUE/LOOP CALL ◄ / ► (0x51/0x53) halve
 * and double the active loop. All four confirmed on the monitor. */
const LOOP_IN_NOTE = 0x10
const LOOP_OUT_NOTE = 0x11
const BEAT_LOOP_NOTE = 0x4d
const LOOP_HALVE_NOTE = 0x51
const LOOP_DOUBLE_NOTE = 0x53
const BEAT_LOOP_BEATS = 4
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
/** SAMPLER bank: the freeze-pad loop slots (M13, ADR-0009). SHIFT +
 * pad clears a slot — tracked in software like the CFX handover; if
 * the firmware sends distinct bytes for shifted SAMPLER pads instead,
 * the monitor will show them and this table gains rows. */
export const LOOP_NOTE_BASE = 0x30

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
/** Jog wheel turn CCs, relative around 0x40 — the Pioneer scheme per
 * the Mixxx FLX4 chart: 0x21 side, 0x22 platter (vinyl on), 0x23
 * platter (vinyl off). */
const JOG_CCS = [0x21, 0x22, 0x23]
/** SHIFT + jog arrives on its OWN CC (jogSearch in the Mixxx FLX4
 * chart), not as a soft-shifted 0x21/0x22 — the same firmware habit as
 * the SHIFT pad layer. The shiftHeld assumption shipped first and read
 * as "scrubbing does nothing" on the device. */
const JOG_SCRUB_CC = 0x29
const LSB_OFFSET = 0x20
const MAX_14BIT = (127 << 7) | 127
/** Browse rotary (M16): a RELATIVE encoder on the mixer status — small
 * values are clockwise clicks, values above 0x40 are two's-complement
 * counter-clockwise. Handled before the 14-bit CC pipeline, which
 * would otherwise mangle relative ticks into absolute positions. */
const BROWSE_CC = 0x40
/** LOAD buttons (M16): their own status byte, one note per deck. */
const LOAD_STATUS = 0x96
const LOAD_NOTE_DECK: Partial<Record<number, DeckId>> = { 0x46: 'a', 0x47: 'b' }
/** Rotary press (M19): interpolated from the DDJ-400 family chart —
 * the Mixxx FLX4 map defines no press control. Confirm with the
 * monitor (docs/midi-ddj-flx4.md). */
const BROWSE_PRESS_NOTE = 0x41

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
      // Tempo slider (M20): mapped at last — varispeed is a playback
      // parameter, not generation tempo (ADR-0014 vs ADR-0004).
      case 0x00:
        return (value) => ({ kind: 'track_rate', deck, value })
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

function buttonIntent(
  status: number,
  note: number,
  shift: Record<DeckId, boolean>,
): ControlIntent | null {
  const playDeck = NOTE_ON_DECK[status]
  if (playDeck && note === PLAY_NOTE) return { kind: 'play_toggle', deck: playDeck }
  if (playDeck && note === CHANNEL_CUE_NOTE) {
    return { kind: 'cue_toggle', deck: playDeck }
  }
  if (playDeck && note === TRANSPORT_CUE_NOTE) {
    return { kind: 'deck_prep', deck: playDeck }
  }
  if (playDeck && note === LOOP_IN_NOTE) {
    return { kind: 'track_loop_in', deck: playDeck }
  }
  if (playDeck && note === LOOP_OUT_NOTE) {
    return { kind: 'track_loop_out', deck: playDeck }
  }
  if (playDeck && note === BEAT_LOOP_NOTE) {
    // The "4 BEAT/EXIT" button (0x4D): one press sets a 4-beat loop or
    // exits a running one — the toggle lives in dispatch (M23, ADR-0016),
    // so this single byte both arms and releases (the M21 exit, kept).
    return { kind: 'track_beat_loop', deck: playDeck, beats: BEAT_LOOP_BEATS }
  }
  if (playDeck && note === LOOP_HALVE_NOTE) {
    return { kind: 'track_loop_halve', deck: playDeck }
  }
  if (playDeck && note === LOOP_DOUBLE_NOTE) {
    return { kind: 'track_loop_double', deck: playDeck }
  }
  const padDeck = PAD_DECK[status]
  if (padDeck && note < PAD_COUNT) {
    return { kind: 'hot_cue_pad', deck: padDeck, index: note }
  }
  if (
    padDeck &&
    note >= PAD_FX_NOTE_BASE &&
    note < PAD_FX_NOTE_BASE + PAD_COUNT
  ) {
    return { kind: 'fx_select', deck: padDeck, index: note - PAD_FX_NOTE_BASE }
  }
  if (
    padDeck &&
    note >= LOOP_NOTE_BASE &&
    note < LOOP_NOTE_BASE + LOOP_SLOT_COUNT
  ) {
    const index = note - LOOP_NOTE_BASE
    return shift[padDeck]
      ? { kind: 'loop_clear', deck: padDeck, index }
      : { kind: 'loop_pad', deck: padDeck, index }
  }
  // SHIFT + SAMPLER pad arrives on the shift pad layer, not as a
  // shifted note on the plain layer (the soft-shift branch above stays
  // for firmware that does keep the pads put). SHIFT + HOT CUE pad
  // (M21) rides the same layer to clear a cue. Other shift-layer
  // banks remain deliberately unmapped.
  const shiftPadDeck = SHIFT_PAD_DECK[status]
  if (shiftPadDeck && note < PAD_COUNT) {
    return { kind: 'hot_cue_clear', deck: shiftPadDeck, index: note }
  }
  if (
    shiftPadDeck &&
    note >= LOOP_NOTE_BASE &&
    note < LOOP_NOTE_BASE + LOOP_SLOT_COUNT
  ) {
    return { kind: 'loop_clear', deck: shiftPadDeck, index: note - LOOP_NOTE_BASE }
  }
  if (BEAT_FX_STATUSES.includes(status) && note === RECORD_NOTE) {
    return { kind: 'record_toggle' }
  }
  const loadDeck = LOAD_NOTE_DECK[note]
  if (status === LOAD_STATUS && loadDeck) {
    return { kind: 'browse_load', deck: loadDeck }
  }
  if (status === LOAD_STATUS && note === BROWSE_PRESS_NOTE) {
    return { kind: 'browse_tab' }
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

    // The browse rotary is relative — its CC must not enter the
    // absolute MSB/LSB machinery below. The magnitude is real: a fast
    // turn packs several clicks into one message (0x02 = two CW,
    // 0x7E = two CCW in two's complement).
    if (status === MIXER_STATUS && number === BROWSE_CC) {
      if (value === 0 || value === 0x40) return null
      return {
        kind: 'browse_scroll',
        steps: value < 0x40 ? value : value - 0x80,
      }
    }

    // Jog wheels are relative too, 0x40-centred (0x41 = +1 tick CW,
    // 0x3F = −1): intercepted before the absolute MSB/LSB machinery.
    // Only a playback deck acts on them (App-side); the live stream
    // still has no scratch concept (ADR-0004).
    const jogDeck = CC_DECK[status]
    if (jogDeck && (JOG_CCS.includes(number) || number === JOG_SCRUB_CC)) {
      if (value === 0x40) return null
      return {
        kind: 'track_seek',
        deck: jogDeck,
        steps: value - 0x40,
        // SHIFT+jog scrubs even mid-play (the CDJ search convention).
        // The firmware moves it to JOG_SCRUB_CC; shiftHeld stays as a
        // fallback for plain-CC firmware.
        shifted: number === JOG_SCRUB_CC || shiftHeld[jogDeck],
      }
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
    return buttonIntent(status, number, shiftHeld)
  }
}
