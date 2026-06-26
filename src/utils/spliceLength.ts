/**
 * Column longitudinal-bar lap / development splice length per ACI 318-19,
 * ported 1:1 from Column_Design_DW design_engine.compute_splice_length.
 *
 *  • Compression lap (§25.5.5.1): l_sc = 0.0005·fy·db for fy ≤ 60 ksi, else
 *    (0.0009·fy − 24)·db; ×1.33 when f'c < 3000 psi; floor 12".
 *  • Tension lap (§25.5.2.1) needs the development length ld first
 *    (§25.4.2.3 simplified): ld = 3·fy·ψs / (40·λ·√f'c·((cb+Ktr)/db)) · db,
 *    with ψs = 0.8 for ≤ #6, the confinement ratio clamped to [1.5, 2.5], and
 *    Class A = 1.0·ld, Class B = 1.3·ld; floor 12".
 *
 * S-Concrete's "Cm Splice" flag is informational only and produces no lap
 * length, so this is validated by ACI code reference, not by S-Concrete.
 *
 * Units: psi in, inches out.
 */
import { getBarDiam } from './concreteDesign';

export type SpliceType =
  | 'None' | 'Tangential' | 'Bearing' | 'Mech/Weld' | 'Mechanical'  // → no lap length
  | 'Compression' | 'Radial'                                        // compression lap
  | 'Tension A' | 'Tension B' | 'Lap';                              // tension lap (Lap ≡ Tension B)

const NO_LAP: ReadonlySet<string> = new Set(['None', 'Tangential', 'Bearing', 'Mech/Weld', 'Mechanical']);

export interface SpliceParams {
  barSize: number;        // longitudinal bar (US # positive; metric Ø mm negative)
  spliceType: SpliceType;
  fcPsi: number;
  fyPsi: number;
  coverIn?: number;       // clear cover (default 1.5)
  tieBarSize?: number;    // tie/hoop bar (default #4)
}

/**
 * Lap splice length in inches, or null when the splice type carries no lap
 * length (mechanical, butt/bearing, none). Mirrors the Python return contract.
 */
export function spliceLengthIn(p: SpliceParams): number | null {
  if (NO_LAP.has(p.spliceType)) return null;

  const db = getBarDiam(p.barSize);
  if (db <= 0) return null;
  const sqFc = Math.sqrt(Math.max(p.fcPsi, 2500));

  if (p.spliceType === 'Compression' || p.spliceType === 'Radial') {
    let lsc = p.fyPsi <= 60000 ? 0.0005 * p.fyPsi * db : (0.0009 * p.fyPsi - 24) * db;
    if (p.fcPsi < 3000) lsc *= 1.33;
    return Math.max(lsc, 12);
  }

  // Tension lap — develop ld first (§25.4.2.3 simplified, confined bars).
  const cover = p.coverIn ?? 1.5;
  const tieD = getBarDiam(p.tieBarSize ?? 4);
  const psiS = db <= getBarDiam(6) ? 0.8 : 1.0;        // ψs = 0.8 for #6 and smaller
  const ratio = Math.max(1.5, Math.min((cover + tieD / 2) / db, 2.5));
  const ld = Math.max((3 * p.fyPsi * psiS) / (40 * sqFc * ratio) * db, 12);

  return p.spliceType === 'Tension A' ? Math.max(ld, 12) : Math.max(ld * 1.3, 12);
}

/** Human-readable ACI clause for a splice type (for calc-sheet refs). */
export function spliceClause(spliceType: SpliceType): string {
  if (spliceType === 'Compression' || spliceType === 'Radial') return 'ACI §25.5.5.1';
  if (spliceType === 'Tension A') return 'ACI §25.5.2.1 (Class A)';
  return 'ACI §25.5.2.1 (Class B)';
}
