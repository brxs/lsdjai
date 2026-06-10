import { useState } from 'react'

import type { DeckId } from '../audio/engine'
import { useControlBus } from './busContext'
import {
  createFlx4Translator,
  PAD_COUNT,
  PAD_STATUS_BY_DECK,
} from './flx4'
import { createMidiLink, type MidiStatus } from './midi'

const MONITOR_SIZE = 6

export type MidiMonitorEntry = { id: number; bytes: number[] }

/** Owns the MIDI link for the app: translates FLX4 traffic onto the
 * ControlBus and keeps the last few raw messages for the monitor. The
 * monitor lives outside React state, read by polling (the LevelMeter
 * pattern), so a fader ride doesn't re-render the app per MIDI message. */
export function useMidi() {
  const bus = useControlBus()
  const [status, setStatus] = useState<MidiStatus>(() =>
    typeof navigator !== 'undefined' &&
    typeof navigator.requestMIDIAccess === 'function'
      ? 'idle'
      : 'unsupported',
  )
  const [deviceName, setDeviceName] = useState<string | null>(null)

  const [{ connect, readMonitor, setPadLeds }] = useState(() => {
    let entries: MidiMonitorEntry[] = []
    let nextEntryId = 0
    const translate = createFlx4Translator()
    const link = createMidiLink({
      onMessage: (data) => {
        const bytes = Array.from(data)
        entries = [
          ...entries.slice(-(MONITOR_SIZE - 1)),
          { id: nextEntryId++, bytes },
        ]
        const intent = translate(bytes)
        if (intent) bus.publish(intent)
      },
      onStatus: (nextStatus, nextDeviceName) => {
        setStatus(nextStatus)
        setDeviceName(nextDeviceName)
      },
    })
    return {
      connect: () => void link.connect(),
      readMonitor: () => entries,
      /** Light pads 1–count for a deck's style targets: Pioneer pads echo
       * their own status/note back as MIDI out, velocity 0x7F on / 0x00
       * off (docs/midi-ddj-flx4.md). */
      setPadLeds: (deck: DeckId, count: number) => {
        for (let pad = 0; pad < PAD_COUNT; pad++) {
          link.send([PAD_STATUS_BY_DECK[deck], pad, pad < count ? 0x7f : 0x00])
        }
      },
    }
  })

  return { status, deviceName, connect, readMonitor, setPadLeds }
}
