type TransportButtonProps = {
  kind: 'play' | 'stop'
  label: string
  accent?: 'a' | 'b'
  /** Light the button in the accent colour (its action is the active state). */
  lit?: boolean
  disabled?: boolean
  onClick: () => void
}

/** Large square transport control with an icon glyph. */
export function TransportButton({
  kind,
  label,
  accent = 'a',
  lit,
  disabled,
  onClick,
}: TransportButtonProps) {
  return (
    <button
      className={`ui-transport ui-transport--${accent}${lit ? ' ui-transport--lit' : ''}`}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {kind === 'play' ? (
          <polygon points="8,5 19,12 8,19" />
        ) : (
          <rect x="7" y="7" width="10" height="10" />
        )}
      </svg>
    </button>
  )
}
