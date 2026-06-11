// Minimal 16-bit PCM WAV reader for test fixtures (the spike corpus).
// Plain JS on purpose: it uses node APIs, which stay outside the
// DOM-typed app project (the kernel-test precedent).
// Returns interleaved stereo float32 — the deck wire format.

import { readFileSync } from 'node:fs'

export function readWav(path) {
  const bytes = readFileSync(path)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`${path}: not a RIFF file`)
  }
  let channels = 2
  let sampleRate = 48_000
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      const format = view.getUint16(offset + 8, true)
      if (format !== 1) throw new Error(`${path}: not PCM (format ${format})`)
      channels = view.getUint16(offset + 10, true)
      sampleRate = view.getUint32(offset + 12, true)
      if (view.getUint16(offset + 22, true) !== 16) {
        throw new Error(`${path}: not 16-bit`)
      }
    } else if (id === 'data') {
      const frames = Math.floor(size / 2 / channels)
      const samples = new Float32Array(frames * 2)
      for (let i = 0; i < frames; i++) {
        const left = view.getInt16(offset + 8 + i * channels * 2, true) / 32768
        const right =
          channels > 1
            ? view.getInt16(offset + 8 + (i * channels + 1) * 2, true) / 32768
            : left
        samples[2 * i] = left
        samples[2 * i + 1] = right
      }
      return { sampleRate, samples }
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error(`${path}: no data chunk`)
}
