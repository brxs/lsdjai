import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

import { subscribeDeckPcm } from './nativeDeckPcm'

class FakeChannel {
  onmessage: ((message: ArrayBuffer) => void) | null = null
}

let invokeCalls: { cmd: string; args: { deck?: number; channel?: FakeChannel } }[]

beforeEach(() => {
  invokeCalls = []
  vi.stubGlobal('__TAURI__', {
    core: {
      invoke: (cmd: string, args?: unknown) => {
        invokeCalls.push({ cmd, args: (args ?? {}) as { deck?: number; channel?: FakeChannel } })
        return Promise.resolve()
      },
      Channel: FakeChannel,
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('subscribeDeckPcm', () => {
  it('subscribes the deck and delivers raw bytes as a Float32Array', () => {
    const got: Float32Array[] = []
    subscribeDeckPcm('b', (s) => got.push(s))

    const sub = invokeCalls.find((c) => c.cmd === 'subscribe_deck_pcm')
    expect(sub?.args.deck).toBe(1) // deck 'b'
    const channel = sub!.args.channel!

    // Two interleaved-stereo f32 frames; the bytes round-trip exactly through the
    // ArrayBuffer view the analysis push contracts depend on.
    const pcm = new Float32Array([0.1, -0.1, 0.2, -0.2])
    channel.onmessage!(pcm.buffer)
    expect(got).toHaveLength(1)
    expect(got[0]).toEqual(new Float32Array([0.1, -0.1, 0.2, -0.2]))
  })

  it('unsubscribe clears onmessage and calls unsubscribe_deck_pcm', () => {
    const stop = subscribeDeckPcm('a', () => {})
    const channel = invokeCalls.find((c) => c.cmd === 'subscribe_deck_pcm')!.args.channel!
    stop()
    expect(channel.onmessage).toBeNull()
    expect(
      invokeCalls.some((c) => c.cmd === 'unsubscribe_deck_pcm' && c.args.deck === 0),
    ).toBe(true)
  })

  it('is a no-op outside Tauri', () => {
    vi.unstubAllGlobals() // no __TAURI__
    const stop = subscribeDeckPcm('a', () => {})
    expect(invokeCalls).toEqual([])
    expect(() => stop()).not.toThrow()
  })
})
