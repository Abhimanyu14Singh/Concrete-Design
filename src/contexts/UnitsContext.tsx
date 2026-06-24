import { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import type { UnitSystem, Quantity } from '../utils/units';
import { loadUnits, saveUnits, fmt, fmtVal, unitLabel, toDisplay, fromDisplay } from '../utils/units';

interface UnitsCtx {
  units: UnitSystem;
  setUnits: (u: UnitSystem) => void;
  fmt: (v: number, q: Quantity, digits?: number) => string;
  fmtVal: (v: number, q: Quantity, digits?: number) => string;
  label: (q: Quantity) => string;
  toDisplay: (v: number, q: Quantity) => number;
  fromDisplay: (v: number, q: Quantity) => number;
}

const UnitsContext = createContext<UnitsCtx | null>(null);

export function UnitsProvider({ children }: { children: ReactNode }) {
  const [units, setUnitsState] = useState<UnitSystem>(loadUnits);

  const setUnits = useCallback((u: UnitSystem) => {
    setUnitsState(u);
    saveUnits(u);
  }, []);

  const value: UnitsCtx = {
    units,
    setUnits,
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
      fmt: (v, q, d) => fmt(v, q, u, d),
      fmtVal: (v, q, d) => fmtVal(v, q, u, d),
      label: q => unitLabel(q, u),
      toDisplay: (v, q) => toDisplay(v, q, u),
      fromDisplay: (v, q) => fromDisplay(v, q, u),
    };
  }
  return ctx;
}
