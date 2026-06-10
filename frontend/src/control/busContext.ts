import { createContext, useContext } from 'react'

import type { ControlBus } from './bus'

export const ControlBusContext = createContext<ControlBus | null>(null)

export function useControlBus(): ControlBus {
  const bus = useContext(ControlBusContext)
  if (!bus) {
    throw new Error('useControlBus requires a ControlBusContext provider')
  }
  return bus
}
