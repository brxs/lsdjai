import { describe, expect, it } from 'vitest'

import { createFlx4Translator, isPadModeSwitch } from './flx4'

const PRESS = 0x7f
const RELEASE = 0x00

describe('createFlx4Translator', () => {
  describe('buttons', () => {
    it.each([
      [0x90, 'a'],
      [0x91, 'b'],
    ] as const)('PLAY/PAUSE press on %s toggles deck %s', (status, deck) => {
      const translate = createFlx4Translator()
      expect(translate([status, 0x0b, PRESS])).toEqual({
        kind: 'play_toggle',
        deck,
      })
    })

    it('ignores button releases (velocity 0)', () => {
      const translate = createFlx4Translator()
      expect(translate([0x90, 0x0b, RELEASE])).toBeNull()
      expect(translate([0x97, 0x03, RELEASE])).toBeNull()
      expect(translate([0x94, 0x47, RELEASE])).toBeNull()
    })

    it.each([
      [0x97, 'a'],
      [0x99, 'b'],
    ] as const)('HOT CUE pads on %s target deck %s styles', (status, deck) => {
      const translate = createFlx4Translator()
      for (let pad = 0; pad < 8; pad++) {
        expect(translate([status, pad, PRESS])).toEqual({
          kind: 'style_target',
          deck,
          index: pad,
        })
      }
    })

    it('ignores pad notes outside the mapped banks', () => {
      const translate = createFlx4Translator()
      expect(translate([0x97, 0x08, PRESS])).toBeNull()
      expect(translate([0x99, 0x20, PRESS])).toBeNull() // BEAT JUMP bank
      expect(translate([0x99, 0x18, PRESS])).toBeNull() // past PAD FX
    })

    it.each([
      [0x97, 'a'],
      [0x99, 'b'],
    ] as const)('PAD FX pads on %s select deck %s effects', (status, deck) => {
      const translate = createFlx4Translator()
      for (let pad = 0; pad < 8; pad++) {
        expect(translate([status, 0x10 + pad, PRESS])).toEqual({
          kind: 'fx_select',
          deck,
          index: pad,
        })
      }
      expect(translate([status, 0x10, RELEASE])).toBeNull()
    })

    it('ignores the shift pad layer', () => {
      const translate = createFlx4Translator()
      expect(translate([0x98, 0x00, PRESS])).toBeNull()
      expect(translate([0x9a, 0x00, PRESS])).toBeNull()
    })

    it.each([[0x94], [0x95]])(
      'BEAT FX ON/OFF press on %s toggles recording',
      (status) => {
        const translate = createFlx4Translator()
        expect(translate([status, 0x47, PRESS])).toEqual({
          kind: 'record_toggle',
        })
      },
    )

    it.each([
      [0x90, 'a'],
      [0x91, 'b'],
    ] as const)('channel CUE press on %s toggles deck %s headphone cue', (status, deck) => {
      const translate = createFlx4Translator()
      expect(translate([status, 0x54, PRESS])).toEqual({
        kind: 'cue_toggle',
        deck,
      })
      expect(translate([status, 0x54, RELEASE])).toBeNull()
    })

    it.each([
      [0x90, 'a'],
      [0x91, 'b'],
    ] as const)('transport CUE press on %s preps deck %s', (status, deck) => {
      const translate = createFlx4Translator()
      expect(translate([status, 0x0c, PRESS])).toEqual({
        kind: 'deck_prep',
        deck,
      })
    })
  })

  describe('14-bit faders and knobs', () => {
    it.each([
      [0xb0, 'a'],
      [0xb1, 'b'],
    ] as const)('channel fader on %s drives deck %s volume', (status, deck) => {
      const translate = createFlx4Translator()
      expect(translate([status, 0x13, 0x7f])).toEqual({
        kind: 'volume',
        deck,
        value: (0x7f << 7) / 16383,
      })
      expect(translate([status, 0x33, 0x7f])).toEqual({
        kind: 'volume',
        deck,
        value: 1,
      })
    })

    it.each([
      [0x07, 0x27, 'high'],
      [0x0b, 0x2b, 'mid'],
      [0x0f, 0x2f, 'low'],
    ] as const)('EQ CC 0x%s/0x%s drives the %s band on both decks', (msb, lsb, band) => {
      for (const [status, deck] of [
        [0xb0, 'a'],
        [0xb1, 'b'],
      ] as const) {
        const translate = createFlx4Translator()
        expect(translate([status, msb, 0x40])).toEqual({
          kind: 'eq',
          deck,
          band,
          value: (0x40 << 7) / 16383,
        })
        expect(translate([status, lsb, 0x00])).toEqual({
          kind: 'eq',
          deck,
          band,
          value: 0x2000 / 16383,
        })
      }
    })

    it('maps the crossfader to a master crossfade intent', () => {
      const translate = createFlx4Translator()
      expect(translate([0xb6, 0x1f, 0x00])).toEqual({
        kind: 'crossfade',
        value: 0,
      })
      expect(translate([0xb6, 0x3f, 0x00])).toEqual({
        kind: 'crossfade',
        value: 0,
      })
    })

    // Remapped in M12: the bare knob is the Color FX amount (its
    // hardware purpose); the style sweep moved to SHIFT + knob.
    it.each([
      [0x17, 0x37, 'a'],
      [0x18, 0x38, 'b'],
    ] as const)('SMART CFX CC 0x%s rides deck %s Color FX', (msb, lsb, deck) => {
      const translate = createFlx4Translator()
      expect(translate([0xb6, msb, 0x20])).toEqual({
        kind: 'fx_amount',
        deck,
        value: (0x20 << 7) / 16383,
      })
      expect(translate([0xb6, lsb, 0x55])).toEqual({
        kind: 'fx_amount',
        deck,
        value: ((0x20 << 7) | 0x55) / 16383,
      })
    })

    it.each([
      [0x90, 0x17, 'a'],
      [0x91, 0x18, 'b'],
    ] as const)(
      'SHIFT (%s) + SMART CFX sweeps deck %s styles, release restores FX',
      (shiftStatus, cc, deck) => {
        const translate = createFlx4Translator()
        translate([shiftStatus, 0x3f, 0x7f]) // SHIFT down
        expect(translate([0xb6, cc, 0x20])).toEqual({
          kind: 'style_sweep',
          deck,
          value: (0x20 << 7) / 16383,
        })
        translate([shiftStatus, 0x3f, 0x00]) // SHIFT up
        expect(translate([0xb6, cc, 0x20])).toEqual({
          kind: 'fx_amount',
          deck,
          value: (0x20 << 7) / 16383,
        })
      },
    )

    it('pairs each SHIFT with its own deck only', () => {
      const translate = createFlx4Translator()
      translate([0x90, 0x3f, 0x7f]) // left SHIFT down
      expect(translate([0xb6, 0x18, 0x20])).toMatchObject({
        kind: 'fx_amount',
        deck: 'b',
      })
      expect(translate([0xb6, 0x17, 0x20])).toMatchObject({
        kind: 'style_sweep',
        deck: 'a',
      })
    })

    it('maps the HEADPHONES MIX knob to the cue blend', () => {
      const translate = createFlx4Translator()
      expect(translate([0xb6, 0x0c, 0x40])).toEqual({
        kind: 'cue_mix',
        value: (0x40 << 7) / 16383,
      })
      expect(translate([0xb6, 0x2c, 0x10])).toEqual({
        kind: 'cue_mix',
        value: ((0x40 << 7) | 0x10) / 16383,
      })
    })

    it('combines MSB and LSB into the full-resolution value', () => {
      const translate = createFlx4Translator()
      translate([0xb6, 0x1f, 0x7f])
      expect(translate([0xb6, 0x3f, 0x7f])).toEqual({
        kind: 'crossfade',
        value: 1,
      })
    })

    it('ignores an LSB arriving before any MSB for that control', () => {
      const translate = createFlx4Translator()
      expect(translate([0xb0, 0x33, 0x10])).toBeNull()
    })

    it('caches the MSB per control, not globally', () => {
      const translate = createFlx4Translator()
      translate([0xb0, 0x13, 0x7f]) // deck a volume MSB
      // Deck b volume LSB has no MSB of its own yet.
      expect(translate([0xb1, 0x33, 0x10])).toBeNull()
      // EQ high LSB on deck a likewise.
      expect(translate([0xb0, 0x27, 0x10])).toBeNull()
    })

    it('a fresh MSB replaces the cached one for later LSBs', () => {
      const translate = createFlx4Translator()
      translate([0xb0, 0x13, 0x7f])
      translate([0xb0, 0x33, 0x7f])
      translate([0xb0, 0x13, 0x00])
      expect(translate([0xb0, 0x33, 0x01])).toEqual({
        kind: 'volume',
        deck: 'a',
        value: 1 / 16383,
      })
    })
  })

  describe('pad-mode switches', () => {
    it('recognises mode-button presses on either deck', () => {
      expect(isPadModeSwitch([0x90, 0x1b, PRESS])).toBe(true) // HOT CUE
      expect(isPadModeSwitch([0x91, 0x1e, PRESS])).toBe(true) // PAD FX1
      expect(isPadModeSwitch([0x90, 0x6b, PRESS])).toBe(true) // PAD FX2
      expect(isPadModeSwitch([0x90, 0x1b, RELEASE])).toBe(false)
      expect(isPadModeSwitch([0x90, 0x0b, PRESS])).toBe(false) // PLAY
      expect(isPadModeSwitch([0x97, 0x1b, PRESS])).toBe(false) // pad channel
      expect(isPadModeSwitch([0x90, 0x1b])).toBe(false)
    })

    it('mode buttons emit no intent of their own', () => {
      const translate = createFlx4Translator()
      expect(translate([0x90, 0x1b, PRESS])).toBeNull()
      expect(translate([0x91, 0x1e, PRESS])).toBeNull()
    })
  })

  describe('unmapped traffic', () => {
    // CUE (0x90 note 0x0C) left this list in M10: it now preps a deck.
    // SHIFT (note 0x3F) is consumed as a modifier since M12 but still
    // emits no intent of its own.
    it('ignores controls the map deliberately leaves out', () => {
      const translate = createFlx4Translator()
      expect(translate([0xb0, 0x00, 0x40])).toBeNull() // tempo slider
      expect(translate([0xb0, 0x21, 0x40])).toBeNull() // jog wheel
      expect(translate([0x90, 0x3f, PRESS])).toBeNull() // SHIFT (modifier)
      expect(translate([0xf8, 0x00, 0x00])).toBeNull() // clock-ish noise
    })

    it('ignores truncated messages', () => {
      const translate = createFlx4Translator()
      expect(translate([0xb0, 0x13])).toBeNull()
      expect(translate([])).toBeNull()
    })
  })
})
