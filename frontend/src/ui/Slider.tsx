import { useId } from 'react'

/** A reset (↺) control in the label row is opt-in, but if present it MUST carry
 * an accessible name — so `onReset` and `resetLabel` travel together or not at
 * all (an unlabelled icon button is a11y-invalid). */
type SliderResetProps =
  | { onReset: () => void; resetLabel: string }
  | { onReset?: never; resetLabel?: never }

type SliderProps = {
  label: string
  min: number
  max: number
  step: number
  value: number
  'data-shortcut'?: string
  onChange: (value: number) => void
} & SliderResetProps

export function Slider({
  label,
  min,
  max,
  step,
  value,
  'data-shortcut': dataShortcut,
  onChange,
  onReset,
  resetLabel,
}: SliderProps) {
  const id = useId()
  return (
    <div className="ui-slider">
      <div className="ui-slider__head">
        <label className="ui-slider__label" htmlFor={id}>
          {label}
        </label>
        {onReset && (
          <button
            type="button"
            className="ui-slider__reset"
            onClick={onReset}
            aria-label={resetLabel}
            title={resetLabel}
          >
            ↺
          </button>
        )}
      </div>
      <input
        className="ui-slider__input"
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-shortcut={dataShortcut}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}
