import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAudioEngine } from '../audio/engineContext'
import { useControlBus } from '../control/busContext'
import { Button } from '../ui/Button'
import './mixer.css'

function downloadWav(blob: Blob) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `lsdj-${stamp}.wav`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function formatElapsed(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** The app's master-bus recorder, surfaced as a transport control in the top
 * bar next to the MIDI cluster (standard DAW placement). A ● glyph at rest,
 * red with the elapsed time while recording; stop downloads the WAV. Owns its
 * own transient recording state — nothing else reads it. */
export function RecordControl() {
  const { t } = useTranslation()
  const engine = useAudioEngine()
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)

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
        await engine.startRecording()
        setElapsedSeconds(0)
        setRecording(true)
      } else {
        setRecording(false)
        downloadWav(await engine.stopRecording())
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
      {error && (
        <span className="mixer__error" role="alert">
          {t('mixer.recordingError', { message: error })}
        </span>
      )}
    </div>
  )
}
