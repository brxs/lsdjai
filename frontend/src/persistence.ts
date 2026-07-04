/** Last-used settings in localStorage, so a reload picks up where the
 * session left off. Tolerant on read: anything malformed loads as absent. */

import type { DeckId } from './audio/types'
import { EQ_BANDS, type EqBand } from './audio/eq'
import { FX_KINDS, type FxKind } from './audio/fx'
import { LOOP_LENGTH_OPTIONS } from './audio/loops'
import { TRIM_RANGE_DB } from './audio/master'
import { clampMediaHeight } from './media/mediaTray'
import type { PadPoint } from './deck/padWeights'
import { clamp01, isPoint, parsePreset, type StylePreset } from './presets'

export type DeckSettings = {
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

/** User-selectable master accent (LSDJai). Default is 'lime'. */
export type AccentTheme = 'lime' | 'violet' | 'cyan'

export type AppSettings = {
  crossfade: number
  cueMix: number
  beatView: BeatViewLayout
  accent: AccentTheme
  /** Media-tray drawer state: whether it's expanded, and its height in px
   * (clamped to the tray's bounds on load). */
  mediaOpen: boolean
  mediaHeight: number
}

/** The settings that moved to shell-side persistence (ADR-0020 phase A:
 * output devices, recordings folder). Pre-inversion builds saved them in
 * localStorage; this reads them ONCE for migration and strips the keys so
 * they can never shadow the shell's settings file again. Null when nothing
 * is left to migrate. */
export function takeLegacyShellSettings(): {
  outputDevice?: string
  cueDevice?: string
  recordingsFolder?: string
} | null {
  const persisted = read()
  const stored = persisted.app as Record<string, unknown> | undefined
  if (!stored || typeof stored !== 'object') return null
  const legacy: {
    outputDevice?: string
    cueDevice?: string
    recordingsFolder?: string
  } = {}
  if (typeof stored.outputDevice === 'string' && stored.outputDevice) {
    legacy.outputDevice = stored.outputDevice
  }
  if (typeof stored.cueDevice === 'string' && stored.cueDevice) {
    legacy.cueDevice = stored.cueDevice
  }
  if (typeof stored.recordingsFolder === 'string' && stored.recordingsFolder) {
    legacy.recordingsFolder = stored.recordingsFolder
  }
  if (!Object.keys(legacy).length) return null
  delete stored.outputDevice
  delete stored.cueDevice
  delete stored.recordingsFolder
  write(persisted)
  return legacy
}

/** The style-pad arrangement moved to shell-side persistence too (ADR-0020
 * phase B: the store owns targets + cursor, the shell settings file persists
 * them). Pre-inversion builds saved them per deck in localStorage; this reads
 * them ONCE for migration and strips the keys. Null when nothing is left. */
export function takeLegacyDeckStyles(): Partial<
  Record<DeckId, { targets: (PadPoint & { text: string })[]; cursor: PadPoint }>
> | null {
  const persisted = read()
  const decks = persisted.decks as
    | Partial<Record<DeckId, Record<string, unknown>>>
    | undefined
  if (!decks) return null
  const legacy: Partial<
    Record<DeckId, { targets: (PadPoint & { text: string })[]; cursor: PadPoint }>
  > = {}
  let stripped = false
  for (const deckId of ['a', 'b'] as const) {
    const stored = decks[deckId]
    if (!stored || typeof stored !== 'object') continue
    const targets = stored.targets
    if (
      Array.isArray(targets) &&
      targets.length > 0 &&
      targets.every(
        (target) =>
          isPoint(target) &&
          typeof (target as { text?: unknown }).text === 'string',
      )
    ) {
      legacy[deckId] = {
        targets: targets.map((target) => ({
          text: target.text as string,
          x: clamp01(target.x as number),
          y: clamp01(target.y as number),
        })),
        cursor: isPoint(stored.cursor)
          ? { x: clamp01(stored.cursor.x), y: clamp01(stored.cursor.y) }
          : { x: 0.5, y: 0.5 },
      }
    }
    if ('targets' in stored || 'cursor' in stored) {
      delete stored.targets
      delete stored.cursor
      stripped = true
    }
  }
  if (stripped) write(persisted)
  return Object.keys(legacy).length ? legacy : null
}

const STORAGE_KEY = 'lsdj:v1'

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
  if (typeof stored.mediaOpen === 'boolean') {
    settings.mediaOpen = stored.mediaOpen
  }
  if (Number.isFinite(stored.mediaHeight)) {
    settings.mediaHeight = clampMediaHeight(stored.mediaHeight as number)
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
