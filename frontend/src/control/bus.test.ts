import { describe, expect, it, vi } from 'vitest'

import { createControlBus, type ControlIntent } from './bus'

const INTENT: ControlIntent = { kind: 'volume', deck: 'a', value: 0.5 }

describe('createControlBus', () => {
  it('delivers published intents to every subscriber', () => {
    const bus = createControlBus()
    const first = vi.fn()
    const second = vi.fn()
    bus.subscribe(first)
    bus.subscribe(second)
    bus.publish(INTENT)
    expect(first).toHaveBeenCalledWith(INTENT)
    expect(second).toHaveBeenCalledWith(INTENT)
  })

  it('stops delivering after unsubscribe', () => {
    const bus = createControlBus()
    const handler = vi.fn()
    const unsubscribe = bus.subscribe(handler)
    unsubscribe()
    bus.publish(INTENT)
    expect(handler).not.toHaveBeenCalled()
  })

  it('publishing with no subscribers is a no-op', () => {
    expect(() => createControlBus().publish(INTENT)).not.toThrow()
  })
})
