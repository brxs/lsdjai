import { useEffect, useState } from 'react'

import {
  modelStatus,
  subscribeModelsChanged,
  type LoraAdapter,
  type LoraBase,
} from '../audio/nativeEngine'

/** Which DiT family each SA3 generation kind rides (mirrors the backend's
 * `loras.KIND_BASES`): the pad kinds share the small DiTs, tracks run medium. */
export const KIND_BASES: Record<'sfx' | 'music' | 'track', LoraBase> = {
  sfx: 'small',
  music: 'small',
  track: 'medium',
}

/** The adapter + strength a generation request rides (the `/api/generate`
 * `lora` field, issue #66). */
export type LoraChoice = { name: string; strength: number }

/** The strength stops the pickers offer. 0 is the bit-exact bypass
 * (ADR-0028); the spike measured ~2 as already strong, so the scale ends
 * there — the backend guard rail sits higher. */
export const LORA_STRENGTHS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

/** The installed SA3 LoRA adapters, kept live against `models://changed`.
 * Empty outside the shell (a plain-browser dev session has no registry). */
export function useLoras(): LoraAdapter[] {
  const [loras, setLoras] = useState<LoraAdapter[]>([])
  useEffect(() => {
    const refresh = () => {
      modelStatus()
        .then((status) => setLoras(status.loras))
        .catch(() => {})
    }
    refresh()
    return subscribeModelsChanged(refresh)
  }, [])
  return loras
}

/** The adapters that can ride a generation kind (base-matched; the backend
 * refuses a mismatch, so the picker never offers one). */
export function adaptersForKind(
  loras: LoraAdapter[],
  kind: 'sfx' | 'music' | 'track',
): LoraAdapter[] {
  return loras.filter((adapter) => adapter.base === KIND_BASES[kind])
}
