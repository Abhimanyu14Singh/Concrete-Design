import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/index.css' // bundled UI font (offline-safe) — see FONT.ui in theme.ts
import './index.css'
import App from './App.tsx'
import DashboardWindowRoot from './components/Dashboard/DashboardWindowRoot.tsx'
import Popout from './workspace/Popout.jsx'
import { popoutWinId } from './workspace/popoutBus.js'
import { UnitsProvider } from './contexts/UnitsContext.tsx'
import ErrorBoundary from './components/common/ErrorBoundary.tsx'
import { initUsage } from './utils/usage.ts'

// ── Which role is this window? ────────────────────────────────────────────────
// One bundle, three roles. Both detached roles load the SAME page with a marker in
// the URL and return a slim root here, so the full app — the rail, the engine runs,
// the toolbar — never mounts behind a single panel.
//
//   #dashboard        the Group Dashboard's own window (the original bespoke route)
//   ?popout=<winId>   a panel WINDOW — a container holding one or more torn-off panels
//
// The parameter names a WINDOW, not a panel. A detached window can hold several panels
// in its own column layout (panels are dragged between windows), so the window asks the
// bus what it is holding rather than reading it off the URL.
//
// The second arm is what the workspace port needs and did not have: usePopoutHost
// opens `…/?popout=<winId>`, and with no branch for it this file fell through to
// <App/> — so detaching a panel re-mounted the WHOLE application in the new window
// instead of the one panel that was asked for. The demo this workspace came from
// has always had this branch in its own entry; it simply did not travel with the
// code. Keep the two in step: a new detachable role needs an arm here or it silently
// becomes a second copy of the app.
const isDashboardWindow = window.location.hash.replace(/^#/, '') === 'dashboard';
const panelWinId = popoutWinId();

// Start the usage log before the tree mounts, so a crash DURING the first render is
// recorded rather than lost — that failure is the one nobody can otherwise describe.
// The role travels with every event: a panel window and the main window fail in
// different ways and the log has to be able to tell them apart. No-op in a browser.
initUsage(panelWinId ? 'panel' : isDashboardWindow ? 'dashboard' : 'main');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <UnitsProvider>
        {panelWinId ? <Popout winId={panelWinId} />
          : isDashboardWindow ? <DashboardWindowRoot />
            : <App />}
      </UnitsProvider>
    </ErrorBoundary>
  </StrictMode>,
)
