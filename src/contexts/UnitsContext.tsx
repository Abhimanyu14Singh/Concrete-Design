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

export function useUnits(): UnitsCtx {
  const ctx = useContext(UnitsContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider (e.g. tests)
    return {
      units: 'imperial',
      setUnits: () => {},
      fmt: (v, q, d) => fmt(v, q, 'imperial', d),
      fmtVal: (v, q, d) => fmtVal(v, q, 'imperial', d),
      label: q => unitLabel(q, 'imperial'),
      toDisplay: v => v,
      fromDisplay: v => v,
    };
  }
  return ctx;
}
