import { describe, expect, it, vi } from 'vitest'

import { initialDeckState, type DeckState } from '../deck/deckState'
import type { DeckControls } from '../deck/useDeck'
import { applyAppIntent } from './appIntents'

function fakeDeck(state: Partial<DeckState> = {}): DeckControls {
  return {
    state: { ...initialDeckState, connection: 'open', ...state },
    volume: 0.8,
    eq: { low: 0.5, mid: 0.5, high: 0.5 },
    play: vi.fn(async () => {}),
    stop: vi.fn(),
    setStyle: vi.fn(),
    setModel: vi.fn(),
    restartWorker: vi.fn(),
    setVolume: vi.fn(),
    setEqBand: vi.fn(),
    getChannelLevel: () => 0,
    getChannelWaveformRange: () => [0, 0],
  }
}

function decks(a = fakeDeck(), b = fakeDeck()) {
  return { a, b }
}

const noCrossfade = () => {}

describe('applyAppIntent', () => {
  it('starts a stopped deck on play_toggle', () => {
    const a = fakeDeck({ playing: false })
    applyAppIntent({ kind: 'play_toggle', deck: 'a' }, decks(a), noCrossfade)
    expect(a.play).toHaveBeenCalled()
    expect(a.stop).not.toHaveBeenCalled()
  })

  it('stops a playing deck on play_toggle', () => {
    const b = fakeDeck({ playing: true })
    applyAppIntent(
      { kind: 'play_toggle', deck: 'b' },
      decks(fakeDeck(), b),
      noCrossfade,
    )
    expect(b.stop).toHaveBeenCalled()
    expect(b.play).not.toHaveBeenCalled()
  })

  it.each([
    ['disconnected', { connection: 'closed' as const }],
    ['loading a model', { switchingModel: true }],
    ['crashed', { workerDied: true }],
  ])('refuses play_toggle while the deck is %s', (_label, state) => {
    const a = fakeDeck(state)
    applyAppIntent({ kind: 'play_toggle', deck: 'a' }, decks(a), noCrossfade)
    expect(a.play).not.toHaveBeenCalled()
    expect(a.stop).not.toHaveBeenCalled()
  })

  it('routes volume to the addressed deck only', () => {
    const a = fakeDeck()
    const b = fakeDeck()
    applyAppIntent({ kind: 'volume', deck: 'b', value: 0.3 }, decks(a, b), noCrossfade)
    expect(b.setVolume).toHaveBeenCalledWith(0.3)
    expect(a.setVolume).not.toHaveBeenCalled()
  })

  it('routes EQ band moves to the addressed deck', () => {
    const a = fakeDeck()
    applyAppIntent(
      { kind: 'eq', deck: 'a', band: 'mid', value: 0.7 },
      decks(a),
      noCrossfade,
    )
    expect(a.setEqBand).toHaveBeenCalledWith('mid', 0.7)
  })

  it('hands crossfade to the callback', () => {
    const onCrossfade = vi.fn()
    applyAppIntent({ kind: 'crossfade', value: 0.25 }, decks(), onCrossfade)
    expect(onCrossfade).toHaveBeenCalledWith(0.25)
  })

  it('leaves style and record intents to their owners', () => {
    const a = fakeDeck()
    const onCrossfade = vi.fn()
    applyAppIntent(
      { kind: 'style_target', deck: 'a', index: 0 },
      decks(a),
      onCrossfade,
    )
    applyAppIntent({ kind: 'record_toggle' }, decks(a), onCrossfade)
    expect(a.play).not.toHaveBeenCalled()
    expect(a.setStyle).not.toHaveBeenCalled()
    expect(onCrossfade).not.toHaveBeenCalled()
  })
})
