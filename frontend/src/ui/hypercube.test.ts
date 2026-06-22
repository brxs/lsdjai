import { describe, expect, it } from 'vitest'

import { cubeCorners, cubeEdges, cubeSegments, type Vec3 } from './hypercube'

const isUnit = (v: Vec3) => v.every((c) => c === 1 || c === -1)

describe('cube geometry', () => {
  it('has 8 distinct unit corners', () => {
    const corners = cubeCorners()
    expect(corners).toHaveLength(8)
    expect(corners.every(isUnit)).toBe(true)
    expect(new Set(corners.map((c) => c.join(','))).size).toBe(8)
  })

  it('has 12 edges, each joining corners one axis apart', () => {
    const corners = cubeCorners()
    const edges = cubeEdges()
    expect(edges).toHaveLength(12)
    for (const [a, b] of edges) {
      const differing = corners[a].filter((c, i) => c !== corners[b][i]).length
      expect(differing).toBe(1)
    }
  })

  it('lists every edge exactly once', () => {
    const edges = cubeEdges()
    const keys = edges.map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`)
    expect(new Set(keys).size).toBe(edges.length)
  })
})

describe('cubeSegments', () => {
  it('produces the cube as 12 unit-corner segments at unit scale', () => {
    const segments = cubeSegments()
    expect(segments).toHaveLength(12)
    expect(segments.every(([a, b]) => isUnit(a) && isUnit(b))).toBe(true)
  })

  it('scales every endpoint by the given factor', () => {
    for (const [a, b] of cubeSegments(0.5)) {
      for (const coord of [...a, ...b]) {
        expect(Math.abs(coord)).toBe(0.5)
      }
    }
  })
})
