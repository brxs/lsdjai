/** Last-used settings in localStorage, so a reload picks up where the
 * session left off. Tolerant on read: anything malformed loads as absent. */

import type { DeckId } from './audio/types'
import { EQ_BANDS, type EqBand } from './audio/eq'
import { FX_KINDS, type FxKind } from './audio/fx'
import { LOOP_LENGTH_OPTIONS } from './audio/loops'
import { TRIM_RANGE_DB } from './audio/master'
import type { PadPoint } from './deck/padWeights'
import { clamp01, isPoint, parsePreset, type StylePreset } from './presets'

export type DeckSettings = {
  targets: (PadPoint & { text: string })[]
  cursor: PadPoint
  volume: number
  eq: Record<EqBand, number>
  fx: { kind: FxKind | null; amount: number }
  /** Freeze-pad capture length (M13). The loops themselves are
   * session-only by design (ADR-0009). */
  loopSeconds: number
  /** Gain-staging trim (M17): the mode and the held/last value. */
  trim: { mode: 'auto' | 'manual'; db: number }
}

/** Where the beat view lives (M22): centre stacked, centre vertical
 * (time runs downward, the Serato convention), full-width top bar,
 * or off. */
export type BeatViewLayout = 'center' | 'vertical' | 'top' | 'off'

/** User-selectable master accent (SlipMate). Default is 'lime'. */
export type AccentTheme = 'lime' | 'violet' | 'cyan'

export type AppSettings = {
  crossfade: number
  cueMix: number
  beatView: BeatViewLayout
  accent: AccentTheme
  /** Last-chosen native output device, by name (M-cutover). The device
   * may be gone on reload, so applying it is best-effort. */
  outputDevice: string
}

const STORAGE_KEY = 'slipmate:v1'

type Persisted = {
  decks?: Partial<Record<DeckId, Partial<DeckSettings>>>
  app?: Partial<AppSettings>
  presets?: StylePreset[]
}

function read(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Persisted) : {}
  } catch {
    return {}
  }
}

function write(persisted: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
  } catch {
    // Storage full or unavailable — settings just don't persist.
  }
}

export function loadDeckSettings(deckId: DeckId): Partial<DeckSettings> {
  const stored = read().decks?.[deckId]
  if (!stored || typeof stored !== 'object') return {}
  const settings: Partial<DeckSettings> = {}
  if (
    Array.isArray(stored.targets) &&
    stored.targets.every(
      (target) => isPoint(target) && typeof target.text === 'string',
    )
  ) {
    settings.targets = stored.targets.map((target) => ({
      text: target.text,
      x: clamp01(target.x),
      y: clamp01(target.y),
    }))
  }
  if (isPoint(stored.cursor)) {
    settings.cursor = { x: clamp01(stored.cursor.x), y: clamp01(stored.cursor.y) }
  }
  if (Number.isFinite(stored.volume)) {
    settings.volume = clamp01(stored.volume as number)
  }
  const eq = stored.eq
  if (
    eq &&
    typeof eq === 'object' &&
    EQ_BANDS.every((band) => Number.isFinite(eq[band]))
  ) {
    settings.eq = Object.fromEntries(
      EQ_BANDS.map((band) => [band, clamp01(eq[band] as number)]),
    ) as Record<EqBand, number>
  }
  const fx = stored.fx
  if (
    fx &&
    typeof fx === 'object' &&
    (fx.kind === null || FX_KINDS.includes(fx.kind as FxKind)) &&
    Number.isFinite(fx.amount)
  ) {
    settings.fx = { kind: fx.kind, amount: clamp01(fx.amount as number) }
  }
  if (
    LOOP_LENGTH_OPTIONS.includes(
      stored.loopSeconds as (typeof LOOP_LENGTH_OPTIONS)[number],
    )
  ) {
    settings.loopSeconds = stored.loopSeconds as number
  }
  const trim = stored.trim
  if (
    trim &&
    typeof trim === 'object' &&
    (trim.mode === 'auto' || trim.mode === 'manual') &&
    Number.isFinite(trim.db)
  ) {
    settings.trim = {
      mode: trim.mode,
      db: Math.max(-TRIM_RANGE_DB, Math.min(TRIM_RANGE_DB, trim.db as number)),
    }
  }
  return settings
}

export function updateDeckSettings(
  deckId: DeckId,
  partial: Partial<DeckSettings>,
) {
  const persisted = read()
  persisted.decks = {
    ...persisted.decks,
    [deckId]: { ...persisted.decks?.[deckId], ...partial },
  }
  write(persisted)
}

export function loadAppSettings(): Partial<AppSettings> {
  const stored = read().app
  if (!stored || typeof stored !== 'object') return {}
  const settings: Partial<AppSettings> = {}
  if (Number.isFinite(stored.crossfade)) {
    settings.crossfade = clamp01(stored.crossfade as number)
  }
  if (Number.isFinite(stored.cueMix)) {
    settings.cueMix = clamp01(stored.cueMix as number)
  }
  if (
    stored.beatView === 'center' ||
    stored.beatView === 'vertical' ||
    stored.beatView === 'top' ||
    stored.beatView === 'off'
  ) {
    settings.beatView = stored.beatView
  }
  if (
    stored.accent === 'lime' ||
    stored.accent === 'violet' ||
    stored.accent === 'cyan'
  ) {
    settings.accent = stored.accent
  }
  if (typeof stored.outputDevice === 'string' && stored.outputDevice) {
    settings.outputDevice = stored.outputDevice
  }
  return settings
}

export function updateAppSettings(partial: Partial<AppSettings>) {
  const persisted = read()
  persisted.app = { ...persisted.app, ...partial }
  write(persisted)
}

/** Crates (M16): presets are stored newest-last and addressed by name. */
export function loadPresets(): StylePreset[] {
  const stored = read().presets
  if (!Array.isArray(stored)) return []
  return stored
    .map(parsePreset)
    .filter((preset): preset is StylePreset => preset !== null)
}

/** Insert or replace by name (saving over an existing name updates it). */
export function upsertPresets(incoming: StylePreset[]): StylePreset[] {
  const presets = loadPresets()
  for (const preset of incoming) {
    const index = presets.findIndex((entry) => entry.name === preset.name)
    if (index >= 0) presets[index] = preset
    else presets.push(preset)
  }
  const persisted = read()
  persisted.presets = presets
  write(persisted)
  return presets
}

export function deletePreset(name: string): StylePreset[] {
  const presets = loadPresets().filter((preset) => preset.name !== name)
  const persisted = read()
  persisted.presets = presets
  write(persisted)
  return presets
}
