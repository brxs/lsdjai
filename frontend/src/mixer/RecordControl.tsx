import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAudioEngine } from '../audio/engineContext'
import { useControlBus } from '../control/busContext'
import { Button } from '../ui/Button'
import './mixer.css'

function takeStem() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `lsdj-${stamp}`
}

function formatElapsed(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** The app's master-bus recorder, surfaced as a transport control in the top
 * bar next to the MIDI cluster (standard DAW placement). A ● glyph at rest,
 * red with the elapsed time while recording; stop saves the WAV into the
 * configured recordings folder (chosen in settings; empty = Downloads) and
 * names the saved take. Owns its own transient recording state — nothing else
 * reads it. */
export function RecordControl({
  recordingsFolder,
}: {
  recordingsFolder: string
}) {
  const { t } = useTranslation()
  const engine = useAudioEngine()
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  // The take streams to disk, so its path is known the moment recording starts; we
  // hold it to confirm where the file landed once recording stops.
  const [savingPath, setSavingPath] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const ticker = setInterval(
      () => setElapsedSeconds((seconds) => seconds + 1),
      1_000,
    )
    return () => clearInterval(ticker)
  }, [recording])

  async function toggleRecording() {
    setBusy(true)
    try {
      if (!recording) {
        await engine.resume()
        // The file opens now, so the path comes back here; remember it to confirm
        // the landing spot once the take stops.
        const path = await engine.startRecording(recordingsFolder, takeStem())
        setSavingPath(path)
        setElapsedSeconds(0)
        setSaved(null)
        setRecording(true)
      } else {
        setRecording(false)
        await engine.stopRecording()
        // Reassure the user where the take landed — the basename is enough; the
        // chosen folder is shown in settings.
        if (savingPath) setSaved(savingPath.split(/[\\/]/).pop() ?? savingPath)
      }
      setError(null)
    } catch (cause) {
      setRecording(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  // Hardware record toggle (ADR-0005); the busy guard mirrors the button's
  // disabled state. Resubscribes per render so the handler sees fresh state.
  const bus = useControlBus()
  useEffect(() =>
    bus.subscribe((intent) => {
      if (intent.kind === 'record_toggle' && !busy) void toggleRecording()
    }),
  )

  return (
    <div className={`record${recording ? ' record--on' : ''}`}>
      <Button
        onClick={() => void toggleRecording()}
        disabled={busy}
        aria-pressed={recording}
        aria-label={recording ? t('mixer.stopRecording') : t('mixer.record')}
      >
        <span className="record__dot" aria-hidden="true" />
        {recording
          ? t('mixer.recordingFor', { time: formatElapsed(elapsedSeconds) })
          : t('mixer.recordLabel')}
      </Button>
      {error ? (
        <span className="mixer__error" role="alert">
          {t('mixer.recordingError', { message: error })}
        </span>
      ) : (
        saved && (
          <span className="record__saved" role="status">
            {t('mixer.recordingSaved', { name: saved })}
          </span>
        )
      )}
    </div>
  )
}
