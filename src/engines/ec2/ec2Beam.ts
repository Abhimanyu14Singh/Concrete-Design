/**
 * Eurocode 2 (EN 1992-1-1) beam strength checks.
 *
 * Boundary convention: the public designMemberEC2() accepts the app's stored
 * imperial data (in, psi, kips, kip-ft), converts to SI at the boundary,
 * runs all checks in SI (mm, MPa, kN, kN·m), and converts results back to
 * imperial so the existing DesignResults display pipeline works unchanged.
 *
 * IMPORTANT: EC2 has no φ strength-reduction factor. Safety lives in the
 * material partial factors γc = 1.5 and γs = 1.15 baked into fcd/fyd.
 * The returned phi_Mn/phi_Vn/phi_Tn fields hold the DESIGN resistances
 * (M_Rd, V_Rd, T_Rd) — do NOT apply φ to them again. Mn_pos === phi_Mn_pos
 * by construction.
 *
 * f'c is interpreted as the CYLINDER strength → fck = f'c × 0.00689476 MPa.
 */

import type {
  MaterialProps, SectionDimensions, RebarLayout, LoadCase,
  DesignResults, DesignWarning, CrackControlParams,
} from '../../types';
import type { ZoneShearResult } from '../../utils/concreteDesign';
import { DEFAULT_CRACK_PARAMS } from '../../types';
import { getBarArea, getBarDiam } from '../../utils/concreteDesign';

// ── Unit factors (imperial → SI) ─────────────────────────────────────────────
const IN_TO_MM   = 25.4;
const PSI_TO_MPA = 0.00689476;
const KIP_TO_KN  = 4.44822;
const KIPFT_TO_KNM = 1.35582;
const IN2_TO_MM2 = 645.16;

// Partial safety factors (EN 1992-1-1 Table 2.1N)
const GAMMA_C = 1.5;
const GAMMA_S = 1.15;
// UK National Annex value (base EN 1992-1-1 uses 1.0)
const ALPHA_CC = 0.85;

// ── §3.1.7 rectangular stress block factors ─────────────────────────────────
export function lambdaEta(fck: number): { lambda: number; eta: number } {
  const lambda = fck <= 50 ? 0.8 : 0.8 - (fck - 50) / 400;
  const eta    = fck <= 50 ? 1.0 : 1.0 - (fck - 50) / 200;
  return { lambda, eta };
}

/** Mean tensile strength fctm (MPa), §3.1.3 Table 3.1 (fck ≤ 50). */
export function fctm(fck: number): number {
  if (fck <= 50) return 0.30 * Math.pow(fck, 2 / 3);
  return 2.12 * Math.log(1 + (fck + 8) / 10);
}

// ── Flexure §6.1 ─────────────────────────────────────────────────────────────
/**
 * M_Rd for a rectangular (or T/L with flange split) section.
 * All inputs SI: mm, MPa, mm². Returns kN·m.
 */
export function mRd(
  As: number, d: number, b: number, fck: number, fcd: number, fyd: number,
  bw?: number, hf?: number,
): { MRd: number; x: number } {
  if (As <= 0 || d <= 0) return { MRd: 0, x: 0 };
  const { lambda, eta } = lambdaEta(fck);

  // Neutral axis depth assuming rectangular block within b
  let x = (As * fyd) / (eta * fcd * lambda * b);

  if (bw !== undefined && hf !== undefined && lambda * x > hf && bw < b) {
    // Compression extends below flange: split into flange overhang + web
    const Ff = eta * fcd * (b - bw) * hf;          // N
    const Fw = As * fyd - Ff;                       // N
    const aw = Fw / (eta * fcd * bw);               // web block depth (mm)
    x = (hf + aw) / lambda;
    const MRd = (Ff * (d - hf / 2) + Fw * (d - hf - aw / 2)) / 1e6; // kN·m
    return { MRd, x };
  }

  const MRd = As * fyd * (d - lambda * x / 2) / 1e6; // kN·m
  return { MRd, x };
}

// ── Shear §6.2 ───────────────────────────────────────────────────────────────
/**
 * V_Rd,c — design shear resistance without shear reinforcement, §6.2.2 eq (6.2a/b).
 * SI inputs: mm, MPa, mm², N. Returns kN.
 */
export function vRdc(
  bw: number, d: number, Asl: number, fck: number, NEd_N = 0, Ac_mm2 = 0,
): number {
  if (bw <= 0 || d <= 0) return 0;
  const k = Math.min(2.0, 1 + Math.sqrt(200 / d));
  const rho_l = Math.min(0.02, Asl / (bw * d));
  const CRdc = 0.18 / GAMMA_C;
  const k1 = 0.15;
  const sigma_cp = Ac_mm2 > 0 ? Math.min(NEd_N / Ac_mm2, 0.2 * ALPHA_CC * fck / GAMMA_C) : 0;
  const vmin = 0.035 * Math.pow(k, 1.5) * Math.sqrt(fck);
  const v1 = CRdc * k * Math.pow(100 * rho_l * fck, 1 / 3) + k1 * sigma_cp;
  const v2 = vmin + k1 * sigma_cp;
  return Math.max(v1, v2) * bw * d / 1000; // kN
}

/** V_Rd,s — shear resistance from stirrups, §6.2.3 eq (6.8). SI in, kN out. */
export function vRds(
  Asw: number, s: number, z: number, fywd: number, cotTheta = 2.5,
): number {
  if (Asw <= 0 || s <= 0) return 0;
  return (Asw / s) * z * fywd * cotTheta / 1000; // kN
}

/** V_Rd,max — crushing limit of compression strut, §6.2.3 eq (6.9). kN. */
export function vRdMax(
  bw: number, z: number, fck: number, fcd: number, cotTheta = 2.5,
): number {
  const nu1 = 0.6 * (1 - fck / 250);
  const alpha_cw = 1.0;
  const tanTheta = 1 / cotTheta;
  return alpha_cw * bw * z * nu1 * fcd / (cotTheta + tanTheta) / 1000; // kN
}

// ── Torsion §6.3 ─────────────────────────────────────────────────────────────
/**
 * Torsion resistance of a solid rectangular section via the equivalent
 * thin-walled tube, §6.3.2. SI inputs: mm, MPa, mm². Returns kN·m values.
 */
