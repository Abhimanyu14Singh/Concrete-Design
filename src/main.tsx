import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { UnitsProvider } from './contexts/UnitsContext.tsx'
import ErrorBoundary from './components/common/ErrorBoundary.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <UnitsProvider>
        <App />
      </UnitsProvider>
    </ErrorBoundary>
  </StrictMode>,
)
