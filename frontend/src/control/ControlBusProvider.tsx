import { useState, type ReactNode } from 'react'

import { createControlBus, type ControlBus } from './bus'
import { ControlBusContext } from './busContext'

export function ControlBusProvider({
  bus,
  children,
}: {
  bus?: ControlBus
  children: ReactNode
}) {
  const [defaultBus] = useState(() => bus ?? createControlBus())
  return (
    <ControlBusContext.Provider value={bus ?? defaultBus}>
      {children}
    </ControlBusContext.Provider>
  )
}
