import { createContext, useContext } from 'react'

import type { AudioEngine } from './types'

export const AudioEngineContext = createContext<AudioEngine | null>(null)

export function useAudioEngine(): AudioEngine {
  const engine = useContext(AudioEngineContext)
  if (!engine) {
    throw new Error('useAudioEngine requires an AudioEngineProvider')
  }
  return engine
}