export function tRd(
  b: number, h: number, AswPerLeg: number, s: number, fywd: number,
  fck: number, fcd: number, cotTheta = 2.5, coverToCentre = 0,
): { TRds: number; TRdMax: number; TRdc: number; Ak: number; uk: number; tef: number } {
  const A = b * h;             // gross area (mm²)
  const u = 2 * (b + h);       // outer perimeter (mm)

  // §6.3.2(1): tef,i = A/u, but ≥ 2× the distance from the surface to the
  // centroid of the longitudinal reinforcement. S-CONCRETE (and EC2) apply the
  // 2×cover floor for the TRUSS resistances (T_Rd,s, T_Rd,max) but use the bare
  // A/u thin-wall for the CRACKING torsion T_Rd,c.
  const tefc = Math.min(A / u, Math.min(b, h) / 2);          // cracking
  const tef  = Math.min(Math.max(A / u, 2 * coverToCentre), Math.min(b, h) / 2); // truss

  // Cracking-torsion properties (thin wall = A/u)
  const Akc = (b - tefc) * (h - tefc);
  // Truss properties (effective wall ≥ 2×cover-to-centre)
  const Ak = (b - tef) * (h - tef);
  const uk = 2 * ((b - tef) + (h - tef));

  // T_Rd,s from closed stirrups (one leg effective for torsion)
  const TRds = AswPerLeg > 0 && s > 0
    ? 2 * Ak * (AswPerLeg / s) * fywd * cotTheta / 1e6  // kN·m
    : 0;

  // T_Rd,max — strut crushing, eq (6.30): 2·ν·α_cw·f_cd·A_k·t_ef·sinθ·cosθ.
  // α_cw = 1.0 for non-prestressed members (same coefficient as shear eq 6.9).
  // f_cd already carries α_cc, so do NOT multiply by ALPHA_CC here.
  const nu = 0.6 * (1 - fck / 250);
  const alpha_cw = 1.0;
  const theta = Math.atan(1 / cotTheta);
  const TRdMax = 2 * nu * alpha_cw * fcd * Ak * tef * Math.sin(theta) * Math.cos(theta) / 1e6;

  // Cracking torsion T_Rd,c, §6.3.2(5): uses the bare A/u thin wall.
  const fctd = fctm(fck) * 0.7 / GAMMA_C; // fctd = αct·fctk,0.05/γc ≈ 0.7·fctm/1.5
  const TRdc = 2 * Akc * tefc * fctd / 1e6; // kN·m

  return { TRds, TRdMax, TRdc, Ak, uk, tef };
}

// ── Multi-layer bar centroid ─────────────────────────────────────────────────

/**
 * Distance from the near face of the section to the centroid of all bar layers
 * (mm). `groups` is ordered outermost-first (e.g. botBars[0] = outermost bottom
 * layer). `layerClearMm` is the clear gap between successive layers.
 */
export function layerCentroidMm(
  groups: import('../../types').BarGroup[],
  coverMm: number,
  stirrupMm: number,
  layerClearMm: number,
): number {
  let totalAs = 0, momentSum = 0;
  let yFromFace = coverMm + stirrupMm; // distance to stirrup inner face
  for (const g of groups) {
    if (!g || g.numBars <= 0) continue;
    const d = getBarDiam(g.barSize) * IN_TO_MM;
    yFromFace += d / 2; // to bar centre
    const a = g.numBars * (Math.PI / 4) * d * d;
    totalAs += a;
    momentSum += a * yFromFace;
    yFromFace += d / 2 + layerClearMm; // clear to next layer face
  }
  return totalAs > 0 ? momentSum / totalAs : yFromFace;
}

// ── Crack width §7.3.4 ───────────────────────────────────────────────────────

/** Mean secant modulus of elasticity Ecm (MPa), §3.1.3 Table 3.1. */
export function ecm(fck: number): number {
  return 22000 * Math.pow((fck + 8) / 10, 0.3);
}

/**
 * Creep coefficient φ(t,t0) per EN 1992-1-1 Annex B (eq B.1–B.10). Long-term by
 * default (pass a large t, e.g. 70 yr, so βc → 1). h0 = notional size (mm) =
 * 2·Ac/u. cementClass: 'S' (slow), 'N' (normal) or 'R' (rapid). 20 °C assumed.
 */
export function creepCoefficient(
  fck: number, RH: number, t0: number, tDays: number, h0: number,
  cementClass: 'S' | 'N' | 'R' = 'N',
): number {
  const fcm = fck + 8;
  const a1 = Math.pow(35 / fcm, 0.7);   // (B.8c)
  const a2 = Math.pow(35 / fcm, 0.2);
  const a3 = Math.pow(35 / fcm, 0.5);
  // Loading-age adjustment for cement class (B.9); 20 °C ⇒ no temperature term.
  const aCem = cementClass === 'S' ? -1 : cementClass === 'R' ? 1 : 0;
  const t0adj = Math.max(0.5, t0 * Math.pow(9 / (2 + Math.pow(t0, 1.2)) + 1, aCem));
  const h0root = Math.cbrt(h0);
  const phiRH = fcm <= 35                                                 // (B.3a/b)
    ? 1 + (1 - RH / 100) / (0.1 * h0root)
    : (1 + (1 - RH / 100) / (0.1 * h0root) * a1) * a2;
  const betaFcm = 16.8 / Math.sqrt(fcm);                                  // (B.4)
  const betaT0 = 1 / (0.1 + Math.pow(t0adj, 0.20));                       // (B.5)
  const phi0 = phiRH * betaFcm * betaT0;                                  // (B.2)
  const betaH = fcm <= 35                                                 // (B.8a/b)
    ? Math.min(1.5 * (1 + Math.pow(0.012 * RH, 18)) * h0 + 250, 1500)
    : Math.min(1.5 * (1 + Math.pow(0.012 * RH, 18)) * h0 + 250 * a3, 1500 * a3);
  const dt = Math.max(0, tDays - t0adj);
  const betaC = Math.pow(dt / (betaH + dt), 0.3);                         // (B.7)
  return phi0 * betaC;                                                    // (B.1)
}

export interface CrackWidthResult {
  wk: number;       // characteristic crack width (mm) — 0 when the section is uncracked
  sigma_s: number;  // steel stress under quasi-permanent moment (MPa)
  sr_max: number;   // maximum crack spacing (mm)
  x: number;        // cracked-section neutral axis depth (mm)
  rho_p_eff: number;
  k2: number;       // strain-distribution factor used (0.5, bending)
  srEq: '7.11' | '7.14' | null;  // which sr,max equation governed the min()
  cracked: boolean; // Mqp > Mcr → cracked; otherwise wk is forced to 0
  Mcr: number;      // cracking moment (kN·m)
  alpha_e: number;  // (creep-adjusted) modular ratio actually used
}

/**
 * Characteristic crack width wk = sr,max·(εsm − εcm) per EN 1992-1-1 §7.3.4,
 * following the Concrete-Institute long-hand method:
 *   • modular ratio αe = Es / Ec,eff with Ec,eff = Ecm/(1+φ)  (creep, opts.phi)
 *   • fully-cracked TRANSFORMED neutral axis incl. compression steel (opts.AsComp/dComp)
 *   • σs from the cracked transformed second moment of area
 *   • k2 = 0.5 (bending); sr,max = min(eq 7.11, eq 7.14)
 *   • un-cracked check: if Mqp ≤ Mcr the section is uncracked ⇒ wk = 0
 * All inputs SI: mm, MPa, kN·m.
 */
