import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DeckSnap, InterfaceState } from '../audio/nativeEngine'
import { setDeckPerformance } from '../audio/nativeEngine'
import { useInterfaceStore } from '../audio/interfaceStore'
import { PerformanceDrawer } from './PerformanceDrawer'

vi.mock('../audio/interfaceStore', () => ({
  useInterfaceStore: vi.fn(() => null),
}))
vi.mock('../audio/nativeEngine', async (importOriginal) => {
  const original = await importOriginal<typeof import('../audio/nativeEngine')>()
  return { ...original, setDeckPerformance: vi.fn() }
})

function deckSnap(over: Partial<DeckSnap> = {}): DeckSnap {
  return {
    volume: 1,
    eq: { low: 0.5, mid: 0.5, high: 0.5 },
    trimDb: 0,
    cue: false,
    onAir: true,
    fx: { kind: null, amount: 0 },
    model: null,
    playing: false,
    cues: [],
    track: null,
    transport: null,
    loopLabels: [],
    styleTargets: [],
    styleSelected: [],
    cursor: { x: 0.5, y: 0.5 },
    primed: false,
    performance: { armed: false, key: 0, scale: 'major', mode: 'chord' },
    notes: null,
    drums: null,
    analysis: { bpm: null, confidence: 0, liveBeat: null, originFrames: 0 },
    ...over,
  }
}

function storeWith(deck1: Partial<DeckSnap>): InterfaceState {
  return {
    decks: [deckSnap(), deckSnap(deck1)],
    crossfade: 0.5,
    cueMix: 0.5,
  }
}

beforeEach(() => {
  vi.mocked(useInterfaceStore).mockReturnValue(null)
  vi.mocked(setDeckPerformance).mockClear()
})

describe('PerformanceDrawer', () => {
  it('starts closed: the door hidden, the handle collapsed', () => {
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    // Name matching is skipped for aria-hidden nodes; the render holds one group.
    const door = screen.getByRole('group', { hidden: true })
    expect(door).toHaveAttribute('aria-hidden', 'true')
    expect(door.className).not.toContain('deck__perform-door--open')
    expect(screen.getByRole('button', { name: 'Perform' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('opening the door arms the deck through the shell service', () => {
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Perform' }))
    expect(setDeckPerformance).toHaveBeenCalledWith(1, {
      armed: true,
      key: 0,
      scale: 'major',
      mode: 'chord',
    })
  })

  it('an armed store snapshot slides the door open — hardware arming included', () => {
    // The store says armed (the FLX4 KEYBOARD selector can write this too);
    // the drawer is a projection, so it opens regardless of who armed it.
    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 9, scale: 'minor', mode: 'onset' },
      }),
    )
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    const door = screen.getByRole('group', { name: 'Play the deck' })
    expect(door).toHaveAttribute('aria-hidden', 'false')
    expect(door.className).toContain('deck__perform-door--open')
    expect(screen.getByLabelText('Key')).toHaveValue('A')
    expect(screen.getByLabelText('Scale')).toHaveValue('minor')
    expect(screen.getByLabelText('Note mode')).toHaveValue('onset')
  })

  it('closing, re-keying, and re-scaling all write through the service', () => {
    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 0, scale: 'major', mode: 'chord' },
      }),
    )
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'D' } })
    expect(setDeckPerformance).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ key: 2, armed: true }),
    )
    fireEvent.change(screen.getByLabelText('Scale'), {
      target: { value: 'pentatonicMinor' },
    })
    expect(setDeckPerformance).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ scale: 'pentatonicMinor' }),
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Close performance controls — back to prompts',
      }),
    )
    expect(setDeckPerformance).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ armed: false }),
    )
  })

  it('the HUD strip shows held notes while steering, and the live idle line otherwise', () => {
    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 0, scale: 'major', mode: 'chord' },
        notes: { pitches: [60, 64, 67], mode: 'chord' },
      }),
    )
    const { unmount } = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    expect(screen.getByRole('status')).toHaveTextContent('Holding C4 E4 G4')
    unmount()

    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 0, scale: 'major', mode: 'chord' },
      }),
    )
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    expect(screen.getByRole('status')).toHaveTextContent('Live — waiting for notes')
  })
})
