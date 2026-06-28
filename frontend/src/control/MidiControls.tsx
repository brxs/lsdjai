import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Select } from '../ui/Select'
import type { MidiStatus } from './midi'
import type { MidiMonitorEntry } from './useMidi'
import './control.css'

const MONITOR_POLL_MS = 150

function formatBytes(bytes: number[]): string {
  return bytes
    .map((byte) => byte.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ')
}

/** Hex ticker of the last few raw messages — the firmware-verification
 * tool ADR-0005 calls for, since published byte charts drift. */
function MidiMonitor({
  readMonitor,
}: {
  readMonitor: () => MidiMonitorEntry[]
}) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<MidiMonitorEntry[]>([])

  useEffect(() => {
    const ticker = setInterval(() => setEntries(readMonitor()), MONITOR_POLL_MS)
    return () => clearInterval(ticker)
  }, [readMonitor])

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
  status: MidiStatus
  deviceName: string | null
  /** Every matched controller currently connected (raw port names). */
  devices: string[]
  onConnect: () => void
  /** Pick which connected controller drives the app, by its port name. */
  onSelectDevice: (name: string) => void
  readMonitor: () => MidiMonitorEntry[]
}

/** Statusbar cluster for hardware control: connect button (MIDI access
 * needs a user gesture), a controller picker when more than one supported
 * device is connected, connection LED, and the raw-byte monitor.
 * Presentational — App owns the useMidi hook so it can drive pad LEDs. */
export function MidiControls({
  status,
  deviceName,
  devices,
  onConnect,
  onSelectDevice,
  readMonitor,
}: MidiControlsProps) {
  const { t } = useTranslation()
  const connected = status === 'connected'
  // The status chip doubles as the connect/retry control: when MIDI is off, no
  // controller turned up, or access was denied, clicking it (re)requests access.
  // Mid-request and "unavailable" are passive readouts.
  const connectable =
    status === 'idle' || status === 'no-device' || status === 'denied'

  // Idle reads as the call to action ("Connect MIDI"); the error states keep
  // their own message so a failed attempt still explains itself.
  const label = connected
    ? deviceName
    : status === 'idle'
      ? t('midi.connect')
      : t(`midi.status.${status}`)
  const led = (
    <span
      className={`midi__led${connected ? ' midi__led--on' : ''}`}
      aria-hidden="true"
    />
  )

  return (
    <div className="midi">
      {connected && <MidiMonitor readMonitor={readMonitor} />}
      {connected && devices.length > 1 && (
        <Select
          label={t('midi.device')}
          value={deviceName ?? ''}
          options={devices}
          onChange={onSelectDevice}
        />
      )}
      {connectable ? (
        <button
          type="button"
          className="midi__status midi__status--action"
          onClick={onConnect}
        >
          {led}
          {label}
        </button>
      ) : (
        <span
          className={`midi__status${connected ? ' midi__status--connected' : ''}`}
          role="status"
        >
          {led}
          {label}
        </span>
      )}
    </div>
  )
}
