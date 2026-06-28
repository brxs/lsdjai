import { describe, expect, it } from 'vitest'

import {
  deckReducer,
  initialDeckState,
  type DeckAction,
  type DeckState,
} from './deckState'

function reduce(actions: DeckAction[], from: DeckState = initialDeckState) {
  return actions.reduce(deckReducer, from)
}

describe('deckReducer', () => {
  it('records buffer level, underruns, and audibility from worklet stats', () => {
    const state = reduce([
      {
        type: 'worklet_stats',
        stats: { underruns: 2, bufferedSeconds: 1.7, playing: true },
      },
    ])
    expect(state.underruns).toBe(2)
    expect(state.bufferedSeconds).toBeCloseTo(1.7)
    expect(state.audible).toBe(true)
  })

  it('returns the SAME state object when worklet stats are unchanged', () => {
    // The engine_snapshot rAF poll dispatches worklet_stats ~10 Hz for the whole
    // session once a channel exists; an unchanged tick must not produce a new state
    // (which would re-render App ~10 Hz and dismiss an open Settings <select>).
    const settled = reduce([
      {
        type: 'worklet_stats',
        stats: { underruns: 1, bufferedSeconds: 1.5, playing: false },
      },
    ])
    const same = deckReducer(settled, {
      type: 'worklet_stats',
      stats: { underruns: 1, bufferedSeconds: 1.5, playing: false },
    })
    expect(same).toBe(settled) // referentially identical → React skips the re-render

    const moved = deckReducer(settled, {
      type: 'worklet_stats',
      stats: { underruns: 1, bufferedSeconds: 1.9, playing: false },
    })
    expect(moved).not.toBe(settled)
    expect(moved.bufferedSeconds).toBeCloseTo(1.9)
  })

  it('tracks generation speed from chunk events', () => {
    const state = reduce([
      {
        type: 'server_event',
        event: { event: 'chunk', index: 4, rtf: 1.86 },
      },
    ])
    expect(state.generationSpeed).toBe(1.86)
  })

  it('surfaces worker errors and clears them when a style applies', () => {
    const errored = reduce([
      { type: 'server_event', event: { event: 'error', error: 'boom' } },
    ])
    expect(errored.error).toBe('boom')

    const recovered = reduce(
      [
        {
          type: 'server_event',
          event: {
            event: 'style_applied',
            prompts: [
              { text: 'funk', weight: 0.7 },
              { text: 'techno', weight: 0.3 },
            ],
            effective_from_chunk: 3,
          },
        },
      ],
      errored,
    )
    expect(recovered.error).toBeNull()
    expect(recovered.activeStyle).toEqual({
      prompts: [
        { text: 'funk', weight: 0.7 },
        { text: 'techno', weight: 0.3 },
      ],
    })
  })

  it('enters a switching state and forgets the stream when a model loads', () => {
    const state = reduce([
      { type: 'play_requested' },
      {
        type: 'server_event',
        event: {
          event: 'style_applied',
          prompts: [{ text: 'funk', weight: 1 }],
          effective_from_chunk: 1,
        },
      },
      { type: 'server_event', event: { event: 'model_loading', model: 'mrt2_base' } },
    ])
    expect(state.switchingModel).toBe(true)
    expect(state.playing).toBe(false)
    expect(state.activeStyle).toBeNull()
    // Adopting the target immediately lets the RAM warning lead the load.
    expect(state.model).toBe('mrt2_base')
  })

  it('clears switching and crash flags when the fresh worker is ready', () => {
    const state = reduce([
      { type: 'server_event', event: { event: 'worker_died', model: 'mrt2_small' } },
      { type: 'server_event', event: { event: 'model_loading', model: 'mrt2_base' } },
      { type: 'server_event', event: { event: 'ready', deck: 'a', model: 'mrt2_base' } },
    ])
    expect(state.switchingModel).toBe(false)
    expect(state.workerDied).toBe(false)
    expect(state.model).toBe('mrt2_base')
  })

  it('flags a dead worker and stops playing', () => {
    const state = reduce([
      { type: 'play_requested' },
      { type: 'server_event', event: { event: 'worker_died', model: 'mrt2_small' } },
    ])
    expect(state.workerDied).toBe(true)
    expect(state.playing).toBe(false)
  })

  it('deck_info sets the model list + RAM without touching model/switch/style', () => {
    const ramInfo = { totalGb: 32, estimateGbByModel: { mrt2_small: 2 } }
    const state = reduce([
      { type: 'server_event', event: { event: 'ready', deck: 'a', model: 'mrt2_small' } },
      { type: 'deck_info', models: ['mrt2_small', 'mrt2_base'], ramInfo },
    ])
    expect(state.availableModels).toEqual(['mrt2_small', 'mrt2_base'])
    expect(state.ramInfo).toEqual(ramInfo)
    // The ready event's model + cleared switch flag are untouched.
    expect(state.model).toBe('mrt2_small')
    expect(state.switchingModel).toBe(false)
  })
})
