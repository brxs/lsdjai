import { act, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { FxKind } from '../audio/fx'
import { createControlBus, type ControlBus } from '../control/bus'
import { ControlBusProvider } from '../control/ControlBusProvider'
import { loadDeckSettings, updateDeckSettings } from '../persistence'
import { DeckColumn } from './DeckColumn'
import { initialDeckState, type DeckState } from './deckState'
import type { DeckMode, LoopState, TrackState } from './useDeck'

const noop = () => {}

const emptyLoop = (): LoopState => ({
  slots: Array.from({ length: 4 }, () => ({ state: 'empty' })),
  active: null,
  seconds: 4,
})

function renderPanel(
  state: Partial<DeckState>,
  handlers: Record<string, () => void> = {},
  bus: ControlBus = createControlBus(),
  fx: { kind: FxKind | null; amount: number } = { kind: null, amount: 0 },
  loop: LoopState = emptyLoop(),
  bpm: number | null = null,
  canSample = true,
  generateError: string | null = null,
  playback: { mode: DeckMode; track: TrackState | null } = {
    mode: 'realtime',
    track: null,
  },
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
        fx={fx}
        onSetFx={(handlers.onSetFx as (k: unknown) => void) ?? noop}
        onSetFxAmount={(handlers.onSetFxAmount as (v: number) => void) ?? noop}
        loop={loop}
        onLoopPad={(handlers.onLoopPad as (slot: number) => void) ?? noop}
        onClearLoopPad={
          (handlers.onClearLoopPad as (slot: number) => void) ?? noop
        }
        onSetLoopSeconds={
          (handlers.onSetLoopSeconds as (seconds: number) => void) ?? noop
        }
        onGenerateToPad={
          (handlers.onGenerateToPad as (prompt: string, kind: string) => void) ??
          noop
        }
        generateError={generateError}
        bpm={bpm}
        onSampleOtherDeck={
          (handlers.onSampleOtherDeck as () => Promise<{
            label: string
            sample: string
          } | null>) ?? (async () => null)
        }
        canSample={canSample}
        onSavePreset={
          (handlers.onSavePreset as (preset: object) => void) ?? noop
        }
        mode={playback.mode}
        track={playback.track}
        onLeavePlayback={handlers.onLeavePlayback ?? noop}
        onSeekTrack={(handlers.onSeekTrack as (s: number) => void) ?? noop}
        getTrackPeaks={() => null}
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

  function editTarget(prompt: string, replacement: string) {
    fireEvent.click(screen.getByRole('button', { name: `Edit ${prompt}` }))
    const field = screen.getByRole('textbox', { name: `Edit ${prompt}` })
    fireEvent.change(field, { target: { value: replacement } })
    fireEvent.keyDown(field, { key: 'Enter' })
  }

  it('edits a prompt in place, keeping its spot and resending the style', () => {
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
    addTarget('fnuk')
    addTarget('techno')
    onSetStyle.mockClear()

    editTarget('fnuk', '  funk  ')
    expect(
      screen.getByRole('button', { name: 'Remove funk' }),
    ).toBeInTheDocument()
    // The renamed target keeps its slot (and therefore its weight).
    const style = onSetStyle.mock.calls.at(-1)![0]
    expect(style.prompts.map((p: { text: string }) => p.text)).toEqual([
      'funk',
      'techno',
    ])
    expect(style.prompts[0].weight).toBeCloseTo(0.5)
  })

  it('escape cancels an edit without touching the style', () => {
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
    addTarget('funk')
    onSetStyle.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Edit funk' }))
    const field = screen.getByRole('textbox', { name: 'Edit funk' })
    fireEvent.change(field, { target: { value: 'techno' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Remove funk' })).toBeInTheDocument()
    expect(onSetStyle).not.toHaveBeenCalled()
  })

  it('a rename that collides with another chip cancels quietly', () => {
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
    addTarget('funk')
    addTarget('techno')
    onSetStyle.mockClear()

    editTarget('funk', 'techno')
    expect(screen.getByRole('button', { name: 'Remove funk' })).toBeInTheDocument()
    expect(onSetStyle).not.toHaveBeenCalled()
  })

  it.each([
    ['an emptied draft', '   '],
    ['an unchanged draft', 'funk'],
  ])('%s cancels quietly without a send', (_label, replacement) => {
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
    addTarget('funk')
    onSetStyle.mockClear()

    editTarget('funk', replacement)
    expect(screen.getByRole('button', { name: 'Remove funk' })).toBeInTheDocument()
    expect(onSetStyle).not.toHaveBeenCalled()
  })

  it('returns focus to the row after a keyboard commit or cancel', () => {
    renderPanel({ connection: 'open' })
    addTarget('fnuk')

    editTarget('fnuk', 'funk') // Enter
    expect(screen.getByRole('button', { name: 'Edit funk' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Edit funk' }))
    const field = screen.getByRole('textbox', { name: 'Edit funk' })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Edit funk' })).toHaveFocus()
  })

  it('an edit open when the deck becomes inoperable cancels instead of committing', () => {
    const onSetStyle = vi.fn()
    const bus = createControlBus()
    const view = renderPanel(
      { connection: 'open' },
      { onSetStyle: onSetStyle as () => void },
      bus,
    )
    addTarget('funk')
    onSetStyle.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Edit funk' }))
    const field = screen.getByRole('textbox', { name: 'Edit funk' })
    fireEvent.change(field, { target: { value: 'techno' } })
    // The model switch starts while the edit is open.
    view.rerender(
      <ControlBusProvider bus={bus}>
        <DeckColumn
          deckId="a"
          state={{ ...initialDeckState, connection: 'open', switchingModel: true }}
          getWaveformRange={() => [0, 0]}
          onPlay={noop}
          onStop={noop}
          onSetStyle={onSetStyle as (s: object) => void}
          onSetModel={noop as (m: string) => void}
          onRestart={noop}
          fx={{ kind: null, amount: 0 }}
          onSetFx={noop as (k: unknown) => void}
          onSetFxAmount={noop as (v: number) => void}
          loop={emptyLoop()}
          onGenerateToPad={noop as (prompt: string, kind: string) => void}
          generateError={null}
          onLoopPad={noop as (slot: number) => void}
          onClearLoopPad={noop as (slot: number) => void}
          onSetLoopSeconds={noop as (seconds: number) => void}
          bpm={null}
          onSampleOtherDeck={async () => null}
          canSample
          onSavePreset={noop as (preset: object) => void}
          mode="realtime"
          track={null}
          onLeavePlayback={noop}
          onSeekTrack={noop as (s: number) => void}
          getTrackPeaks={() => null}
        />
      </ControlBusProvider>,
    )
    fireEvent.keyDown(
      screen.getByRole('textbox', { name: 'Edit funk' }),
      { key: 'Enter' },
    )
    expect(
      screen.getByRole('button', { name: 'Remove funk' }),
    ).toBeInTheDocument()
    expect(onSetStyle).not.toHaveBeenCalled()
    expect(
      (loadDeckSettings('a').targets ?? []).map((target) => target.text),
    ).toEqual(['funk'])
  })

  it('a preset load closes an open edit instead of leaving a stale draft', () => {
    const bus = createControlBus()
    renderPanel({ connection: 'open' }, {}, bus)
    addTarget('funk')
    fireEvent.click(screen.getByRole('button', { name: 'Edit funk' }))
    expect(screen.getByRole('textbox', { name: 'Edit funk' })).toBeInTheDocument()

    act(() =>
      bus.publish({
        kind: 'preset_load',
        deck: 'a',
        preset: {
          name: 'Other',
          targets: [{ text: 'dub', x: 0.5, y: 0.5 }],
          cursor: { x: 0.5, y: 0.5 },
          fx: { kind: null, amount: 0 },
        },
      }),
    )
    expect(
      screen.queryByRole('textbox', { name: 'Edit funk' }),
    ).not.toBeInTheDocument()
    // Re-adding the same text must render a plain row, not a
    // pre-opened editor with the stale draft.
    addTarget('funk')
    expect(
      screen.queryByRole('textbox', { name: 'Edit funk' }),
    ).not.toBeInTheDocument()
  })

  it('blurring the edit field commits like Enter', () => {
    const onSetStyle = vi.fn()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void })
    addTarget('funk')
    onSetStyle.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Edit funk' }))
    const field = screen.getByRole('textbox', { name: 'Edit funk' })
    fireEvent.change(field, { target: { value: 'dub' } })
    fireEvent.blur(field)
    expect(screen.getByRole('button', { name: 'Remove dub' })).toBeInTheDocument()
    expect(onSetStyle).toHaveBeenCalledWith({
      prompts: [{ text: 'dub', weight: 1 }],
    })
  })

  it('a rename persists like any other pad change', () => {
    renderPanel({ connection: 'open' })
    addTarget('fnuk')
    editTarget('fnuk', 'funk')
    expect(
      (loadDeckSettings('a').targets ?? []).map((target) => target.text),
    ).toEqual(['funk'])
  })

  it('sampled chips are not editable — their label names a moment', async () => {
    const onSampleOtherDeck = vi.fn(async () => ({
      label: '⏺ B·1',
      sample: 'sample:b:1',
    }))
    renderPanel(
      { connection: 'open' },
      { onSampleOtherDeck: onSampleOtherDeck as unknown as () => void },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sample deck B' }))
    await screen.findByRole('button', { name: 'Remove ⏺ B·1' })
    // aria-disabled, not disabled: the button stays focusable so a
    // screen reader hears WHY instead of skipping the control.
    const edit = screen.getByRole('button', { name: 'Edit ⏺ B·1' })
    expect(edit).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(edit)
    expect(
      screen.queryByRole('textbox', { name: 'Edit ⏺ B·1' }),
    ).not.toBeInTheDocument()
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
      // The chip's text button also says 'funk' now — address the
      // pad dot's label specifically.
      fireEvent.pointerDown(
        screen.getByText('funk', { selector: '.ui-xypad__target-label' }),
        { clientX: 50, clientY: 12, pointerId: 1 },
      )
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

  it('selects a Color FX by name and reports knob moves', () => {
    const onSetFx = vi.fn()
    const onSetFxAmount = vi.fn()
    renderPanel(
      { connection: 'open' },
      { onSetFx: onSetFx as () => void, onSetFxAmount: onSetFxAmount as () => void },
      createControlBus(),
      { kind: 'filter', amount: 0.5 },
    )

    fireEvent.change(screen.getByLabelText('Effect'), {
      target: { value: 'dub_echo' },
    })
    expect(onSetFx).toHaveBeenCalledWith('dub_echo')
    // The option shows translated copy while the value stays the kind.
    expect(screen.getByRole('option', { name: 'Dub Echo' })).toHaveValue(
      'dub_echo',
    )

    fireEvent.change(screen.getByLabelText('FX amount'), {
      target: { value: '0.8' },
    })
    expect(onSetFxAmount).toHaveBeenCalledWith(0.8)
  })

  it('switching FX off and disabling the knob', () => {
    const onSetFx = vi.fn()
    renderPanel(
      { connection: 'open' },
      { onSetFx: onSetFx as () => void },
      createControlBus(),
      { kind: null, amount: 0 },
    )
    expect(screen.getByLabelText('Effect')).toHaveValue('')
    expect(screen.getByLabelText('FX amount')).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Effect'), {
      target: { value: '' },
    })
    expect(onSetFx).toHaveBeenCalledWith(null)
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

  it('samples the other deck onto the pad and sends the blend', async () => {
    const onSampleOtherDeck = vi.fn(async () => ({
      label: '⏺ B·1',
      sample: 'sample:b:1',
    }))
    const onSetStyle = vi.fn()
    renderPanel(
      { connection: 'open' },
      {
        onSampleOtherDeck: onSampleOtherDeck as unknown as () => void,
        onSetStyle: onSetStyle as () => void,
      },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sample deck B' }))
    expect(
      await screen.findByRole('button', { name: 'Remove ⏺ B·1' }),
    ).toBeInTheDocument()
    expect(onSetStyle).toHaveBeenCalledWith({
      prompts: [{ text: '⏺ B·1', weight: 1, sample: 'sample:b:1' }],
    })
  })

  it('sends the sampled blend exactly once under StrictMode', async () => {
    // Guards the updater-purity fix: a sendStyle smuggled into a
    // setTargets updater double-fires when StrictMode replays it.
    const onSampleOtherDeck = vi.fn(async () => ({
      label: '⏺ B·1',
      sample: 'sample:b:1',
    }))
    const onSetStyle = vi.fn()
    render(
      <StrictMode>
        <ControlBusProvider bus={createControlBus()}>
          <DeckColumn
            deckId="a"
            // activeStyle set: keeps the reload-resend effect quiet so
            // the only sender under test is the sampling handler.
            state={{
              ...initialDeckState,
              connection: 'open',
              activeStyle: { prompts: [{ text: 'x', weight: 1 }] },
            }}
            getWaveformRange={() => [0, 0]}
            onPlay={noop}
            onStop={noop}
            onSetStyle={onSetStyle as (s: object) => void}
            onSetModel={noop as (m: string) => void}
            onRestart={noop}
            fx={{ kind: null, amount: 0 }}
            onSetFx={noop as (k: unknown) => void}
            onSetFxAmount={noop as (v: number) => void}
            loop={emptyLoop()}
            onGenerateToPad={noop as (prompt: string, kind: string) => void}
            generateError={null}
            onLoopPad={noop as (slot: number) => void}
            onClearLoopPad={noop as (slot: number) => void}
            onSetLoopSeconds={noop as (seconds: number) => void}
            bpm={null}
            onSampleOtherDeck={onSampleOtherDeck}
            canSample
            onSavePreset={noop as (preset: object) => void}
            mode="realtime"
            track={null}
            onLeavePlayback={noop}
            onSeekTrack={noop as (s: number) => void}
            getTrackPeaks={() => null}
          />
        </ControlBusProvider>
      </StrictMode>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sample deck B' }))
    await screen.findByRole('button', { name: 'Remove ⏺ B·1' })
    expect(onSetStyle).toHaveBeenCalledTimes(1)
  })

  it('reports an honest reason when the other deck has not played enough', async () => {
    const onSampleOtherDeck = vi.fn(async () => null)
    renderPanel(
      { connection: 'open' },
      { onSampleOtherDeck: onSampleOtherDeck as unknown as () => void },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sample deck B' }))
    expect(
      await screen.findByText(
        "Sampling failed: the other deck hasn't played enough yet",
      ),
    ).toBeInTheDocument()
  })

  it('disables sampling while the other deck is silent', () => {
    renderPanel(
      { connection: 'open' },
      {},
      createControlBus(),
      { kind: null, amount: 0 },
      emptyLoop(),
      null,
      false,
    )
    expect(screen.getByRole('button', { name: 'Sample deck B' })).toBeDisabled()
  })

  it('shows the reason when sampling fails', async () => {
    const onSampleOtherDeck = vi.fn(async () => {
      throw new Error('deck is loading a model')
    })
    renderPanel(
      { connection: 'open' },
      { onSampleOtherDeck: onSampleOtherDeck as unknown as () => void },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sample deck B' }))
    expect(
      await screen.findByText('Sampling failed: deck is loading a model'),
    ).toBeInTheDocument()
  })

  it('keeps sampled targets out of persistence', async () => {
    const onSampleOtherDeck = vi.fn(async () => ({
      label: '⏺ B·1',
      sample: 'sample:b:1',
    }))
    renderPanel(
      { connection: 'open' },
      { onSampleOtherDeck: onSampleOtherDeck as unknown as () => void },
    )
    addTarget('funk')
    fireEvent.click(screen.getByRole('button', { name: 'Sample deck B' }))
    await screen.findByRole('button', { name: 'Remove ⏺ B·1' })
    const persisted = loadDeckSettings('a').targets ?? []
    expect(persisted.map((target) => target.text)).toEqual(['funk'])
  })

  it('drops sampled targets when the worker dies', async () => {
    const onSampleOtherDeck = vi.fn(async () => ({
      label: '⏺ B·1',
      sample: 'sample:b:1',
    }))
    const { rerender } = renderPanel(
      { connection: 'open' },
      { onSampleOtherDeck: onSampleOtherDeck as unknown as () => void },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sample deck B' }))
    await screen.findByRole('button', { name: 'Remove ⏺ B·1' })

    rerender(
      <ControlBusProvider bus={createControlBus()}>
        <DeckColumn
          deckId="a"
          state={{ ...initialDeckState, connection: 'open', workerDied: true }}
          getWaveformRange={() => [0, 0]}
          onPlay={noop}
          onStop={noop}
          onSetStyle={noop as (s: object) => void}
          onSetModel={noop as (m: string) => void}
          onRestart={noop}
          fx={{ kind: null, amount: 0 }}
          onSetFx={noop as (k: unknown) => void}
          onSetFxAmount={noop as (v: number) => void}
          loop={emptyLoop()}
          onGenerateToPad={noop as (prompt: string, kind: string) => void}
          generateError={null}
          onLoopPad={noop as (slot: number) => void}
          onClearLoopPad={noop as (slot: number) => void}
          onSetLoopSeconds={noop as (seconds: number) => void}
          bpm={null}
          onSampleOtherDeck={async () => null}
          canSample
          onSavePreset={noop as (preset: object) => void}
          mode="realtime"
          track={null}
          onLeavePlayback={noop}
          onSeekTrack={noop as (s: number) => void}
          getTrackPeaks={() => null}
        />
      </ControlBusProvider>,
    )
    expect(
      screen.queryByRole('button', { name: 'Remove ⏺ B·1' }),
    ).not.toBeInTheDocument()
  })

  it('saves the pad and FX as a named preset, excluding sampled chips', async () => {
    const onSavePreset = vi.fn()
    const onSampleOtherDeck = vi.fn(async () => ({
      label: '⏺ B·1',
      sample: 'sample:b:1',
    }))
    renderPanel(
      { connection: 'open' },
      {
        onSavePreset: onSavePreset as () => void,
        onSampleOtherDeck: onSampleOtherDeck as unknown as () => void,
      },
      createControlBus(),
      { kind: 'dub_echo', amount: 0.4 },
    )
    addTarget('funk')
    fireEvent.click(screen.getByRole('button', { name: 'Sample deck B' }))
    await screen.findByRole('button', { name: 'Remove ⏺ B·1' })

    fireEvent.change(screen.getByLabelText('Preset name'), {
      target: { value: '  Warm funk  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save preset' }))
    expect(onSavePreset).toHaveBeenCalledWith({
      name: 'Warm funk',
      targets: [{ text: 'funk', x: 0.5, y: expect.any(Number) }],
      cursor: { x: 0.5, y: 0.5 },
      fx: { kind: 'dub_echo', amount: 0.4 },
    })
    // The name clears so the next save starts fresh.
    expect(screen.getByLabelText('Preset name')).toHaveValue('')
  })

  it('refuses to save when only sampled chips are on the pad', async () => {
    const onSampleOtherDeck = vi.fn(async () => ({
      label: '⏺ B·1',
      sample: 'sample:b:1',
    }))
    renderPanel(
      { connection: 'open' },
      { onSampleOtherDeck: onSampleOtherDeck as unknown as () => void },
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sample deck B' }))
    await screen.findByRole('button', { name: 'Remove ⏺ B·1' })
    fireEvent.change(screen.getByLabelText('Preset name'), {
      target: { value: 'Only samples' },
    })
    expect(screen.getByRole('button', { name: 'Save preset' })).toBeDisabled()
  })

  it('applies a loaded preset wholesale and sends its style', () => {
    const onSetStyle = vi.fn()
    const bus = createControlBus()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void }, bus)
    addTarget('old target')
    onSetStyle.mockClear()

    act(() =>
      bus.publish({
        kind: 'preset_load',
        deck: 'a',
        preset: {
          name: 'Warm funk',
          targets: [
            { text: 'warm disco funk', x: 0.2, y: 0.3 },
            { text: 'soul breaks', x: 0.8, y: 0.7 },
          ],
          cursor: { x: 0.2, y: 0.3 },
          fx: { kind: null, amount: 0 },
        },
      }),
    )
    expect(
      screen.getByRole('button', { name: 'Remove warm disco funk' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Remove old target' }),
    ).not.toBeInTheDocument()
    const style = onSetStyle.mock.calls.at(-1)![0]
    expect(style.prompts[0]).toMatchObject({ text: 'warm disco funk' })
    // Cursor sits on the first target: full weight there.
    expect(style.prompts[0].weight).toBeCloseTo(1)
  })

  it('ignores preset loads addressed to the other deck', () => {
    const onSetStyle = vi.fn()
    const bus = createControlBus()
    renderPanel({ connection: 'open' }, { onSetStyle: onSetStyle as () => void }, bus)
    addTarget('mine')
    onSetStyle.mockClear()
    act(() =>
      bus.publish({
        kind: 'preset_load',
        deck: 'b',
        preset: {
          name: 'X',
          targets: [{ text: 'theirs', x: 0.5, y: 0.5 }],
          cursor: { x: 0.5, y: 0.5 },
          fx: { kind: null, amount: 0 },
        },
      }),
    )
    expect(
      screen.queryByRole('button', { name: 'Remove theirs' }),
    ).not.toBeInTheDocument()
    expect(onSetStyle).not.toHaveBeenCalled()
  })

  it('fires a loop pad on click and a clear on shift-click', () => {
    const onLoopPad = vi.fn()
    const onClearLoopPad = vi.fn()
    renderPanel(
      { connection: 'open' },
      {
        onLoopPad: onLoopPad as () => void,
        onClearLoopPad: onClearLoopPad as () => void,
      },
    )
    const slot = screen.getByRole('button', { name: 'Loop slot 2' })

    fireEvent.click(slot)
    expect(onLoopPad).toHaveBeenCalledWith(1)
    fireEvent.click(slot, { shiftKey: true })
    expect(onClearLoopPad).toHaveBeenCalledWith(1)
  })

  it('shows the frozen status while a loop is on air', () => {
    renderPanel(
      { connection: 'open', playing: true },
      {},
      createControlBus(),
      { kind: null, amount: 0 },
      {
        ...emptyLoop(),
        slots: [
          { state: 'filled', label: null, oneShot: false },
          { state: 'empty' },
          { state: 'empty' },
          { state: 'empty' },
        ],
        active: 0,
      },
    )
    expect(screen.getByText('Frozen — looping')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Loop slot 1' }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('disables the loop slots while the deck cannot take them', () => {
    renderPanel({ connection: 'closed' })
    expect(
      screen.getByRole('button', { name: 'Loop slot 1' }),
    ).toBeDisabled()
  })

  function generateRow(
    handlers: Record<string, () => void> = {},
    loop: LoopState = emptyLoop(),
    generateError: string | null = null,
  ) {
    renderPanel(
      { connection: 'open' },
      handlers,
      createControlBus(),
      { kind: null, amount: 0 },
      loop,
      null,
      true,
      generateError,
    )
  }

  it('generates with the typed prompt, chosen engine, and behaviour', () => {
    const onGenerateToPad = vi.fn()
    generateRow({ onGenerateToPad: onGenerateToPad as () => void })

    fireEvent.change(screen.getByLabelText('Generate prompt'), {
      target: { value: 'vinyl spinback' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onGenerateToPad).toHaveBeenCalledWith('vinyl spinback', 'sfx', true)

    fireEvent.change(screen.getByLabelText('Engine'), {
      target: { value: 'music' },
    })
    fireEvent.change(screen.getByLabelText('Type'), {
      target: { value: 'loop' },
    })
    fireEvent.keyDown(screen.getByLabelText('Generate prompt'), {
      key: 'Enter',
    })
    expect(onGenerateToPad).toHaveBeenLastCalledWith(
      'vinyl spinback',
      'music',
      false,
    )
  })

  it('offers Magenta while the deck plays — the third engine is its own worker', () => {
    const onGenerateToPad = vi.fn()
    renderPanel(
      { connection: 'open', playing: true },
      { onGenerateToPad: onGenerateToPad as () => void },
    )
    fireEvent.change(screen.getByLabelText('Generate prompt'), {
      target: { value: 'dub chords' },
    })
    fireEvent.change(screen.getByLabelText('Engine'), {
      target: { value: 'magenta' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(onGenerateToPad).toHaveBeenCalledWith('dub chords', 'magenta', true)
  })

  it('caps the prompt input short of the backend limit, sparing the BPM stamp', () => {
    generateRow()
    // 500 (the backend cap) minus room for ", NNN BPM" — so a prompt the
    // input accepted can never bounce off the backend once stamped.
    expect(screen.getByLabelText('Generate prompt')).toHaveAttribute(
      'maxlength',
      '491',
    )
  })

  it('refuses to generate without a prompt or an empty slot', () => {
    const fullSlots: LoopState = {
      ...emptyLoop(),
      slots: Array.from({ length: 4 }, () => ({
        state: 'filled',
        label: null,
        oneShot: false,
      })),
    }
    generateRow({}, fullSlots)
    fireEvent.change(screen.getByLabelText('Generate prompt'), {
      target: { value: 'riser' },
    })
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
  })

  it('shows a pending slot as busy and unpressable', () => {
    const pending: LoopState = {
      ...emptyLoop(),
      slots: [
        { state: 'pending', label: 'air horn', oneShot: true },
        { state: 'empty' },
        { state: 'empty' },
        { state: 'empty' },
      ],
    }
    generateRow({}, pending)
    const pad = screen.getByRole('button', {
      name: 'Loop slot 1 — generating',
    })
    expect(pad).toBeDisabled()
    expect(pad).toHaveTextContent('…')
  })

  it('labels a generated slot with its prompt', () => {
    const generated: LoopState = {
      ...emptyLoop(),
      slots: [
        { state: 'filled', label: 'air horn', oneShot: true },
        { state: 'empty' },
        { state: 'empty' },
        { state: 'empty' },
      ],
    }
    generateRow({}, generated)
    expect(screen.getByRole('button', { name: 'Loop slot 1' })).toHaveAttribute(
      'title',
      'air horn',
    )
  })

  it('surfaces the generation failure detail', () => {
    generateRow({}, emptyLoop(), 'sa3_mlx checkout not found')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Generation failed: sa3_mlx checkout not found',
    )
  })

  it('shows the gated BPM, and an honest dash without one', () => {
    renderPanel(
      { connection: 'open', playing: true },
      {},
      createControlBus(),
      { kind: null, amount: 0 },
      emptyLoop(),
      131.9,
    )
    const stat = screen.getByText('BPM').parentElement!
    expect(stat).toHaveTextContent('131.9')

    renderPanel({ connection: 'open', playing: true })
    expect(screen.getAllByText('BPM').at(-1)!.parentElement).toHaveTextContent('—')
  })

  it('changes the loop capture length', () => {
    const onSetLoopSeconds = vi.fn()
    renderPanel(
      { connection: 'open' },
      { onSetLoopSeconds: onSetLoopSeconds as () => void },
    )
    fireEvent.change(screen.getByLabelText('Loop length'), {
      target: { value: '8' },
    })
    expect(onSetLoopSeconds).toHaveBeenCalledWith(8)
  })
})

describe('DeckColumn playback mode (M19)', () => {
  const aTrack = (overrides: Partial<TrackState> = {}): TrackState => ({
    loadId: 1,
    title: 'Warehouse Anthem',
    duration: 125,
    position: 65.4,
    playing: false,
    ended: false,
    bpm: 132.5,
    ...overrides,
  })

  function renderPlayback(
    track: TrackState,
    handlers: Record<string, () => void> = {},
  ) {
    return renderPanel(
      { connection: 'open' },
      handlers,
      createControlBus(),
      { kind: null, amount: 0 },
      emptyLoop(),
      null,
      true,
      null,
      { mode: 'playback', track },
    )
  }

  it('swaps the style pane for the track overview, title, and status', () => {
    renderPlayback(aTrack())
    expect(screen.queryByLabelText('Style pad')).toBeNull()
    expect(screen.queryByLabelText('Model')).toBeNull()
    expect(
      screen.getByRole('slider', { name: 'Track overview a' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Warehouse Anthem')).toBeInTheDocument()
    expect(screen.getByText('Track — paused')).toBeInTheDocument()
  })

  it('reads the transport from the track, not the worker', () => {
    const onStop = vi.fn()
    renderPlayback(aTrack({ playing: true }), { onStop })
    // state.playing is false — the lit STOP belongs to the track.
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalled()
    expect(screen.getByText('Track — playing')).toBeInTheDocument()
  })

  it('shows the track clock instead of the stream plumbing', () => {
    renderPlayback(aTrack())
    const position = screen.getByText('Position').parentElement!
    expect(position).toHaveTextContent('1:05 / 2:05')
    const stat = screen.getByText('BPM').parentElement!
    expect(stat).toHaveTextContent('132.5')
    expect(screen.queryByText('Buffer')).toBeNull()
    expect(screen.queryByText('Underruns')).toBeNull()
  })

  it('seeks from the overview with the keyboard', () => {
    const onSeekTrack = vi.fn()
    renderPlayback(aTrack(), {
      onSeekTrack: onSeekTrack as unknown as () => void,
    })
    const slider = screen.getByRole('slider', { name: 'Track overview a' })
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(onSeekTrack).toHaveBeenCalledWith(70.4)
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(onSeekTrack).toHaveBeenCalledWith(0)
    fireEvent.keyDown(slider, { key: 'End' })
    expect(onSeekTrack).toHaveBeenCalledWith(125)
  })

  it('announces the explicit end-of-track state', () => {
    renderPlayback(aTrack({ position: 125, ended: true }))
    expect(screen.getByText('Track — ended')).toBeInTheDocument()
  })

  it('carries its own exit back to the live stream', () => {
    // Without crates the Media Explorer's live row is the only other
    // way out — the deck must not depend on it.
    const onLeavePlayback = vi.fn()
    renderPlayback(aTrack(), { onLeavePlayback })
    fireEvent.click(screen.getByRole('button', { name: 'Back to live' }))
    expect(onLeavePlayback).toHaveBeenCalled()
  })
})
