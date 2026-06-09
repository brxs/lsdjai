import { describe, expect, it } from 'vitest'

import {
  deckReducer,
  initialDeckState,
  type DeckAction,
  type DeckState,
  type ServerEvent,
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

  const helloEvent: ServerEvent = {
    event: 'hello',
    deck: 'a',
    model: 'mrt2_small',
    sample_rate: 48_000,
    channels: 2,
    chunk_seconds: 1,
    models: ['mrt2_small', 'mrt2_base'],
    restarting: false,
    total_ram_gb: 16,
    model_ram_estimate_gb: { mrt2_small: 2, mrt2_base: 6 },
  }

  it('adopts model, model list, and RAM info from the hello event', () => {
    const state = reduce([{ type: 'server_event', event: helloEvent }])
    expect(state.model).toBe('mrt2_small')
    expect(state.availableModels).toEqual(['mrt2_small', 'mrt2_base'])
    expect(state.ramInfo).toEqual({
      totalGb: 16,
      estimateGbByModel: { mrt2_small: 2, mrt2_base: 6 },
    })
  })

  it('lets hello clear a switch flag stranded by a mid-switch reconnect', () => {
    const state = reduce([
      { type: 'server_event', event: { event: 'model_loading', model: 'mrt2_base' } },
      { type: 'socket_closed' },
      { type: 'server_event', event: { ...helloEvent, model: 'mrt2_base' } },
    ])
    expect(state.switchingModel).toBe(false)
    expect(state.model).toBe('mrt2_base')
  })

  it('tracks generation speed from chunk events', () => {
    const state = reduce([
      {
        type: 'server_event',
        event: { event: 'chunk', index: 4, rtf: 1.86, prompt: 'x' },
      },
    ])
    expect(state.generationSpeed).toBe(1.86)
  })

  it('surfaces worker errors and clears them when a prompt applies', () => {
    const errored = reduce([
      { type: 'server_event', event: { event: 'error', error: 'boom' } },
    ])
    expect(errored.error).toBe('boom')

    const recovered = reduce(
      [
        {
          type: 'server_event',
          event: { event: 'prompt_applied', prompt: 'funk', effective_from_chunk: 3 },
        },
      ],
      errored,
    )
    expect(recovered.error).toBeNull()
    expect(recovered.activePrompt).toBe('funk')
  })

  it('enters a switching state and forgets the stream when a model loads', () => {
    const state = reduce([
      { type: 'play_requested' },
      {
        type: 'server_event',
        event: { event: 'prompt_applied', prompt: 'funk', effective_from_chunk: 1 },
      },
      { type: 'server_event', event: { event: 'model_loading', model: 'mrt2_base' } },
    ])
    expect(state.switchingModel).toBe(true)
    expect(state.playing).toBe(false)
    expect(state.activePrompt).toBeNull()
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

  it('stops playing and marks the connection when the socket closes', () => {
    const state = reduce([
      { type: 'play_requested' },
      { type: 'socket_closed' },
    ])
    expect(state.playing).toBe(false)
    expect(state.connection).toBe('closed')
  })
})
