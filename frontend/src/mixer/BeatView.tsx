import { useTranslation } from 'react-i18next'

import { Panel } from '../ui/Panel'
import { ZoomStrip } from '../ui/ZoomStrip'
import type { ZoomSource } from '../deck/useDeck'

type BeatViewProps = {
  /** Side-by-side vertical strips (time runs downward) instead of
   * the stacked horizontal pair. */
  vertical?: boolean
  getSourceA: () => ZoomSource | null
  getSourceB: () => ZoomSource | null
}

/** The visual beatmatcher (M22): both decks' band-coloured close-ups
 * stacked (or side by side, vertical), playheads aligned mid-view —
 * when M20 says the decks are locked, the beat marks coincide. */
export function BeatView({ vertical, getSourceA, getSourceB }: BeatViewProps) {
  const { t } = useTranslation()
  return (
    <Panel
      className={`beatview${vertical ? ' beatview--vertical' : ''}`}
      aria-label={t('beatview.title')}
    >
      <ZoomStrip
        label={t('beatview.deck', { id: 'A' })}
        deck="a"
        vertical={vertical}
        getSource={getSourceA}
      />
      <ZoomStrip
        label={t('beatview.deck', { id: 'B' })}
        deck="b"
        vertical={vertical}
        getSource={getSourceB}
      />
    </Panel>
  )
}
