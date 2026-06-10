import { describe, expect, it } from 'vitest'

import { rangeFromBytes, rmsFromBytes } from './levels'

describe('rmsFromBytes', () => {
  it('is zero for silence (all 128) and empty windows', () => {
    expect(rmsFromBytes(new Uint8Array(64).fill(128))).toBe(0)
    expect(rmsFromBytes(new Uint8Array(0))).toBe(0)
  })

  it('approaches 1 for a full-scale square wave', () => {
    const bytes = new Uint8Array(64)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 2 ? 0 : 255
    expect(rmsFromBytes(bytes)).toBeCloseTo(1, 1)
  })

  it('scales with amplitude', () => {
    const half = new Uint8Array(64)
    for (let i = 0; i < half.length; i++) half[i] = i % 2 ? 64 : 192
    expect(rmsFromBytes(half)).toBeCloseTo(0.5, 1)
  })
})

describe('rangeFromBytes', () => {
  it('is [0, 0] for silence and empty windows', () => {
    expect(rangeFromBytes(new Uint8Array(16).fill(128))).toEqual([0, 0])
    expect(rangeFromBytes(new Uint8Array(0))).toEqual([0, 0])
  })

  it('finds the normalized extremes', () => {
    const bytes = new Uint8Array([128, 0, 255, 128])
    const [low, high] = rangeFromBytes(bytes)
    expect(low).toBe(-1)
    expect(high).toBeCloseTo(0.99, 2)
  })
})
