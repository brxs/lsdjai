import { useState, type ReactNode } from 'react'

import { createAudioEngine, type AudioEngine } from './engine'
import { AudioEngineContext } from './engineContext'

export function AudioEngineProvider({
  engine,
  children,
}: {
  engine?: AudioEngine
  children: ReactNode
}) {
  const [defaultEngine] = useState(() => engine ?? createAudioEngine())
  return (
    <AudioEngineContext.Provider value={engine ?? defaultEngine}>
      {children}
    </AudioEngineContext.Provider>
  )
}
