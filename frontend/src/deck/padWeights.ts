/** Geometry of the style pad: targets live at user-draggable positions, the
 * cursor blends them by inverse-distance weighting — smooth everywhere,
 * exactly one target at its own position. Pure functions, unit-tested. */

export type PadPoint = { x: number; y: number }

const EXACT_HIT = 1e-6
const CIRCLE_RADIUS = 0.38
const SPAWN_SLOTS = 8

/** Normalized blend weights for a cursor over the targets (all in 0..1
 * pad coordinates). */
export function padWeights(targets: PadPoint[], cursor: PadPoint): number[] {
  const distances = targets.map((target) =>
    Math.hypot(target.x - cursor.x, target.y - cursor.y),
  )
  const hit = distances.findIndex((distance) => distance < EXACT_HIT)
  if (hit >= 0) return targets.map((_, index) => (index === hit ? 1 : 0))
  const raw = distances.map((distance) => 1 / (distance * distance))
  const total = raw.reduce((sum, weight) => sum + weight, 0)
  return raw.map((weight) => weight / total)
}

/** Where a sweep fraction in [0, 1] lands: on the same circle the spawn
 * slots sit on, 0 at 12 o'clock, increasing clockwise — so a hardware knob
 * rides the cursor through every spawned target in order (M7). */
export function sweepPosition(fraction: number): PadPoint {
  const angle = 2 * Math.PI * fraction - Math.PI / 2
  return {
    x: 0.5 + CIRCLE_RADIUS * Math.cos(angle),
    y: 0.5 + CIRCLE_RADIUS * Math.sin(angle),
  }
}

function circleSlot(index: number): PadPoint {
  return sweepPosition(index / SPAWN_SLOTS)
}

/** Where a newly added target spawns: the circle slot with the most
 * clearance from the targets already placed, so adding never reshuffles an
 * arrangement the user made by dragging. */
export function spawnPosition(existing: PadPoint[]): PadPoint {
  let best = circleSlot(0)
  let bestClearance = -1
  for (let index = 0; index < SPAWN_SLOTS; index++) {
    const slot = circleSlot(index)
    const clearance = existing.length
      ? Math.min(
          ...existing.map((target) =>
            Math.hypot(target.x - slot.x, target.y - slot.y),
          ),
        )
      : Number.POSITIVE_INFINITY
    if (clearance > bestClearance) {
      bestClearance = clearance
      best = slot
    }
  }
  return best
}
