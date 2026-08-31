/**
 * A detachable panel is registered in THREE places, and nothing connected them:
 *
 *   1. `PANELS`      — its title and the callbacks allowed across the bus
 *   2. `PANEL_ORDER` — the rail, and the "detach every panel" sweep
 *   3. `COMPONENTS`  — what the detached WINDOW actually mounts
 *
 * Miss (3) and the workspace still offers Detach — PanelFrame's button is
 * unconditional — but the window that opens renders "Unknown panel “<kind>”". That
 * is exactly what `sconcrete` did: registered in (1) and (2), absent from (3), so
 * S-Concrete was the one panel that could not be moved to a second screen.
 *
 * Keeping the three lists in agreement is the whole point of this file.
 */
import { describe, it, expect } from 'vitest';
import { PANELS, PANEL_ORDER } from '../popoutBus.js';
import { COMPONENTS } from '../Popout.jsx';

describe('detachable panels are registered consistently', () => {
  it('every ordered panel can actually mount in its own window', () => {
    expect(PANEL_ORDER.filter((k) => !COMPONENTS[k])).toEqual([]);
  });

  it('every ordered panel declares its bus contract', () => {
    expect(PANEL_ORDER.filter((k) => !PANELS[k])).toEqual([]);
  });

  it('nothing is mountable that the rail does not know about', () => {
    const orphans = Object.keys(COMPONENTS).filter((k) => !PANEL_ORDER.includes(k));
    expect(orphans).toEqual([]);
  });

  it('includes S-Concrete, and lets it hand its run results back', () => {
    expect(COMPONENTS.sconcrete).toBeTypeOf('function');
    // onProjectPatch is how a detached run's results reach the main window — without
    // it the batch would run in the popout and the results would go nowhere.
    expect(PANELS.sconcrete.fns).toContain('onProjectPatch');
    expect(PANELS.sconcrete.fns).toContain('onSelectGroup');
    expect(PANELS.sconcrete.fns).toContain('onOpenMember');
  });
});
