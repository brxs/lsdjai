import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EQ_BANDS, type EqBand } from '../audio/eq'
import type { DeckId } from '../audio/engine'
import { useAudioEngine } from '../audio/engineContext'
import { listCueJackOutputs } from '../audio/cueStream'
import { TRIM_RANGE_DB } from '../audio/master'
import { listAudioOutputs, type AudioOutputDevice } from '../audio/outputs'
import { useControlBus } from '../control/busContext'
import { Button } from '../ui/Button'
import { Knob } from '../ui/Knob'
import { LevelMeter } from '../ui/LevelMeter'
import { Select } from '../ui/Select'
import { PhaseMeter } from '../ui/PhaseMeter'
import { Slider } from '../ui/Slider'
import { Stat } from '../ui/Stat'
import { VerticalFader } from '../ui/VerticalFader'
import './mixer.css'

export type ChannelControls = {
  volume: number
  eq: Record<EqBand, number>
  cue: boolean
  /** Gain-staging trim (M17): auto follows source loudness, a knob
   * move takes over, AUTO re-engages. */
  trim: { mode: 'auto' | 'manual'; db: number }
  onSetVolume: (value: number) => void
  onSetEqBand: (band: EqBand, value: number) => void
  onSetCue: (on: boolean) => void
  onSetTrimDb: (db: number) => void
  onEnableAutoTrim: () => void
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
  /** Beat-phase offset between the decks (M20), null while either
   * clock is unconfident — the meter blanks. */
  getPhaseOffset: () => number | null
}

function downloadWav(blob: Blob) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `slipmate-${stamp}.wav`
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
  getPhaseOffset,
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
  // The limiter's gain reduction, polled gently — it is a health
  // readout, not a meter.
  const [gainReduction, setGainReduction] = useState(0)
  useEffect(() => {
    const ticker = setInterval(
      () => setGainReduction(engine.getMasterGainReduction()),
      250,
    )
    return () => clearInterval(ticker)
  }, [engine])

  async function scanCueOutputs() {
    try {
      // Browser sinks plus the backend's phones jacks (ADR-0007) — the
      // jack entries route through /ws/cue instead of an audio element.
      const [browserOutputs, jackOutputs] = await Promise.all([
        listAudioOutputs(),
        listCueJackOutputs(),
      ])
      setCueOutputs([
        ...browserOutputs,
        ...jackOutputs.map(({ name }) => ({
          deviceId: name,
          label: t('mixer.phonesJack', { name }),
          backend: true,
        })),
      ])
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
  // Hardware mixers stack HI on top; EQ_BANDS stays low→high for the
  // audio chain, this is display order only.
  const eqDisplayOrder: EqBand[] = [...EQ_BANDS].reverse()

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
            {/* Trim sits above the EQ like a hardware channel strip;
                the knob shows the live value even while auto rides it. */}
            <Knob
              label={t('mixer.trim')}
              value={
                (channels[deckId].trim.db + TRIM_RANGE_DB) / (2 * TRIM_RANGE_DB)
              }
              accent={deckId}
              onChange={(value) =>
                channels[deckId].onSetTrimDb(
                  value * 2 * TRIM_RANGE_DB - TRIM_RANGE_DB,
                )
              }
            />
            <Button
              lit={channels[deckId].trim.mode === 'auto'}
              aria-pressed={channels[deckId].trim.mode === 'auto'}
              onClick={channels[deckId].onEnableAutoTrim}
            >
              {t('mixer.trimAuto')}
            </Button>
            {eqDisplayOrder.map((band) => (
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

      <PhaseMeter label={t('mixer.phase')} getOffset={getPhaseOffset} />

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
        <Stat
          label={t('mixer.limiter')}
          value={
            gainReduction < -0.5
              ? t('mixer.limiterDb', { db: gainReduction.toFixed(1) })
              : t('deck.health.noData')
          }
          tone={gainReduction < -6 ? 'danger' : 'default'}
        />
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
