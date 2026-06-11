/** Shared rhythm fixtures for the beat tests: deterministic noise and
 * an interleaved-stereo click train (a drum-hit caricature). */

/** Deterministic noise (mulberry32) — tests must not use a real RNG. */
export function noiseSource(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
}

/** Interleaved stereo: decaying noise bursts on every beat over a
 * quiet noise floor. */
export function clickTrack(
  bpm: number,
  seconds: number,
  sampleRate: number,
  seed = 1,
): Float32Array {
  const noise = noiseSource(seed)
  const frames = Math.round(seconds * sampleRate)
  const beatPeriod = Math.round((60 / bpm) * sampleRate)
  const burstFrames = Math.round(0.02 * sampleRate)
  const out = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i++) {
    const sinceBeat = i % beatPeriod
    let sample = noise() * 0.01
    if (sinceBeat < burstFrames) {
      sample += noise() * 0.8 * (1 - sinceBeat / burstFrames)
    }
    out[2 * i] = sample
    out[2 * i + 1] = sample
  }
  return out
}
