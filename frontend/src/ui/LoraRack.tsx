import { useTranslation } from 'react-i18next'

import { Knob, type KnobAccent } from './Knob'

/** One selectable adapter: `name` is the registry identity sent in requests,
 * `label` the display slug. */
export type LoraRackAdapter = { name: string; label: string }
/** One slot of the stack: an adapter in the mix at a merge strength. */
export type LoraRackChoice = { name: string; strength: number }

// The trim knob's range: the current stops (0-2 in quarter steps) become
// detents. 0 is the bit-exact bypass (ADR-0028); the backend bound is wider
// (0-4), this is the curated UX range.
const STRENGTH_MIN = 0
const STRENGTH_MAX = 2
const STRENGTH_STEP = 0.25
const STRENGTH_REST = 1

type LoraRackProps = {
  /** Base-matched adapters, library order — one slot each. */
  adapters: LoraRackAdapter[]
  /** The stack: which adapters ride the generation, at what strength. */
  value: LoraRackChoice[]
  onToggle: (name: string) => void
  onStrength: (name: string, strength: number) => void
  accent?: KnobAccent
  /** Stack cap (mirrors the backend's MAX_LORA_STACK); excess chips disable. */
  max?: number
}

/** The LoRA stack as an FX rack (issue #66 follow-up): every adapter is a
 * toggle chip; clicking one into the stack grows a trim knob (double-click
 * parks it at ×1). At ×0 the slot dims — in the stack, bit-exact silent.
 * Order never matters (the merge is order-independent, ADR-0028), so slots
 * stay in library order. */
export function LoraRack({
  adapters,
  value,
  onToggle,
  onStrength,
  accent = 'master',
  max = 4,
}: LoraRackProps) {
  const { t } = useTranslation()
  const full = value.length >= max

  return (
    <div className={`ui-lorarack ui-lorarack--${accent}`}>
      <span className="ui-lorarack__label">{t('lora.rack')}</span>
      <div className="ui-lorarack__slots">
        {adapters.map((adapter) => {
          const choice = value.find((entry) => entry.name === adapter.name)
          const active = choice !== undefined
          const blocked = !active && full
          const slotClass = [
            'ui-lorarack__slot',
            active ? 'ui-lorarack__slot--on' : '',
            choice?.strength === 0 ? 'ui-lorarack__slot--bypass' : '',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div className={slotClass} key={adapter.name}>
              <button
                type="button"
                className="ui-lorarack__chip"
                aria-pressed={active}
                aria-label={t(active ? 'lora.exclude' : 'lora.include', {
                  name: adapter.label,
                })}
                disabled={blocked}
                title={blocked ? t('lora.stackFull', { max }) : undefined}
                onClick={() => onToggle(adapter.name)}
              >
                {adapter.label}
              </button>
              {active && (
                <div className="ui-lorarack__trim">
                  <Knob
                    label={t('lora.strengthValue', { value: choice.strength })}
                    ariaLabel={t('lora.strength', { name: adapter.label })}
                    size="s"
                    accent={accent}
                    value={choice.strength}
                    min={STRENGTH_MIN}
                    max={STRENGTH_MAX}
                    step={STRENGTH_STEP}
                    resetValue={STRENGTH_REST}
                    onChange={(strength) => onStrength(adapter.name, strength)}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
