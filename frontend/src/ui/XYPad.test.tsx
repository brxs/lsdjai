import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { XYPad, type XYPadTarget } from './XYPad'

const targets: XYPadTarget[] = [
  { id: 'funk', label: 'funk', x: 0.5, y: 0.2 },
  { id: 'techno', label: 'techno', x: 0.5, y: 0.8 },
  { id: 'dub', label: 'dub', x: 0.2, y: 0.5 },
]

const centre = { x: 0.5, y: 0.5 }

describe('XYPad net', () => {
  it('draws one radial strand per target', () => {
    const { container } = render(
      <XYPad label="Pad" targets={targets} cursor={centre} onChange={() => {}} />,
    )
    expect(container.querySelectorAll('.ui-xypad__strand')).toHaveLength(3)
  })

  it('laces three or more dots into a closed web', () => {
    const { container } = render(
      <XYPad label="Pad" targets={targets} cursor={centre} onChange={() => {}} />,
    )
    expect(container.querySelectorAll('.ui-xypad__web')).toHaveLength(3)
  })

  it('draws a single web thread between exactly two dots', () => {
    const { container } = render(
      <XYPad
        label="Pad"
        targets={targets.slice(0, 2)}
        cursor={centre}
        onChange={() => {}}
      />,
    )
    expect(container.querySelectorAll('.ui-xypad__web')).toHaveLength(1)
  })

  it('highlights only the selected strand and dot', () => {
    const { container } = render(
      <XYPad
        label="Pad"
        targets={targets}
        cursor={centre}
        onChange={() => {}}
        selectedIds={new Set(['techno'])}
      />,
    )
    expect(
      container.querySelectorAll('.ui-xypad__strand--selected'),
    ).toHaveLength(1)
    expect(
      container.querySelectorAll('.ui-xypad__target-dot--selected'),
    ).toHaveLength(1)
  })

  it('keeps the net out of the accessibility tree', () => {
    const { container } = render(
      <XYPad label="Pad" targets={targets} cursor={centre} onChange={() => {}} />,
    )
    expect(
      container.querySelector('.ui-xypad__net')?.getAttribute('aria-hidden'),
    ).toBe('true')
  })

  it('fires onCursorActivate when the blue dot is double-clicked', () => {
    const onCursorActivate = vi.fn()
    const { container } = render(
      <XYPad
        label="Pad"
        targets={targets}
        cursor={centre}
        onChange={() => {}}
        onCursorActivate={onCursorActivate}
      />,
    )
    fireEvent.doubleClick(container.querySelector('[data-cursor]')!)
    expect(onCursorActivate).toHaveBeenCalledTimes(1)
  })

  it('ignores a double-click that is not on the blue dot', () => {
    const onCursorActivate = vi.fn()
    const { container } = render(
      <XYPad
        label="Pad"
        targets={targets}
        cursor={centre}
        onChange={() => {}}
        onCursorActivate={onCursorActivate}
      />,
    )
    fireEvent.doubleClick(container.querySelector('.ui-xypad__surface')!)
    expect(onCursorActivate).not.toHaveBeenCalled()
  })
})
