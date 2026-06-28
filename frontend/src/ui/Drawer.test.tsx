import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Drawer } from './Drawer'

function renderDrawer(open: boolean) {
  const onClose = vi.fn()
  const view = render(
    <Drawer open={open} onClose={onClose} title="Settings" closeLabel="Close">
      <button>inside</button>
    </Drawer>,
  )
  return { onClose, ...view }
}

describe('Drawer', () => {
  it('renders nothing while closed', () => {
    renderDrawer(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a labelled modal dialog when open', () => {
    renderDrawer(true)
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })

  it('closes on the close button', () => {
    const { onClose } = renderDrawer(true)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    const { onClose } = renderDrawer(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a scrim click', () => {
    const { onClose, container } = renderDrawer(true)
    const scrim = container.querySelector('.ui-drawer__scrim')
    expect(scrim).not.toBeNull()
    fireEvent.click(scrim as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not steal focus back to the panel when it re-renders while open', () => {
    // Regression: the focus-trap effect depended on onClose — an inline closure,
    // fresh every parent render — so a re-render re-ran panel.focus() and dismissed
    // an open native <select>. While a deck plays App re-renders ~10 Hz, closing any
    // open Settings select. Focus must move in only when `open` flips true.
    function Harness() {
      const [, force] = useState(0)
      return (
        <>
          <button onClick={() => force((n) => n + 1)}>force</button>
          {/* inline onClose: a fresh reference every render — the realistic call site */}
          <Drawer open onClose={() => {}} title="Settings" closeLabel="Close">
            <select aria-label="pick">
              <option>a</option>
            </select>
          </Drawer>
        </>
      )
    }
    render(<Harness />)
    const pick = screen.getByLabelText('pick')
    pick.focus()
    expect(document.activeElement).toBe(pick)

    act(() => {
      fireEvent.click(screen.getByText('force'))
    })
    // The Drawer did NOT re-focus the panel — the open child keeps focus.
    expect(document.activeElement).toBe(pick)
  })
})
