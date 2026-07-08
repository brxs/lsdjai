/** A simple piano-keyboard glyph for the MIDI-keyboard toggle (issue #49): four
 * white keys framed by an outline, with three black keys on top. Drawn in
 * `currentColor` so it inherits the button's ink — including the lit-LED colour
 * when the keyboard window is open. Sized to the surrounding text (1em). */
export function PianoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      style={{ width: '1em', height: '1em', verticalAlign: 'middle' }}
    >
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <line x1="7.5" y1="4" x2="7.5" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="16.5" y1="4" x2="16.5" y2="20" />
      <rect x="6" y="4" width="3" height="8" rx="0.4" fill="currentColor" stroke="none" />
      <rect x="10.5" y="4" width="3" height="8" rx="0.4" fill="currentColor" stroke="none" />
      <rect x="15" y="4" width="3" height="8" rx="0.4" fill="currentColor" stroke="none" />
    </svg>
  )
}
