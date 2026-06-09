import type { DeckId } from './audio/engine'
import type { RamInfo } from './deck/deckState'

// Above this share of total RAM, the combined model selection gets a
// warning banner — a guardrail, not enforcement (estimates come from the
// backend hello event).
const RAM_COMFORT_FRACTION = 0.6

export function combinedRamWarning(
  deckModels: Record<DeckId, string | null>,
  ramInfo: RamInfo | null,
): { combined: string; total: string } | null {
  if (!ramInfo || !deckModels.a || !deckModels.b) return null
  const combined =
    (ramInfo.estimateGbByModel[deckModels.a] ?? 0) +
    (ramInfo.estimateGbByModel[deckModels.b] ?? 0)
  if (combined <= ramInfo.totalGb * RAM_COMFORT_FRACTION) return null
  return { combined: combined.toFixed(0), total: ramInfo.totalGb.toFixed(0) }
}