export function crackWidth(
  Mqp: number,     // quasi-permanent moment (kN·m)
  As: number,      // tension steel (mm²)
  barD: number,    // tension bar diameter (mm)
  b: number,       // section width at the tension face (mm)
  h: number,       // overall depth (mm)
  d: number,       // effective depth to tension steel (mm)
  cover: number,   // cover to the tension bar surface (mm)
  fck: number,     // MPa
  Es: number,      // MPa
  kt: number,      // 0.4 long-term / 0.6 short-term
  opts: { AsComp?: number; dComp?: number; phi?: number } = {},
): CrackWidthResult {
  const phi = opts.phi ?? 0;
  const alpha_e = Es / (ecm(fck) / (1 + phi));  // creep-adjusted modular ratio
  const AsComp = opts.AsComp ?? 0;              // compression steel (mm²)
  const dComp = opts.dComp ?? 0;                // its depth from the compression face

  if (Mqp <= 0 || As <= 0 || d <= 0) {
    return { wk: 0, sigma_s: 0, sr_max: 0, x: 0, rho_p_eff: 0, k2: 0.5, srEq: null, cracked: false, Mcr: 0, alpha_e };
  }

  // ── Un-cracked transformed section → cracking moment §7.1 ──
  const Au = b * h + (alpha_e - 1) * (As + AsComp);
  const xu = (b * h * h / 2 + (alpha_e - 1) * (As * d + AsComp * dComp)) / Au;
  const Iu = b * h ** 3 / 12 + b * h * (h / 2 - xu) ** 2
    + (alpha_e - 1) * (As * (d - xu) ** 2 + AsComp * (xu - dComp) ** 2);
  const Mcr = fctm(fck) * Iu / (h - xu) / 1e6; // kN·m

  // ── Fully-cracked TRANSFORMED neutral axis (incl. compression steel) ──
  // (b/2)x² + [(αe−1)As' + αe·As]·x − [(αe−1)As'·d' + αe·As·d] = 0
  const qA = b / 2;
  const qB = (alpha_e - 1) * AsComp + alpha_e * As;
  const qC = -((alpha_e - 1) * AsComp * dComp + alpha_e * As * d);
  const x = (-qB + Math.sqrt(qB * qB - 4 * qA * qC)) / (2 * qA);

  // Cracked transformed 2nd moment of area about the NA → tension-steel stress
  const Icr = b * x ** 3 / 3 + (alpha_e - 1) * AsComp * (x - dComp) ** 2 + alpha_e * As * (d - x) ** 2;
  const sigma_s = Icr > 0 ? alpha_e * Mqp * 1e6 * (d - x) / Icr : 0; // MPa

  // Effective tension area §7.3.2(3) — concrete area net of the tension bars
  const hc_ef = Math.min(2.5 * (h - d), (h - x) / 3, h / 2);
  const Ac_eff = Math.max(b * hc_ef - As, 1);
  const rho_p_eff = As / Ac_eff;

  // Un-cracked: below the cracking moment there is no crack to check.
  if (Mqp <= Mcr) {
    return { wk: 0, sigma_s, sr_max: 0, x, rho_p_eff, k2: 0.5, srEq: null, cracked: false, Mcr, alpha_e };
  }

  // Maximum crack spacing §7.3.4(3): min of eq (7.11) and the (7.14) upper bound.
  const k1 = 0.8, k2 = 0.5, k3 = 3.4, k4 = 0.425;
  const sr711 = k3 * cover + k1 * k2 * k4 * barD / rho_p_eff;
  const sr714 = 1.3 * (h - x);
  const sr_max = Math.min(sr711, sr714);
  const srEq: '7.11' | '7.14' = sr711 <= sr714 ? '7.11' : '7.14';

  // Mean strain difference eq (7.9), floor 0.6·σs/Es
  const fct_eff = fctm(fck);
  const eps = Math.max(
    (sigma_s - kt * (fct_eff / rho_p_eff) * (1 + alpha_e * rho_p_eff)) / Es,
    0.6 * sigma_s / Es,
  );

  return { wk: sr_max * eps, sigma_s, sr_max, x, rho_p_eff, k2, srEq, cracked: true, Mcr, alpha_e };
}

// ── Full member check ────────────────────────────────────────────────────────

function rebarAs(bars: { numBars: number; barSize: number }[]): number {
  return bars.reduce((sum, g) => sum + g.numBars * getBarArea(g.barSize), 0); // in²
}

// ── Skin / side-face minimum reinforcement §7.3.2(2) + §7.3.3(3) ──────────────

/**
 * EN 1992-1-1 Table 7.2N — maximum bar diameters φ*s for crack control — inverted
 * to give the steel-stress limit σs (MPa) for a chosen skin bar diameter and crack
 * width wk. Linear interpolation on φ within the wk = 0.2 / 0.3 / 0.4 mm columns.
 *
 * S-CONCRETE keys the skin As,min on this crack-limited stress (≈ 273 MPa for
 * Ø12 / 0.3 mm — this table returns 280) rather than the literal §7.3.3(3) relaxation
 * σs = fyk, so we follow the same, stricter reading and land within ~3 % of it.
 */
export function sigmaSforSkin(barDia_mm: number, wk: number): number {
  // Rows: [σs, φ*s@0.4, φ*s@0.3, φ*s@0.2] (mm). φ*s decreases as σs increases.
  const T: [number, number, number, number][] = [
    [160, 40, 32, 25],
    [200, 32, 25, 16],
    [240, 20, 16, 12],
    [280, 16, 12, 8],
    [320, 12, 10, 6],
    [360, 10, 8, 5],
    [400, 8, 6, 4],
    [450, 6, 5, 3],
  ];
  const col = wk >= 0.35 ? 1 : wk >= 0.25 ? 2 : 3; // nearest wk column
  const pts = T.map(r => [r[col], r[0]] as [number, number]); // (φ*s, σs), φ descending
  if (barDia_mm >= pts[0][0]) return pts[0][1];                       // ≥ largest φ → 160
  if (barDia_mm <= pts[pts.length - 1][0]) return pts[pts.length - 1][1]; // ≤ smallest φ → 450
  for (let i = 0; i < pts.length - 1; i++) {
    const [phiHi, sLo] = pts[i];
    const [phiLo, sHi] = pts[i + 1];
    if (barDia_mm <= phiHi && barDia_mm >= phiLo) {
      const t = (phiHi - barDia_mm) / (phiHi - phiLo);
      return sLo + t * (sHi - sLo);
    }
  }
  return pts[pts.length - 1][1];
}

/**
 * Minimum side/skin reinforcement AREA for a deep beam, EN 1992-1-1 §7.3.3(3) +
 * §7.3.2(2): As,min·σs = kc·k·fct,eff·Act.
 *   • Act = concrete tensile-zone area at first cracking (extreme fibre = fctm),
 *     allowing for the axial force NEd — Act = b·yt, yt = fct/(2(fct−σN))·h.
 *   • kc  = Eq (7.2) stress-distribution coefficient (0.4 in pure bending, raised
 *     by axial tension through the k1 factor).
 *   • k   = 0.5 for skin (§7.3.3(3)).
 *   • σs  = crack-control stress for the bar (Table 7.2N, `sigmaSforSkin`).
 * All SI (mm, MPa, N); NEd_N is compression-positive. Returns the total (both
 * faces) As,min in mm² plus intermediates, or null for h < 1000 mm (no skin rule).
 *
 * Benchmarked to S-CONCRETE 2026 (500×1500, fck 40, N = 206.9 kN tension):
 * kc ≈ 0.45, Act ≈ 407 000 mm², As,min ≈ 1140 mm² (report 1177).
 */
