import { useTranslation } from 'react-i18next'

import { useAudioEngine } from '../audio/engineContext'
import { Slider } from '../ui/Slider'
import './mixer.css'

type MixerProps = {
  crossfade: number
  onCrossfadeChange: (position: number) => void
}

/** The master section: equal-power crossfader between deck A and deck B.
 * Position state lives in App; the audio-rate blend lives in the engine. */
export function Mixer({ crossfade, onCrossfadeChange }: MixerProps) {
  const { t } = useTranslation()
  const engine = useAudioEngine()

  function handleChange(position: number) {
    onCrossfadeChange(position)
    engine.setCrossfade(position)
  }

  return (
    <section className="mixer" aria-label={t('mixer.title')}>
      <span className="mixer__edge">{t('mixer.deckA')}</span>
      <div className="mixer__fader">
        <Slider
          label={t('mixer.crossfade')}
          min={0}
          max={1}
          step={0.01}
          value={crossfade}
          onChange={handleChange}
        />
      </div>
      <span className="mixer__edge">{t('mixer.deckB')}</span>
    </section>
  )
}
