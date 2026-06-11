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
  it('posts the PCM under the sample id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 's' })))
    vi.stubGlobal('fetch', fetchMock)
    const samples = new Float32Array([0.5, -0.5])

    await uploadStyleSample('b', 'sample:a:1', samples)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/deck/b/style-sample?id=sample%3Aa%3A1')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(samples.buffer)
  })

  it('surfaces the server detail on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'deck is loading a model' }), {
            status: 409,
          }),
      ),
    )
    await expect(
      uploadStyleSample('b', 's', new Float32Array(2)),
    ).rejects.toThrow('deck is loading a model')
  })

  it('falls back to the status code on a non-JSON error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    )
    await expect(
      uploadStyleSample('b', 's', new Float32Array(2)),
    ).rejects.toThrow('HTTP 500')
  })
})
