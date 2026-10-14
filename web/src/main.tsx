import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/instrument-serif/400.css'
import '@xyflow/react/dist/style.css'
// In this order: a later file's rules win over an earlier one's, as they did in one stylesheet.
import './styles/theme.css'
import './styles/shell.css'
import './styles/inbox.css'
import './styles/canvas.css'
import './styles/orrery.css'
import './styles/drawer.css'
import './styles/usage.css'
import './styles/artifacts.css'
import './styles/day.css'
import './styles/library.css'
import './styles/tycho.css'
import './styles/responsive.css'
import './styles/extras.css'

import { App } from './App'
import { moveOldSettings } from './settings'
import { applyStoredTheme } from './useTheme'

moveOldSettings()
applyStoredTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
