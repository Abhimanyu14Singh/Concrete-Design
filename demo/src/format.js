import { useUnits } from '../../src/contexts/UnitsContext.tsx'

// Display formatting, through the app's own UnitsContext.
//
// Nothing in the demo may hand-format a number with a unit on it. Everything the engine
// stores is IMPERIAL — inches, psi, kips, kip-ft — and the display system converts at the
// boundary, so a hard-coded `in²` or `kip-ft` is not a cosmetic shortcut: it is a wrong
// label the moment anyone flips to SI, on numbers an engineer is going to read off the
// screen. That is why this file exists rather than a few inline template strings.
//
// It works in a detached window too, because both windows mount the real UnitsProvider
// and the `units` prop keeps them in step.

export function useFmt() {
  const { fmt, fmtVal, label, units, toDisplay, barFamily } = useUnits()

  /** "16×24". Every section in this model is rectangular, so there is no flange suffix
   *  to append and no web width to prefer over b — `bw`/`hf` do not exist here.
   *  Zero decimals on purpose: this is a MARK, scanned in a dense list and a header, not
   *  a dimension to read a value off. The default 2 places turns "16×24" into
   *  "16.00×24.00", which stops fitting and stops being scannable. */
  const section = m => {
    const s = m.section
    const n = v => fmtVal(v, 'length', 0)
    return `${n(s.b)}×${n(s.h)}`
  }

  return { fmt, fmtVal, label, units, toDisplay, barFamily, section }
}
