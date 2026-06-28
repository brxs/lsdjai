import { memo, useId } from 'react'

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

/**
 * `memo` is LOAD-BEARING, not an optimization. This is a controlled native
 * `<select>`; React re-commits an HostComponent on a referential props change
 * (a fresh props object every parent render) and `updateOptions` then re-asserts
 * the selected `<option>` unconditionally. WKWebView treats that value re-sync as
 * a reason to dismiss an OPEN native popup — so any parent re-render (the ~10 Hz
 * `worklet_stats` churn, a `store://changed` event) would close the menu before a
 * choice could be made (the same mechanism as the per-picker fix in commit
 * 3838069). Memoising here skips the commit entirely when value/options/handlers
 * are referentially unchanged, so callers MUST pass stable `options`/`onChange`/
 * `onReopen` references (useMemo/useCallback) for it to bite.
 */
export const Select = memo(function Select({
  label,
  value,
  options,
  disabled,
  onChange,
  onReopen,
}: SelectProps) {
  const id = useId()
  const entries = options.map((option) =>
    typeof option === 'string' ? { value: option, label: option } : option,
  )
  return (
    <div className="ui-field">
      <label className="ui-field__label" htmlFor={id}>
        {label}
      </label>
      <div className="ui-select">
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
        <span className="ui-select__arrow" aria-hidden="true" />
      </div>
    </div>
  )
})
