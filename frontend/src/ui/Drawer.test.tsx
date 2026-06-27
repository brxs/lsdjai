import { fireEvent, render, screen } from '@testing-library/react'
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
})
