import { beforeEach, describe, expect, it } from 'vitest'

import { deletePreset, loadPresets, upsertPresets } from './persistence'
import {
  parsePreset,
  parsePresetsExport,
  serialisePresets,
  type StylePreset,
} from './presets'

const FUNK: StylePreset = {
  name: 'Warm funk',
  targets: [
    { text: 'warm disco funk', x: 0.3, y: 0.4 },
    { text: 'soul breaks', x: 0.7, y: 0.6 },
  ],
  cursor: { x: 0.5, y: 0.5 },
  fx: { kind: 'dub_echo', amount: 0.4 },
}

beforeEach(() => localStorage.clear())

describe('parsePreset', () => {
  it('accepts a well-formed preset and clamps its geometry', () => {
    const parsed = parsePreset({
      ...FUNK,
      cursor: { x: 2, y: -1 },
      fx: { kind: null, amount: 9 },
    })
    expect(parsed).toMatchObject({
      name: 'Warm funk',
      cursor: { x: 1, y: 0 },
      fx: { kind: null, amount: 1 },
    })
  })

  it.each([
    ['no name', { ...FUNK, name: '   ' }],
    ['no targets', { ...FUNK, targets: [] }],
    ['malformed target', { ...FUNK, targets: [{ text: 7, x: 0, y: 0 }] }],
    [
      // Import is a trust boundary: the pad caps at 8 and the backend
      // rejects styles beyond it — a file must not sneak past.
      'more targets than the pad holds',
      {
        ...FUNK,
        targets: Array.from({ length: 9 }, (_, i) => ({
          text: `style ${i}`,
          x: 0.5,
          y: 0.5,
        })),
      },
    ],
    [
      'duplicate target texts',
      {
        ...FUNK,
        targets: [
          { text: 'funk', x: 0.2, y: 0.2 },
          { text: ' funk ', x: 0.8, y: 0.8 },
        ],
      },
    ],
    [
      'a whitespace-only target',
      { ...FUNK, targets: [{ text: '   ', x: 0.5, y: 0.5 }] },
    ],
    ['unknown fx kind', { ...FUNK, fx: { kind: 'megaverb', amount: 0 } }],
    ['not an object', 'funk'],
  ])('rejects a preset with %s', (_label, raw) => {
    expect(parsePreset(raw)).toBeNull()
  })

  it('trims target texts so they match what the pad would key', () => {
    const parsed = parsePreset({
      ...FUNK,
      targets: [{ text: '  funk  ', x: 0.5, y: 0.5 }],
    })
    expect(parsed!.targets[0].text).toBe('funk')
  })
})

describe('preset storage', () => {
  it('round-trips presets and replaces by name', () => {
    upsertPresets([FUNK])
    upsertPresets([{ ...FUNK, fx: { kind: null, amount: 0 } }])
    const presets = loadPresets()
    expect(presets).toHaveLength(1)
    expect(presets[0].fx.kind).toBeNull()
  })

  it('keeps save order and deletes by name', () => {
    upsertPresets([FUNK, { ...FUNK, name: 'Dub session' }])
    expect(loadPresets().map((preset) => preset.name)).toEqual([
      'Warm funk',
      'Dub session',
    ])
    deletePreset('Warm funk')
    expect(loadPresets().map((preset) => preset.name)).toEqual(['Dub session'])
  })

  it('drops malformed stored entries instead of crashing', () => {
    localStorage.setItem(
      'magenta-dj:v1',
      JSON.stringify({ presets: [FUNK, { name: 'broken' }] }),
    )
    expect(loadPresets().map((preset) => preset.name)).toEqual(['Warm funk'])
  })
})

describe('export / import', () => {
  it('round-trips through the export file format', () => {
    const exported = serialisePresets([FUNK])
    expect(parsePresetsExport(exported)).toEqual([FUNK])
  })

  it('rejects non-JSON and non-export files with a reason', () => {
    expect(() => parsePresetsExport('{nope')).toThrow('not a JSON file')
    expect(() => parsePresetsExport('{"foo": 1}')).toThrow('not a crates export')
    expect(() =>
      parsePresetsExport(JSON.stringify({ version: 2, presets: [FUNK] })),
    ).toThrow('different crates version')
    expect(() =>
      parsePresetsExport(JSON.stringify({ version: 1, presets: [{ name: 'x' }] })),
    ).toThrow('no usable presets')
  })

  it('imports merge by name through the storage layer', () => {
    upsertPresets([FUNK])
    const imported = parsePresetsExport(
      serialisePresets([
        { ...FUNK, fx: { kind: 'filter', amount: 0.5 } },
        { ...FUNK, name: 'Dub session' },
      ]),
    )
    const merged = upsertPresets(imported)
    expect(merged.map((preset) => preset.name)).toEqual([
      'Warm funk',
      'Dub session',
    ])
    expect(merged[0].fx.kind).toBe('filter')
  })
})
