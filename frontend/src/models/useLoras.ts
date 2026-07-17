import { useCallback, useEffect, useRef, useState } from 'react'

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

/** One slot of a generation's LoRA stack (a `/api/generate` `loras` entry,
 * issue #66): an adapter in the mix at a merge strength. */
export type LoraChoice = { name: string; strength: number }

/** Adapters per generation — mirrors the backend's `loras.MAX_LORA_STACK`. */
export const MAX_LORA_STACK = 4

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
 * refuses a mismatch, so the rack never offers one). */
export function adaptersForKind(
  loras: LoraAdapter[],
  kind: 'sfx' | 'music' | 'track',
): LoraAdapter[] {
  return loras.filter((adapter) => adapter.base === KIND_BASES[kind])
}

/** One form's LoRA stack, driving a {@link LoraRack}: toggle an adapter in or
 * out, trim its strength. Strengths are remembered per adapter name (a ref,
 * not state — only the stack renders), so toggling a chip out and back keeps
 * its trim for the session. The cap is enforced here AND in the rack's
 * disabled chips — a hardware intent can't overfill it either way. */
export function useLoraStack(): {
  stack: LoraChoice[]
  toggle: (name: string) => void
  setStrength: (name: string, strength: number) => void
} {
  const [stack, setStack] = useState<LoraChoice[]>([])
  const strengths = useRef(new Map<string, number>())
  const toggle = useCallback((name: string) => {
    setStack((current) => {
      if (current.some((entry) => entry.name === name)) {
        return current.filter((entry) => entry.name !== name)
      }
      if (current.length >= MAX_LORA_STACK) return current
      return [...current, { name, strength: strengths.current.get(name) ?? 1 }]
    })
  }, [])
  const setStrength = useCallback((name: string, strength: number) => {
    strengths.current.set(name, strength)
    setStack((current) =>
      current.map((entry) => (entry.name === name ? { ...entry, strength } : entry)),
    )
  }, [])
  return { stack, toggle, setStrength }
}

/** The stack filtered to what still resolves for this kind at request time —
 * an adapter deleted mid-session, or orphaned by an engine switch to the
 * other base, silently drops from the request (the stale-choice rule,
 * applied per slot). */
export function stackForKind(
  stack: LoraChoice[],
  loras: LoraAdapter[],
  kind: 'sfx' | 'music' | 'track',
): LoraChoice[] {
  const matched = new Set(adaptersForKind(loras, kind).map((adapter) => adapter.name))
  return stack.filter((entry) => matched.has(entry.name))
}
