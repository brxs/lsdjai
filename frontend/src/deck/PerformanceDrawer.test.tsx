import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DeckSnap, InterfaceState } from '../audio/nativeEngine'
import {
  resetDeckGeneration,
  setDeckDrums,
  setDeckDrumsStrength,
  setDeckGeneration,
  setDeckPerformance,
} from '../audio/nativeEngine'
import { useInterfaceStore } from '../audio/interfaceStore'
import { PerformanceDrawer } from './PerformanceDrawer'

vi.mock('../audio/interfaceStore', () => ({
  useInterfaceStore: vi.fn(() => null),
}))
vi.mock('../audio/nativeEngine', async (importOriginal) => {
  const original = await importOriginal<typeof import('../audio/nativeEngine')>()
  return {
    ...original,
    setDeckPerformance: vi.fn(),
    setDeckDrums: vi.fn(),
    setDeckDrumsStrength: vi.fn(),
    setDeckGeneration: vi.fn(),
    resetDeckGeneration: vi.fn(),
  }
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
    mode: 'realtime',
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
    drumsStrength: 4,
    generation: { temperature: 1.1, topK: 50, cfgMusiccoca: 1.6, cfgNotes: 2.4 },
    analysis: { bpm: null, confidence: 0, liveBeat: null, originFrames: 0 },
    workerDied: false,
    switchingModel: false,
    shiftHeld: false,
    ...over,
  }
}

function storeWith(deck1: Partial<DeckSnap>): InterfaceState {
  return {
    decks: [deckSnap(), deckSnap(deck1)],
    crossfade: 0.5,
    cueMix: 0.5,
    recording: { active: false, path: null },
    mainDevice: '',
    cueDevice: '',
    recordingsFolder: '',
  }
}

beforeEach(() => {
  vi.mocked(useInterfaceStore).mockReturnValue(null)
  vi.mocked(setDeckPerformance).mockClear()
  vi.mocked(setDeckDrums).mockClear()
  vi.mocked(setDeckDrumsStrength).mockClear()
  vi.mocked(setDeckGeneration).mockClear()
  vi.mocked(resetDeckGeneration).mockClear()
})

