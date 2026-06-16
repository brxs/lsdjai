import { useState, type ReactNode } from 'react'

import { AudioEngineContext } from './engineContext'
import { createNativeEngine } from './nativeEngine'
import type { AudioEngine } from './types'

export function AudioEngineProvider({
  engine,
  children,
}: {
  engine?: AudioEngine
  children: ReactNode
}) {
  // The Rust engine drives all audio over IPC (ADR-0017/0018); the app only runs
  // under Tauri. An explicitly injected engine always wins (tests inject a fake).
  const [defaultEngine] = useState(() => engine ?? createNativeEngine())
  return (
    <AudioEngineContext.Provider value={engine ?? defaultEngine}>
      {children}
    </AudioEngineContext.Provider>
  )
}
