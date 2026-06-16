import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sendNativeDeckCommand, subscribeSidecarStatus } from './nativeDeck'

type Handler = (e: { payload: unknown }) => void

let invokeCalls: { cmd: string; args: unknown }[]
let listeners: { event: string; handler: Handler }[]
let unlisten: ReturnType<typeof vi.fn>

beforeEach(() => {
  invokeCalls = []
  listeners = []
  unlisten = vi.fn()
  vi.stubGlobal('__TAURI__', {
    core: {
      invoke: (cmd: string, args?: unknown) => {
        invokeCalls.push({ cmd, args })
        return Promise.resolve()
      },
    },
    event: {
      listen: (event: string, handler: Handler) => {
        listeners.push({ event, handler })
        return Promise.resolve(unlisten)
      },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendNativeDeckCommand', () => {
  it('maps play/stop/set_style to the deck_* commands with the deck index', () => {
    sendNativeDeckCommand('a', { type: 'play' })
    sendNativeDeckCommand('b', { type: 'stop' })
    sendNativeDeckCommand('a', { type: 'set_style', prompts: [{ text: 'techno', weight: 1 }] })

    expect(invokeCalls).toEqual([
      { cmd: 'deck_play', args: { deck: 0 } },
      { cmd: 'deck_stop', args: { deck: 1 } },
      { cmd: 'deck_set_style', args: { deck: 0, prompts: [{ text: 'techno', weight: 1 }] } },
    ])
  })

  it('maps set_model and restart to deck_set_model (with the model)', () => {
    sendNativeDeckCommand('a', { type: 'set_model', model: 'mrt2_base' })
    sendNativeDeckCommand('b', { type: 'restart', model: 'mrt2_small' })
    expect(invokeCalls).toEqual([
      { cmd: 'deck_set_model', args: { deck: 0, model: 'mrt2_base' } },
      { cmd: 'deck_set_model', args: { deck: 1, model: 'mrt2_small' } },
    ])
  })

  it('drops a model switch with no model (rejected at the Rust boundary anyway)', () => {
    sendNativeDeckCommand('a', { type: 'restart' })
    expect(invokeCalls).toEqual([])
  })
})

describe('subscribeSidecarStatus', () => {
  it('delivers parsed status for the matching deck and ignores the other', async () => {
    const got: unknown[] = []
    subscribeSidecarStatus('b', (e) => got.push(e))
    await Promise.resolve() // let listen() resolve

    expect(listeners).toHaveLength(1)
    expect(listeners[0].event).toBe('sidecar://status')
    const fire = listeners[0].handler

    // Deck b (index 1) → delivered, parsed.
    fire({ payload: { deck: 1, json: '{"event":"chunk","index":3}' } })
    // Deck a (index 0) → ignored.
    fire({ payload: { deck: 0, json: '{"event":"chunk"}' } })
    // Malformed json → dropped, not thrown.
    fire({ payload: { deck: 1, json: 'not json' } })

    expect(got).toEqual([{ event: 'chunk', index: 3 }])
  })

  it('unsubscribe tears down the listener', async () => {
    const stop = subscribeSidecarStatus('a', () => {})
    await Promise.resolve()
    stop()
    expect(unlisten).toHaveBeenCalledOnce()
  })
})
