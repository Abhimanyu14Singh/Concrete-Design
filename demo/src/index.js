import { createRoot } from 'react-dom/client'
import App from './App.js'
import Popout from './Popout.js'
import { isPopoutWindow, popoutKind } from './popoutBus.js'
import { UnitsProvider } from '../../src/contexts/UnitsContext.tsx'
import './ui.css'
import './shell.css'

// One bundle, one entry, two roles. A detached window loads the SAME page with
// ?popout=<kind> and returns early here, so the whole main-window app — the group rail,
// the engine runs, the toolbar — never mounts behind a single panel.
//
// UnitsProvider is the app's real one, mounted in BOTH roles: SectionView and the
// formatters read it, and a detached window has its own React tree, so it needs its own.
// The two are kept in step by the `units` prop, not by sharing a provider.
const root = createRoot(document.getElementById('root'))
root.render(
  <UnitsProvider>
    {isPopoutWindow() ? <Popout kind={popoutKind()} /> : <App />}
  </UnitsProvider>,
)
