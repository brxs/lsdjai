import { useEffect, useState } from 'react'

import { useControlBus } from './busContext'
import {
  DISCONNECTED_STATUS,
  midiSelect,
  midiStatus,
  subscribeMidiIntent,
  subscribeMidiStatus,
  type NativeMidiStatus,
} from './nativeMidi'

/** The webview's MIDI hook after ADR-0031: the shell owns the transport, the
 * translation, and the LEDs — this hook only (1) projects the connection
 * status for the statusbar/picker and (2) bridges `midi://intent` onto the
 * ControlBus, where the existing App/DeckColumn dispatch consumes hardware
 * intents exactly as before. No connect gesture (native access needs none),
 * no byte handling, no LED plumbing. */
export function useMidi() {
  const bus = useControlBus()
  const [status, setStatus] = useState<NativeMidiStatus>(DISCONNECTED_STATUS)

  useEffect(() => {
    let cancelled = false
    // Hydrate, then follow changes — the service emits only on change, so a
    // mount mid-session needs the initial snapshot.
    void midiStatus().then((initial) => {
      if (!cancelled) setStatus(initial)
    })
    const unsubscribeStatus = subscribeMidiStatus(setStatus)
    const unsubscribeIntent = subscribeMidiIntent((intent) => bus.publish(intent))
    return () => {
      cancelled = true
      unsubscribeStatus()
      unsubscribeIntent()
    }
  }, [bus])

  return {
    connected: status.connected,
    deviceName: status.deviceName,
    devices: status.devices,
    selectDevice: midiSelect,
  }
}
