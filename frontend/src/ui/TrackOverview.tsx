import { useEffect, useRef } from 'react'

/** One peaks bucket per canvas column — what callers pass to
 * getTrackPeaks so the envelope maps 1:1 onto pixels. */
export const TRACK_OVERVIEW_BUCKETS = 480

const WIDTH = TRACK_OVERVIEW_BUCKETS
const HEIGHT = 56
const KEY_SEEK_SECONDS = 5

type TrackOverviewProps = {
  label: string
  /** Static min/max envelope, one bucket per canvas column — drawn once
   * per track, unlike the live WaveformStrip's scrolling window. */
  peaks: { min: Float32Array; max: Float32Array } | null
  /** Playhead position and track length, in seconds. */
  position: number
  duration: number
  /** Beatgrid ticks (M20), drawn only while a grid is confident —
   * downbeats heavier. Null draws no ticks. */
  grid: { bpm: number; firstBeatSeconds: number } | null
  /** Hot cue markers (M21): filled slots draw numbered-by-position
   * flags in the deck accent. */
  cues?: (number | null)[]
  /** The active loop region, shaded in the deck accent. */
  loop?: { start: number; end: number } | null
  accent: 'a' | 'b'
  disabled?: boolean
  onSeek: (seconds: number) => void
}

/** Whole-track overview for a playback deck (M19, ADR-0013): the decoded
 * buffer's envelope with a playhead, clickable and arrow-key seekable —
 * the slider a live stream can never be. */
export function TrackOverview({
  label,
  peaks,
  position,
  duration,
  grid,
  cues,
  loop,
  accent,
  disabled,
  onSeek,
}: TrackOverviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context || !peaks) return
    const trace =
      getComputedStyle(canvas)
        .getPropertyValue(`--color-deck-${accent}`)
        .trim() || '#ffffff'
    context.clearRect(0, 0, WIDTH, HEIGHT)
    // The loop region (M21) shades beneath the envelope so the
    // waveform stays readable inside it.
    if (loop && duration > 0) {
      const left = (loop.start / duration) * WIDTH
      const right = (loop.end / duration) * WIDTH
      context.globalAlpha = 0.25
      context.fillStyle = trace
      context.fillRect(left, 0, Math.max(right - left, 2), HEIGHT)
      context.globalAlpha = 1
    }
    context.fillStyle = trace
    const buckets = Math.min(peaks.min.length, WIDTH)
    for (let x = 0; x < buckets; x++) {
      // The same sqrt compression as the live strip, so dense material
      // shows its dynamics instead of pegging the view.
      const amplitude = Math.sqrt(
        Math.min(1, (peaks.max[x] - peaks.min[x]) / 2),
      )
      const half = Math.max(1, (amplitude * HEIGHT * 0.92) / 2)
      context.fillRect(x, HEIGHT / 2 - half, 1, half * 2)
    }
    // Beatgrid ticks (M20): top edge, only while the grid is
    // confident (null grid, no ticks; the honesty rule). Density-
    // aware: a 2-minute track is ~270 beats across 480 px — drawing
    // every beat fuses into a solid band (found on the device), so
    // ticks step up to downbeats, then bars-of-4, until they fit.
    if (grid && duration > 0) {
      const tick =
        getComputedStyle(canvas).getPropertyValue('--color-wave-beat').trim() ||
        '#ff4757'
      context.fillStyle = tick
      const period = 60 / grid.bpm
      const pxPerBeat = (period / duration) * WIDTH
      const stride = pxPerBeat >= 6 ? 1 : pxPerBeat >= 1.5 ? 4 : 16
      const first = grid.firstBeatSeconds % period
      let beat = 0
      for (let t = first; t < duration; t += period, beat++) {
        if (beat % stride !== 0) continue
        const x = Math.round((t / duration) * WIDTH)
        const heavy = beat % (stride * 4) === 0
        context.fillRect(x, 0, heavy ? 2 : 1, heavy ? 14 : 7)
      }
    }
    // Hot cue flags (M21): bottom edge, deck accent — distinct from
    // the grid-red beat ticks along the top.
    if (cues && duration > 0) {
      context.fillStyle = trace
      for (const cue of cues) {
        if (cue === null) continue
        const x = Math.round((cue / duration) * WIDTH)
        context.fillRect(x, HEIGHT - 16, 2, 16)
        context.fillRect(x, HEIGHT - 16, 6, 5)
      }
    }
  }, [peaks, accent, grid, cues, loop, duration])

  function seekFromPointer(event: React.PointerEvent<HTMLDivElement>) {
    if (disabled || duration <= 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    const fraction = (event.clientX - rect.left) / rect.width
    onSeek(fraction * duration)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled || duration <= 0) return
    const jumps: Record<string, number> = {
      ArrowLeft: position - KEY_SEEK_SECONDS,
      ArrowRight: position + KEY_SEEK_SECONDS,
      Home: 0,
      End: duration,
    }
    const next = jumps[event.key]
    if (next === undefined) return
    event.preventDefault()
    onSeek(next)
  }

  const fraction = duration > 0 ? Math.min(position / duration, 1) : 0

  return (
    <div
      className={`ui-trackoverview${disabled ? ' ui-trackoverview--disabled' : ''}`}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(position)}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={seekFromPointer}
      onKeyDown={handleKeyDown}
    >
      <canvas
        ref={canvasRef}
        className="ui-trackoverview__canvas"
        width={WIDTH}
        height={HEIGHT}
        aria-hidden="true"
      />
      <div
        className="ui-trackoverview__playhead"
        style={{ left: `${fraction * 100}%` }}
      />
    </div>
  )
}
