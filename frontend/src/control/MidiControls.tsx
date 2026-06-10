import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../ui/Button'
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
  onConnect: () => void
  readMonitor: () => MidiMonitorEntry[]
}

/** Statusbar cluster for hardware control: connect button (MIDI access
 * needs a user gesture), connection LED, and the raw-byte monitor.
 * Presentational — App owns the useMidi hook so it can drive pad LEDs. */
export function MidiControls({
  status,
  deviceName,
  onConnect,
  readMonitor,
}: MidiControlsProps) {
  const { t } = useTranslation()
  const connected = status === 'connected'

  return (
    <div className="midi">
      {connected && <MidiMonitor readMonitor={readMonitor} />}
      {!connected && status !== 'unsupported' && (
        <Button onClick={onConnect} disabled={status === 'requesting'}>
          {t('midi.connect')}
        </Button>
      )}
      <span
        className={`midi__status${connected ? ' midi__status--connected' : ''}`}
        role="status"
      >
        <span
          className={`midi__led${connected ? ' midi__led--on' : ''}`}
          aria-hidden="true"
        />
        {connected ? deviceName : t(`midi.status.${status}`)}
      </span>
    </div>
  )
}
