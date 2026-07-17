import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { LoraRack } from './LoraRack'

const ADAPTERS = [
  { name: 'small/gamelan', label: 'gamelan' },
  { name: 'small/tape-drums', label: 'tape-drums' },
  { name: 'small/vinyl-noise', label: 'vinyl-noise' },
]

describe('LoraRack', () => {
  it('renders nothing at all without adapters', () => {
    const { container } = render(
      <LoraRack adapters={[]} value={[]} onToggle={() => {}} onStrength={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders every adapter as a chip and marks the stacked ones', () => {
    render(
      <LoraRack
        adapters={ADAPTERS}
        value={[{ name: 'small/gamelan', strength: 1 }]}
        onToggle={() => {}}
        onStrength={() => {}}
      />,
    )
    expect(screen.getByText('gamelan')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('tape-drums')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('vinyl-noise')).toHaveAttribute('aria-pressed', 'false')
  })

  it('signals a toggle for chips in and out of the stack', () => {
    const onToggle = vi.fn()
    render(
      <LoraRack
        adapters={ADAPTERS}
        value={[{ name: 'small/gamelan', strength: 1 }]}
        onToggle={onToggle}
        onStrength={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('tape-drums')) // into the stack
    fireEvent.click(screen.getByText('gamelan')) // out of it
    expect(onToggle.mock.calls).toEqual([['small/tape-drums'], ['small/gamelan']])
  })

  it('shows a trim knob only for stacked adapters and reports turns', () => {
    const onStrength = vi.fn()
    render(
      <LoraRack
        adapters={ADAPTERS}
        value={[{ name: 'small/gamelan', strength: 1 }]}
        onToggle={() => {}}
        onStrength={onStrength}
      />,
    )
    expect(screen.queryByLabelText('tape-drums strength')).toBeNull()
    const knob = screen.getByLabelText('gamelan strength')
    fireEvent.change(knob, { target: { value: '0.5' } })
    expect(onStrength).toHaveBeenCalledWith('small/gamelan', 0.5)
  })

  it('parks the trim back at ×1 on double-click', () => {
    const onStrength = vi.fn()
    render(
      <LoraRack
        adapters={ADAPTERS}
        value={[{ name: 'small/gamelan', strength: 0.25 }]}
        onToggle={() => {}}
        onStrength={onStrength}
      />,
    )
    fireEvent.doubleClick(screen.getByLabelText('gamelan strength'))
    expect(onStrength).toHaveBeenCalledWith('small/gamelan', 1)
  })

  it('dims a slot at ×0 — in the stack, bit-exact silent', () => {
    render(
      <LoraRack
        adapters={ADAPTERS}
        value={[{ name: 'small/gamelan', strength: 0 }]}
        onToggle={() => {}}
        onStrength={() => {}}
      />,
    )
    const slot = screen.getByText('gamelan').closest('.ui-lorarack__slot')
    expect(slot).toHaveClass('ui-lorarack__slot--bypass')
    expect(screen.getByText('×0')).toBeInTheDocument()
  })

  it('disables the remaining chips once the stack hits the cap', () => {
    render(
      <LoraRack
        adapters={ADAPTERS}
        value={[
          { name: 'small/gamelan', strength: 1 },
          { name: 'small/tape-drums', strength: 1 },
        ]}
        onToggle={() => {}}
        onStrength={() => {}}
        max={2}
      />,
    )
    expect(screen.getByText('vinyl-noise')).toBeDisabled()
    // Stacked chips stay clickable — dropping out must always be possible.
    expect(screen.getByText('gamelan')).toBeEnabled()
  })
})
