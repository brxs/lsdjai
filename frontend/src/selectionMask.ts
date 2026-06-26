/** Two net selection masks are equal when same length and same flags, so the
 * pad-LED state only churns on a real selection change (App's no-churn guard). */
export function sameMask(a: boolean[], b: boolean[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
