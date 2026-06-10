import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DeckPanel } from './DeckPanel'
import { initialDeckState, type DeckState } from './deckState'

const noop = () => {}

function renderPanel(state: Partial<DeckState>, handlers: Record<string, () => void> = {}) {
  return render(
    <DeckPanel
      deckId="a"
      state={{ ...initialDeckState, ...state }}
      volume={0.8}
      onPlay={handlers.onPlay ?? noop}
      onStop={handlers.onStop ?? noop}
      onSetStyle={(handlers.onSetStyle as (s: object) => void) ?? noop}
      onSetModel={(handlers.onSetModel as (m: string) => void) ?? noop}
      onRestart={handlers.onRestart ?? noop}
      onSetVolume={noop}
    />,
  )
}

describe('DeckPanel', () => {
  it('makes underruns visible, highlighted when above zero', () => {
    renderPanel({ connection: 'open', playing: true, underruns: 3 })
    const stat = screen.getByText('Underruns').parentElement!
    expect(stat).toHaveTextContent('3')
    expect(stat).toHaveClass('ui-stat--danger')
  })

  it('shows the buffer level in seconds', () => {
    renderPanel({ connection: 'open', bufferedSeconds: 2.4 })
    expect(screen.getByText('2.4s')).toBeInTheDocument()
  })

  it('flags a generation speed below real time', () => {
    renderPanel({ connection: 'open', generationSpeed: 0.84 })
    const stat = screen.getByText('Gen speed').parentElement!
    expect(stat).toHaveTextContent('0.84×')
    expect(stat).toHaveClass('ui-stat--danger')
  })

  it('disables transport until the deck is connected', () => {
    renderPanel({ connection: 'closed' })
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
  })

  it('starts playback from the play button', () => {
    const onPlay = vi.fn()
    renderPanel({ connection: 'open' }, { onPlay })
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(onPlay).toHaveBeenCalled()
  })

  it('stops playback from the stop button while playing', () => {
    const onStop = vi.fn()
    renderPanel({ connection: 'open', playing: true }, { onStop })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalled()
  })

  function addTarget(text: string) {
    fireEvent.change(screen.getByLabelText('Style target'), {
      target: { value: text },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  }

  it('applies a single centred target on add', () => {
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
    addTarget('  warm disco funk  ')
    expect(onSetStyle).toHaveBeenCalledWith({
      prompts: [{ text: 'warm disco funk', weight: 1 }],
      bpm: null,
    })
  })

  it('splits weights between targets from the centred cursor', () => {
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
    addTarget('funk')
    addTarget('techno')
    const style = onSetStyle.mock.calls.at(-1)![0]
    expect(style.prompts.map((p: { text: string }) => p.text)).toEqual([
      'funk',
      'techno',
    ])
    const [a, b] = style.prompts.map((p: { weight: number }) => p.weight)
    expect(a).toBeCloseTo(0.5)
    expect(b).toBeCloseTo(0.5)
  })

  it('removes a target from its chip and resends the style', () => {
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
    addTarget('funk')
    addTarget('techno')
    fireEvent.click(screen.getByRole('button', { name: 'Remove funk' }))
    expect(onSetStyle.mock.calls.at(-1)![0]).toEqual({
      prompts: [{ text: 'techno', weight: 1 }],
      bpm: null,
    })
  })

  it('includes a valid tempo hint and drops the style send on an invalid one', () => {
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
    fireEvent.change(screen.getByLabelText('Tempo hint (bpm)'), {
      target: { value: '124' },
    })
    addTarget('funk')
    expect(onSetStyle).toHaveBeenCalledWith({
      prompts: [{ text: 'funk', weight: 1 }],
      bpm: 124,
    })

    onSetStyle.mockClear()
    fireEvent.change(screen.getByLabelText('Tempo hint (bpm)'), {
      target: { value: '999' },
    })
    addTarget('techno')
    expect(onSetStyle).not.toHaveBeenCalled()
  })

  it('keeps the pad locked until there are two targets to blend', () => {
    renderPanel({ connection: 'open' })
    expect(screen.getByLabelText('Style pad')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('moves the cursor by keyboard and sends reweighted styles', () => {
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
    addTarget('funk')
    addTarget('techno')
    onSetStyle.mockClear()

    const pad = screen.getByLabelText('Style pad')
    fireEvent.keyDown(pad, { key: 'ArrowUp' })
    expect(onSetStyle).toHaveBeenCalledTimes(1)
    const style = onSetStyle.mock.calls.at(-1)![0]
    // Two targets sit at 12 and 6 o'clock; moving up favours the first.
    expect(style.prompts[0].weight).toBeGreaterThan(style.prompts[1].weight)
  })

  it('shows the active blend summary', () => {
    renderPanel({
      connection: 'open',
      activeStyle: {
        prompts: [
          { text: 'funk', weight: 0.7 },
          { text: 'techno', weight: 0.3 },
        ],
        bpm: 124,
      },
    })
    expect(screen.getByText('Playing: 70% funk · 30% techno')).toBeInTheDocument()
  })

  it('offers the model picker and reports a selection', () => {
    const onSetModel = vi.fn()
    renderPanel(
      {
        connection: 'open',
        model: 'mrt2_small',
        availableModels: ['mrt2_small', 'mrt2_base'],
      },
      { onSetModel: onSetModel as () => void },
    )
    fireEvent.change(screen.getByLabelText('Model'), {
      target: { value: 'mrt2_base' },
    })
    expect(onSetModel).toHaveBeenCalledWith('mrt2_base')
  })

  it('locks the deck while a model is loading', () => {
    renderPanel({
      connection: 'open',
      switchingModel: true,
      model: 'mrt2_base',
      availableModels: ['mrt2_small', 'mrt2_base'],
    })
    expect(screen.getByText('Loading model…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.getByLabelText('Model')).toBeDisabled()
  })

  it('offers recovery when the worker died', () => {
    const onRestart = vi.fn()
    renderPanel(
      {
        connection: 'open',
        workerDied: true,
        model: 'mrt2_base',
        availableModels: ['mrt2_small', 'mrt2_base'],
      },
      { onRestart },
    )
    expect(screen.getByRole('alert')).toHaveTextContent('The deck engine crashed.')
    fireEvent.click(screen.getByRole('button', { name: 'Restart deck' }))
    expect(onRestart).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    // Recovery from a model that cannot load is switching to one that can —
    // the picker must stay usable while the worker is dead.
    expect(screen.getByLabelText('Model')).toBeEnabled()
  })

  it('announces worker errors', () => {
    renderPanel({ connection: 'open', error: 'generation failed; deck stopped' })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'generation failed; deck stopped',
    )
  })
})
