import { describe, expect, it } from 'vitest'

import {
  buildNoteMultihot,
  CHORD_FOLLOW_STATE,
  drumWireFlag,
  NOTE_OFF,
  NOTE_ONSET,
  NOTE_SLOTS,
  NOTE_SUSTAIN,
  sameNoteSteering,
} from './notes'

describe('buildNoteMultihot', () => {
  it('maps a held chord to the chord-follow state with the rest off', () => {
    const multihot = buildNoteMultihot([60, 64, 67], 'chord')
    expect(multihot).toHaveLength(NOTE_SLOTS)
    expect(multihot![60]).toBe(CHORD_FOLLOW_STATE)
    expect(multihot![64]).toBe(CHORD_FOLLOW_STATE)
    expect(multihot![67]).toBe(CHORD_FOLLOW_STATE)
    // Non-held pitches are OFF so the chord constrains the harmony.
    const others = multihot!.filter((_, pitch) => ![60, 64, 67].includes(pitch))
    expect(others.every((state) => state === NOTE_OFF)).toBe(true)
  })

  it('returns null for an empty hold — masked, never all-zeros', () => {
    expect(buildNoteMultihot([], 'chord')).toBeNull()
    expect(buildNoteMultihot([], 'onset')).toBeNull()
  })

  it('marks fresh presses as onsets and continued holds as sustain', () => {
    const multihot = buildNoteMultihot([60, 64], 'onset', [60])
    expect(multihot![60]).toBe(NOTE_SUSTAIN)
    expect(multihot![64]).toBe(NOTE_ONSET)
  })

  it('treats every pitch as fresh when nothing was held before', () => {
    const multihot = buildNoteMultihot([60], 'onset')
    expect(multihot![60]).toBe(NOTE_ONSET)
  })

  it('skips out-of-range and non-integer pitches', () => {
    const multihot = buildNoteMultihot([60, -1, 128, 60.5], 'chord')
    expect(multihot![60]).toBe(CHORD_FOLLOW_STATE)
    expect(multihot!.filter((state) => state !== NOTE_OFF)).toHaveLength(1)
  })
})

describe('drumWireFlag', () => {
  it('maps the tri-state to the wire flag', () => {
    expect(drumWireFlag(null)).toBeNull()
    expect(drumWireFlag(false)).toBe(0)
    expect(drumWireFlag(true)).toBe(1)
  })
})

describe('sameNoteSteering', () => {
  it('compares pitches and mode, null against null', () => {
    expect(sameNoteSteering(null, null)).toBe(true)
    expect(sameNoteSteering(null, { pitches: [60], mode: 'chord' })).toBe(false)
    expect(
      sameNoteSteering(
        { pitches: [60, 64], mode: 'chord' },
        { pitches: [60, 64], mode: 'chord' },
      ),
    ).toBe(true)
    expect(
      sameNoteSteering(
        { pitches: [60, 64], mode: 'chord' },
        { pitches: [60, 64], mode: 'onset' },
      ),
    ).toBe(false)
    expect(
      sameNoteSteering(
        { pitches: [60], mode: 'chord' },
        { pitches: [60, 64], mode: 'chord' },
      ),
    ).toBe(false)
  })
})
