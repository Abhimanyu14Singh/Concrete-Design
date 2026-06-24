/**
 * Regression tests for the units-context robustness bug.
 *
 * Symptoms (reported in SI + Eurocode mode):
 *  1. GroupRebarEditor: typing stirrup spacing "150" mm snapped to "24" — the
 *     IMPERIAL spacingMax. Only possible if the component saw units==='imperial'.
 *  2. Member editor then displayed it as ~3800 mm (150 × 25.4) — a value stored
 *     as raw inches (no fromDisplay) then re-displayed via toDisplay.
 *
 * Both are explained by `useUnits()` silently falling back to an IMPERIAL
 * identity context when a subtree renders outside <UnitsProvider>. This test
 * pins down that the fallback must reflect the user's persisted unit system,
 * so spacing round-trips consistently regardless of provider reach.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnitsProvider, useUnits } from '../UnitsContext';
import { UNITS_STORAGE_KEY } from '../../utils/units';

// Minimal localStorage shim for the node test environment.
function installLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

describe('useUnits round-trip (in provider)', () => {
  beforeEach(() => installLocalStorage());

  it('SI: typing 150 mm stores ~5.91 in and redisplays as 150 mm', () => {
    let captured: ReturnType<typeof useUnits> | null = null;
    function Probe() { captured = useUnits(); return null; }
    installLocalStorage({ [UNITS_STORAGE_KEY]: 'si' });
    renderToStaticMarkup(<UnitsProvider><Probe /></UnitsProvider>);
    const ctx = captured!;
    expect(ctx.units).toBe('si');
    const stored = ctx.fromDisplay(150, 'length');     // mm typed → inches stored
    expect(stored).toBeCloseTo(150 / 25.4, 6);          // ≈ 5.91 in
    expect(ctx.toDisplay(stored, 'length')).toBeCloseTo(150, 6); // redisplay → 150 mm
  });
});

describe('useUnits no-provider fallback robustness (the bug)', () => {
  it('does NOT silently force imperial when the user persisted SI', () => {
    installLocalStorage({ [UNITS_STORAGE_KEY]: 'si' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let captured: ReturnType<typeof useUnits> | null = null;
    function Probe() { captured = useUnits(); return null; }
    // Rendered WITHOUT a provider — simulates an escaped subtree.
    renderToStaticMarkup(<Probe />);
    const ctx = captured!;
    // Before the fix this returned units:'imperial' with identity conversions,
    // which both clamped 150→24 and stored display values as raw inches.
    expect(ctx.units).toBe('si');
    expect(ctx.toDisplay(1, 'length')).toBeCloseTo(25.4, 6);
    expect(ctx.fromDisplay(150, 'length')).toBeCloseTo(150 / 25.4, 6);
    warn.mockRestore();
  });

  it('full display→store→display round-trip is stable without a provider', () => {
    installLocalStorage({ [UNITS_STORAGE_KEY]: 'si' });
    let captured: ReturnType<typeof useUnits> | null = null;
    function Probe() { captured = useUnits(); return null; }
    renderToStaticMarkup(<Probe />);
    const ctx = captured!;
    const stored = ctx.fromDisplay(150, 'length');
    expect(ctx.toDisplay(stored, 'length')).toBeCloseTo(150, 6);
  });
});
