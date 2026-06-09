import { useId } from 'react'

type SelectProps = {
  label: string
  value: string
  options: string[]
  disabled?: boolean
  onChange: (value: string) => void
}

export function Select({ label, value, options, disabled, onChange }: SelectProps) {
  const id = useId()
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
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  )
}
