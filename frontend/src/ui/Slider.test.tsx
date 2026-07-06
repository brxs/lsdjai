import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Slider } from './Slider'

describe('Slider', () => {
  it('reports the range value on change', () => {
    const onChange = vi.fn()
    const { container } = render(
      <Slider label="Temperature" min={0} max={3} step={0.01} value={1.1} onChange={onChange} />,
    )
    const input = container.querySelector('.ui-slider__input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '2' } })
    expect(onChange).toHaveBeenCalledWith(2)
  })

  it('shows a reset control that fires onReset when provided', () => {
    const onReset = vi.fn()
    const { getByLabelText } = render(
      <Slider
        label="Temperature"
        min={0}
        max={3}
        step={0.01}
        value={1.1}
        onChange={() => {}}
        onReset={onReset}
        resetLabel="Reset Temperature to default"
      />,
    )
    fireEvent.click(getByLabelText('Reset Temperature to default'))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('renders no reset control without onReset', () => {
    const { container } = render(
      <Slider label="Temperature" min={0} max={3} step={0.01} value={1.1} onChange={() => {}} />,
    )
    expect(container.querySelector('.ui-slider__reset')).toBeNull()
  })
})
