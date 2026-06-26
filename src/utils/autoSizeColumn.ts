/**
 * autoSizeColumnSection — minimum gross section for a column's axial demand,
 * ported from Column_Design_DW design_engine.auto_size.
 *
 * Solves the ACI §22.4.2 short-column axial capacity for the gross area that
 * carries |Pu| at the target DCR with a chosen steel ratio ρ:
 *
 *   φPn = φ·α·[0.85·f'c·(Ag − Ast) + fy·Ast],  Ast = ρ·Ag
 *       = φ·α·[0.85·f'c·(1 − ρ) + fy·ρ]·Ag = K·Ag
 *   ⇒ Ag,req = |Pu| / (target_DCR · K)
 *
 * then rounds the section up to even inches. This is an axial-demand starting
 * size (it does not include the P-M moment interaction), so when a design is
 * P-M-governed the caller should enlarge past it — exactly the Column_Design_DW
 * behaviour. tied: φ=0.65 α=0.80; spiral: φ=0.75 α=0.85.
 *
 * Units: kips in, psi in, inches out.
 */

const roundUpEven = (x: number): number => 2 * Math.ceil(x / 2 - 1e-9);

export interface ColumnSectionSuggestion {
  shape: 'rectangular' | 'circular';
  b: number;            // in (= diameter for circular)
  h: number;            // in (= diameter for circular)
  diameter?: number;    // in (circular only)
  AgReq: number;        // required gross area (in²)
  AgProvided: number;   // provided gross area of the rounded section (in²)
  rho: number;          // steel ratio assumed
  governingPuKip: number;
}

export interface AutoSizeOptions {
  governingPuKip: number;
  fcPsi: number;
  fyPsi: number;
  targetDCR?: number;      // default 0.9
  rho?: number;            // assumed steel ratio (default 0.02)
  spiral?: boolean;        // default false (tied)
  shape?: 'rectangular' | 'circular';
  minDimIn?: number;       // default 12
  maxDimIn?: number;       // default 60
  /** Force the result strictly larger than this current section (in). */
  currentBIn?: number;
  currentHIn?: number;
}

/** Minimum even-inch column section for the axial demand, or null if it would
 *  exceed maxDimIn (demand needs a bigger member or a different ρ). */
export function autoSizeColumnSection(opts: AutoSizeOptions): ColumnSectionSuggestion | null {
  const targetDCR = opts.targetDCR ?? 0.9;
  const rho = opts.rho ?? 0.02;
  const spiral = opts.spiral ?? false;
  const shape = opts.shape ?? 'rectangular';
  const minDim = opts.minDimIn ?? 12;
  const maxDim = opts.maxDimIn ?? 60;

  const phi = spiral ? 0.75 : 0.65;
  const alpha = spiral ? 0.85 : 0.80;
  const K = phi * alpha * (0.85 * opts.fcPsi * (1 - rho) + opts.fyPsi * rho); // psi
  if (K <= 0) return null;
  const AgReq = (Math.abs(opts.governingPuKip) * 1000) / (targetDCR * K);     // in²

  if (shape === 'circular') {
    let D = Math.max(minDim, roundUpEven(Math.sqrt((4 * AgReq) / Math.PI)));
    if (opts.currentBIn) D = Math.max(D, roundUpEven(opts.currentBIn + 2));
    if (D > maxDim) return null;
    const Ag = (Math.PI * D * D) / 4;
    return { shape, b: D, h: D, diameter: D, AgReq, AgProvided: Ag, rho, governingPuKip: opts.governingPuKip };
  }

  let h = Math.max(minDim, roundUpEven(Math.sqrt(AgReq)));
  let b = Math.max(minDim, roundUpEven(AgReq / h));
  // When P-M (not axial) governs, the axial size can be smaller than the failing
  // section — ensure the recommendation is an actual enlargement.
  if (opts.currentHIn) h = Math.max(h, roundUpEven(opts.currentHIn + 2));
  if (opts.currentBIn) b = Math.max(b, roundUpEven(opts.currentBIn + 2));
  if (b > maxDim || h > maxDim) return null;
  return { shape, b, h, AgReq, AgProvided: b * h, rho, governingPuKip: opts.governingPuKip };
}

/** One-line human summary for a suggestion (used in the auto-design note). */
export function describeColumnSection(s: ColumnSectionSuggestion): string {
  const geom = s.shape === 'circular' ? `Ø${s.diameter}"` : `${s.b}×${s.h}"`;
  return `${geom} (ρ≈${(s.rho * 100).toFixed(0)}%)`;
}
