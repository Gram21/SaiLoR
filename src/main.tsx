import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { loadTheme, loadFontScale, applyTheme, applyFontScale } from './state/settings'
import './styles/index.css'

// Apply persisted theme + font scale before the first paint (no flash).
applyTheme(loadTheme())
applyFontScale(loadFontScale())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
