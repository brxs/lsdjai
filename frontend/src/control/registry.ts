/** The controller registry (issue #30): the one place that knows which
 * controllers LSDJai supports. Binding (midi.ts) matches a connected MIDI
 * port's name against these drivers in order — first match wins. Adding a
 * controller is a new driver module plus one line here; nothing else in the
 * control layer, audio engine, or UI changes. */

import { ddj400Driver } from './ddj400'
import type { ControllerDriver } from './driver'
import { flx4Driver } from './flx4'

export const CONTROLLER_DRIVERS: ControllerDriver[] = [flx4Driver, ddj400Driver]

/** The first registered driver whose name fragment the port name contains,
 * or null if no supported controller matches. */
export function driverForName(name: string): ControllerDriver | null {
  return (
    CONTROLLER_DRIVERS.find((driver) => name.includes(driver.nameFragment)) ??
    null
  )
}
