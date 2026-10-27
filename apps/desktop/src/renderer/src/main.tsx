import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import '@fontsource-variable/geist'
import './styles.css'
import App from './App'
import SettingsWindow from './SettingsWindow'
import { queryClient } from './queryClient'
import { initTheme } from './theme'

initTheme()

// The settings window is this same page, opened with #settings.
const settings = window.location.hash === "#settings"

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {settings ? (
      <QueryClientProvider client={queryClient}>
        <SettingsWindow />
      </QueryClientProvider>
    ) : (
      <App />
    )}
  </StrictMode>
)