export function skinMinArea(
  b_mm: number, h_mm: number, NEd_N: number, fck: number,
  skinBarDia_mm: number, wLimitFace: number,
): { AsMin: number; kc: number; k: number; Act: number; sigmaS: number; yt: number } | null {
  if (h_mm < 1000) return null;
  const fct = fctm(fck);
  const sigmaTens = -NEd_N / (b_mm * h_mm);            // mean axial stress, tension +
  const yt = sigmaTens >= fct
    ? h_mm                                             // whole section in tension
    : Math.max(0, Math.min(h_mm, (fct / (2 * (fct - sigmaTens))) * h_mm));
  const Act = b_mm * yt;
  const hstar = Math.min(h_mm, 1000);
  const sigmaC = NEd_N / (b_mm * h_mm);                // compression +
  const k1 = sigmaC >= 0 ? 1.5 : (2 * hstar) / (3 * h_mm);
  const kc = Math.max(0, Math.min(1, 0.4 * (1 - sigmaC / (k1 * (h_mm / hstar) * fct))));
  const k = 0.5;
  const sigmaS = sigmaSforSkin(skinBarDia_mm, wLimitFace > 0 ? wLimitFace : 0.3);
  return { AsMin: (kc * k * fct * Act) / sigmaS, kc, k, Act, sigmaS, yt };
}

