import { useState } from 'react'

import type { DeckId } from '../audio/engine'
import { useControlBus } from './busContext'
import {
  createFlx4Translator,
  isPadModeSwitch,
  LOOP_NOTE_BASE,
  PAD_COUNT,
  PAD_FX_NOTE_BASE,
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
  // Bumped when the controller switches pad modes — a switch clears the
  // device's pad LEDs, so subscribers repaint everything they own.
  const [ledEpoch, setLedEpoch] = useState(0)

  const [
    {
      connect,
      readMonitor,
      setLed,
      setPadLeds,
      setFxPadLeds,
      setLoopPadLeds,
      setCuePadLeds,
    },
  ] = useState(() => {
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
        if (isPadModeSwitch(bytes)) setLedEpoch((epoch) => epoch + 1)
      },
      onStatus: (nextStatus, nextDeviceName) => {
        setStatus(nextStatus)
        setDeviceName(nextDeviceName)
      },
    })
    /** Pioneer buttons/pads light by echoing their own status/note back
     * as MIDI out, velocity 0x7F on / 0x00 off (docs/midi-ddj-flx4.md). */
    const setLed = (status: number, note: number, on: boolean) => {
      link.send([status, note, on ? 0x7f : 0x00])
    }
    return {
      connect: () => void link.connect(),
      readMonitor: () => entries,
      setLed,
      /** Light pads 1–count for a deck's style targets. */
      setPadLeds: (deck: DeckId, count: number) => {
        for (let pad = 0; pad < PAD_COUNT; pad++) {
          setLed(PAD_STATUS_BY_DECK[deck], pad, pad < count)
        }
      },
      /** Light the active effect's pad in the PAD FX bank (null = all
       * dark). */
      setFxPadLeds: (deck: DeckId, activeIndex: number | null) => {
        for (let pad = 0; pad < PAD_COUNT; pad++) {
          setLed(
            PAD_STATUS_BY_DECK[deck],
            PAD_FX_NOTE_BASE + pad,
            pad === activeIndex,
          )
        }
      },
      /** Light filled loop slots in the SAMPLER bank (M13); pads
       * beyond the slots stay dark. */
      setLoopPadLeds: (deck: DeckId, filled: boolean[]) => {
        for (let pad = 0; pad < PAD_COUNT; pad++) {
          setLed(PAD_STATUS_BY_DECK[deck], LOOP_NOTE_BASE + pad, Boolean(filled[pad]))
        }
      },
      /** Light filled hot cues in the HOT CUE bank (M21) — the same
       * notes setPadLeds drives; the caller picks one meaning per
       * deck mode, never both. */
      setCuePadLeds: (deck: DeckId, filled: boolean[]) => {
        for (let pad = 0; pad < PAD_COUNT; pad++) {
          setLed(PAD_STATUS_BY_DECK[deck], pad, Boolean(filled[pad]))
        }
      },
    }
  })

  return {
    status,
    deviceName,
    connect,
    readMonitor,
    setLed,
    setPadLeds,
    setFxPadLeds,
    setLoopPadLeds,
    setCuePadLeds,
    ledEpoch,
  }
}
