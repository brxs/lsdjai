import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deckKeyboardNote } from '../audio/nativeEngine'
import { PianoWindow } from './PianoWindow'

vi.mock('../audio/nativeEngine', async (importOriginal) => {
  const original = await importOriginal<typeof import('../audio/nativeEngine')>()
  return { ...original, deckKeyboardNote: vi.fn() }
})

const note = vi.mocked(deckKeyboardNote)

beforeEach(() => note.mockClear())

describe('PianoWindow', () => {
  it('plays the default-routed deck A on key-down and releases on key-up', () => {
    render(<PianoWindow />)
    // Route A is on by default, B off, so KeyA (C4 = 60) reaches only deck 0.
    fireEvent.keyDown(window, { code: 'KeyA' })
    expect(note).toHaveBeenCalledWith(0, 60, true)
    expect(note).toHaveBeenCalledTimes(1)
    fireEvent.keyUp(window, { code: 'KeyA' })
    expect(note).toHaveBeenCalledWith(0, 60, false)
  })

  it('routes a press to every enabled deck', () => {
    render(<PianoWindow />)
    fireEvent.click(screen.getByRole('switch', { name: 'Deck B' })) // A + B now on
    fireEvent.keyDown(window, { code: 'KeyS' }) // D4 = 62
    expect(note).toHaveBeenCalledWith(0, 62, true)
    expect(note).toHaveBeenCalledWith(1, 62, true)
  })

  it('sends nothing while a deck is not routed', () => {
    render(<PianoWindow />)
    fireEvent.click(screen.getByRole('switch', { name: 'Deck A' })) // A off, B off
    fireEvent.keyDown(window, { code: 'KeyA' })
    expect(note).not.toHaveBeenCalled()
  })

  it('turning a route off releases notes still held on that deck', () => {
    render(<PianoWindow />)
    fireEvent.keyDown(window, { code: 'KeyA' }) // held on deck 0
    note.mockClear()
    fireEvent.click(screen.getByRole('switch', { name: 'Deck A' })) // route A off
    expect(note).toHaveBeenCalledWith(0, 60, false)
  })

  it('releases held notes when the window loses focus (no stuck drone)', () => {
    render(<PianoWindow />)
    fireEvent.keyDown(window, { code: 'KeyA' }) // held on deck 0
    note.mockClear()
    fireEvent.blur(window)
    expect(note).toHaveBeenCalledWith(0, 60, false)
  })

  it('releases held notes when the piano unmounts', () => {
    const { unmount } = render(<PianoWindow />)
    fireEvent.keyDown(window, { code: 'KeyA' })
    note.mockClear()
    unmount()
    expect(note).toHaveBeenCalledWith(0, 60, false)
  })

  it('octave up shifts the played pitch by a whole octave', () => {
    render(<PianoWindow />)
    fireEvent.click(screen.getByRole('button', { name: 'Octave up' }))
    fireEvent.keyDown(window, { code: 'KeyA' })
    expect(note).toHaveBeenCalledWith(0, 72, true)
  })

  it('ignores auto-repeat and a second down for an already-held key', () => {
    render(<PianoWindow />)
    fireEvent.keyDown(window, { code: 'KeyA' })
    fireEvent.keyDown(window, { code: 'KeyA', repeat: true })
    fireEvent.keyDown(window, { code: 'KeyA' })
    expect(note).toHaveBeenCalledTimes(1)
  })

  it('plays from a pointer click and reflects the held state via aria-pressed', () => {
    render(<PianoWindow />)
    const cKey = screen.getByRole('button', { name: 'C4' })
    expect(cKey).toHaveAttribute('aria-pressed', 'false')
    fireEvent.pointerDown(cKey)
    expect(note).toHaveBeenCalledWith(0, 60, true)
    expect(cKey).toHaveAttribute('aria-pressed', 'true')
    fireEvent.pointerUp(cKey)
    expect(note).toHaveBeenCalledWith(0, 60, false)
    expect(cKey).toHaveAttribute('aria-pressed', 'false')
  })
})
