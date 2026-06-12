import { describe, expect, it, vi } from 'vitest'

import { initialDeckState, type DeckState } from '../deck/deckState'
import type { DeckControls } from '../deck/useDeck'
import { applyAppIntent } from './appIntents'

function fakeDeck(state: Partial<DeckState> = {}): DeckControls {
  return {
    state: { ...initialDeckState, connection: 'open', ...state },
    volume: 0.8,
    eq: { low: 0.5, mid: 0.5, high: 0.5 },
    cue: false,
    setCue: vi.fn(),
    fx: { kind: null, amount: 0 },
    setFx: vi.fn(),
    setFxAmount: vi.fn(),
    loop: {
      slots: Array.from({ length: 4 }, () => ({ state: 'empty' as const })),
      active: null,
      seconds: 4,
    },
    toggleLoopPad: vi.fn(),
    clearLoopPad: vi.fn(),
    setLoopSeconds: vi.fn(),
    generateToPad: vi.fn(),
    generateError: null,
    bpm: null,
    captureStyleSample: vi.fn(async () => null),
    trim: { mode: 'auto' as const, db: 0 },
    setTrimDb: vi.fn(),
    enableAutoTrim: vi.fn(),
    primed: false,
    prime: vi.fn(async () => {}),
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

const noHandlers = { onCrossfade: () => {}, onCueMix: () => {} }

describe('applyAppIntent', () => {
  it('starts a stopped deck on play_toggle', () => {
    const a = fakeDeck({ playing: false })
    applyAppIntent({ kind: 'play_toggle', deck: 'a' }, decks(a), noHandlers)
    expect(a.play).toHaveBeenCalled()
    expect(a.stop).not.toHaveBeenCalled()
  })

  it('stops a playing deck on play_toggle', () => {
    const b = fakeDeck({ playing: true })
    applyAppIntent(
      { kind: 'play_toggle', deck: 'b' },
      decks(fakeDeck(), b),
      noHandlers,
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
    applyAppIntent({ kind: 'play_toggle', deck: 'a' }, decks(a), noHandlers)
    expect(a.play).not.toHaveBeenCalled()
    expect(a.stop).not.toHaveBeenCalled()
  })

  it('routes volume to the addressed deck only', () => {
    const a = fakeDeck()
    const b = fakeDeck()
    applyAppIntent({ kind: 'volume', deck: 'b', value: 0.3 }, decks(a, b), noHandlers)
    expect(b.setVolume).toHaveBeenCalledWith(0.3)
    expect(a.setVolume).not.toHaveBeenCalled()
  })

  it('routes EQ band moves to the addressed deck', () => {
    const a = fakeDeck()
    applyAppIntent(
      { kind: 'eq', deck: 'a', band: 'mid', value: 0.7 },
      decks(a),
      noHandlers,
    )
    expect(a.setEqBand).toHaveBeenCalledWith('mid', 0.7)
  })

  it('toggles the addressed deck headphone cue', () => {
    const a = fakeDeck()
    const b = { ...fakeDeck(), cue: true }
    applyAppIntent({ kind: 'cue_toggle', deck: 'a' }, decks(a, b), noHandlers)
    expect(a.setCue).toHaveBeenCalledWith(true)
    applyAppIntent({ kind: 'cue_toggle', deck: 'b' }, decks(a, b), noHandlers)
    expect(b.setCue).toHaveBeenCalledWith(false)
  })

  it('primes a stopped deck on deck_prep and stops a rolling one', () => {
    const stopped = fakeDeck({ playing: false })
    applyAppIntent({ kind: 'deck_prep', deck: 'a' }, decks(stopped), noHandlers)
    expect(stopped.prime).toHaveBeenCalled()
    expect(stopped.stop).not.toHaveBeenCalled()

    const rolling = fakeDeck({ playing: true })
    applyAppIntent({ kind: 'deck_prep', deck: 'a' }, decks(rolling), noHandlers)
    expect(rolling.stop).toHaveBeenCalled()
    expect(rolling.prime).not.toHaveBeenCalled()
  })

  it('refuses deck_prep while the deck cannot take it', () => {
    const a = fakeDeck({ switchingModel: true })
    applyAppIntent({ kind: 'deck_prep', deck: 'a' }, decks(a), noHandlers)
    expect(a.prime).not.toHaveBeenCalled()
    expect(a.stop).not.toHaveBeenCalled()
  })

  it('routes the FX amount to the addressed deck', () => {
    const a = fakeDeck()
    const b = fakeDeck()
    applyAppIntent(
      { kind: 'fx_amount', deck: 'b', value: 0.7 },
      decks(a, b),
      noHandlers,
    )
    expect(b.setFxAmount).toHaveBeenCalledWith(0.7)
    expect(a.setFxAmount).not.toHaveBeenCalled()
  })

  it('selects an effect from a PAD FX pad and toggles it off on repeat', () => {
    const a = fakeDeck()
    applyAppIntent({ kind: 'fx_select', deck: 'a', index: 1 }, decks(a), noHandlers)
    expect(a.setFx).toHaveBeenCalledWith('dub_echo')

    const echoed = { ...fakeDeck(), fx: { kind: 'dub_echo' as const, amount: 0.4 } }
    applyAppIntent(
      { kind: 'fx_select', deck: 'a', index: 1 },
      decks(echoed),
      noHandlers,
    )
    expect(echoed.setFx).toHaveBeenCalledWith(null)
  })

  it('ignores PAD FX pads beyond the effect list', () => {
    const a = fakeDeck()
    applyAppIntent({ kind: 'fx_select', deck: 'a', index: 7 }, decks(a), noHandlers)
    expect(a.setFx).not.toHaveBeenCalled()
  })

  it('routes loop pads to the addressed deck', () => {
    const a = fakeDeck()
    const b = fakeDeck()
    applyAppIntent({ kind: 'loop_pad', deck: 'b', index: 2 }, decks(a, b), noHandlers)
    expect(b.toggleLoopPad).toHaveBeenCalledWith(2)
    expect(a.toggleLoopPad).not.toHaveBeenCalled()
  })

  it('routes loop clears to the addressed deck', () => {
    const a = fakeDeck()
    const b = fakeDeck()
    applyAppIntent(
      { kind: 'loop_clear', deck: 'a', index: 0 },
      decks(a, b),
      noHandlers,
    )
    expect(a.clearLoopPad).toHaveBeenCalledWith(0)
    expect(b.clearLoopPad).not.toHaveBeenCalled()
  })

  it('hands crossfade to the callback', () => {
    const onCrossfade = vi.fn()
    applyAppIntent(
      { kind: 'crossfade', value: 0.25 },
      decks(),
      { ...noHandlers, onCrossfade },
    )
    expect(onCrossfade).toHaveBeenCalledWith(0.25)
  })

  it('hands the cue mix to the callback', () => {
    const onCueMix = vi.fn()
    applyAppIntent(
      { kind: 'cue_mix', value: 0.9 },
      decks(),
      { ...noHandlers, onCueMix },
    )
    expect(onCueMix).toHaveBeenCalledWith(0.9)
  })

  it('leaves style and record intents to their owners', () => {
    const a = fakeDeck()
    const onCrossfade = vi.fn()
    const handlers = { ...noHandlers, onCrossfade }
    applyAppIntent(
      { kind: 'style_target', deck: 'a', index: 0 },
      decks(a),
      handlers,
    )
    applyAppIntent({ kind: 'record_toggle' }, decks(a), handlers)
    expect(a.play).not.toHaveBeenCalled()
    expect(a.setStyle).not.toHaveBeenCalled()
    expect(onCrossfade).not.toHaveBeenCalled()
  })
})
