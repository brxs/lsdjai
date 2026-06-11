import { beforeEach, describe, expect, it } from 'vitest'

import {
  loadAppSettings,
  loadDeckSettings,
  updateAppSettings,
  updateDeckSettings,
} from './persistence'

beforeEach(() => localStorage.clear())

describe('persistence', () => {
  it('round-trips deck settings and merges partial updates', () => {
    updateDeckSettings('a', {
      targets: [{ text: 'funk', x: 0.5, y: 0.12 }],
      cursor: { x: 0.4, y: 0.6 },
    })
    updateDeckSettings('a', { volume: 0.6 })
    expect(loadDeckSettings('a')).toEqual({
      targets: [{ text: 'funk', x: 0.5, y: 0.12 }],
      cursor: { x: 0.4, y: 0.6 },
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
      'magenta-dj:v1',
      JSON.stringify({ decks: { a: { fx: { kind: 'megaverb', amount: 2 } } } }),
    )
    expect(loadDeckSettings('a').fx).toBeUndefined()
  })

  it('round-trips the loop length and drops off-menu values', () => {
    updateDeckSettings('a', { loopSeconds: 8 })
    expect(loadDeckSettings('a').loopSeconds).toBe(8)

    localStorage.setItem(
      'magenta-dj:v1',
      JSON.stringify({ decks: { a: { loopSeconds: 7 } } }),
    )
    expect(loadDeckSettings('a').loopSeconds).toBeUndefined()
  })

  it('round-trips the trim, clamps its range, and drops bad modes', () => {
    updateDeckSettings('a', { trim: { mode: 'manual', db: -4.5 } })
    expect(loadDeckSettings('a').trim).toEqual({ mode: 'manual', db: -4.5 })

    localStorage.setItem(
      'magenta-dj:v1',
      JSON.stringify({ decks: { a: { trim: { mode: 'auto', db: 40 } } } }),
    )
    expect(loadDeckSettings('a').trim).toEqual({ mode: 'auto', db: 12 })

    localStorage.setItem(
      'magenta-dj:v1',
      JSON.stringify({ decks: { a: { trim: { mode: 'loud', db: 0 } } } }),
    )
    expect(loadDeckSettings('a').trim).toBeUndefined()

    localStorage.setItem(
      'magenta-dj:v1',
      JSON.stringify({ decks: { a: { trim: { mode: 'auto', db: 'hot' } } } }),
    )
    expect(loadDeckSettings('a').trim).toBeUndefined()
  })

  it('round-trips and clamps deck EQ', () => {
    updateDeckSettings('a', { eq: { low: 0, mid: 0.5, high: 1 } })
    expect(loadDeckSettings('a').eq).toEqual({ low: 0, mid: 0.5, high: 1 })

    localStorage.setItem(
      'magenta-dj:v1',
      JSON.stringify({ decks: { a: { eq: { low: -3, mid: 'loud', high: 9 } } } }),
    )
    expect(loadDeckSettings('a').eq).toBeUndefined() // mid invalid → field dropped
  })

  it('round-trips app settings', () => {
    updateAppSettings({ crossfade: 0.8 })
    updateAppSettings({
      cueMix: 0.3,
      cueDevice: { deviceId: 'flx4', label: 'DDJ-FLX4' },
    })
    expect(loadAppSettings()).toEqual({
      crossfade: 0.8,
      cueMix: 0.3,
      cueDevice: { deviceId: 'flx4', label: 'DDJ-FLX4' },
    })
  })

  it('round-trips a backend cue device with its flag', () => {
    updateAppSettings({
      cueDevice: { deviceId: 'DDJ-FLX4', label: 'DDJ-FLX4 — phones jack', backend: true },
    })
    expect(loadAppSettings().cueDevice).toEqual({
      deviceId: 'DDJ-FLX4',
      label: 'DDJ-FLX4 — phones jack',
      backend: true,
    })
  })

  it('keeps an explicit cue-device opt-out distinct from never-set', () => {
    expect(loadAppSettings().cueDevice).toBeUndefined()
    updateAppSettings({ cueDevice: null })
    expect(loadAppSettings().cueDevice).toBeNull()
  })

  it('drops a malformed cue device but keeps the cue mix', () => {
    localStorage.setItem(
      'magenta-dj:v1',
      JSON.stringify({ app: { cueMix: 2, cueDevice: { deviceId: 7 } } }),
    )
    expect(loadAppSettings()).toEqual({ cueMix: 1 }) // clamped, device dropped
  })

  it('treats corrupt storage as absent', () => {
    localStorage.setItem('magenta-dj:v1', '{nope')
    expect(loadDeckSettings('a')).toEqual({})
    expect(loadAppSettings()).toEqual({})
  })

  it('drops malformed fields but keeps valid ones', () => {
    localStorage.setItem(
      'magenta-dj:v1',
      JSON.stringify({
        decks: {
          a: {
            targets: [{ text: 42, x: 'left', y: 0 }],
            cursor: { x: 0.5, y: 0.5 },
            volume: 'loud',
          },
        },
        app: { crossfade: 'middle' },
      }),
    )
    expect(loadDeckSettings('a')).toEqual({ cursor: { x: 0.5, y: 0.5 } })
    expect(loadAppSettings()).toEqual({})
  })
})
