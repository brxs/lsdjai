import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './i18n'
import './index.css'
import App from './App.tsx'
import { AudioEngineProvider } from './audio/AudioEngineProvider'
import { ControlBusProvider } from './control/ControlBusProvider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AudioEngineProvider>
      <ControlBusProvider>
        <App />
      </ControlBusProvider>
    </AudioEngineProvider>
  </StrictMode>,
)