describe('PerformanceDrawer', () => {
  it('starts parked: rail as the Config tab, content untabbable, LED off', () => {
    const { container } = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    const door = screen.getByRole('group', { name: 'Play the deck' })
    expect(door.className).not.toContain('deck__perform-door--open')
    const rail = screen.getByRole('button', { name: 'Config' })
    expect(rail).toHaveAttribute('aria-expanded', 'false')
    // The parked door body is hidden from the tree — only the rail remains.
    expect(screen.queryByRole('switch', { name: 'MIDI steering' })).toBeNull()
    expect(container.querySelector('.deck__perform-rail-led--on')).toBeNull()
  })

  it('the rail slides the door open and becomes the close chevron — no arm write', () => {
    render(<PerformanceDrawer deckId="a" deckIndex={0} />)
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    const door = screen.getByRole('group', { name: 'Play the deck' })
    expect(door.className).toContain('deck__perform-door--open')
    // The same button now reads as the close control (the rail travelled).
    const rail = screen.getByRole('button', { name: CLOSE_LABEL })
    expect(rail).toHaveAttribute('aria-expanded', 'true')
    expect(setDeckPerformance).not.toHaveBeenCalled()
  })

  it('the MIDI steer toggle arms and disarms through the shell service', () => {
    const first = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    fireEvent.click(screen.getByRole('switch', { name: 'MIDI steering' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    fireEvent.click(screen.getByRole('switch', { name: 'MIDI steering' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
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

  it('the No-drums toggle writes suppress/auto through the shell without arming', () => {
    // Steering stays disarmed on purpose: drum conditioning (issue #50) is
    // independent of the performance arm and must not touch it. Off by default
    // (auto) → toggling on suppresses.
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    const drums = screen.getByRole('switch', { name: 'No drums' })
    expect(drums).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(drums)
    expect(setDeckDrums).toHaveBeenCalledWith(1, 'suppress')
    expect(setDeckPerformance).not.toHaveBeenCalled()
    // The toggle carries a hint explaining what on/off do.
    expect(screen.getByText(/holds this deck's drums out/i)).toBeInTheDocument()
  })

  it('the No-drums toggle reflects the store mirror and toggles back to auto', () => {
    // Suppressing: the toggle reads on, and clicking it hands drums back.
    vi.mocked(useInterfaceStore).mockReturnValue(storeWith({ drums: false }))
    const first = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    const on = screen.getByRole('switch', { name: 'No drums' })
    expect(on).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(on)
    expect(setDeckDrums).toHaveBeenCalledWith(1, 'auto')
    first.unmount()

    // null (auto) with a real snapshot present, not just the no-store fallback.
    vi.mocked(useInterfaceStore).mockReturnValue(storeWith({ drums: null }))
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    expect(
      screen.getByRole('switch', { name: 'No drums' }),
    ).toHaveAttribute('aria-checked', 'false')
  })

  it('the adherence slider is always shown, even in auto', () => {
    // Independent of steering (issue #50) — the value always guides
    // generation, so the slider is never hidden. Reference range 0-5, step 0.1.
    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({ drums: null, drumsStrength: 4 }),
    )
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    const slider = screen.getByLabelText('Drums adherence — 4') as HTMLInputElement
    expect(slider.value).toBe('4')
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('5')
    // A hint explains what the value means (the number alone is opaque).
    expect(screen.getByText(/how strictly the model follows/i)).toBeInTheDocument()
    fireEvent.change(slider, { target: { value: '3.5' } })
    expect(setDeckDrumsStrength).toHaveBeenCalledWith(1, 3.5)
  })

  it('the adherence slider projects a fractional store value', () => {
    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({ drums: false, drumsStrength: 2.5 }),
    )
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    const slider = screen.getByLabelText('Drums adherence — 2.5') as HTMLInputElement
    expect(slider.value).toBe('2.5')
  })

  it('the generation sliders project the store tuning with reference ranges', () => {
    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        generation: { temperature: 0.8, topK: 30, cfgMusiccoca: 2, cfgNotes: 3 },
      }),
    )
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    const temp = screen.getByLabelText('Temperature — 0.8') as HTMLInputElement
    expect(temp.value).toBe('0.8')
    expect(temp.min).toBe('0')
    expect(temp.max).toBe('3')
    const topK = screen.getByLabelText('Top-k — 30') as HTMLInputElement
    expect(topK.max).toBe('1024')
    expect(screen.getByLabelText('Prompt adherence — 2')).toBeInTheDocument()
    // The note-adherence hint says it only bites while steering.
    expect(screen.getByText(/no effect unless steering/i)).toBeInTheDocument()
  })

  it('a generation slider sends only its own field as a partial patch', () => {
    // The shell merges the delta onto its authoritative value, so the webview
    // sends just the changed field — never a full snapshot that could be stale.
    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        generation: { temperature: 0.8, topK: 30, cfgMusiccoca: 2, cfgNotes: 3 },
      }),
    )
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    fireEvent.change(screen.getByLabelText('Temperature — 0.8'), {
      target: { value: '1.5' },
    })
    expect(setDeckGeneration).toHaveBeenCalledWith(1, { temperature: 1.5 })
  })

  it("each knob's reset names its field for the shell to default", () => {
    // The reset target is the shell's baseline; the webview only names the
    // field, so it never holds a copy of the default that could drift.
    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        generation: { temperature: 0.8, topK: 30, cfgMusiccoca: 2, cfgNotes: 3 },
      }),
    )
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    fireEvent.click(screen.getByLabelText('Reset Top-k to default'))
    expect(resetDeckGeneration).toHaveBeenCalledWith(1, 'topK')
    // A reset is not a value write.
    expect(setDeckGeneration).not.toHaveBeenCalled()
  })

  it('the HUD strip reads off / live / holding', () => {
    const first = render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    expect(screen.getByRole('status')).toHaveTextContent('Live — waiting for notes')
    second.unmount()

    vi.mocked(useInterfaceStore).mockReturnValue(
      storeWith({
        performance: { armed: true, key: 0, scale: 'major', mode: 'chord' },
        notes: { pitches: [60, 64, 67], mode: 'chord' },
      }),
    )
    render(<PerformanceDrawer deckId="b" deckIndex={1} />)
    fireEvent.click(screen.getByRole('button', { name: 'Config' }))
    expect(screen.getByRole('status')).toHaveTextContent('Holding C4 E4 G4')
  })
})
