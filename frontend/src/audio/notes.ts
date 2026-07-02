/** Note/drum conditioning for the realtime decks (ADR-0023).
 *
 * The UI→multihot mapping lives here, engine-side of every steering surface:
 * a surface (MCP tool, future pads/keyboard) holds pitches + a mode, and this
 * module turns them into the wire multihot `deck_set_notes` carries — one int
 * per MIDI pitch. Messages are idempotent full state, never deltas, so a
 * dropped or reordered send cannot desync held notes. */

export const NOTE_SLOTS = 128

/** The wire states one note slot can hold (docs/spike-mrt2.md). */
export const NOTE_OFF = 0
export const NOTE_SUSTAIN = 1
export const NOTE_ONSET = 2
export const NOTE_MODEL_DECIDES = 3

/** How a steering surface authors notes: `chord` (the forgiving default)
 * hands articulation to the model; `onset` marks fresh presses as attacks so
 * the performer owns the timing. */
export type NoteMode = 'chord' | 'onset'

/** A deck's authored steering state (held pitches + mode) — the shape the
 * store mirrors (`DeckSnap.notes`), null when unsteered. */
export type NoteSteering = { pitches: number[]; mode: NoteMode }

/** Chord-follow's wire state for a held pitch. ADR-0023 wants the model to
 * pick the attacks for held chords, which is the model-decides state (3) —
 * pure sustain (1) would ask it to continue notes it never attacked. One
 * constant on purpose: the by-ear checklist item confirms (or flips) it. */
export const CHORD_FOLLOW_STATE = NOTE_MODEL_DECIDES

/** Whether a pitch can occupy a multihot slot. Surfaces filter their hold with
 * this BEFORE authoring state (ref / wire / store mirror): an invalid pitch
 * that merely skipped in the builder would leave a non-empty hold whose
 * multihot is all-OFF (suppress melody) while the Rust mirror guard drops the
 * write — three holders, three different stories. */
export function isNotePitch(pitch: number): boolean {
  return Number.isInteger(pitch) && pitch >= 0 && pitch < NOTE_SLOTS
}

/** Build the full wire multihot from held pitches, or null for an empty hold.
 *
 * Null means fully masked — the model plays freely — which is the resting
 * state; an all-zero multihot would instead steer every pitch OFF (suppress
 * melody), a deliberate state no empty hold should imply. Non-held pitches
 * are OFF so the held chord actually constrains the harmony. In onset mode a
 * pitch also in `previousPitches` is a continued hold (sustain), a fresh one
 * an attack. Out-of-range or non-integer pitches are skipped as a last line —
 * surfaces filter with `isNotePitch` first, and the trust boundaries upstream
 * (Rust command, MCP tool) reject them. */
export function buildNoteMultihot(
  pitches: number[],
  mode: NoteMode,
  previousPitches: number[] = [],
): number[] | null {
  if (pitches.length === 0) return null
  const multihot = new Array<number>(NOTE_SLOTS).fill(NOTE_OFF)
  const held = new Set(previousPitches)
  for (const pitch of pitches) {
    if (!isNotePitch(pitch)) continue
    multihot[pitch] =
      mode === 'chord'
        ? CHORD_FOLLOW_STATE
        : held.has(pitch)
          ? NOTE_SUSTAIN
          : NOTE_ONSET
  }
  return multihot
}

/** The wire flag for the drum tri-state: null = masked (model decides),
 * false = suppress (0), true = force (1). */
export function drumWireFlag(drums: boolean | null): number | null {
  return drums === null ? null : drums ? 1 : 0
}

/** Whether two authored steering states are the same — the projection's
 * "did the store change under us?" compare (pitch order counts: a reorder
 * re-sends the same idempotent state, which is harmless). */
export function sameNoteSteering(
  a: NoteSteering | null,
  b: NoteSteering | null,
): boolean {
  if (a === null || b === null) return a === b
  return (
    a.mode === b.mode &&
    a.pitches.length === b.pitches.length &&
    a.pitches.every((pitch, index) => pitch === b.pitches[index])
  )
}
