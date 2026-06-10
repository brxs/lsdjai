/** Geometry of the style pad: targets live at fixed positions, the cursor
 * blends them by inverse-distance weighting — smooth everywhere, exactly one
 * target at its own position. Pure functions, unit-tested. */

export type PadPoint = { x: number; y: number }

const EXACT_HIT = 1e-6
const CIRCLE_RADIUS = 0.38

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

/** Where targets sit on the pad: one in the centre, several spread evenly
 * on a circle starting at 12 o'clock. */
export function targetPositions(count: number): PadPoint[] {
  if (count === 1) return [{ x: 0.5, y: 0.5 }]
  return Array.from({ length: count }, (_, index) => {
    const angle = (2 * Math.PI * index) / count - Math.PI / 2
    return {
      x: 0.5 + CIRCLE_RADIUS * Math.cos(angle),
      y: 0.5 + CIRCLE_RADIUS * Math.sin(angle),
    }
  })
}
