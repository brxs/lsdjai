import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './i18n'
import './index.css'
import App from './App.tsx'
import { AudioEngineProvider } from './audio/AudioEngineProvider'
import { ControlBusProvider } from './control/ControlBusProvider'
import { PianoWindow } from './deck/PianoWindow'

// The standalone MIDI-keyboard window (issue #49) loads the same bundle with
// `?window=piano` (set by the shell's toggle_piano_window command); render the
// piano there instead of the full app. Every other window is the app proper.
const isPianoWindow =
  new URLSearchParams(window.location.search).get('window') === 'piano'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPianoWindow ? (
      <PianoWindow />
    ) : (
      <AudioEngineProvider>
        <ControlBusProvider>
          <App />
        </ControlBusProvider>
      </AudioEngineProvider>
    )}
  </StrictMode>,
)