export function designMemberEC2(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  _span = 20,
  crack: CrackControlParams = DEFAULT_CRACK_PARAMS,
): DesignResults {
  const warnings: DesignWarning[] = [];

  // ── Convert to SI ──
  const b_mm  = (section.bw ?? section.b) * IN_TO_MM;     // web width
  const bf_mm = section.b * IN_TO_MM;                      // flange/full width
  const h_mm  = (section.h ?? 12) * IN_TO_MM;
  const hf_mm = (section.hf ?? section.h ?? 12) * IN_TO_MM;
  const cover_mm = section.coverClear * IN_TO_MM;
  const stirrupD_mm = getBarDiam(section.stirrupDia) * IN_TO_MM;

  const fck  = material.fc * PSI_TO_MPA;
  const fyk  = material.fy * PSI_TO_MPA;
  const fywk = material.fyt * PSI_TO_MPA;
  const fcd  = ALPHA_CC * fck / GAMMA_C;
  const fyd  = fyk / GAMMA_S;
  const fywd = fywk / GAMMA_S;

  const As_bot_mm2 = rebarAs(rebar.botBars) * IN2_TO_MM2;
  const As_top_mm2 = rebarAs(rebar.topBars) * IN2_TO_MM2;
  const botBarD_mm = getBarDiam(rebar.botBars[0]?.barSize ?? 8) * IN_TO_MM;
  const topBarD_mm = getBarDiam(rebar.topBars[0]?.barSize ?? 8) * IN_TO_MM;

  // Multi-layer centroid: when there is only one BarGroup the centroid equals
  // the single-layer formula; for multiple layers it is the area-weighted mean.
  const layerClear_mm = (rebar.layerClearSpacing ?? 1.0) * IN_TO_MM;
  const d_bot = h_mm - layerCentroidMm(rebar.botBars, cover_mm, stirrupD_mm, layerClear_mm);
  const d_top = h_mm - layerCentroidMm(rebar.topBars, cover_mm, stirrupD_mm, layerClear_mm);

  const MEd_pos = load.Mu_pos * KIPFT_TO_KNM;
  const MEd_neg = load.Mu_neg * KIPFT_TO_KNM;
  const VEd     = load.Vu * KIP_TO_KN;
  const TEd     = load.Tu * KIPFT_TO_KNM;
  const NEd_N   = load.Pu * KIP_TO_KN * 1000; // N (compression +)

  // ── Flexure ──
  const isT = section.type === 'T_beam' || section.type === 'L_beam';
  const pos = mRd(As_bot_mm2, d_bot, isT ? bf_mm : b_mm, fck, fcd, fyd,
    isT ? b_mm : undefined, isT ? hf_mm : undefined);
  const neg = mRd(As_top_mm2, d_top, b_mm, fck, fcd, fyd);

  const MRd_pos = pos.MRd;
  const MRd_neg = neg.MRd;

  // Ductility: x/d ≤ 0.45 recommended for redistribution-free design
  if (pos.x > 0 && pos.x / d_bot > 0.45)
    warnings.push({ code: 'EC2 §5.5', message: `x/d = ${(pos.x / d_bot).toFixed(2)} > 0.45 — section is approaching over-reinforced behaviour`, severity: 'warning' });

  // ── Shear ──
  const Ac = b_mm * h_mm;
  const VRdc = vRdc(b_mm, d_bot, As_bot_mm2, fck, NEd_N, Ac);
  const z = 0.9 * d_bot;
  const cotTheta = 2.5;

  // Governing tie spacing for ALL spacing-derived capacity & detailing checks.
  // When zoned stirrups exist the worst (most widely spaced) zone governs —
  // ties.spacing stores the tightest end-zone value, which would overstate
  // capacity and understate ρw / s_max. Used by shear, torsion and detailing
  // so the single-value (headline) result reflects the critical zone. The
  // per-zone breakdown (zonedShearCheckEC2) reports each third individually.
  const worstSpacing = rebar.tieZones
    ? Math.max(...rebar.tieZones.map(z => z.spacing))
    : (rebar.ties?.spacing ?? 0);
  const worstSpacing_mm = worstSpacing * IN_TO_MM;

  let VRds = 0, VRdmax = 0, Asw_s = 0;
  if (rebar.ties) {
    const Asw_mm2 = rebar.ties.legs * getBarArea(rebar.ties.barSize) * IN2_TO_MM2;
    Asw_s = Asw_mm2 / worstSpacing_mm;
    VRds = vRds(Asw_mm2, worstSpacing_mm, z, fywd, cotTheta);
    VRdmax = vRdMax(b_mm, z, fck, fcd, cotTheta);
  }

  // EC2: with stirrups V_Rd = min(V_Rd,s, V_Rd,max); without, V_Rd,c
  const VRd = rebar.ties ? Math.min(VRds, VRdmax) : VRdc;

  // Only flag strut crushing when it is a genuine failure — i.e. the demand
  // exceeds the crushing limit (V_Ed > V_Rd,max ⇔ DCR_shear > 1). When stirrups
  // are merely over-provided (V_Rd,s > V_Rd,max but V_Rd = V_Rd,max ≥ V_Ed) the
  // design is still adequate, so no warning is raised.
  if (rebar.ties && VEd > VRdmax)
    warnings.push({ code: 'EC2 §6.2.3', message: `Strut crushing: V_Ed = ${VEd.toFixed(1)} kN > V_Rd,max = ${VRdmax.toFixed(1)} kN — adding more links won't help; increase section width or f_ck`, severity: 'error' });

  // ── Torsion ──
  let TRd = 0, TRdc_val = 0, TRdMax_val = 0;
  // Longitudinal torsion steel demand §6.3.2(3) eq (6.28): ΣAsl = TEd·cotθ·uk/(2·Ak·fyd)
  let Asl_tor_mm2 = 0;
  // Combined transverse (shear + torsion) reinforcement demand, per outer leg.
  let Asw_s_req_VT = 0;       // mm²/mm per leg required for V+T together
  let Asw_s_prov_leg = 0;     // mm²/mm provided per leg
  // Distance from concrete surface to centroid of the longitudinal bar
  // (clear cover + link Ø + ½ main bar Ø) — sets the §6.3.2(1) tef floor.
  const coverToCentre = cover_mm + stirrupD_mm + botBarD_mm / 2;
  if (rebar.ties) {
    const AtLeg_mm2 = getBarArea(rebar.ties.barSize) * IN2_TO_MM2; // one leg
    // Worst-zone spacing governs (see worstSpacing definition above).
    const s_mm = worstSpacing_mm;
    const t = tRd(b_mm, h_mm, AtLeg_mm2, s_mm, fywd, fck, fcd, cotTheta, coverToCentre);
    TRd = Math.min(t.TRds, t.TRdMax);
    TRdc_val = t.TRdc;
    TRdMax_val = t.TRdMax;
    if (TEd > t.TRdc && t.TRds > t.TRdMax)
      warnings.push({ code: 'EC2 §6.3.2', message: `Torsion strut crushing governs: T_Rd,max = ${t.TRdMax.toFixed(1)} kN·m < T_Rd,s = ${t.TRds.toFixed(1)} kN·m — increasing links won't help; increase section or f_ck`, severity: 'warning' });

    // §6.3.2(3): additional longitudinal steel for torsion (only above cracking).
    if (TEd > t.TRdc && t.Ak > 0) {
      Asl_tor_mm2 = TEd * 1e6 * cotTheta * t.uk / (2 * t.Ak * fyd);
    }

    // Combined V+T transverse reinforcement §6.3.1(2)/§6.3.2: torsion links
    // act on the outer perimeter (per leg) and ADD to the shear link demand
    // (shear shared across all legs). Compare to the area provided per leg.
    const nLegs = rebar.ties.legs || 2;
    const asReqShearPerLeg = VEd > VRdc ? (VEd * 1000) / (nLegs * z * fywd * cotTheta) : 0;
    const asReqTorsionPerLeg = TEd > t.TRdc ? (TEd * 1e6) / (2 * t.Ak * fywd * cotTheta) : 0;
    Asw_s_req_VT = asReqShearPerLeg + asReqTorsionPerLeg;
    Asw_s_prov_leg = AtLeg_mm2 / s_mm;
    if (Asw_s_req_VT > Asw_s_prov_leg && (VEd > VRdc || TEd > t.TRdc))
      warnings.push({ code: 'EC2 §6.3.2', message: `Combined shear+torsion links NG: required Asw/s = ${Asw_s_req_VT.toFixed(3)} mm²/mm/leg > provided ${Asw_s_prov_leg.toFixed(3)} mm²/mm/leg — shear and torsion link demands add`, severity: 'error' });
  } else {
    const t = tRd(b_mm, h_mm, 0, 1, fywd, fck, fcd, cotTheta, coverToCentre);
    TRdc_val = t.TRdc;
    if (TEd > t.TRdc)
      warnings.push({ code: 'EC2 §6.3.1', message: `T_Ed = ${TEd.toFixed(1)} kN·m > T_Rd,c = ${t.TRdc.toFixed(1)} kN·m — torsion reinforcement (closed links + longitudinal bars) required`, severity: 'error' });
  }

  // Combined shear+torsion interaction §6.3.2(4) Eq 6.29
  if (TEd > TRdc_val && TRdMax_val > 0 && VRdmax > 0) {
    const combined = TEd / TRdMax_val + VEd / VRdmax;
    if (combined > 1.0) {
      warnings.push({ code: 'EC2 §6.3.2(4)', message: `Combined V+T interaction: T_Ed/T_Rd,max + V_Ed/V_Rd,max = ${combined.toFixed(2)} > 1.0 — strut crushing governs`, severity: 'error' });
    }
  }

  // ── Longitudinal steel for torsion §6.3.2(3) only ──
  // Shear tension shift §6.2.3(7) is intentionally excluded (not checked in this engine).
  const z_long = 0.9 * d_bot;
  const AslTorChord = Asl_tor_mm2 / 4;
  const AsLongReqBot = (MEd_pos > 0 ? (MEd_pos * 1e6 / z_long) / fyd : 0) + AslTorChord;
  const AsLongReqTop = (MEd_neg > 0 ? (MEd_neg * 1e6 / (0.9 * d_top)) / fyd : 0) + AslTorChord;

  // ── Detailing checks ──
  // As_min §9.2.1.1: max(0.26·fctm/fyk, 0.0013)·bt·d
  const AsMin_mm2 = Math.max(0.26 * fctm(fck) / fyk, 0.0013) * b_mm * d_bot;
  const AsMax_mm2 = 0.04 * Ac; // §9.2.1.1(3)

  if (As_bot_mm2 < AsMin_mm2 && load.Mu_pos > 0)
    warnings.push({ code: 'EC2 §9.2.1.1', message: `Bottom steel ${As_bot_mm2.toFixed(0)} mm² < As,min = ${AsMin_mm2.toFixed(0)} mm²`, severity: 'error' });
  if (As_top_mm2 < AsMin_mm2 && load.Mu_neg > 0)
    warnings.push({ code: 'EC2 §9.2.1.1', message: `Top steel ${As_top_mm2.toFixed(0)} mm² < As,min = ${AsMin_mm2.toFixed(0)} mm²`, severity: 'error' });
  if (As_bot_mm2 > AsMax_mm2 || As_top_mm2 > AsMax_mm2)
    warnings.push({ code: 'EC2 §9.2.1.1', message: `Steel exceeds As,max = 0.04·Ac = ${AsMax_mm2.toFixed(0)} mm²`, severity: 'error' });

  // ── Minimum clear bar spacing §8.2 ──
  // Clear horizontal distance between parallel bars ≥ max(k1·db, dg + k2, 20 mm).
  // Recommended values: k1 = 1, k2 = 5 mm. dg = max aggregate size (default 20 mm
  // — typical when unspecified).
  const DG_MM = 20;              // assumed max aggregate size when not given
  const k1 = 1, k2 = 5;

  // §8.2 horizontal clear check for one bar group in a horizontal layer.
  const checkClearSpacing = (
    grp: { numBars: number; barSize: number } | undefined,
    face: string,
    active: boolean,
  ) => {
    if (!grp || grp.numBars < 2 || !active) return;
    const db = getBarDiam(grp.barSize) * IN_TO_MM;
    const sMin = Math.max(k1 * db, DG_MM + k2, 20);
    // Clear gap = (width − 2·cover − 2·stirrupØ − Σbar Ø) / (n − 1)
    const clear = (b_mm - 2 * cover_mm - 2 * stirrupD_mm - grp.numBars * db) / (grp.numBars - 1);
    if (clear < sMin)
      warnings.push({
        code: 'EC2 §8.2',
        message: `${face} bars: clear spacing ${clear.toFixed(0)} mm < s_min = ${sMin.toFixed(0)} mm (max of db=${db.toFixed(0)}, dg+5=${DG_MM + k2}, 20 mm) — reduce bar count, use a larger size, or add a layer`,
        severity: 'error',
      });
  };

  // Check every layer on each face (§8.2 applies to all layers, not just the outermost).
  for (const grp of rebar.botBars) checkClearSpacing(grp, 'Bottom', load.Mu_pos > 0 || As_bot_mm2 > 0);
  for (const grp of rebar.topBars) checkClearSpacing(grp, 'Top',    load.Mu_neg > 0 || As_top_mm2 > 0);

  // §8.2 side/face bars — each group uses the full web width available.
  if (rebar.sideBars) {
    for (const grp of rebar.sideBars) checkClearSpacing(grp, 'Side face', true);
  }

  // §9.2.2(8) max transverse spacing between stirrup legs ≤ min(0.75d, 600 mm).
  if (rebar.ties && rebar.ties.legs >= 2) {
    const s_trans_max = Math.min(0.75 * d_bot, 600); // mm
    // Transverse leg spacing = (bw − 2·cover − 2·stirrupØ) / (nLegs − 1)
    const s_trans = (b_mm - 2 * cover_mm - 2 * stirrupD_mm) / (rebar.ties.legs - 1);
    if (s_trans > s_trans_max + 0.5)
      warnings.push({
        code: 'EC2 §9.2.2(8)',
        message: `Stirrup leg spacing ${s_trans.toFixed(0)} mm > max ${s_trans_max.toFixed(0)} mm (min(0.75d, 600 mm)) — add intermediate stirrup legs`,
        severity: 'warning',
      });
  }

  // §6.3.2(3): longitudinal torsion steel is distributed around the perimeter.
  // The two horizontal faces (top/bot chords) carry ~half between them; report
  // the total demand and the per-chord share that adds to flexural steel.
  if (Asl_tor_mm2 > 0)
    warnings.push({ code: 'EC2 §6.3.2(3)', message: `Torsion needs ΣAsl = ${Asl_tor_mm2.toFixed(0)} mm² longitudinal steel distributed around the perimeter, in addition to flexural reinforcement`, severity: 'warning' });

  // ρw,min §9.2.2(5) and s_max §9.2.2(6)
  if (rebar.ties) {
    const rho_w = Asw_s / b_mm;
    const rho_w_min = 0.08 * Math.sqrt(fck) / fywk;
    if (rho_w < rho_w_min)
      warnings.push({ code: 'EC2 §9.2.2(5)', message: `ρw = ${(rho_w * 1000).toFixed(2)}‰ < ρw,min = ${(rho_w_min * 1000).toFixed(2)}‰`, severity: 'warning' });

    const s_max = 0.75 * d_bot;
    // Worst-zone spacing governs the s_max detailing limit (see above).
    const s_mm = worstSpacing_mm;
    if (s_mm > s_max)
      warnings.push({ code: 'EC2 §9.2.2(6)', message: `Stirrup spacing ${s_mm.toFixed(0)} mm > s_max = 0.75d = ${s_max.toFixed(0)} mm`, severity: 'warning' });
  } else if (VEd > VRdc) {
    warnings.push({ code: 'EC2 §6.2.1', message: `V_Ed = ${VEd.toFixed(1)} kN > V_Rd,c = ${VRdc.toFixed(1)} kN — shear reinforcement required`, severity: 'error' });
  }

  // ── Crack width §7.3.4 (quasi-permanent combination) ──
  const Es_MPa = material.Es * PSI_TO_MPA;
  const Mqp_pos = crack.Mqp_pos !== undefined ? crack.Mqp_pos * KIPFT_TO_KNM : crack.qpFactor * MEd_pos;
  const Mqp_neg = crack.Mqp_neg !== undefined ? crack.Mqp_neg * KIPFT_TO_KNM : crack.qpFactor * MEd_neg;

  // Effective creep coefficient for the crack modular ratio (Annex B, long-term).
  // Notional size h0 = 2·Ac/u with the full perimeter taken as the drying face.
  const h0_mm = 2 * (b_mm * h_mm) / (2 * (b_mm + h_mm));
  const phiCreep = crack.creepPhi
    ?? creepCoefficient(fck, crack.creepRH ?? 50, crack.creepT0 ?? 28, 25550, h0_mm, crack.cementClass ?? 'N');
  // Compression-steel depth from the compression face for each bending sense.
  const dComp_pos = cover_mm + stirrupD_mm + topBarD_mm / 2; // +M: top steel in compression
  const dComp_neg = cover_mm + stirrupD_mm + botBarD_mm / 2; // −M: bottom steel in compression

  // Bottom face (positive bending → bottom steel in tension)
  const cw_bot = crackWidth(Mqp_pos, As_bot_mm2, botBarD_mm, b_mm, h_mm, d_bot,
    cover_mm + stirrupD_mm, fck, Es_MPa, crack.kt, { AsComp: As_top_mm2, dComp: dComp_pos, phi: phiCreep });
  // Top face (negative bending → top steel in tension)
  const cw_top = crackWidth(Mqp_neg, As_top_mm2, topBarD_mm, b_mm, h_mm, d_top,
    cover_mm + stirrupD_mm, fck, Es_MPa, crack.kt, { AsComp: As_bot_mm2, dComp: dComp_neg, phi: phiCreep });

  if (cw_bot.wk > crack.wLimitBot)
    warnings.push({ code: 'EC2 §7.3.4', message: `Bottom face crack width wk = ${cw_bot.wk.toFixed(2)} mm > limit ${crack.wLimitBot.toFixed(2)} mm (σs = ${cw_bot.sigma_s.toFixed(0)} MPa under M_qp = ${Mqp_pos.toFixed(1)} kN·m)`, severity: 'error' });
  if (cw_top.wk > crack.wLimitTop)
    warnings.push({ code: 'EC2 §7.3.4', message: `Top face crack width wk = ${cw_top.wk.toFixed(2)} mm > limit ${crack.wLimitTop.toFixed(2)} mm (σs = ${cw_top.sigma_s.toFixed(0)} MPa under M_qp = ${Mqp_neg.toFixed(1)} kN·m)`, severity: 'error' });

  // Side-face crack width §7.3.4.
  // Corrected per S-CONCRETE 2026 benchmark:
  //   k2 = 1.0 (skin bars at mid-height → both strip edges in tension → pure tension)
  //   ρ_eff = As_one_bar / (s_v × hc,eff)  where s_v = vertical bar spacing
  //   fs_skin interpolated from governing chord elastic strain profile
  let wk_face: number | undefined;
  const governingMqp = Math.max(Mqp_pos, Mqp_neg);
  if (rebar.sideBars && rebar.sideBars.length > 0 && governingMqp > 0 && (cw_bot.cracked || cw_top.cracked)) {
    const firstSideGroup = rebar.sideBars[0];
    const sideBarD = getBarDiam(firstSideGroup.barSize) * IN_TO_MM;
    const As_per_bar = getBarArea(firstSideGroup.barSize) * IN2_TO_MM2;
    const totalSideBars = rebar.sideBars.reduce((s, g) => s + g.numBars, 0);
    if (As_per_bar > 0 && totalSideBars > 0) {
      // Governing chord (whichever bending moment governs)
      const useHogging = Mqp_neg >= Mqp_pos;
      const cwGov = useHogging ? cw_top : cw_bot;
      const x_mm = cwGov.x;       // elastic cracked NA depth from compression face (mm)
      const sigma_chord = cwGov.sigma_s;  // tension chord steel stress (MPa)
      const d_chord = useHogging ? d_top : d_bot;

      // Effective tension strip height on each side face per EC2 §7.3.2:
      //   h_c,ef = min(2.5(c + φ_link + φ_skin/2),  h/2)
      const hc_side = Math.min(2.5 * (cover_mm + stirrupD_mm + sideBarD / 2), h_mm / 2);

      // Vertical spacing s_v: use user-supplied value if present, otherwise
      // distribute bars uniformly over the available web height (conservatively
      // reduced by main bar zone on each side).
      let s_v_mm: number;
      if (firstSideGroup.spacing != null && firstSideGroup.spacing > 0) {
        s_v_mm = firstSideGroup.spacing * IN_TO_MM;
      } else {
        // Available web height between main bar zones at top and bottom
        const avail = h_mm - 2 * (cover_mm + stirrupD_mm + botBarD_mm);
        s_v_mm = totalSideBars > 1 ? avail / (totalSideBars - 1) : avail;
      }

      // Critical skin bar position: the bar just outside the main tension chord
      // effective strip (hc,eff_chord) is the most highly stressed skin bar.
      // hc,eff at the governing chord face = min(2.5×(h-d_chord),(h-x)/3,h/2).
      const hc_ef_chord = Math.min(
        2.5 * (h_mm - d_chord),
        (h_mm - x_mm) / 3,
        h_mm / 2,
      );
      // Position of the critical skin bar from the COMPRESSION face (same
      // reference as x_mm). The first skin bar lies s_v/2 outside the inner
      // edge of the chord's effective tension strip.
      const y_crit = h_mm - hc_ef_chord - s_v_mm / 2;   // from compression face
      const lever = d_chord - x_mm;                       // NA → tension chord
      const y_skin_from_NA = Math.max(0, y_crit - x_mm); // NA → critical bar
      // Interpolated steel stress at critical skin bar height (linear strain diagram)
      const fs_skin = lever > 0 ? Math.max(0, sigma_chord * y_skin_from_NA / lever) : 0;

      // ρ_eff per EC2 §7.3.2: area of one bar over its tributary area (s_v × hc,eff)
      const rho_side = As_per_bar / (s_v_mm * hc_side);

      // Sr,max §7.3.4(3) — k2 = 1.0 for side face (pure tension at mid-height)
      const k1 = 0.8, k2 = 1.0, k3 = 3.4, k4 = 0.425;
      const sr_side = k3 * (cover_mm + stirrupD_mm) + k1 * k2 * k4 * sideBarD / Math.max(rho_side, 1e-4);

      // (εsm − εcm) at skin bar using EC2 eq (7.9)
      const fct_eff = fctm(fck);
      const alpha_e_side = Es_MPa / (ecm(fck) / (1 + phiCreep));
      const eps_skin = Math.max(
        (fs_skin - crack.kt * fct_eff / Math.max(rho_side, 1e-6) * (1 + alpha_e_side * rho_side)) / Es_MPa,
        0.6 * fs_skin / Es_MPa,
      );

      wk_face = sr_side * eps_skin;
      if (wk_face > crack.wLimitFace)
        warnings.push({ code: 'EC2 §7.3.4', message: `Side face crack width wk ≈ ${wk_face.toFixed(2)} mm > limit ${crack.wLimitFace.toFixed(2)} mm — add/enlarge skin reinforcement`, severity: 'warning' });
    }
  }

  // EC2 §7.3.3(3)+§7.3.2(2) — minimum skin AREA for a deep beam (h ≥ 1000 mm).
  // This is the criterion that GOVERNS a deep, lightly-loaded section, where the
  // crack WIDTH above is trivially satisfied (the concrete barely cracks) yet a
  // minimum crack-control area is still required — the case S-CONCRETE flags as
  // "Min Crack Control Reinforcement – Skin Region". Independent of M_qp; driven by
  // the section, fct, the axial force and the chosen skin bar size.
  let As_skin_min: number | undefined;
  let As_skin_prov: number | undefined;
  if (h_mm >= 1000) {
    const skinDia_mm = getBarDiam(rebar.sideBars?.[0]?.barSize ?? -12) * IN_TO_MM;
    const skin = skinMinArea(b_mm, h_mm, NEd_N, fck, skinDia_mm, crack.wLimitFace);
    if (skin) {
      As_skin_min = skin.AsMin;
      // sideBars.numBars is PER FACE (beam convention) → ×2 faces for the total.
      As_skin_prov = 2 * (rebar.sideBars ?? []).reduce((s, g) => s + g.numBars * getBarArea(g.barSize) * IN2_TO_MM2, 0);
      if (As_skin_prov < skin.AsMin - 1) // 1 mm² tolerance
        warnings.push({ code: 'EC2 §7.3.3', message: `Skin steel A_s = ${As_skin_prov.toFixed(0)} mm² < A_s,min = ${skin.AsMin.toFixed(0)} mm² (§7.3.2: k_c = ${skin.kc.toFixed(2)}, k = 0.5, A_ct = ${(skin.Act / 1e3).toFixed(0)}×10³ mm², σ_s = ${skin.sigmaS.toFixed(0)} MPa) — add side-face bars`, severity: 'warning' });
    }
  }

  // ── DCRs ──
  const DCR_flex_pos = MRd_pos > 0 ? MEd_pos / MRd_pos : (MEd_pos > 0 ? Infinity : 0);
  const DCR_flex_neg = MRd_neg > 0 ? MEd_neg / MRd_neg : (MEd_neg > 0 ? Infinity : 0);
  const DCR_shear    = VRd > 0 ? VEd / VRd : (VEd > 0 ? Infinity : 0);
  // Below cracking threshold show Tu/TRdc (utilization of concrete resistance);
  // above it show Tu/TRd (utilization of full stirrup resistance).
  const DCR_torsion  = TEd <= TRdc_val
    ? (TRdc_val > 0 ? TEd / TRdc_val : 0)
    : (TRd > 0 ? TEd / TRd : Infinity);

  if (DCR_flex_pos > 1)
    warnings.push({ code: 'EC2 §6.1', message: `Positive flexure NG: M_Ed = ${MEd_pos.toFixed(1)} kN·m > M_Rd = ${MRd_pos.toFixed(1)} kN·m`, severity: 'error' });
  if (DCR_flex_neg > 1)
    warnings.push({ code: 'EC2 §6.1', message: `Negative flexure NG: M_Ed = ${MEd_neg.toFixed(1)} kN·m > M_Rd = ${MRd_neg.toFixed(1)} kN·m`, severity: 'error' });
  if (DCR_shear > 1)
    warnings.push({ code: 'EC2 §6.2', message: `Shear NG: V_Ed = ${VEd.toFixed(1)} kN > V_Rd = ${VRd.toFixed(1)} kN`, severity: 'error' });
  if (DCR_torsion > 1)
    warnings.push({ code: 'EC2 §6.3', message: `Torsion NG: T_Ed = ${TEd.toFixed(1)} kN·m > T_Rd = ${TRd.toFixed(1)} kN·m`, severity: 'error' });

  // Crack-width DCR = wk / w_limit, governing face (SLS §7.3.4).
  const DCR_crack = Math.max(
    crack.wLimitBot > 0 ? cw_bot.wk / crack.wLimitBot : 0,
    crack.wLimitTop > 0 ? cw_top.wk / crack.wLimitTop : 0,
    wk_face !== undefined && crack.wLimitFace > 0 ? wk_face / crack.wLimitFace : 0,
  );

  const maxDCR = Math.max(DCR_flex_pos, DCR_flex_neg, DCR_shear, DCR_torsion, DCR_crack);
  // Status reflects ACTUAL issues, not raw utilization: NG when any capacity
  // (incl. crack width) is exceeded; Warning only when a real code message
  // exists; otherwise OK — even at high (but passing) utilization.
  const hasMessage = warnings.length > 0;
  const status: DesignResults['status'] = maxDCR > 1 ? 'NG' : hasMessage ? 'Warning' : 'OK';

  // ── Convert back to imperial for the shared DesignResults shape ──
  // NOTE: phi_* fields hold γ-factored design resistances; Mn === phi_Mn.
  const toKipFt = (knm: number) => knm / KIPFT_TO_KNM;
  const toKip   = (kn: number) => kn / KIP_TO_KN;
  const toIn2   = (mm2: number) => mm2 / IN2_TO_MM2;

  return {
    loadCaseId: load.id,
    Mn_pos: toKipFt(MRd_pos), Mn_neg: toKipFt(MRd_neg),
    phi_Mn_pos: toKipFt(MRd_pos), phi_Mn_neg: toKipFt(MRd_neg),
    DCR_flex_pos, DCR_flex_neg,
    Vc: toKip(VRdc), Vs: toKip(VRds), phi_Vn: toKip(VRd), DCR_shear,
    Tcr: toKipFt(TRdc_val), Tu_threshold: toKipFt(TRdc_val), phi_Tn: toKipFt(TRd), DCR_torsion,
    // Flexure + torsion longitudinal share (§6.3.2(3)), floored at As,min.
    // The §6.2.3(7) shear tension shift is intentionally NOT included here
    // (see AsLongReqBot/Top above) — only flexure and torsion contribute.
    As_req_pos: toIn2(Math.max(AsLongReqBot, AsMin_mm2)),
    As_req_neg: toIn2(Math.max(AsLongReqTop, MEd_neg > 0 ? AsMin_mm2 : 0)),
    As_min: toIn2(AsMin_mm2), As_max: toIn2(AsMax_mm2),
    // EC2 variable strut-inclination: when shear reinf is required the full
    // V_Ed is carried by the truss (no concrete contribution added, unlike ACI).
    // Asw/s = V_Ed/(z·f_ywd·cotθ). Only nonzero once V_Ed exceeds V_Rd,c.
    Av_req: VEd > VRdc ? (VEd * 1000) / (z * fywd * cotTheta) * IN_TO_MM / IN2_TO_MM2 : 0,
    Av_min_per_s: (0.08 * Math.sqrt(fck) / fywk) * b_mm / IN_TO_MM, // in²/in equivalent
    wk_bot: cw_bot.wk, wk_top: cw_top.wk, wk_face, DCR_crack,
    As_skin_min, As_skin_prov,
    warnings, status,
  };
}

