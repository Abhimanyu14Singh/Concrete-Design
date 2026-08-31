import { useEffect } from 'react'
import { useUnits } from '../../src/contexts/UnitsContext.tsx'

// Push a unit system into the app's real UnitsContext.
//
// Needed because a detached panel is a separate document with its own React tree and its
// own provider — it cannot inherit the main window's. `units` therefore travels as a
// prop like any other piece of state, and this applies it. The same component is used in
// the main window so there is one path, not two.
//
// It renders nothing; it exists to own an effect. Doing this inside a panel would put a
// context write in a component that is supposed to be pure props-in-events-out.
export default function UnitsSync({ units }) {
  const { units: current, setUnits } = useUnits()
  useEffect(() => {
    if (units && units !== current) setUnits(units)
  }, [units, current, setUnits])
  return null
}
