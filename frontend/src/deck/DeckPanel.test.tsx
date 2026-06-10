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

  it('applies a trimmed single-prompt style', () => {
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
    fireEvent.change(screen.getByLabelText('Prompt A'), {
      target: { value: '  warm disco funk  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set style' }))
    expect(onSetStyle).toHaveBeenCalledWith({
      promptA: 'warm disco funk',
      promptB: null,
      mix: 0,
      bpm: null,
    })
  })

  it('applies a morph style with both prompts and a tempo hint', () => {
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
    fireEvent.change(screen.getByLabelText('Prompt A'), {
      target: { value: 'warm disco funk' },
    })
    fireEvent.change(screen.getByLabelText('Prompt B (morph target)'), {
      target: { value: 'dark minimal techno' },
    })
    fireEvent.change(screen.getByLabelText('Tempo hint (bpm)'), {
      target: { value: '124' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Set style' }))
    expect(onSetStyle).toHaveBeenCalledWith({
      promptA: 'warm disco funk',
      promptB: 'dark minimal techno',
      mix: 0,
      bpm: 124,
    })
  })

  it('rejects an out-of-range tempo hint by disabling apply', () => {
    renderPanel({ connection: 'open' })
    fireEvent.change(screen.getByLabelText('Prompt A'), {
      target: { value: 'funk' },
    })
    fireEvent.change(screen.getByLabelText('Tempo hint (bpm)'), {
      target: { value: '999' },
    })
    expect(screen.getByRole('button', { name: 'Set style' })).toBeDisabled()
  })

  it('keeps the morph slider locked until a morph target is active', () => {
    renderPanel({ connection: 'open' })
    expect(screen.getByLabelText('Morph A ↔ B')).toBeDisabled()
  })

  it('rides the morph slider live against the active style', () => {
    const onSetStyle = vi.fn()
    renderPanel(
      {
        connection: 'open',
        activeStyle: { promptA: 'funk', promptB: 'techno', mix: 0.2, bpm: null },
      },
      { onSetStyle: onSetStyle as () => void },
    )
    const slider = screen.getByLabelText('Morph A ↔ B')
    expect(slider).toBeEnabled()
    fireEvent.change(slider, { target: { value: '0.8' } })
    expect(onSetStyle).toHaveBeenCalledWith({
      promptA: 'funk',
      promptB: 'techno',
      mix: 0.8,
      bpm: null,
    })
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
