import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EQ_BANDS, type EqBand } from '../audio/eq'
import type { DeckId } from '../audio/engine'
import { useAudioEngine } from '../audio/engineContext'
import { listAudioOutputs, type AudioOutputDevice } from '../audio/outputs'
import { useControlBus } from '../control/busContext'
import { FLX4_NAME_FRAGMENT } from '../control/midi'
import { Button } from '../ui/Button'
import { Knob } from '../ui/Knob'
import { LevelMeter } from '../ui/LevelMeter'
import { Select } from '../ui/Select'
import { Slider } from '../ui/Slider'
import { VerticalFader } from '../ui/VerticalFader'
import './mixer.css'

export type ChannelControls = {
  volume: number
  eq: Record<EqBand, number>
  cue: boolean
  onSetVolume: (value: number) => void
  onSetEqBand: (band: EqBand, value: number) => void
  onSetCue: (on: boolean) => void
  getLevel: () => number
}

type MixerStripProps = {
  channels: Record<DeckId, ChannelControls>
  crossfade: number
  onCrossfadeChange: (position: number) => void
  cueMix: number
  onCueMixChange: (position: number) => void
  cueDevice: AudioOutputDevice | null
  /** Rejects when the device can't take the feed (e.g. unplugged). */
  onCueDeviceChange: (device: AudioOutputDevice | null) => Promise<void>
}

function downloadWav(blob: Blob) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `magenta-dj-${stamp}.wav`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function formatElapsed(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** The centre mixer strip: per-channel EQ knob columns, level meters, and
 * vertical faders, with the crossfader and master/record section below.
 * Channel state lives in each deck's hook; the strip only renders it. */
export function MixerStrip({
  channels,
  crossfade,
  onCrossfadeChange,
  cueMix,
  onCueMixChange,
  cueDevice,
  onCueDeviceChange,
}: MixerStripProps) {
  const { t } = useTranslation()
  const engine = useAudioEngine()
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // null = not scanned yet; the saved device still shows as an option.
  const [cueOutputs, setCueOutputs] = useState<AudioOutputDevice[] | null>(null)
  const [phonesError, setPhonesError] = useState<string | null>(null)

  async function scanCueOutputs() {
    try {
      // The FLX4 is never a valid cue output: Chromium can only reach its
      // first stereo pair, which is the MASTER RCA — picking it would
      // leak the preview to the room, and its phones jack (USB 3/4) is
      // unreachable from the browser anyway (ADR-0006).
      setCueOutputs(
        (await listAudioOutputs()).filter(
          (output) => !output.label.includes(FLX4_NAME_FRAGMENT),
        ),
      )
      setPhonesError(null)
    } catch (cause) {
      setPhonesError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  function pickCueDevice(label: string) {
    const device =
      cueOutputs?.find((output) => output.label === label) ??
      (cueDevice?.label === label ? cueDevice : null)
    onCueDeviceChange(device).then(
      () => setPhonesError(null),
      (cause: unknown) =>
        setPhonesError(cause instanceof Error ? cause.message : String(cause)),
    )
  }

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

  const deckIds: DeckId[] = ['a', 'b']

  return (
    <section className="mixer" aria-label={t('mixer.title')}>
      <div className="mixer__channels">
        {deckIds.map((deckId) => (
          <div
            key={deckId}
            className="mixer__channel"
            role="group"
            aria-label={t('mixer.channel', { id: deckId })}
          >
            {EQ_BANDS.map((band) => (
              <Knob
                key={band}
                label={t(`deck.eq.${band}`)}
                value={channels[deckId].eq[band]}
                accent={deckId}
                onChange={(value) => channels[deckId].onSetEqBand(band, value)}
              />
            ))}
            <div className="mixer__fader-row">
              <LevelMeter
                label={t('mixer.channelLevel', { id: deckId })}
                getLevel={channels[deckId].getLevel}
              />
              <VerticalFader
                label={t('deck.volume')}
                accent={deckId}
                value={channels[deckId].volume}
                onChange={channels[deckId].onSetVolume}
              />
            </div>
            <Button
              lit={channels[deckId].cue}
              aria-pressed={channels[deckId].cue}
              onClick={() => channels[deckId].onSetCue(!channels[deckId].cue)}
            >
              {t('mixer.cue')}
            </Button>
          </div>
        ))}
      </div>

      <div className="mixer__crossfade">
        <span className="mixer__edge">{t('mixer.deckA')}</span>
        <div className="mixer__crossfade-slider">
          <Slider
            label={t('mixer.crossfade')}
            min={0}
            max={1}
            step={0.01}
            value={crossfade}
            data-shortcut="crossfade"
            onChange={onCrossfadeChange}
          />
        </div>
        <span className="mixer__edge">{t('mixer.deckB')}</span>
      </div>

      <div className="mixer__phones" role="group" aria-label={t('mixer.phones')}>
        <Knob
          label={t('mixer.cueMix')}
          accent="master"
          value={cueMix}
          onChange={onCueMixChange}
        />
        <div className="mixer__phones-device">
          <Select
            label={t('mixer.phonesOutput')}
            value={cueDevice?.label ?? t('mixer.phonesOff')}
            options={[
              t('mixer.phonesOff'),
              ...(cueOutputs?.map((output) => output.label) ??
                (cueDevice ? [cueDevice.label] : [])),
            ]}
            onChange={pickCueDevice}
          />
          {!cueOutputs && (
            <Button onClick={() => void scanCueOutputs()}>
              {t('mixer.phonesScan')}
            </Button>
          )}
          {phonesError && (
            <span className="mixer__error" role="alert">
              {t('mixer.phonesError', { message: phonesError })}
            </span>
          )}
        </div>
      </div>

      <div className="mixer__master">
        <LevelMeter label={t('mixer.masterLevel')} getLevel={engine.getMasterLevel} />
        <div className="mixer__record">
          <Button onClick={() => void toggleRecording()} disabled={busy}>
            {recording ? t('mixer.stopRecording') : t('mixer.record')}
          </Button>
          {recording && (
            <span className="mixer__elapsed" role="status">
              {t('mixer.recordingFor', { time: formatElapsed(elapsedSeconds) })}
            </span>
          )}
          {error && (
            <span className="mixer__error" role="alert">
              {t('mixer.recordingError', { message: error })}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}
