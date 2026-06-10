import { useId, useRef, type KeyboardEvent, type PointerEvent } from 'react'

export type XYPadTarget = {
  id: string
  label: string
  x: number
  y: number
}

type XYPadProps = {
  label: string
  targets: XYPadTarget[]
  cursor: { x: number; y: number }
  disabled?: boolean
  onChange: (x: number, y: number) => void
}

const KEYBOARD_STEP = 0.05

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

/** A 2D control surface: fixed labelled targets, one draggable cursor.
 * Pointer drags and arrow keys move the cursor; positions are normalized
 * 0..1 in both axes. */
export function XYPad({ label, targets, cursor, disabled, onChange }: XYPadProps) {
  const id = useId()
  const surfaceRef = useRef<HTMLDivElement>(null)

  function moveToPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    onChange(
      clamp01((event.clientX - rect.left) / rect.width),
      clamp01((event.clientY - rect.top) / rect.height),
    )
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (disabled) return
    surfaceRef.current?.setPointerCapture(event.pointerId)
    moveToPointer(event)
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (disabled) return
    if (!surfaceRef.current?.hasPointerCapture(event.pointerId)) return
    moveToPointer(event)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled) return
    const steps: Record<string, [number, number]> = {
      ArrowLeft: [-KEYBOARD_STEP, 0],
      ArrowRight: [KEYBOARD_STEP, 0],
      ArrowUp: [0, -KEYBOARD_STEP],
      ArrowDown: [0, KEYBOARD_STEP],
    }
    const step = steps[event.key]
    if (!step) return
    event.preventDefault()
    onChange(clamp01(cursor.x + step[0]), clamp01(cursor.y + step[1]))
  }

  return (
    <div className="ui-xypad">
      <span className="ui-xypad__label" id={id}>
        {label}
      </span>
      <div
        ref={surfaceRef}
        className={`ui-xypad__surface${disabled ? ' ui-xypad__surface--disabled' : ''}`}
        role="application"
        aria-labelledby={id}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onKeyDown={handleKeyDown}
      >
        {targets.map((target) => (
          <span
            key={target.id}
            className="ui-xypad__target"
            style={{ left: `${target.x * 100}%`, top: `${target.y * 100}%` }}
          >
            <span className="ui-xypad__target-dot" />
            <span className="ui-xypad__target-label">{target.label}</span>
          </span>
        ))}
        <span
          className="ui-xypad__cursor"
          style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }}
        />
      </div>
    </div>
  )
}
