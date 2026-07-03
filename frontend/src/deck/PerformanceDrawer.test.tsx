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
  it('starts closed and idle: the door hidden, the handle unlit', () => {
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    // Name matching is skipped for aria-hidden nodes; the render holds one group.
    const door = screen.getByRole('group', { hidden: true })
    expect(door).toHaveAttribute('aria-hidden', 'true')
    expect(door.className).not.toContain('deck__perform-door--open')
    const handle = screen.getByRole('button', { name: 'Perform' })
    expect(handle).toHaveAttribute('aria-expanded', 'false')
    expect(handle.className).not.toContain('deck__perform-handle--live')
  })

  it('the handle opens the door as pure view state — no arm write', () => {
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Perform' }))
    const door = screen.getByRole('group', { name: 'Play the deck' })
    expect(door).toHaveAttribute('aria-hidden', 'false')
    expect(setDeckPerformance).not.toHaveBeenCalled()
  })

  it('the MIDI steer toggle arms and disarms through the shell service', () => {
    const first = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Perform' }))
    fireEvent.click(screen.getByRole('button', { name: 'MIDI steer' }))
    expect(setDeckPerformance).toHaveBeenCalledWith(1, {
      armed: true,
      key: 0,
      scale: 'major',
      mode: 'chord',
    })
    first.unmount()

    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 0, scale: 'major', mode: 'chord' },
      }),
    )
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Perform' }))
    fireEvent.click(screen.getByRole('button', { name: 'MIDI steer' }))
    expect(setDeckPerformance).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ armed: false }),
    )
  })

  it('closing the door leaves steering on — the deck keeps following notes', () => {
    // Arm through a live transition (the hardware path): the rising edge
    // auto-opens the door.
    const { rerender } = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 0, scale: 'major', mode: 'chord' },
      }),
    )
    rerender(<PerformanceDrawer deckId="b" deckIndex={1} />)
    const door = screen.getByRole('group', { name: 'Play the deck' })
    expect(door).toHaveAttribute('aria-hidden', 'false')
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Close performance controls — back to prompts',
      }),
    )
    expect(door).toHaveAttribute('aria-hidden', 'true')
    // View-only: no disarm crossed the boundary.
    expect(setDeckPerformance).not.toHaveBeenCalled()
    // The handle stays lit — steering reads with the door shut.
    expect(screen.getByRole('button', { name: 'Perform' }).className).toContain(
      'deck__perform-handle--live',
    )
  })

  it('a steering rising edge (hardware arm) slides the door open', () => {
    const { rerender } = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    expect(screen.getByRole('group', { hidden: true })).toHaveAttribute(
      'aria-hidden',
      'true',
    )
    // The FLX4 KEYBOARD selector arms it: the store snapshot flips.
    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 9, scale: 'minor', mode: 'onset' },
      }),
    )
    rerender(<PerformanceDrawer deckId="b" deckIndex={1} />)
    const door = screen.getByRole('group', { name: 'Play the deck' })
    expect(door).toHaveAttribute('aria-hidden', 'false')
    expect(screen.getByLabelText('Key')).toHaveValue('A')
    expect(screen.getByLabelText('Scale')).toHaveValue('minor')
    expect(screen.getByLabelText('Note mode')).toHaveValue('onset')
  })

  it('config writes carry the current steer state through unchanged', () => {
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
      expect.objectContaining({ scale: 'pentatonicMinor', armed: true }),
    )
  })

  it('the HUD strip reads off / live / holding', () => {
    const { unmount } = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Perform' }))
    expect(screen.getByRole('status')).toHaveTextContent(
      'Steering off — flip MIDI steer to play',
    )
    unmount()

    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 0, scale: 'major', mode: 'chord' },
      }),
    )
    const second = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    // Mounted already-armed: the door starts closed (no rising edge) — open
    // it by hand to read the HUD.
    fireEvent.click(screen.getByRole('button', { name: 'Perform' }))
    expect(screen.getByRole('status')).toHaveTextContent('Live — waiting for notes')
    second.unmount()

    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 0, scale: 'major', mode: 'chord' },
        notes: { pitches: [60, 64, 67], mode: 'chord' },
      }),
    )
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Perform' }))
    expect(screen.getByRole('status')).toHaveTextContent('Holding C4 E4 G4')
  })
})
