/** Shared bounds for the collapsible media tray's height (px), so App's state,
 * the resize-drag clamp, and the persistence validation agree on one range.
 * Default matches the tray's former fixed `max-height: 18rem`. */

export const MEDIA_MIN_HEIGHT = 120
export const MEDIA_MAX_HEIGHT = 720
export const MEDIA_DEFAULT_HEIGHT = 288

export function clampMediaHeight(height: number): number {
  return Math.max(MEDIA_MIN_HEIGHT, Math.min(MEDIA_MAX_HEIGHT, height))
}
