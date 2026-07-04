import type { ButtonHTMLAttributes } from 'react'

type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'role'> & {
  /** Visible legend; also the accessible name. Part of the hit target. */
  label: string
  on: boolean
  /** Deck-accent variant; omitted = the master accent. */
  accent?: 'a' | 'b'
}

/** A labelled rocker toggle: dark inset track, thumb jumps to the accent
 * side when on — the hardware answer to a checkbox. State rides
 * `role="switch"` + `aria-checked`; flipping is the caller's `onClick`. */
export function Switch({ label, on, accent, ...props }: SwitchProps) {
  const accentClass = accent ? ` ui-switch--${accent}` : ''
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`ui-switch${accentClass}${on ? ' ui-switch--on' : ''}`}
      {...props}
    >
      <span className="ui-switch__label">{label}</span>
      <span className="ui-switch__track" aria-hidden="true">
        <span className="ui-switch__thumb" />
      </span>
    </button>
  )
}
