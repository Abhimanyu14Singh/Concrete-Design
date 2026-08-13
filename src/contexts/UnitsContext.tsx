import { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import type { UnitSystem, Quantity } from '../utils/units';
import type { BarFamily } from '../types';
import { loadUnits, saveUnits, fmt, fmtVal, unitLabel, toDisplay, fromDisplay } from '../utils/units';
import { loadStandards } from '../utils/projectSettings';

interface UnitsCtx {
  units: UnitSystem;
  setUnits: (u: UnitSystem) => void;
  /** Bar catalogue for every rebar picker. Deliberately independent of `units`
   *  — a millimetre job can still be detailed in US #-bars. Owned by project
   *  settings and pushed down here so the pickers need no extra prop. */
  barFamily: BarFamily;
  setBarFamily: (f: BarFamily) => void;
  fmt: (v: number, q: Quantity, digits?: number) => string;
  fmtVal: (v: number, q: Quantity, digits?: number) => string;
  label: (q: Quantity) => string;
  toDisplay: (v: number, q: Quantity) => number;
  fromDisplay: (v: number, q: Quantity) => number;
}

const UnitsContext = createContext<UnitsCtx | null>(null);

export function UnitsProvider({ children }: { children: ReactNode }) {
  const [units, setUnitsState] = useState<UnitSystem>(loadUnits);
  // Seeded from the remembered standards so the very first render already offers
  // the right catalogue; App pushes the active project's choice over it on load.
  const [barFamily, setBarFamily] = useState<BarFamily>(() => loadStandards()?.settings.barFamily ?? 'us');

  const setUnits = useCallback((u: UnitSystem) => {
    setUnitsState(u);
    saveUnits(u);
  }, []);

  const value: UnitsCtx = {
    units,
    setUnits,
    barFamily,
    setBarFamily,
    fmt: (v, q, d) => fmt(v, q, units, d),
    fmtVal: (v, q, d) => fmtVal(v, q, units, d),
    label: q => unitLabel(q, units),
    toDisplay: (v, q) => toDisplay(v, q, units),
    fromDisplay: (v, q) => fromDisplay(v, q, units),
  };

  return <UnitsContext.Provider value={value}>{children}</UnitsContext.Provider>;
}

let warnedNoProvider = false;

export function useUnits(): UnitsCtx {
  const ctx = useContext(UnitsContext);
  if (!ctx) {
    // No <UnitsProvider> above us. This must NOT silently force imperial:
    // doing so clamps SI inputs against imperial limits and stores display
    // values as raw inches (the double-conversion bug). Honour the user's
    // PERSISTED unit system so conversions stay correct and symmetric, and
    // shout in dev so the missing provider gets fixed.
    if (import.meta.env?.DEV && !warnedNoProvider) {
      warnedNoProvider = true;
      console.warn(
        '[useUnits] called outside <UnitsProvider>. Falling back to persisted ' +
        'units; wrap this subtree in <UnitsProvider> to share live unit state.',
      );
    }
    const u = loadUnits();
    return {
      units: u,
      setUnits: () => {},
      barFamily: u === 'si' ? 'euro' : 'us',
      setBarFamily: () => {},
      fmt: (v, q, d) => fmt(v, q, u, d),
      fmtVal: (v, q, d) => fmtVal(v, q, u, d),
      label: q => unitLabel(q, u),
      toDisplay: (v, q) => toDisplay(v, q, u),
      fromDisplay: (v, q) => fromDisplay(v, q, u),
    };
  }
  return ctx;
}
