/** Crates (M16): named style presets — a deck's pad arrangement,
 * cursor, and Color FX selection, saved for recall mid-set. Pure
 * model + validation + the export/import wire format; storage lives
 * in persistence.ts, UI in crates/.
 *
 * Sampled targets (M15) are deliberately absent: their embeddings are
 * session-only (ADR-0011), so a preset holds only text targets —
 * loading re-embeds prompts exactly like typing them. */

import { FX_KINDS, type FxKind } from './audio/fx'
import type { PadPoint } from './deck/padWeights'

export type PresetTarget = PadPoint & { text: string }

export type StylePreset = {
  name: string
  targets: PresetTarget[]
  cursor: PadPoint
  fx: { kind: FxKind | null; amount: number }
}

export const MAX_PRESET_NAME_LENGTH = 48
/** Matches the backend's MAX_STYLE_PROMPTS — a pad (and therefore a
 * preset) holds at most this many targets. The single source for the
 * pad's own cap too (DeckColumn imports it). */
export const MAX_PRESET_TARGETS = 8

/** The export file format; versioned so a future shape can migrate. */
const EXPORT_VERSION = 1

export function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

export function isPoint(value: unknown): value is PadPoint {
  const point = value as PadPoint
  return (
    typeof point === 'object' &&
    point !== null &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y)
  )
}

/** Tolerant reader: anything malformed comes back null (the
 * persistence convention — bad data loads as absent, never throws). */
export function parsePreset(value: unknown): StylePreset | null {
  const raw = value as StylePreset
  if (typeof raw !== 'object' || raw === null) return null
  if (typeof raw.name !== 'string') return null
  const name = raw.name.trim().slice(0, MAX_PRESET_NAME_LENGTH)
  if (!name) return null
  if (
    !Array.isArray(raw.targets) ||
    raw.targets.length === 0 ||
    raw.targets.length > MAX_PRESET_TARGETS ||
    !raw.targets.every(
      (target) => isPoint(target) && typeof target.text === 'string' && target.text,
    )
  ) {
    return null
  }
  // Import is a trust boundary: the pad keys targets by text, and the
  // backend rejects styles over the prompt cap — a file must not be
  // able to put the deck in a state the UI itself cannot reach.
  const texts = raw.targets.map((target) => target.text.trim())
  if (texts.some((text) => !text) || new Set(texts).size !== texts.length) {
    return null
  }
  if (!isPoint(raw.cursor)) return null
  const fx = raw.fx as StylePreset['fx']
  if (
    typeof fx !== 'object' ||
    fx === null ||
    !(fx.kind === null || FX_KINDS.includes(fx.kind)) ||
    !Number.isFinite(fx.amount)
  ) {
    return null
  }
  return {
    name,
    targets: raw.targets.map((target, index) => ({
      text: texts[index],
      x: clamp01(target.x),
      y: clamp01(target.y),
    })),
    cursor: { x: clamp01(raw.cursor.x), y: clamp01(raw.cursor.y) },
    fx: { kind: fx.kind, amount: clamp01(fx.amount) },
  }
}

export function serialisePresets(presets: StylePreset[]): string {
  return JSON.stringify({ version: EXPORT_VERSION, presets }, null, 2)
}

/** Parse an export file; throws with a reason (shown to the user). */
export function parsePresetsExport(json: string): StylePreset[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('not a JSON file')
  }
  const file = parsed as { version?: unknown; presets?: unknown }
  if (typeof file !== 'object' || file === null || !Array.isArray(file.presets)) {
    throw new Error('not a crates export')
  }
  // A future format bumps the version; refusing with a clear reason
  // beats silently filtering a newer file down to nothing.
  if (file.version !== EXPORT_VERSION) {
    throw new Error('file from a different crates version')
  }
  const presets = file.presets.map(parsePreset).filter(
    (preset): preset is StylePreset => preset !== null,
  )
  if (presets.length === 0) {
    throw new Error('no usable presets in the file')
  }
  return presets
}
