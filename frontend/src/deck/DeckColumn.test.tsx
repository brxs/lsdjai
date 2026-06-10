import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { createControlBus, type ControlBus } from '../control/bus'
import { ControlBusProvider } from '../control/ControlBusProvider'
import { updateDeckSettings } from '../persistence'
import { DeckColumn } from './DeckColumn'
import { initialDeckState, type DeckState } from './deckState'

const noop = () => {}

function renderPanel(
  state: Partial<DeckState>,
  handlers: Record<string, () => void> = {},
  bus: ControlBus = createControlBus(),
) {
  return render(
    <ControlBusProvider bus={bus}>
      <DeckColumn
        deckId="a"
        state={{ ...initialDeckState, ...state }}
        getWaveformRange={() => [0, 0]}
        onPlay={handlers.onPlay ?? noop}
        onStop={handlers.onStop ?? noop}
        onSetStyle={(handlers.onSetStyle as (s: object) => void) ?? noop}
        onSetModel={(handlers.onSetModel as (m: string) => void) ?? noop}
        onRestart={handlers.onRestart ?? noop}
        onTargetCount={handlers.onTargetCount as (count: number) => void}
      />
    </ControlBusProvider>,
  )
}

describe('DeckColumn', () => {
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
    })
  })

  it('keeps the pad locked until there are two targets to blend', () => {
    renderPanel({ connection: 'open' })
    expect(screen.getByLabelText('Style pad')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('moves the cursor by keyboard and sends reweighted styles', () => {
    vi.useFakeTimers()
    try {
      const onSetStyle = vi.fn()
      renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
      addTarget('funk')
      addTarget('techno')
      onSetStyle.mockClear()

      const pad = screen.getByLabelText('Style pad')
      fireEvent.keyDown(pad, { key: 'ArrowUp' })
      vi.advanceTimersByTime(300) // inside the throttle window → trailing send
      expect(onSetStyle).toHaveBeenCalledTimes(1)
      const style = onSetStyle.mock.calls.at(-1)![0]
      // Two targets sit at 12 and 6 o'clock; moving up favours the first.
      expect(style.prompts[0].weight).toBeGreaterThan(style.prompts[1].weight)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never resurrects a removed target via a stale trailing send', () => {
    vi.useFakeTimers()
    try {
      const onSetStyle = vi.fn()
      renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
      addTarget('funk')
      addTarget('techno')

      // Two quick cursor moves: the second lands inside the throttle window
      // and queues a trailing send that still references both targets.
      const pad = screen.getByLabelText('Style pad')
      fireEvent.keyDown(pad, { key: 'ArrowUp' })
      fireEvent.keyDown(pad, { key: 'ArrowUp' })

      // Remove funk before the trailing send fires.
      fireEvent.click(screen.getByRole('button', { name: 'Remove funk' }))
      vi.advanceTimersByTime(500)

      const finalStyle = onSetStyle.mock.calls.at(-1)![0]
      expect(
        finalStyle.prompts.map((prompt: { text: string }) => prompt.text),
      ).toEqual(['techno'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drags a target dot under the cursor and resends its dominant weight', () => {
    vi.useFakeTimers()
    try {
      const onSetStyle = vi.fn()
      renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
      addTarget('funk')
      addTarget('techno')
      onSetStyle.mockClear()

      const surface = screen.getByLabelText('Style pad')
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        right: 100,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect)

      // Grab the funk dot (12 o'clock) and drop it just beside the centred
      // cursor — a cluster move.
      fireEvent.pointerDown(screen.getByText('funk'), {
        clientX: 50,
        clientY: 12,
        pointerId: 1,
      })
      fireEvent.pointerMove(surface, { clientX: 51, clientY: 50, pointerId: 1 })
      fireEvent.pointerUp(surface, { pointerId: 1 })
      vi.advanceTimersByTime(300) // flush the throttle's trailing send

      const style = onSetStyle.mock.calls.at(-1)![0]
      expect(style.prompts[0].text).toBe('funk')
      expect(style.prompts[0].weight).toBeGreaterThan(0.9)
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores persisted targets and re-applies the style to a fresh worker', () => {
    updateDeckSettings('a', {
      targets: [
        { text: 'funk', x: 0.2, y: 0.2 },
        { text: 'techno', x: 0.8, y: 0.8 },
      ],
      cursor: { x: 0.2, y: 0.2 },
    })
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })

    // The arrangement is restored…
    expect(screen.getByRole('button', { name: 'Remove funk' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove techno' })).toBeInTheDocument()
    // …and re-sent once (cursor sits on funk, so funk dominates).
    expect(onSetStyle).toHaveBeenCalledTimes(1)
    const style = onSetStyle.mock.calls[0][0]
    expect(style.prompts[0]).toEqual({ text: 'funk', weight: 1 })
  })

  it('shows the active blend summary', () => {
    renderPanel({
      connection: 'open',
      activeStyle: {
        prompts: [
          { text: 'funk', weight: 0.7 },
          { text: 'techno', weight: 0.3 },
        ],
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

  it('reports the style target count for the pad LED echo', () => {
    const onTargetCount = vi.fn()
    renderPanel({ connection: 'open' }, { onTargetCount: onTargetCount as () => void })
    expect(onTargetCount).toHaveBeenLastCalledWith(0)
    addTarget('funk')
    expect(onTargetCount).toHaveBeenLastCalledWith(1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove funk' }))
    expect(onTargetCount).toHaveBeenLastCalledWith(0)
  })

  it('snaps the cursor onto a pad target from the control bus', () => {
    const onSetStyle = vi.fn()
    const bus = createControlBus()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void }, bus)
    addTarget('funk')
    addTarget('techno')

    act(() => bus.publish({ kind: 'style_target', deck: 'a', index: 1 }))

    expect(onSetStyle.mock.calls.at(-1)![0]).toEqual({
      prompts: [
        { text: 'funk', weight: 0 },
        { text: 'techno', weight: 1 },
      ],
    })
  })

  it('sweeps the cursor around the target circle from the control bus', () => {
    vi.useFakeTimers()
    try {
      const onSetStyle = vi.fn()
      const bus = createControlBus()
      renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void }, bus)
      addTarget('funk') // spawns at 12 o'clock — exactly where sweep 0 lands
      addTarget('techno')
      onSetStyle.mockClear()

      act(() => bus.publish({ kind: 'style_sweep', deck: 'a', value: 0 }))
      act(() => vi.advanceTimersByTime(300)) // flush the throttle's trailing send

      expect(onSetStyle.mock.calls.at(-1)![0]).toEqual({
        prompts: [
          { text: 'funk', weight: 1 },
          { text: 'techno', weight: 0 },
        ],
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores style intents addressed to the other deck', () => {
    const onSetStyle = vi.fn()
    const bus = createControlBus()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void }, bus)
    addTarget('funk')
    onSetStyle.mockClear()

    act(() => bus.publish({ kind: 'style_target', deck: 'b', index: 0 }))
    act(() => bus.publish({ kind: 'style_sweep', deck: 'b', value: 0.5 }))

    expect(onSetStyle).not.toHaveBeenCalled()
  })

  it('ignores hardware style intents while the deck cannot take them', () => {
    updateDeckSettings('a', {
      targets: [{ text: 'funk', x: 0.5, y: 0.12 }],
      cursor: { x: 0.5, y: 0.5 },
    })
    const onSetStyle = vi.fn()
    const bus = createControlBus()
    renderPanel(
      { connection: 'open', switchingModel: true },
      { onSetStyle: onSetStyle as () => void },
      bus,
    )

    act(() => bus.publish({ kind: 'style_target', deck: 'a', index: 0 }))

    expect(onSetStyle).not.toHaveBeenCalled()
  })
})
