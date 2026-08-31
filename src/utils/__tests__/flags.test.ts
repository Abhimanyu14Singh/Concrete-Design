/**
 * Hidden-feature flags.
 *
 * The failure that matters here is asymmetric. A flag stuck OFF is an annoyance — the
 * feature is missing and someone goes looking. A flag stuck ON ships a panel to every
 * customer that was explicitly meant to be hidden, and nothing about the build says so.
 * So the cases below lean on "off unless the value is exactly right".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { flagOn } from '../flags';

const KEY = 'sdash.flag.importDiagnostics';
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
});
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

describe('flagOn', () => {
  it('is OFF when nothing has been set — the shipped default', () => {
    expect(flagOn('importDiagnostics')).toBe(false);
  });

  it('is ON for exactly "1"', () => {
    store.set(KEY, '1');
    expect(flagOn('importDiagnostics')).toBe(true);
  });

  it('stays off for other truthy-looking values', () => {
    // Not pedantry: "true"/"yes" are what someone types from memory, and a flag that
    // accepts anything non-empty would also be turned on by a stale "0".
    for (const v of ['true', 'yes', 'on', '0', 'false', '', ' 1', '1 ']) {
      store.set(KEY, v);
      expect(flagOn('importDiagnostics'), `value ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it('goes back off when the key is removed', () => {
    store.set(KEY, '1');
    expect(flagOn('importDiagnostics')).toBe(true);
    store.delete(KEY);
    expect(flagOn('importDiagnostics')).toBe(false);
  });

  it('reads the prefixed key, not the bare flag name', () => {
    // The prefix is what keeps these out of the way of the layout and units keys that
    // share this origin.
    store.set('importDiagnostics', '1');
    expect(flagOn('importDiagnostics')).toBe(false);
    store.set(KEY, '1');
    expect(flagOn('importDiagnostics')).toBe(true);
  });

  it('returns false rather than throwing when storage is unavailable', () => {
    // Private mode, a locked-down profile, or a non-DOM test runner. A hidden feature
    // staying hidden is the safe answer; an exception here would take out the render.
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem() { throw new Error('access denied'); },
    };
    expect(() => flagOn('importDiagnostics')).not.toThrow();
    expect(flagOn('importDiagnostics')).toBe(false);
  });

  it('survives there being no localStorage at all', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(flagOn('importDiagnostics')).toBe(false);
  });
});
