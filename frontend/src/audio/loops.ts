/** Freeze-pad loop math (M13, ADR-0009): pure functions and constants
 * for capturing the just-played tail of a deck and looping it
 * seamlessly. The audio-graph side lives in engine.ts; the worklet-side
 * history bookkeeping in public/loop-capture-kernel.js. */

export const LOOP_SLOT_COUNT = 4

/** Selectable capture lengths, in seconds. */
export const LOOP_LENGTH_OPTIONS = [1, 2, 4, 8] as const

export const DEFAULT_LOOP_SECONDS = 4

/** Seam crossfade: long enough to hide the splice, short enough not to
 * eat into the loop. */
export const LOOP_CROSSFADE_SECONDS = 0.03

/** A press with less played history than this is refused — a shorter
 * "loop" is a stutter, not a freeze. */
export const MIN_LOOP_SECONDS = 0.5

/** With a confident tempo (M14) a capture snaps to whole beats, so
 * the loop wraps on the grid instead of mid-stride; level-tolerant by
 * construction (whole beats of a half-time reading are still whole
 * beats). Without one, the raw length is the honest behaviour. */
export function quantiseLoopSeconds(seconds: number, bpm: number): number {
  const beat = 60 / bpm
  // The floor keeps a quantised press above the capture refusal
  // threshold regardless of the caller's length menu (one beat at
  // 200 bpm is 0.3 s — under MIN_LOOP_SECONDS).
  const beats = Math.max(
    Math.ceil(MIN_LOOP_SECONDS / beat),
    Math.round(seconds / beat),
    1,
  )
  return beats * beat
}

/** The music model breaks up below ~4 s (measured 2026-06-12: a 3.6 s
 * request came back garbled from CLI and API alike, while 7.2 s and the
 * spike's 7.74 s were clean), so generated loops never ask for less
 * than this — more bars beat broken audio. */
export const GENERATED_LOOP_MIN_SECONDS = 7

/** Request length for a generated loop (M18). Quantised to whole BARS,
 * not beats: a generated phrase is composed material, and wrapping it
 * mid-bar throws away the musical sentence the prompt asked for. Four
 * beats to the bar — the idiom of everything the decks produce. The
 * quality floor above is enforced in both branches (ceil, so rounding
 * can never dip back under it). */
export function generatedLoopSeconds(seconds: number, bpm: number | null): number {
  const floored = Math.max(seconds, GENERATED_LOOP_MIN_SECONDS)
  if (bpm === null) return floored
  const bar = (60 / bpm) * 4
  const bars = Math.max(
    Math.ceil(GENERATED_LOOP_MIN_SECONDS / bar),
    Math.round(floored / bar),
  )
  return bars * bar
}

/** Build a seamless loop from a captured channel: the first
 * `crossfadeFrames` of the output blend the capture's surplus tail into
 * its head, so the wrap point is continuous by construction. The fade
 * is linear, not equal-power: the seam blends the same deck's material
 * moments apart (strongly correlated), where linear is exact for
 * sustained content and equal-power would bump it by up to 3 dB.
 * Output length = input length − fade (the fade is clamped to half the
 * capture so degenerate inputs still produce a loop). */
export function buildLoopChannel(
  samples: Float32Array,
  crossfadeFrames: number,
): Float32Array<ArrayBuffer> {
  const fade = Math.max(
    0,
    Math.min(crossfadeFrames, Math.floor(samples.length / 2)),
  )
  const length = samples.length - fade
  const out = new Float32Array(length)
  out.set(samples.subarray(0, length))
  for (let i = 0; i < fade; i++) {
    const t = i / fade
    out[i] = samples[length + i] * (1 - t) + samples[i] * t
  }
  return out
}
