import { useId } from 'react'

/** Plain strings double as value and label; pair options decouple the
 * stable value from translated display copy. */
export type SelectOption = string | { value: string; label: string }

type SelectProps = {
  label: string
  value: string
  options: SelectOption[]
  disabled?: boolean
  onChange: (value: string) => void
  /** Fired as the field is about to open (focus/pointer) — lets callers
   * refresh the option list each time the menu is reopened. */
  onReopen?: () => void
}

export function Select({ label, value, options, disabled, onChange, onReopen }: SelectProps) {
  const id = useId()
  const entries = options.map((option) =>
    typeof option === 'string' ? { value: option, label: option } : option,
  )
  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={id}>
        {label}
      </label>
      <select
        className="ui-field__input"
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onMouseDown={onReopen}
        onFocus={onReopen}
      >
        {entries.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {entry.label}
          </option>
        ))}
      </select>
    </div>
  )
}
