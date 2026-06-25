/** The controller-driver contract (issue #30, extends ADR-0005). One driver
 * per supported controller is the whole device-specific surface: a name
 * fragment to bind on, a byte→ControlIntent translator (the flx4.ts pattern),
 * an optional init/position-sync SysEx, and a semantic LED scheme. The
 * registry (registry.ts) picks one by matched device name; midi.ts/useMidi.ts
 * drive it, and the ControlBus, audio engine, decks, and intent vocabulary are
 * untouched. Adding a controller is a new driver file + one registry line. */

import type { DeckId } from '../audio/types'
import type { ControlIntent } from './bus'

export type ControllerTranslator = (
  data: ArrayLike<number>,
) => ControlIntent | null

/** The LED feedback a driver supports, expressed semantically: the app asks
 * for "light pad N" or "channel cue on", the driver returns the raw MIDI
 * messages to send so useMidi/the link stay byte-agnostic forwarders. The
 * Pioneer echo (status/note back, velocity 0x7F on / 0x00 off) is one scheme;
 * another controller's may differ. Each op returns the messages for the full
 * group it owns so a single call repaints it (e.g. all eight pads). */
export type ControllerLeds = {
  /** Light pads 1..count for a deck's style targets, the rest dark. When a
   * selection mask is given (the net, one bool per pad), selected pads burn
   * bright and the rest sit dim; omitted, every target pad is lit full. */
  styleTargetPads: (
    deck: DeckId,
    count: number,
    selected?: boolean[],
  ) => number[][]
  /** Light only the active effect's pad in the PAD FX bank (null = all dark). */
  fxPads: (deck: DeckId, activeIndex: number | null) => number[][]
  /** Light the filled loop slots in the SAMPLER bank. */
  loopPads: (deck: DeckId, filled: boolean[]) => number[][]
  /** Light the filled hot cues in the HOT CUE bank. */
  cuePads: (deck: DeckId, filled: boolean[]) => number[][]
  /** Channel (headphone) CUE button LED for a deck. */
  channelCue: (deck: DeckId, on: boolean) => number[][]
  /** Transport CUE button LED for a deck (lit while primed off air). */
  transportCue: (deck: DeckId, on: boolean) => number[][]
}

export type ControllerDriver = {
  /** Stable identifier, e.g. 'flx4' | 'ddj400'. */
  id: string
  /** Human label for diagnostics; the picker shows the raw MIDI port name. */
  label: string
  /** Matched against MIDIPort.name to bind the device. */
  nameFragment: string
  /** Position-sync / keep-alive SysEx, sent on every bind when SysEx is
   * granted (knobs are silent until moved, so this syncs a fresh
   * connection). Omitted when the controller has none. */
  initSysex?: number[]
  /** Builds a translator for this driver; useMidi keeps one per active driver
   * (translators carry per-device state — the 14-bit MSB cache, shift
   * held-state) and rebuilds only when the bound controller changes. */
  createTranslator: () => ControllerTranslator
  /** True when a message is a pad-mode switch — the cue to repaint pad LEDs,
   * which the device clears on a mode change. */
  isPadModeSwitch: (data: ArrayLike<number>) => boolean
  leds: ControllerLeds
}
