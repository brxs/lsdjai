import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Select } from '../ui/Select'
import { midiMonitor, type MidiMonitorEntry } from './nativeMidi'
import './control.css'

const MONITOR_POLL_MS = 150

function formatBytes(bytes: number[]): string {
  return bytes
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ')
}

/** Hex ticker of the last few raw messages — the firmware-verification
 * tool ADR-0005 called for and ADR-0031 keeps: published byte charts drift,
 * so the monitor stays the arbiter. Fed by the native service now. */
function MidiMonitor() {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<MidiMonitorEntry[]>([])

  useEffect(() => {
    let live = true
    const ticker = setInterval(() => {
      void midiMonitor().then((next) => {
        if (live) setEntries(next)
      })
    }, MONITOR_POLL_MS)
    return () => {
      live = false
      clearInterval(ticker)
    }
  }, [])

  return (
    <code className="midi__monitor" aria-label={t('midi.monitor.label')}>
      {entries.length
        ? entries.map((entry) => (
            <span key={entry.id} className="midi__monitor-entry">
              {formatBytes(entry.bytes)}
            </span>
          ))
        : t('midi.monitor.empty')}
    </code>
  )
}

type MidiControlsProps = {
  connected: boolean
  deviceName: string | null
  /** Every matched controller currently connected (raw port names). */
  devices: string[]
  /** Pick which connected controller drives the app, by its port name. */
  onSelectDevice: (name: string) => void
}

/** Statusbar cluster for hardware control: connection LED, a controller
 * picker when more than one supported device is connected, and the raw-byte
 * monitor. Purely a projection — the native shell binds controllers itself
 * (ADR-0031), so there is no connect gesture any more. */
export function MidiControls({
  connected,
  deviceName,
  devices,
  onSelectDevice,
}: MidiControlsProps) {
  const { t } = useTranslation()
  const label = connected ? deviceName : t('midi.status.no-device')

  return (
    <div className="midi">
      {connected && <MidiMonitor />}
      {connected && devices.length > 1 && (
        <Select
          label={t('midi.device')}
          value={deviceName ?? ''}
          options={devices}
          onChange={onSelectDevice}
        />
      )}
      <span
        className={`midi__status${connected ? ' midi__status--connected' : ''}`}
        role="status"
      >
        <span
          className={`midi__led${connected ? ' midi__led--on' : ''}`}
          aria-hidden="true"
        />
        {label}
      </span>
    </div>
  )
}
