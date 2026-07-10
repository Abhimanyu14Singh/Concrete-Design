import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/index.css' // bundled UI font (offline-safe) — see FONT.ui in theme.ts
import './index.css'
import App from './App.tsx'
import DashboardWindowRoot from './components/Dashboard/DashboardWindowRoot.tsx'
import { UnitsProvider } from './contexts/UnitsContext.tsx'
import ErrorBoundary from './components/common/ErrorBoundary.tsx'

// The popped-out Group Dashboard window loads the same bundle with #dashboard so it
// can reuse the preload/IPC bridge; it mounts a slim root instead of the full app.
const isDashboardWindow = window.location.hash.replace(/^#/, '') === 'dashboard';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <UnitsProvider>
        {isDashboardWindow ? <DashboardWindowRoot /> : <App />}
      </UnitsProvider>
    </ErrorBoundary>
  </StrictMode>,
)
