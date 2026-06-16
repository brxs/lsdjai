import { afterEach, describe, expect, it, vi } from 'vitest'

import { interleaveChannels, uploadStyleSample } from './styleSample'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('interleaveChannels', () => {
  it('zips planar channels into the wire format', () => {
    const out = interleaveChannels(
      Float32Array.from([1, 2, 3]),
      Float32Array.from([-1, -2, -3]),
    )
    expect(Array.from(out)).toEqual([1, -1, 2, -2, 3, -3])
  })

  it('truncates to the shorter channel', () => {
    const out = interleaveChannels(
      Float32Array.from([1, 2]),
      Float32Array.from([5]),
    )
    expect(Array.from(out)).toEqual([1, 5])
  })
})

describe('uploadStyleSample', () => {
  it('frames the embed and sends it to the deck sidecar over IPC', async () => {
    const invoke = vi.fn(async () => undefined)
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    const samples = new Float32Array([0.5, -0.5])

    await uploadStyleSample('b', 'sample:a:1', samples)

    expect(invoke).toHaveBeenCalledTimes(1)
    const [cmd, payload] = invoke.mock.calls[0] as unknown as [string, Uint8Array]
    expect(cmd).toBe('deck_embed_sample')
    // [u32 LE deck][u32 LE id length][id utf-8][interleaved f32 LE PCM]
    const view = new DataView(payload.buffer)
    expect(view.getUint32(0, true)).toBe(1) // deck b
    const idLen = view.getUint32(4, true)
    expect(new TextDecoder().decode(payload.slice(8, 8 + idLen))).toBe('sample:a:1')
    expect(Array.from(new Float32Array(payload.buffer.slice(8 + idLen)))).toEqual([
      0.5, -0.5,
    ])
  })

  it('rejects when the Tauri IPC bridge is unavailable', async () => {
    vi.unstubAllGlobals() // no __TAURI__
    await expect(
      uploadStyleSample('b', 's', new Float32Array(2)),
    ).rejects.toThrow('Tauri IPC unavailable')
  })
})
