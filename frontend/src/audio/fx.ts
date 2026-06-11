/** Color FX curves (roadmap M12, ADR-0008): each effect is a pure
 * `amount → parameters` function over the one-knob convention — a rest
 * position (centre for the bipolar filter, zero otherwise) with a dead
 * zone around it where the insert is bit-transparently bypassed. The
 * graph builders in engine.ts only apply what these curves compute. */

export type FxKind = 'filter' | 'dub_echo' | 'space' | 'crush' | 'noise' | 'sweep'

export const FX_KINDS: FxKind[] = [
  'filter',
  'dub_echo',
  'space',
  'crush',
  'noise',
  'sweep',
]

/** |amount − rest| at or below this keeps the dry path bit-exact. */
export const FX_DEAD_ZONE = 0.02

/** Knob position where the effect is off (dblclick on the Knob lands
 * the filter here). */
export function fxRestPosition(kind: FxKind): number {
  return kind === 'filter' ? 0.5 : 0
}

export function isFxActive(kind: FxKind, amount: number): boolean {
  return Math.abs(clamp01(amount) - fxRestPosition(kind)) > FX_DEAD_ZONE
}

/** Whether the effect replaces the dry signal (filter, crush, sweep) or
 * adds to it (echo tail, hall, noise riser) while active. */
export function fxBlend(kind: FxKind): 'replace' | 'add' {
  return kind === 'filter' || kind === 'crush' || kind === 'sweep'
    ? 'replace'
    : 'add'
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Logarithmic sweep from `from` (drive 0) to `to` (drive 1). */
function logSweep(from: number, to: number, drive: number): number {
  return from * (to / from) ** clamp01(drive)
}

/** Bipolar filter: the left half sweeps a low-pass down from open, the
 * right half a high-pass up — the classic single-knob DJ filter. */
export function filterCurve(amount: number): {
  type: BiquadFilterType
  frequency: number
} {
  const clamped = clamp01(amount)
  if (clamped < 0.5) {
    const drive = (0.5 - clamped) / 0.5
    return { type: 'lowpass', frequency: logSweep(18_000, 80, drive) }
  }
  const drive = (clamped - 0.5) / 0.5
  return { type: 'highpass', frequency: logSweep(30, 6_000, drive) }
}

/** Dub echo: the knob rides feedback and wet together; time and the
 * darkening loop filter stay put so the tail keeps its character. */
export const DUB_ECHO_SECONDS = 0.35
export const DUB_ECHO_TONE_HZ = 2_500

/** Musical delay lengths for the synced echo (fractions of a beat). */
const ECHO_BEAT_FRACTIONS = [0.25, 0.375, 0.5, 0.75, 1]

/** With a confident beat period the echo snaps to the musical fraction
 * nearest its free-running character (M14); without one it stays at
 * DUB_ECHO_SECONDS. Level-tolerant by construction: fractions of a
 * half- or double-time reading are still beat fractions. */
export function echoDelaySeconds(beatPeriodSeconds: number | null): number {
  if (beatPeriodSeconds === null || beatPeriodSeconds <= 0) {
    return DUB_ECHO_SECONDS
  }
  let best = DUB_ECHO_SECONDS
  let bestDistance = Infinity
  for (const fraction of ECHO_BEAT_FRACTIONS) {
    const seconds = fraction * beatPeriodSeconds
    if (seconds > 1) continue // the DelayNode's ceiling
    const distance = Math.abs(seconds - DUB_ECHO_SECONDS)
    if (distance < bestDistance) {
      bestDistance = distance
      best = seconds
    }
  }
  return best
}

export function dubEchoCurve(amount: number): { wet: number; feedback: number } {
  const clamped = clamp01(amount)
  return {
    wet: clamped * 0.9,
    // Capped below unity: a parked knob must always let the tail die.
    feedback: Math.min(0.82, clamped * 0.9),
  }
}

/** Space: dry stays untouched (the parallel branch), the knob brings
 * the hall up. */
export function spaceCurve(amount: number): { wet: number } {
  return { wet: clamp01(amount) }
}

/** Crush: bit depth falls and the sample-hold factor grows together. */
export function crushCurve(amount: number): { bits: number; reduction: number } {
  const clamped = clamp01(amount)
  return {
    bits: 16 - clamped * 12, // 16 → 4 bits
    reduction: 1 + Math.round(clamped * 39), // hold 1 → 40 samples
  }
}

/** Noise: a filtered white-noise riser mixed in; the knob raises both
 * the level and the filter's centre, like the DJM's noise build. */
export function noiseCurve(amount: number): { level: number; frequency: number } {
  const clamped = clamp01(amount)
  return {
    level: clamped * 0.35,
    frequency: logSweep(120, 9_000, clamped),
  }
}

/** Sweep: a free-running LFO duck (no tempo grid, ADR-0004) — rate and
 * depth rise together. */
export function sweepCurve(amount: number): { rateHz: number; depth: number } {
  const clamped = clamp01(amount)
  return {
    rateHz: 0.5 + clamped * 7.5,
    depth: Math.min(1, clamped * 1.2),
  }
}
