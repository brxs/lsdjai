import { describe, expect, it } from 'vitest'

import {
  MAX_RADIUS,
  MIN_RADIUS,
  RADIUS_STEP,
  moveRadial,
  orderByAngle,
  strandPath,
  webPath,
  type NetPoint,
} from './netGeometry'

const CENTRE: NetPoint = { x: 0.5, y: 0.5 }

function radius(dot: NetPoint, hub: NetPoint) {
  return Math.hypot(dot.x - hub.x, dot.y - hub.y)
}

describe('moveRadial', () => {
  it('pulls a dot inward on a clockwise (positive) tick', () => {
    const dot = { x: 0.5, y: 0.2 } // straight up, radius 0.3
    const moved = moveRadial(dot, CENTRE, 1)
    expect(radius(moved, CENTRE)).toBeCloseTo(0.3 - RADIUS_STEP)
    expect(moved.x).toBeCloseTo(0.5) // angle preserved
    expect(moved.y).toBeGreaterThan(dot.y) // closer to centre
  })

  it('pushes a dot outward on a counter-clockwise (negative) tick', () => {
    const dot = { x: 0.5, y: 0.2 }
    const moved = moveRadial(dot, CENTRE, -1)
    expect(radius(moved, CENTRE)).toBeCloseTo(0.3 + RADIUS_STEP)
    expect(moved.y).toBeLessThan(dot.y) // further from centre
  })

  it('scales with the magnitude of a fast spin', () => {
    const dot = { x: 0.5, y: 0.2 }
    const one = moveRadial(dot, CENTRE, 1)
    const four = moveRadial(dot, CENTRE, 4)
    expect(0.3 - radius(four, CENTRE)).toBeCloseTo(4 * (0.3 - radius(one, CENTRE)))
  })

  it('keeps the dot on its own angle (off-axis direction preserved)', () => {
    const dot = { x: 0.8, y: 0.8 } // 45° down-right
    const before = Math.atan2(dot.y - 0.5, dot.x - 0.5)
    const moved = moveRadial(dot, CENTRE, 1)
    const after = Math.atan2(moved.y - 0.5, moved.x - 0.5)
    expect(after).toBeCloseTo(before)
  })

  it('never pulls a dot closer than MIN_RADIUS', () => {
    const dot = { x: 0.5, y: 0.5 - MIN_RADIUS - 0.005 }
    const moved = moveRadial(dot, CENTRE, 50)
    expect(radius(moved, CENTRE)).toBeGreaterThanOrEqual(MIN_RADIUS - 1e-9)
  })

  it('never pushes a dot past MAX_RADIUS', () => {
    const dot = { x: 0.5, y: 0.2 }
    const moved = moveRadial(dot, CENTRE, -100)
    expect(radius(moved, CENTRE)).toBeLessThanOrEqual(MAX_RADIUS + 1e-9)
  })

  it('keeps the moved dot inside the pad', () => {
    const dot = { x: 0.9, y: 0.5 }
    const moved = moveRadial(dot, CENTRE, -100)
    expect(moved.x).toBeGreaterThanOrEqual(0)
    expect(moved.x).toBeLessThanOrEqual(1)
    expect(moved.y).toBeGreaterThanOrEqual(0)
    expect(moved.y).toBeLessThanOrEqual(1)
  })

  it('gives a dot resting on the hub a defined outward direction', () => {
    const hub = { x: 0.3, y: 0.7 }
    const moved = moveRadial({ ...hub }, hub, -1)
    expect(Number.isFinite(moved.x)).toBe(true)
    expect(Number.isFinite(moved.y)).toBe(true)
    expect(radius(moved, hub)).toBeGreaterThan(0)
  })

  it('measures the radius from the hub, not the pad centre', () => {
    const hub = { x: 0.2, y: 0.2 }
    const dot = { x: 0.6, y: 0.2 } // radius 0.4 from this hub
    const moved = moveRadial(dot, hub, 1)
    expect(radius(moved, hub)).toBeCloseTo(0.4 - RADIUS_STEP)
  })
})

describe('orderByAngle', () => {
  it('orders targets by their angle around the hub', () => {
    // Four targets at the cardinal points around the centre.
    const targets = [
      { x: 0.5, y: 0.9 }, // down  (angle +90°)
      { x: 0.9, y: 0.5 }, // right (angle 0°)
      { x: 0.5, y: 0.1 }, // up    (angle -90°)
      { x: 0.1, y: 0.5 }, // left  (angle 180°)
    ]
    // atan2 runs -π..π, so order is up, right, down, left.
    expect(orderByAngle(targets, CENTRE)).toEqual([2, 1, 0, 3])
  })

  it('returns one index per target', () => {
    const targets = [
      { x: 0.3, y: 0.3 },
      { x: 0.7, y: 0.4 },
      { x: 0.5, y: 0.8 },
    ]
    expect(orderByAngle(targets, CENTRE).slice().sort()).toEqual([0, 1, 2])
  })
})

describe('strandPath', () => {
  it('starts at the hub and ends at the dot, both scaled to the 0..100 box', () => {
    const path = strandPath(CENTRE, { x: 1, y: 1 })
    expect(path.startsWith('M 50 50')).toBe(true)
    expect(path).toContain('Q')
    expect(path.trimEnd().endsWith('100 100')).toBe(true)
  })

  it('emits only finite coordinates for a zero-length strand', () => {
    const path = strandPath(CENTRE, CENTRE)
    for (const token of path.split(/[ ]/).filter((t) => t && t !== 'M' && t !== 'Q')) {
      expect(Number.isFinite(Number(token))).toBe(true)
    }
  })
})

describe('webPath', () => {
  it('bows its control point toward the pad centre', () => {
    // Two dots on the top edge; the inward bow pulls the control point down.
    const path = webPath({ x: 0.2, y: 0.1 }, { x: 0.8, y: 0.1 })
    const control = path.split('Q')[1].trim().split(' ')
    const controlY = Number(control[1])
    const midpointY = 10 // both dots at y=0.1 → 10 in the box
    expect(controlY).toBeGreaterThan(midpointY) // pulled toward centre (y=50)
  })
})
