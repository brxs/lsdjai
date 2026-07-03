import {
  useId,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'

import { orderByAngle, strandPath, webPath } from './netGeometry'

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
  /** When provided, target dots are draggable. */
  onTargetMove?: (id: string, x: number, y: number) => void
  /** Ids of the targets currently selected on the controller — their strands
   * and dots are highlighted in the net. */
  selectedIds?: ReadonlySet<string>
  /** Double-clicking the pad fires this — the owner decides what it does
   * (centre the cursor and fan the dots out). */
  onCursorActivate?: () => void
  /** Overlay slot: rendered inside (and clipped to) the square surface,
   * above the net — for covers like the deck's performance door. Pointer
   * events on overlay content stay in the overlay (they never start a pad
   * drag underneath). */
  children?: ReactNode
}

const KEYBOARD_STEP = 0.05

type Drag = { kind: 'cursor' } | { kind: 'target'; id: string }

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value))
}

/** A 2D control surface: labelled targets and one cursor. Dragging the
 * surface moves the cursor; dragging a dot repositions that target (so
 * targets can be clustered). Arrow keys nudge the cursor. All positions are
 * normalized 0..1 in both axes. */
export function XYPad({
  label,
  targets,
  cursor,
  disabled,
  onChange,
  onTargetMove,
  selectedIds,
  onCursorActivate,
  children,
}: XYPadProps) {
  const id = useId()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  // Pointer capture keeps a drag alive past the surface edge — but taking it in
  // pointerdown suppresses the follow-up click/double-click (a Chromium
  // gotcha), which would swallow the blue dot's double-click. So we capture
  // lazily, only once a real drag starts moving.
  const capturedRef = useRef(false)

  function pointerPosition(event: PointerEvent<HTMLDivElement>) {
    const rect = surfaceRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return null
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    }
  }

  function applyDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    const position = pointerPosition(event)
    if (!drag || !position) return
    if (drag.kind === 'target') {
      onTargetMove?.(drag.id, position.x, position.y)
    } else {
      onChange(position.x, position.y)
    }
  }

  function capture(event: PointerEvent<HTMLDivElement>) {
    if (capturedRef.current) return
    // jsdom has no pointer capture; in browsers it keeps the drag alive
    // outside the surface.
    surfaceRef.current?.setPointerCapture?.(event.pointerId)
    capturedRef.current = true
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (disabled) return
    const node = event.target as HTMLElement
    const grabbedTarget = node
      .closest?.('[data-target-id]')
      ?.getAttribute('data-target-id')
    const onCursor = Boolean(node.closest?.('[data-cursor]'))
    dragRef.current =
      grabbedTarget && onTargetMove
        ? { kind: 'target', id: grabbedTarget }
        : { kind: 'cursor' }
    capturedRef.current = false
    // Pressing the blue dot grabs it where it sits — no teleport, and no
    // capture yet so its double-click still fires. Everything else places or
    // moves on press and captures straight away.
    if (!onCursor) {
      capture(event)
      applyDrag(event)
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (disabled || !dragRef.current) return
    // A real drag has started; now it's safe to capture (the click is gone).
    capture(event)
    applyDrag(event)
  }

  function handlePointerEnd() {
    dragRef.current = null
    capturedRef.current = false
  }

  // Double-clicking the blue dot is the "tidy up" gesture (centre the cursor,
  // fan the dots out). Only the dot, not the rest of the pad.
  function handleDoubleClick(event: MouseEvent<HTMLDivElement>) {
    if (disabled) return
    if ((event.target as HTMLElement).closest?.('[data-cursor]')) {
      onCursorActivate?.()
    }
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

  // The net: a radial strand from the cursor (the hub) to every target, plus
  // an inward-bowing web lacing neighbouring dots. Drawn under the dots and
  // inert to the pointer so dragging still hits the dots.
  const strands = targets.map((target) => ({
    id: target.id,
    d: strandPath(cursor, target),
    selected: selectedIds?.has(target.id) ?? false,
  }))
  const order = orderByAngle(targets, cursor)
  const webCount = order.length < 2 ? 0 : order.length === 2 ? 1 : order.length
  const web = Array.from({ length: webCount }, (_, index) => {
    const a = targets[order[index]]
    const b = targets[order[(index + 1) % order.length]]
    return { key: `${a.id}|${b.id}`, d: webPath(a, b) }
  })

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
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        <svg
          className="ui-xypad__net"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {web.map((segment) => (
            <path key={segment.key} className="ui-xypad__web" d={segment.d} />
          ))}
          {strands.map((strand) => (
            <path
              key={strand.id}
              className={`ui-xypad__strand${strand.selected ? ' ui-xypad__strand--selected' : ''}`}
              d={strand.d}
            />
          ))}
        </svg>
        {targets.map((target) => (
          <span
            key={target.id}
            className={`ui-xypad__target${onTargetMove ? ' ui-xypad__target--draggable' : ''}`}
            style={{ left: `${target.x * 100}%`, top: `${target.y * 100}%` }}
            data-target-id={target.id}
          >
            <span
              className={`ui-xypad__target-dot${selectedIds?.has(target.id) ? ' ui-xypad__target-dot--selected' : ''}`}
            />
            <span className="ui-xypad__target-label">{target.label}</span>
          </span>
        ))}
        <span
          className="ui-xypad__cursor"
          style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }}
          data-cursor=""
        />
        {children && (
          <div
            className="ui-xypad__overlay"
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  )
}
