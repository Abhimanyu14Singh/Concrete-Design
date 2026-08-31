/**
 * Booting on a colour mode that no longer exists.
 *
 * `planColorMode` persists per machine, so withdrawing a scheme from the dropdown does
 * not withdraw it from the machines already sitting on it. Without a migration those
 * boot into a mode the picker has no entry for: the control reads back the raw key and
 * the histogram renders nothing, which looks like a broken panel rather than a retired
 * option. This is the check that the retirement is handled on the way in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadLayout, DEFAULT_LAYOUT } from '../layout.js';

const KEY = 'sdash-beam-demo/layout/v2';

/** vitest runs in `node`, which has no localStorage — the module reads it on every call,
 *  so a plain in-memory stand-in is enough. */
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
});

const save = (patch: Record<string, unknown>) => store.set(KEY, JSON.stringify(patch));

describe('loadLayout — the withdrawn S-Concrete pass/fail scheme', () => {
  it('moves a machine parked on pass/fail onto the DCR scheme', () => {
    save({ planColorMode: 'sconcrete' });
    expect(loadLayout().planColorMode).toBe('sconcreteDcr');
  });

  it('leaves every other colour mode alone', () => {
    for (const mode of ['none', 'dcr', 'group', 'flexSteel', 'weight', 'sconcreteDcr']) {
      save({ planColorMode: mode });
      expect(loadLayout().planColorMode).toBe(mode);
    }
  });

  it('falls back to the default when the key was never written', () => {
    // The migration names planColorMode explicitly in the returned object, which beats
    // the DEFAULTS spread — so an absent key must not come back as undefined.
    save({ units: 'si' });
    expect(loadLayout().planColorMode).toBe(DEFAULT_LAYOUT.planColorMode);
    expect(loadLayout().planColorMode).not.toBeUndefined();
  });

  it('falls back with no stored layout at all', () => {
    expect(loadLayout().planColorMode).toBe(DEFAULT_LAYOUT.planColorMode);
  });

  it('does not disturb the other preferences it travels with', () => {
    save({ planColorMode: 'sconcrete', flexFace: 'top', lineWeightScale: 0.8 });
    const l = loadLayout();
    expect(l.planColorMode).toBe('sconcreteDcr');
    expect(l.flexFace).toBe('top');
    expect(l.lineWeightScale).toBe(0.8);
  });
});
