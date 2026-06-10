import { useId } from 'react'

export type KnobAccent = 'a' | 'b' | 'master'

type KnobProps = {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  accent?: KnobAccent
  disabled?: boolean
  onChange: (value: number) => void
}

const SIZE = 44
const RADIUS = 17
const POINTER_RADIUS = 10
const SWEEP_DEGREES = 270
// Min points to 7 o'clock and the dial sweeps clockwise over the top to
// 5 o'clock, leaving the conventional gap at the bottom. Angles are
// y-up math convention, so clockwise on screen = decreasing angle.
const START_DEGREES = -135

function angleFor(fraction: number) {
  return START_DEGREES - SWEEP_DEGREES * fraction
}

function polar(angleDegrees: number, radius = RADIUS) {
  const radians = (angleDegrees * Math.PI) / 180
  return {
    x: SIZE / 2 + radius * Math.cos(radians),
    y: SIZE / 2 - radius * Math.sin(radians),
  }
}

function arcPath(fromDegrees: number, toDegrees: number) {
  const start = polar(fromDegrees)
  const end = polar(toDegrees)
  const largeArc = Math.abs(fromDegrees - toDegrees) > 180 ? 1 : 0
  return `M ${start.x} ${start.y} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${end.x} ${end.y}`
}

/** Rotary control: an SVG arc dial over a real (invisible) range input, so
 * keyboard, labels, and test tooling keep native input semantics.
 * Double-click resets to the centre of the range (the EQ-flat convention). */
export function Knob({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  accent = 'master',
  disabled,
  onChange,
}: KnobProps) {
  const id = useId()
  const fraction = max === min ? 0 : (value - min) / (max - min)
  const valueAngle = angleFor(fraction)
  const pointer = polar(valueAngle, POINTER_RADIUS)

  return (
    <div className={`ui-knob ui-knob--${accent}${disabled ? ' ui-knob--disabled' : ''}`}>
      <div className="ui-knob__dial">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <path className="ui-knob__track" d={arcPath(START_DEGREES, angleFor(1))} />
          <path className="ui-knob__value" d={arcPath(START_DEGREES, valueAngle)} />
          <circle className="ui-knob__cap" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS - 5} />
          <line
            className="ui-knob__pointer"
            x1={SIZE / 2}
            y1={SIZE / 2}
            x2={pointer.x}
            y2={pointer.y}
          />
        </svg>
        <input
          className="ui-knob__input"
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          onDoubleClick={() => onChange((min + max) / 2)}
        />
      </div>
      <label className="ui-knob__label" htmlFor={id}>
        {label}
      </label>
    </div>
  )
}
