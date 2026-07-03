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

const CLOSE_LABEL = 'Close performance controls — back to prompts'

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
  it('starts parked: rail as the Steer tab, content untabbable, LED off', () => {
    const { container } = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    const door = screen.getByRole('group', { name: 'Play the deck' })
    expect(door.className).not.toContain('deck__perform-door--open')
    const rail = screen.getByRole('button', { name: 'Steer' })
    expect(rail).toHaveAttribute('aria-expanded', 'false')
    // The parked door body is hidden from the tree — only the rail remains.
    expect(screen.queryByRole('button', { name: 'MIDI steering' })).toBeNull()
    expect(container.querySelector('.deck__perform-rail-led--on')).toBeNull()
  })

  it('the rail slides the door open and becomes the close chevron — no arm write', () => {
    render(<PerformanceDrawer deckId="a" deckIndex={0} />)
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
    const door = screen.getByRole('group', { name: 'Play the deck' })
    expect(door.className).toContain('deck__perform-door--open')
    // The same button now reads as the close control (the rail travelled).
    const rail = screen.getByRole('button', { name: CLOSE_LABEL })
    expect(rail).toHaveAttribute('aria-expanded', 'true')
    expect(setDeckPerformance).not.toHaveBeenCalled()
  })

  it('the MIDI steer toggle arms and disarms through the shell service', () => {
    const first = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
    fireEvent.click(screen.getByRole('button', { name: 'MIDI steering' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
    fireEvent.click(screen.getByRole('button', { name: 'MIDI steering' }))
    expect(setDeckPerformance).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ armed: false }),
    )
  })

  it('closing the door leaves steering on — the rail LED stays lit', () => {
    // Arm through a live transition (the hardware path): the rising edge
    // auto-opens the door.
    const { container, rerender } = render(
      <PerformanceDrawer deckId="b" deckIndex={1} />,
    )
    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 0, scale: 'major', mode: 'chord' },
      }),
    )
    rerender(<PerformanceDrawer deckId="b" deckIndex={1} />)
    const door = screen.getByRole('group', { name: 'Play the deck' })
    expect(door.className).toContain('deck__perform-door--open')

    fireEvent.click(screen.getByRole('button', { name: CLOSE_LABEL }))
    expect(door.className).not.toContain('deck__perform-door--open')
    // View-only: no disarm crossed the boundary, and the LED still shows it.
    expect(setDeckPerformance).not.toHaveBeenCalled()
    expect(container.querySelector('.deck__perform-rail-led--on')).not.toBeNull()
  })

  it('a steering rising edge (hardware arm) slides the door open', () => {
    const { rerender } = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    expect(
      screen.getByRole('group', { name: 'Play the deck' }).className,
    ).not.toContain('deck__perform-door--open')
    // The FLX4 KEYBOARD selector arms it: the store snapshot flips.
    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 9, scale: 'minor', mode: 'onset' },
      }),
    )
    rerender(<PerformanceDrawer deckId="b" deckIndex={1} />)
    expect(
      screen.getByRole('group', { name: 'Play the deck' }).className,
    ).toContain('deck__perform-door--open')
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
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
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
    const first = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
    expect(screen.getByRole('status')).toHaveTextContent(
      'Steering off — flip MIDI steering to play',
    )
    first.unmount()

    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 0, scale: 'major', mode: 'chord' },
      }),
    )
    const second = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
    expect(screen.getByRole('status')).toHaveTextContent('Live — waiting for notes')
    second.unmount()

    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 0, scale: 'major', mode: 'chord' },
        notes: { pitches: [60, 64, 67], mode: 'chord' },
      }),
    )
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Steer' }))
    expect(screen.getByRole('status')).toHaveTextContent('Holding C4 E4 G4')
  })
})
