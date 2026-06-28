/** App's SHIFT routing: a `shift` intent updates which deck is "shifted", and
 * App hands that down to each deck as `shiftedDeck` (the prop that decides whose
 * cursor the jogs steer). DeckColumn is stubbed so the derivation is observed
 * directly, without standing up operable decks. */

import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import App from './App'
import { AudioEngineProvider } from './audio/AudioEngineProvider'
import type { AudioEngine, DeckId } from './audio/types'
import { createControlBus, type ControlBus } from './control/bus'
import { ControlBusProvider } from './control/ControlBusProvider'

// The brand mark needs WebGL; irrelevant here.
vi.mock('./ui/HypercubeMark', () => ({ HypercubeMark: () => null }))

// Capture the shiftedDeck App derives and passes down — that prop IS what picks
// the steered deck, so asserting it is asserting the routing.
const { captured } = vi.hoisted(() => ({
  captured: { shiftedDeck: null as DeckId | null },
}))
vi.mock('./deck/DeckColumn', () => ({
  DeckColumn: (props: { deckId: DeckId; shiftedDeck?: DeckId | null }) => {
    if (props.deckId === 'a') captured.shiftedDeck = props.shiftedDeck ?? null
    return null
  },
}))

function makeEngine(): AudioEngine {
  return {
    createDeckChannel: vi.fn(),
    resume: vi.fn(async () => {}),
    getContextTime: vi.fn(() => 0),
    setCrossfade: vi.fn(),
    setCueMix: vi.fn(),
    auditionPlay: vi.fn(async () => {}),
    auditionStop: vi.fn(),
    listOutputDevices: vi.fn(async () => []),
    setMainDevice: vi.fn(async () => {}),
    setCueDevice: vi.fn(async () => {}),
    startRecording: vi.fn(async () => '/Downloads/lsdj-take.wav'),
    stopRecording: vi.fn(async () => {}),
    getMasterLevel: vi.fn(() => 0),
    getMasterGainReduction: vi.fn(() => 0),
  }
}

function renderApp(bus: ControlBus) {
  return render(
    <AudioEngineProvider engine={makeEngine()}>
      <ControlBusProvider bus={bus}>
        <App />
      </ControlBusProvider>
    </AudioEngineProvider>,
  )
}

describe('App SHIFT routing', () => {
  it('routes held SHIFT to the steered deck, A winning when both are down', () => {
    const bus = createControlBus()
    renderApp(bus)
    expect(captured.shiftedDeck).toBeNull()

    act(() => bus.publish({ kind: 'shift', deck: 'b', held: true }))
    expect(captured.shiftedDeck).toBe('b')

    // Both SHIFTs down → deck A wins the tie.
    act(() => bus.publish({ kind: 'shift', deck: 'a', held: true }))
    expect(captured.shiftedDeck).toBe('a')

    // Release A → B steers again; release B → nobody steers.
    act(() => bus.publish({ kind: 'shift', deck: 'a', held: false }))
    expect(captured.shiftedDeck).toBe('b')
    act(() => bus.publish({ kind: 'shift', deck: 'b', held: false }))
    expect(captured.shiftedDeck).toBeNull()
  })
})
