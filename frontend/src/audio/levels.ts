/** Pure math over AnalyserNode byte time-domain data (128 = zero). */

/** RMS level of a byte window, 0..~1. */
export function rmsFromBytes(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0
  let sum = 0
  for (let i = 0; i < bytes.length; i++) {
    const sample = (bytes[i] - 128) / 128
    sum += sample * sample
  }
  return Math.sqrt(sum / bytes.length)
}

/** Min/max of a byte window, normalized to -1..1. */
export function rangeFromBytes(bytes: Uint8Array): [number, number] {
  if (bytes.length === 0) return [0, 0]
  let lowest = 255
  let highest = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] < lowest) lowest = bytes[i]
    if (bytes[i] > highest) highest = bytes[i]
  }
  return [(lowest - 128) / 128, (highest - 128) / 128]
}
