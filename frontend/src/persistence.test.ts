import { beforeEach, describe, expect, it } from 'vitest'

import {
  loadAppSettings,
  loadDeckSettings,
  takeLegacyDeckStyles,
  takeLegacyShellSettings,
  updateAppSettings,
  updateDeckSettings,
} from './persistence'

beforeEach(() => localStorage.clear())

describe('persistence', () => {
  it('round-trips deck settings and merges partial updates', () => {
    updateDeckSettings('a', { loopSeconds: 8 })
    updateDeckSettings('a', { volume: 0.6 })
    expect(loadDeckSettings('a')).toEqual({
      loopSeconds: 8,
      volume: 0.6,
    })
  })

  it('keeps decks independent', () => {
    updateDeckSettings('a', { volume: 0.2 })
    updateDeckSettings('b', { volume: 0.9 })
    expect(loadDeckSettings('a').volume).toBe(0.2)
    expect(loadDeckSettings('b').volume).toBe(0.9)
  })

  it('round-trips deck FX and drops malformed kinds', () => {
    updateDeckSettings('a', { fx: { kind: 'filter', amount: 0.5 } })
    expect(loadDeckSettings('a').fx).toEqual({ kind: 'filter', amount: 0.5 })

    updateDeckSettings('a', { fx: { kind: null, amount: 0 } })
    expect(loadDeckSettings('a').fx).toEqual({ kind: null, amount: 0 })

    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({ decks: { a: { fx: { kind: 'megaverb', amount: 2 } } } }),
    )
    expect(loadDeckSettings('a').fx).toBeUndefined()
  })

  it('round-trips the loop length and drops off-menu values', () => {
    updateDeckSettings('a', { loopSeconds: 8 })
    expect(loadDeckSettings('a').loopSeconds).toBe(8)

    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({ decks: { a: { loopSeconds: 7 } } }),
    )
    expect(loadDeckSettings('a').loopSeconds).toBeUndefined()
  })

  it('round-trips the trim, clamps its range, and drops bad modes', () => {
    updateDeckSettings('a', { trim: { mode: 'manual', db: -4.5 } })
    expect(loadDeckSettings('a').trim).toEqual({ mode: 'manual', db: -4.5 })

    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({ decks: { a: { trim: { mode: 'auto', db: 40 } } } }),
    )
    expect(loadDeckSettings('a').trim).toEqual({ mode: 'auto', db: 12 })

    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({ decks: { a: { trim: { mode: 'loud', db: 0 } } } }),
    )
    expect(loadDeckSettings('a').trim).toBeUndefined()

    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({ decks: { a: { trim: { mode: 'auto', db: 'hot' } } } }),
    )
    expect(loadDeckSettings('a').trim).toBeUndefined()
  })

  it('round-trips and clamps deck EQ', () => {
    updateDeckSettings('a', { eq: { low: 0, mid: 0.5, high: 1 } })
    expect(loadDeckSettings('a').eq).toEqual({ low: 0, mid: 0.5, high: 1 })

    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({ decks: { a: { eq: { low: -3, mid: 'loud', high: 9 } } } }),
    )
    expect(loadDeckSettings('a').eq).toBeUndefined() // mid invalid → field dropped
  })

  it('round-trips app settings', () => {
    updateAppSettings({ crossfade: 0.8 })
    updateAppSettings({ cueMix: 0.3 })
    expect(loadAppSettings()).toEqual({
      crossfade: 0.8,
      cueMix: 0.3,
    })
  })

  it('migrates legacy device/folder settings ONCE, stripping the keys (ADR-0020 phase A)', () => {
    // A blob saved by a pre-inversion build: shell-owned settings still in
    // localStorage beside the surviving webview ones.
    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({
        app: {
          crossfade: 0.4,
          outputDevice: 'MacBook Speakers',
          cueDevice: 'DDJ-FLX4',
          recordingsFolder: '/Users/dj/Sets',
        },
      }),
    )
    expect(takeLegacyShellSettings()).toEqual({
      outputDevice: 'MacBook Speakers',
      cueDevice: 'DDJ-FLX4',
      recordingsFolder: '/Users/dj/Sets',
    })
    // The keys are gone; the surviving settings are untouched; a second take
    // finds nothing (the shell file owns them now).
    expect(loadAppSettings()).toEqual({ crossfade: 0.4 })
    expect(takeLegacyShellSettings()).toBeNull()
  })

  it('round-trips the beat view layout and drops garbage (M22)', () => {
    updateAppSettings({ beatView: 'top' })
    expect(loadAppSettings().beatView).toBe('top')
    updateAppSettings({ beatView: 'vertical' })
    expect(loadAppSettings().beatView).toBe('vertical')
    updateAppSettings({ beatView: 'sideways' as never })
    expect(loadAppSettings().beatView).toBeUndefined()
  })

  it('round-trips the media tray drawer state', () => {
    updateAppSettings({ mediaOpen: false, mediaHeight: 320 })
    expect(loadAppSettings().mediaOpen).toBe(false)
    expect(loadAppSettings().mediaHeight).toBe(320)
  })

  it('ignores garbage in the legacy shell-setting keys during migration', () => {
    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({ app: { recordingsFolder: 42, outputDevice: '' } }),
    )
    // Nothing valid to migrate — and nothing to migrate is null, not {}.
    expect(takeLegacyShellSettings()).toBeNull()
  })

  it('clamps the media height and drops a non-boolean open flag', () => {
    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({ app: { mediaOpen: 'yes', mediaHeight: 5000 } }),
    )
    const loaded = loadAppSettings()
    expect(loaded.mediaOpen).toBeUndefined() // not a boolean → dropped
    expect(loaded.mediaHeight).toBe(720) // clamped to MEDIA_MAX_HEIGHT
  })

  it('clamps an out-of-range cue mix', () => {
    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({ app: { cueMix: 2 } }),
    )
    expect(loadAppSettings()).toEqual({ cueMix: 1 }) // clamped
  })

  it('treats corrupt storage as absent', () => {
    localStorage.setItem('lsdj:v1', '{nope')
    expect(loadDeckSettings('a')).toEqual({})
    expect(loadAppSettings()).toEqual({})
  })

  it('drops malformed fields but keeps valid ones', () => {
    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({
        decks: {
          a: {
            volume: 'loud',
            loopSeconds: 8,
          },
        },
        app: { crossfade: 'middle' },
      }),
    )
    expect(loadDeckSettings('a')).toEqual({ loopSeconds: 8 })
    expect(loadAppSettings()).toEqual({})
  })

  it('migrates legacy deck-style layouts ONCE, stripping the keys (ADR-0020 phase B)', () => {
    // A blob saved by a pre-inversion build: the pad arrangement still in
    // localStorage beside the surviving webview deck settings.
    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({
        decks: {
          a: {
            targets: [{ text: 'funk', x: 0.5, y: 1.7 }],
            cursor: { x: 0.4, y: 0.6 },
            volume: 0.6,
          },
          b: { cursor: { x: 0.1, y: 0.1 } },
        },
      }),
    )
    // Deck A migrates (coordinates clamped); deck B has no targets, so its
    // orphan cursor is stripped without producing a migration entry.
    expect(takeLegacyDeckStyles()).toEqual({
      a: {
        targets: [{ text: 'funk', x: 0.5, y: 1 }],
        cursor: { x: 0.4, y: 0.6 },
      },
    })
    // The keys are gone; the surviving settings are untouched; a second take
    // finds nothing (the shell settings file owns the layout now).
    expect(loadDeckSettings('a')).toEqual({ volume: 0.6 })
    expect(takeLegacyDeckStyles()).toBeNull()
  })

  it('ignores malformed legacy style targets during migration', () => {
    localStorage.setItem(
      'lsdj:v1',
      JSON.stringify({
        decks: { a: { targets: [{ text: 42, x: 'left', y: 0 }] } },
      }),
    )
    // Nothing valid to migrate — and the garbage keys are still stripped.
    expect(takeLegacyDeckStyles()).toBeNull()
    expect(localStorage.getItem('lsdj:v1')).not.toContain('targets')
  })
})
