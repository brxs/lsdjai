import { useId } from 'react'

type SliderProps = {
  label: string
  min: number
  max: number
  step: number
  value: number
  disabled?: boolean
  onChange: (value: number) => void
}

export function Slider({ label, min, max, step, value, disabled, onChange }: SliderProps) {
  const id = useId()
  return (
    <div className="ui-slider">
      <label className="ui-slider__label" htmlFor={id}>
        {label}
      </label>
      <input
        className="ui-slider__input"
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}
