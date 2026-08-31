/**
 * A detached panel gets exactly the callbacks `PANELS` names, and nothing else.
 *
 * `Popout.fnsFor` builds one proxy per entry in `PANELS[kind].fns`. The main window's
 * own `fns(kind)` hands every panel the whole set regardless of kind, so a DOCKED panel
 * works no matter what this list says — the list only matters once the panel is on
 * another screen. That asymmetry is the trap: you add a prop, wire it in the workspace,
 * see it work, and it is dead in a detached window with nothing to say so.
 *
 * Dead how, exactly: a missing name arrives `undefined`, and a component that calls it
 * without a guard THROWS out of the event handler. That is what happened to the Plan
 * panel — its storey dropdown became a multi-select Filter, `onStory` was replaced by
 * `onHiddenStories` + `onElements`, and this list kept the old name. Detached, every
 * checkbox in the Filter popover threw, which reads as a dead popover rather than the
 * crash it is.
 *
 * So both directions are checked:
 *
 *   forward  every `on*` prop a panel destructures is declared  → nothing arrives
 *            undefined on a second screen
 *   reverse  every declared fn is a prop some panel takes       → the list cannot rot
 *            into naming callbacks that no longer exist
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PANELS, PANEL_ORDER } from '../popoutBus.js';
import { COMPONENTS } from '../Popout.jsx';

/** Supplied by the detached WINDOW, not by the bus — see `Popout.renderPanel`. */
const FROM_POPOUT = new Set(['onMenu', 'onBeamMenu', 'onSendHome', 'onHost', 'onDrag']);

/**
 * Declared fns that no panel destructures BY DESIGN. `onClose` reaches PanelFrame
 * through the `...frame` rest, so it is never named in a panel's own signature and the
 * reverse check would otherwise flag it on all ten panels.
 */
const VIA_FRAME = new Set(['onClose']);

const PANELS_DIR = path.join(__dirname, '..', 'panels');

/** `popoutBus` is plain JS, so read its entries through one typed accessor rather than
 *  narrowing at each use. A kind with no entry yields empty lists, which the sibling
 *  `popoutComponents.test.ts` is the one to complain about. */
function contract(kind: string): { fns: string[]; reqs: string[] } {
  const p = (PANELS as Record<string, { fns?: string[]; reqs?: string[] }>)[kind];
  return { fns: p?.fns ?? [], reqs: p?.reqs ?? [] };
}

/**
 * The `on*` props a panel destructures.
 *
 * Read from source rather than by rendering: the signature IS the complete list of what
 * a panel is handed by name, and anything not named there lands in `...frame` and goes
 * to PanelFrame. Sourced off the component's own function name so the file this reads
 * cannot drift from the component `Popout` actually mounts.
 */
function propsOf(kind: string): { file: string; props: Set<string> } {
  const name = (COMPONENTS as Record<string, { name: string }>)[kind].name;
  const file = path.join(PANELS_DIR, `${name}.jsx`);
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('export default function');
  expect(start, `${name}.jsx has no default export`).toBeGreaterThan(-1);
  const sig = src.slice(start, src.indexOf('}) {', start));
  return { file: `${name}.jsx`, props: new Set([...sig.matchAll(/\b(on[A-Z]\w*)\b/g)].map((m) => m[1])) };
}

describe('every detachable panel gets the callbacks it actually uses', () => {
  it.each(PANEL_ORDER)('%s — nothing it destructures arrives undefined when detached', (kind) => {
    const { file, props } = propsOf(kind);
    const { fns, reqs } = contract(kind);
    const declared = new Set([...fns, ...reqs]);
    const undeclared = [...props].filter((p) => !declared.has(p) && !FROM_POPOUT.has(p));
    expect(undeclared, `${file} takes these, but PANELS.${kind} does not send them`).toEqual([]);
  });

  it.each(PANEL_ORDER)('%s — declares nothing the panel has stopped taking', (kind) => {
    const { file, props } = propsOf(kind);
    const stale = contract(kind).fns.filter((f) => !props.has(f) && !VIA_FRAME.has(f));
    expect(stale, `PANELS.${kind} sends these, but ${file} has no such prop`).toEqual([]);
  });

  it('the Plan Filter can still write back from a detached window', () => {
    // The specific regression the checks above generalise. Both are the Filter popover's
    // outputs, and PlanFilter calls them unguarded — undefined here is a throw, not a
    // no-op, on every storey and element checkbox.
    expect(contract('plan').fns).toContain('onHiddenStories');
    expect(contract('plan').fns).toContain('onElements');
  });

  it('every panel can be closed from its own window', () => {
    // PanelFrame's ✕ is unconditional, so a panel missing this has a close button that
    // throws rather than one that is absent.
    for (const kind of PANEL_ORDER) expect(contract(kind).fns, kind).toContain('onClose');
  });
});
