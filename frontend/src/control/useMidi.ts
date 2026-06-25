import { useState } from 'react'

import type { DeckId } from '../audio/types'
import { useControlBus } from './busContext'
import type { ControllerDriver, ControllerTranslator } from './driver'
import { createMidiLink, type MidiStatus } from './midi'
import { CONTROLLER_DRIVERS } from './registry'

const MONITOR_SIZE = 6

export type MidiMonitorEntry = { id: number; bytes: number[] }

/** Owns the MIDI link for the app: binds whichever supported controller is
 * connected (the registry, CONTROLLER_DRIVERS), translates its traffic onto
 * the ControlBus through the active driver, and keeps the last few raw
 * messages for the monitor. LED feedback goes back out through the same
 * driver's scheme, so this hook never speaks a controller's raw bytes. The
 * monitor lives outside React state, read by polling (the LevelMeter pattern),
 * so a fader ride doesn't re-render the app per MIDI message. */
export function useMidi() {
  const bus = useControlBus()
  const [status, setStatus] = useState<MidiStatus>(() =>
    typeof navigator !== 'undefined' &&
    typeof navigator.requestMIDIAccess === 'function'
      ? 'idle'
      : 'unsupported',
  )
  const [deviceName, setDeviceName] = useState<string | null>(null)
  // Every matched controller currently connected (raw port names), for the
  // picker when more than one is plugged in.
  const [devices, setDevices] = useState<string[]>([])
  // Bumped when the controller switches pad modes — a switch clears the
  // device's pad LEDs, so subscribers repaint everything they own.
  const [ledEpoch, setLedEpoch] = useState(0)

  const [
    {
      connect,
      selectDevice,
      readMonitor,
      setPadLeds,
      setFxPadLeds,
      setLoopPadLeds,
      setCuePadLeds,
      setChannelCueLed,
      setTransportCueLed,
    },
  ] = useState(() => {
    let entries: MidiMonitorEntry[] = []
    let nextEntryId = 0
    // The active driver and its translator live here, outside React, rebuilt
    // only when the bound controller actually changes — so the FLX4's 14-bit
    // and shift state survive a spurious statechange, as it always has.
    let activeDriver: ControllerDriver | null = null
    let activeName: string | null = null
    let translate: ControllerTranslator | null = null
    const link = createMidiLink({
      drivers: CONTROLLER_DRIVERS,
      onMessage: (data) => {
        const bytes = Array.from(data)
        entries = [
          ...entries.slice(-(MONITOR_SIZE - 1)),
          { id: nextEntryId++, bytes },
        ]
        const intent = translate?.(bytes)
        if (intent) bus.publish(intent)
        if (activeDriver?.isPadModeSwitch(bytes)) {
          setLedEpoch((epoch) => epoch + 1)
        }
      },
      onStatus: (nextStatus, active, available) => {
        setStatus(nextStatus)
        setDeviceName(active?.name ?? null)
        setDevices(available.map((device) => device.name))
        if (active?.driver.id !== activeDriver?.id) {
          activeDriver = active?.driver ?? null
          translate = activeDriver?.createTranslator() ?? null
        }
        // Switching between two connected controllers (the picker, or unplugging
        // one of a pair) keeps the status at 'connected', so the status-keyed LED
        // effects don't re-fire — bump the epoch so the newly-bound device gets
        // repainted (it powered up dark / with stale LEDs). The first connect is
        // already covered by the status change, so only a device-to-device switch
        // needs this.
        if (active && activeName !== null && active.name !== activeName) {
          setLedEpoch((epoch) => epoch + 1)
        }
        activeName = active?.name ?? null
      },
    })
    /** Forward a driver's LED messages out to the controller; a missing
     * driver (nothing connected) is a safe no-op. */
    const sendLeds = (messages: number[][] | undefined) => {
      if (!messages) return
      for (const message of messages) link.send(message)
    }
    return {
      connect: () => void link.connect(),
      selectDevice: (name: string) => link.select(name),
      readMonitor: () => entries,
      /** Light pads 1–count for a deck's style targets; the optional net
       * selection mask burns selected pads bright and dims the rest. */
      setPadLeds: (deck: DeckId, count: number, selected?: boolean[]) =>
        sendLeds(activeDriver?.leds.styleTargetPads(deck, count, selected)),
      /** Light the active effect's pad in the PAD FX bank (null = all dark). */
      setFxPadLeds: (deck: DeckId, activeIndex: number | null) =>
        sendLeds(activeDriver?.leds.fxPads(deck, activeIndex)),
      /** Light filled loop slots in the SAMPLER bank; empty slots stay dark. */
      setLoopPadLeds: (deck: DeckId, filled: boolean[]) =>
        sendLeds(activeDriver?.leds.loopPads(deck, filled)),
      /** Light filled hot cues in the HOT CUE bank — the same pads
       * setPadLeds drives; the caller picks one meaning per deck mode. */
      setCuePadLeds: (deck: DeckId, filled: boolean[]) =>
        sendLeds(activeDriver?.leds.cuePads(deck, filled)),
      /** Channel (headphone) CUE button LED for a deck. */
      setChannelCueLed: (deck: DeckId, on: boolean) =>
        sendLeds(activeDriver?.leds.channelCue(deck, on)),
      /** Transport CUE button LED for a deck (lit while primed off air). */
      setTransportCueLed: (deck: DeckId, on: boolean) =>
        sendLeds(activeDriver?.leds.transportCue(deck, on)),
    }
  })

  return {
    status,
    deviceName,
    devices,
    connect,
    selectDevice,
    readMonitor,
    setPadLeds,
    setFxPadLeds,
    setLoopPadLeds,
    setCuePadLeds,
    setChannelCueLed,
    setTransportCueLed,
    ledEpoch,
  }
}
