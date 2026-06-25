/** Geometry of the "net": strands strung from the blend cursor (the hub) out
 * to each prompt dot, an inward-bowing web that laces the dots together, and
 * the radial move a jog tick applies to a selected dot. Pure functions over
 * normalized 0..1 pad space; the SVG paths are emitted in a 0..100 viewBox so
 * stroke widths read in sensible units. Unit-tested alongside padWeights. */

export type NetPoint = { x: number; y: number }

const VIEWBOX = 100
/** How far a radial strand bows sideways out of the straight hub→dot line, as
 * a fraction of its length. A gentle, consistent swirl reads as a web, not a
 * bare star. */
const STRAND_SWIRL = 0.12
/** How far a web segment's midpoint is pulled toward the pad centre, as a
 * fraction of the midpoint→centre gap. Higher = the lacing leans further in. */
const WEB_INSET = 0.35
/** Pad units of radius a single jog tick adds or removes. */
export const RADIUS_STEP = 0.015
/** The band a dot's radius is held within: it never collapses onto the hub,
 * and `moveRadial`'s caller still clamps the final point inside the pad. */
export const MIN_RADIUS = 0.04
export const MAX_RADIUS = 0.5
const EDGE_MARGIN = 0.02
/** Below this hub→dot distance the radial direction is ill-defined. */
const DEGENERATE = 1e-4

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

/** Trim path coordinates to 2dp — enough precision for a 100-unit box, and it
 * keeps the emitted `d` strings short. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** A radial strand hub→dot as a quadratic bezier, bowed sideways by a
 * consistent perpendicular offset so every strand swirls the same way. */
export function strandPath(
  hub: NetPoint,
  dot: NetPoint,
  swirl = STRAND_SWIRL,
): string {
  const hx = hub.x * VIEWBOX
  const hy = hub.y * VIEWBOX
  const dx = dot.x * VIEWBOX
  const dy = dot.y * VIEWBOX
  const vx = dx - hx
  const vy = dy - hy
  const length = Math.hypot(vx, vy)
  const midX = (hx + dx) / 2
  const midY = (hy + dy) / 2
  // Unit perpendicular (rotate the strand 90°); zero-length strands stay flat.
  const nx = length === 0 ? 0 : -vy / length
  const ny = length === 0 ? 0 : vx / length
  const bow = swirl * length
  const cx = midX + nx * bow
  const cy = midY + ny * bow
  return `M ${round(hx)} ${round(hy)} Q ${round(cx)} ${round(cy)} ${round(dx)} ${round(dy)}`
}

/** A web segment a→b as a quadratic bezier whose control point is pulled toward
 * the pad centre, so the lacing leans inward (a concave net thread). */
export function webPath(a: NetPoint, b: NetPoint, inset = WEB_INSET): string {
  const ax = a.x * VIEWBOX
  const ay = a.y * VIEWBOX
  const bx = b.x * VIEWBOX
  const by = b.y * VIEWBOX
  const midX = (ax + bx) / 2
  const midY = (ay + by) / 2
  const centre = VIEWBOX / 2
  const cx = midX + (centre - midX) * inset
  const cy = midY + (centre - midY) * inset
  return `M ${round(ax)} ${round(ay)} Q ${round(cx)} ${round(cy)} ${round(bx)} ${round(by)}`
}

/** Target indices ordered by their angle around the hub, so consecutive
 * neighbours can be laced into a web that closes on itself. */
export function orderByAngle(targets: NetPoint[], hub: NetPoint): number[] {
  return targets
    .map((target, index) => ({
      index,
      angle: Math.atan2(target.y - hub.y, target.x - hub.x),
    }))
    .sort((first, second) => first.angle - second.angle)
    .map((entry) => entry.index)
}

/** Move a dot radially about the hub by a signed jog delta: positive steps
 * (clockwise) pull it inward, negative push it out. The dot keeps its angle;
 * its radius is held within [MIN_RADIUS, MAX_RADIUS] and the final point inside
 * the pad. A dot sitting on the hub gets a defined outward direction. */
export function moveRadial(
  dot: NetPoint,
  hub: NetPoint,
  steps: number,
  step = RADIUS_STEP,
): NetPoint {
  const vx = dot.x - hub.x
  const vy = dot.y - hub.y
  const radius = Math.hypot(vx, vy)
  let ux: number
  let uy: number
  let currentRadius: number
  if (radius < DEGENERATE) {
    // On the hub: aim away from the pad centre (or straight up if the dot is
    // dead centre too) so there is always a direction to push along.
    const cx = dot.x - 0.5
    const cy = dot.y - 0.5
    const centreDist = Math.hypot(cx, cy)
    if (centreDist < DEGENERATE) {
      ux = 0
      uy = -1
    } else {
      ux = cx / centreDist
      uy = cy / centreDist
    }
    currentRadius = MIN_RADIUS
  } else {
    ux = vx / radius
    uy = vy / radius
    currentRadius = radius
  }
  const nextRadius = clamp(currentRadius - step * steps, MIN_RADIUS, MAX_RADIUS)
  return {
    x: clamp(hub.x + ux * nextRadius, EDGE_MARGIN, 1 - EDGE_MARGIN),
    y: clamp(hub.y + uy * nextRadius, EDGE_MARGIN, 1 - EDGE_MARGIN),
  }
}