/**
 * Per-zone shear check for EC2 beams with `rebar.tieZones`. Mirrors
 * `zonedShearCheck` in concreteDesign.ts but uses EC2 variable-strut
 * formulas (V_Rd = min(V_Rd,s, V_Rd,max)) instead of ACI §22.5.
 *
 * `zoneVu` = [end1, middle, end2] max shear (kips) per third.
 */
export function zonedShearCheckEC2(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  zoneVu: [number, number, number],
): ZoneShearResult[] {
  const zones = rebar.tieZones;
  if (!zones || !rebar.ties) return [];

  const b_mm = (section.bw ?? section.b) * IN_TO_MM;
  const h_mm = (section.h ?? 12) * IN_TO_MM;
  const cover_mm = section.coverClear * IN_TO_MM;
  const stirrupD_mm = getBarDiam(section.stirrupDia) * IN_TO_MM;
  const botBarD_mm = getBarDiam(rebar.botBars[0]?.barSize ?? 8) * IN_TO_MM;
  const d_bot = h_mm - cover_mm - stirrupD_mm - botBarD_mm / 2;
  const z = 0.9 * d_bot;
  const cotTheta = 2.5;

  const fck  = material.fc * PSI_TO_MPA;
  const fywk = material.fyt * PSI_TO_MPA;
  const fywd = fywk / GAMMA_S;
  const fcd  = ALPHA_CC * fck / GAMMA_C;

  const Asw_mm2 = rebar.ties.legs * getBarArea(rebar.ties.barSize) * IN2_TO_MM2;

  return zones.map((zone, i) => {
    const s_mm = zone.spacing * IN_TO_MM;
    const VRds_z = vRds(Asw_mm2, s_mm, z, fywd, cotTheta);
    const VRdmax_z = vRdMax(b_mm, z, fck, fcd, cotTheta);
    const phi_Vn_kip = Math.min(VRds_z, VRdmax_z) / KIP_TO_KN;
    const Vu = zoneVu[i];
    return {
      zone: i as 0 | 1 | 2,
      spacing: zone.spacing,
      Vu,
      phi_Vn: phi_Vn_kip,
      DCR: phi_Vn_kip > 0 ? Vu / phi_Vn_kip : 0,
    };
  });
}
