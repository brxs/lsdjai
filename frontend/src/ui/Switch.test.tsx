import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Switch } from './Switch'

describe('Switch', () => {
  it('is a labelled switch carrying its state on aria-checked', () => {
    const { rerender } = render(<Switch label="MIDI steering" on={false} />)
    const toggle = screen.getByRole('switch', { name: 'MIDI steering' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(toggle.className).not.toContain('ui-switch--on')
    rerender(<Switch label="MIDI steering" on />)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(toggle.className).toContain('ui-switch--on')
  })

  it('flips through the caller and takes the deck accent variant', () => {
    const onClick = vi.fn()
    render(<Switch label="Cue" on accent="b" onClick={onClick} />)
    const toggle = screen.getByRole('switch', { name: 'Cue' })
    expect(toggle.className).toContain('ui-switch--b')
    fireEvent.click(toggle)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
