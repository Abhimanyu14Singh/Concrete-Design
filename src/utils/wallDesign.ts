/**
 * ACI 318-25 Shear Wall Design Engine
 *
 * Key sections:
 *   §11.6   Minimum distributed reinforcement ratios
 *   §18.10.2.2  Maximum bar spacing in wall web
 *   §18.10.4  In-plane shear strength
 *   §18.10.5  Flexure and axial (P-M interaction, strain compatibility)
 *   §18.10.6  Special Boundary Zone (SBZ) triggers and confinement
 */

import type { MaterialProps, SectionDimensions, WallRebarLayout, LoadCase, DesignResults, DesignWarning } from '../types';
import { getBarArea, getBarDiam } from './concreteDesign';

function warn(code: string, message: string, severity: DesignWarning['severity'] = 'warning'): DesignWarning {
  return { code, message, severity };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function beta1Wall(fc: number): number {
  if (fc <= 4000) return 0.85;
  return Math.max(0.65, 0.85 - 0.05 * (fc - 4000) / 1000);
}

/** Effective depth for wall flexure: distance from compression face to resultant tension steel */
function wallEffectiveDepth(lw: number, tw: number, cover: number, tieBarSize: number, vertBarSize: number): number {
  const tieR = getBarDiam(tieBarSize) / 2;
  const barR = getBarDiam(vertBarSize) / 2;
  return lw - cover - tieR - barR;
}

// ─── reinforcement ratios ─────────────────────────────────────────────────

export interface ReinfRatios {
  rhoL: number;   // vertical (longitudinal) ratio
  rhoT: number;   // horizontal (transverse) ratio
  AvL: number;    // vertical steel area per unit height (in²/in)
  AvT: number;    // horizontal steel area per unit width (in²/in)
}

/**
 * Compute distributed web reinforcement ratios.
 * ρl = As_vert / (tw × s_vert_total)  where s_vert_total = spacing per curtain
 * ρt = As_horiz / (tw × s_horiz_total)
 */
export function wallReinfRatios(
  tw: number,
  wallRebar: WallRebarLayout
): ReinfRatios {
  const n = wallRebar.numCurtains;
  const Av_vert_per_curtain = getBarArea(wallRebar.vertBarSize);
  const Av_horiz_per_curtain = getBarArea(wallRebar.horizBarSize);

  // ρl = (n × Av_bar) / (s_vert × tw)
  const rhoL = (n * Av_vert_per_curtain) / (wallRebar.vertSpacing * tw);
  // ρt = (n × Ah_bar) / (s_horiz × tw)
  const rhoT = (n * Av_horiz_per_curtain) / (wallRebar.horizSpacing * tw);

  const AvL = (n * Av_vert_per_curtain) / wallRebar.vertSpacing;   // in²/in of height
  const AvT = (n * Av_horiz_per_curtain) / wallRebar.horizSpacing; // in²/in of width

  return { rhoL, rhoT, AvL, AvT };
}

// ─── §11.6 minimum reinforcement ─────────────────────────────────────────

export interface MinReinfResult {
  rhoL_min: number;
  rhoT_min: number;
  rhoL_ok: boolean;
  rhoT_ok: boolean;
  warnings: DesignWarning[];
}

/**
 * ACI 318-25 §11.6
 * ρt ≥ 0.0025 (or 0.0020 for hw/lw ≤ 2, deformed bars §11.6.1)
 * ρl ≥ 0.0025 (or 0.0020 for hw/lw ≤ 2)
 * When hw/lw ≤ 2: ρl ≥ ρt  (§11.6.2)
 */
export function checkMinReinf(
  rhoL: number,
  rhoT: number,
  hw: number,
  lw: number
): MinReinfResult {
  const hwlw = hw / lw;
  // §11.6.1: use 0.0025 for standard seismic walls; ACI 318-25 Table 11.6.1
  // For structural walls in seismic: ρl_min = ρt_min = 0.0025
  // §11.6.2 when hw/lw ≤ 2: ρl need not exceed ρt, but ρl ≥ ρt required
  const rhoT_min = 0.0025;
  let rhoL_min = 0.0025;

  const warnings: DesignWarning[] = [];

  // hw/lw ≤ 2: ρl ≥ ρt  (§11.6.2 — vertical not less than horizontal)
  if (hwlw <= 2) {
    rhoL_min = Math.max(rhoL_min, rhoT);
    if (rhoL < rhoT) {
      warnings.push(warn('ACI318-25-11.6.2', `§11.6.2: hw/lw = ${hwlw.toFixed(2)} ≤ 2.0 — ρl must be ≥ ρt. ρl = ${(rhoL * 100).toFixed(4)}% < ρt = ${(rhoT * 100).toFixed(4)}%`));
    }
  }

  const rhoL_ok = rhoL >= rhoL_min;
  const rhoT_ok = rhoT >= rhoT_min;

  if (!rhoT_ok) warnings.push(warn('ACI318-25-11.6.1', `§11.6.1: ρt = ${(rhoT * 100).toFixed(4)}% < ρt_min = ${(rhoT_min * 100).toFixed(4)}% (0.25%)`, 'error'));
  if (!rhoL_ok) warnings.push(warn('ACI318-25-11.6.2', `§11.6.1/11.6.2: ρl = ${(rhoL * 100).toFixed(4)}% < ρl_min = ${(rhoL_min * 100).toFixed(4)}%`, 'error'));

  return { rhoL_min, rhoT_min, rhoL_ok, rhoT_ok, warnings };
}

// ─── §18.10.2.2 maximum bar spacing ──────────────────────────────────────

export interface SpacingCheckResult {
  s_max: number;
  sVert_ok: boolean;
  sHoriz_ok: boolean;
  warnings: DesignWarning[];
}

/**
 * ACI 318-25 §18.10.2.2
 * s ≤ min(lw/5, 3·tw, 18") for both directions
 */
export function checkWallSpacing(
  sVert: number,
  sHoriz: number,
  lw: number,
  tw: number
): SpacingCheckResult {
  const s_max = Math.min(lw / 5, 3 * tw, 18);
  const sVert_ok = sVert <= s_max + 0.001;
  const sHoriz_ok = sHoriz <= s_max + 0.001;
  const warnings: DesignWarning[] = [];

  if (!sVert_ok) {
    warnings.push(warn('ACI318-25-18.10.2.2', `§18.10.2.2: Vertical bar spacing ${sVert.toFixed(2)}" > s_max = ${s_max.toFixed(2)}" [min(lw/5=${(lw/5).toFixed(2)}", 3tw=${(3*tw).toFixed(2)}", 18")]`, 'error'));
  }
  if (!sHoriz_ok) {
    warnings.push(warn('ACI318-25-18.10.2.2', `§18.10.2.2: Horizontal bar spacing ${sHoriz.toFixed(2)}" > s_max = ${s_max.toFixed(2)}"`, 'error'));
  }

  return { s_max, sVert_ok, sHoriz_ok, warnings };
}

// ─── §18.10.4 in-plane shear ──────────────────────────────────────────────

export interface WallShearResult {
  Acv: number;
  alphaC: number;
  Vn: number;
  Vn_max: number;
  phi_Vn: number;
  DCR: number;
  governedByMax: boolean;
}

/**
 * ACI 318-25 §18.10.4
 * Vn = Acv × (αc × λ × √f'c + ρt × fyt)
 * Vn_max = 10 × Acv × √f'c  (ACI 318-25 §18.10.4.4 — limit for individual wall segments)
 * φ = 0.75
 *
 * αc: 3.0 for hw/lw ≤ 1.5, 2.0 for hw/lw ≥ 2.0, linear interpolation
 */
export function wallShear(
  lw: number,
  tw: number,
  hw: number,
  fc: number,
  lambda: number,
  rhoT: number,
  fyt: number,
  Vu: number
): WallShearResult {
  const hwlw = hw / lw;
  let alphaC: number;
  if (hwlw <= 1.5) {
    alphaC = 3.0;
  } else if (hwlw >= 2.0) {
    alphaC = 2.0;
  } else {
    alphaC = 3.0 - (hwlw - 1.5) / 0.5; // linear 3.0→2.0
  }

  const Acv = lw * tw; // in²
  const sqrtFc = Math.sqrt(fc);

  let Vn = Acv * (alphaC * lambda * sqrtFc + rhoT * fyt) / 1000; // kips
  const Vn_max = 10 * Acv * sqrtFc / 1000; // kips (§18.10.4.4)
  const governedByMax = Vn > Vn_max;
  Vn = Math.min(Vn, Vn_max);

  const phi = 0.75;
  const phi_Vn = phi * Vn;
  const DCR = phi_Vn > 0 ? Vu / phi_Vn : Infinity;

  return { Acv, alphaC, Vn, Vn_max, phi_Vn, DCR, governedByMax };
}

// ─── §18.10.5 P-M interaction ─────────────────────────────────────────────

export interface WallInteractionPoint {
  c: number;
  Pn: number;  // kips
  Mn: number;  // kip-ft
  phi: number;
  phiPn: number;
  phiMn: number;
}

/**
 * Strain-compatibility P-M interaction for slender wall section.
 * Wall treated as a wide rectangular section with:
 *   - Distributed vertical steel in web
 *   - Concentrated SBZ steel at boundaries (optional)
 * εcu = 0.003, rectangular stress block β1
 */
export function wallInteractionCurve(
  lw: number,
  tw: number,
  fc: number,
  fy: number,
  Es: number,
  wallRebar: WallRebarLayout,
  nPoints = 32
): WallInteractionPoint[] {
  const cover = 1.5; // default clear cover assumed
  const b1 = beta1Wall(fc);
  const ecu = 0.003;
  const n = wallRebar.numCurtains;

  // Distributed vertical bar spacing and area
  const Av_per_s = n * getBarArea(wallRebar.vertBarSize) / wallRebar.vertSpacing; // in²/in

  // SBZ bars at each end (concentrated)
  const hasSBZ = (wallRebar.sbzNumBars ?? 0) > 0 && (wallRebar.sbzBarSize ?? 0) > 0;
  const A_sbz = hasSBZ ? (wallRebar.sbzNumBars! * getBarArea(wallRebar.sbzBarSize!)) : 0;
  const tieD = getBarDiam(4); // assumed #4 tie
  const vertD = getBarDiam(wallRebar.vertBarSize);
  const d_sbz = cover + tieD + getBarDiam(wallRebar.sbzBarSize ?? wallRebar.vertBarSize) / 2;

  const points: WallInteractionPoint[] = [];

  // Pure compression cap: §22.4.2.1
  const Ag = lw * tw;
  const As_total_web = Av_per_s * lw;
  const As_total = As_total_web + 2 * A_sbz;
  const Pn0 = 0.85 * fc * (Ag - As_total) + fy * As_total; // lbs
  const Pn0_kips = 0.80 * Pn0 / 1000; // 0.80 factor for tied wall
  points.push({ c: 1e6, Pn: Pn0_kips, Mn: 0, phi: 0.65, phiPn: 0.65 * Pn0_kips, phiMn: 0 });

  // Sweep c from lw down to near zero
  const d_eff = lw - d_sbz; // distance from compression face to tension SBZ bars

  for (let i = 1; i <= nPoints; i++) {
    const c = d_eff * (nPoints - i + 1) / nPoints;
    if (c <= 0) continue;

    const a = Math.min(b1 * c, lw);

    // Concrete compression force
    const Cc = 0.85 * fc * a * tw / 1000; // kips

    // Net axial from distributed steel: integrate along wall length
    // For bar at position x from compression face: ε = εcu*(c-x)/c
    // Discretize into small strips
    let P_steel = 0;
    let M_steel = 0;
    const nStrips = Math.max(20, Math.round(lw / 2));
    for (let j = 0; j < nStrips; j++) {
      const x = (j + 0.5) * lw / nStrips;
      const As_strip = Av_per_s * (lw / nStrips);
      const eps = ecu * (c - x) / c;
      const fs = Math.min(Math.max(eps * Es, -fy), fy);
      // Subtract concrete compression contribution where in compression zone
      const fc_conc = x < a ? 0.85 * fc : 0;
      const P_strip = As_strip * (fs - fc_conc) / 1000;
      const M_strip = P_strip * (lw / 2 - x) / 12; // moment about centroid (kip-ft)
      P_steel += P_strip;
      M_steel += M_strip;
    }

    // SBZ bars: compression end (x = d_sbz from compression face)
    const eps_sbzC = ecu * (c - d_sbz) / c;
    const fs_sbzC = Math.min(Math.max(eps_sbzC * Es, -fy), fy);
    const fc_sbzC = d_sbz < a ? 0.85 * fc : 0;
    const P_sbzC = A_sbz * (fs_sbzC - fc_sbzC) / 1000;
    const M_sbzC = P_sbzC * (lw / 2 - d_sbz) / 12;

    // SBZ bars: tension end (x = lw - d_sbz from compression face)
    const x_sbzT = lw - d_sbz;
    const eps_sbzT = ecu * (c - x_sbzT) / c;
    const fs_sbzT = Math.min(Math.max(eps_sbzT * Es, -fy), fy);
    const P_sbzT = A_sbz * fs_sbzT / 1000; // no concrete compression here
    const M_sbzT = P_sbzT * (lw / 2 - x_sbzT) / 12;

    // Concrete moment about centroid
    const M_cc = Cc * (lw / 2 - a / 2) / 12; // kip-ft

    const Pn = Cc + P_steel + P_sbzC + P_sbzT;
    const Mn = Math.abs(M_cc + M_steel + M_sbzC + M_sbzT);

    // φ factor based on tension-side strain
    const et = ecu * (d_eff - c) / c;
    const phi = et >= 0.005 ? 0.90 : et <= 0.002 ? 0.65 : 0.65 + (et - 0.002) * (250 / 3);

    points.push({ c, Pn, Mn, phi, phiPn: phi * Pn, phiMn: phi * Mn });
  }

  // Pure tension
  const Pn_ten = -As_total * fy / 1000;
  points.push({ c: 0, Pn: Pn_ten, Mn: 0, phi: 0.90, phiPn: 0.90 * Pn_ten, phiMn: 0 });

  return points;
}

/** Find φPn, φMn capacity for a given (Pu, Mu) demand by projecting onto curve */
export function wallCapacityOnRay(
  curve: WallInteractionPoint[],
  Pu: number,  // kips
  Mu: number   // kip-ft
): { phiPn: number; phiMn: number; dcr: number; c: number } {
  if (Mu <= 0 && Pu <= 0) return { phiPn: curve[curve.length - 1].phiPn, phiMn: 0, dcr: Math.abs(Pu) / Math.abs(curve[curve.length - 1].phiPn + 1e-6), c: 0 };

  const angle = Math.atan2(Pu, Mu);

  // Find two bracketing points on curve closest to this ray angle
  let bestDist = Infinity;
  let bestPhiPn = 0;
  let bestPhiMn = 0;
  let bestC = 0;

  for (let i = 0; i < curve.length - 1; i++) {
    const p1 = curve[i];
    const p2 = curve[i + 1];
    // Parametric intersection of ray (Pu/Mu direction) with segment p1→p2
    const dx = p2.phiMn - p1.phiMn;
    const dy = p2.phiPn - p1.phiPn;
    // Ray: (Mn, Pn) = t*(Mu, Pu), t>0
    // Segment: (Mn,Pn) = p1 + s*(dx,dy), s ∈ [0,1]
    const denom = dx * Pu - dy * Mu;
    if (Math.abs(denom) < 1e-9) continue;
    const t = (p1.phiMn * Pu - p1.phiPn * Mu) / denom;
    if (t < -0.001 || t > 1.001) continue;
    const s = Mu > 0 ? (p1.phiMn + t * dx) / Mu : (p1.phiPn + t * dy) / Pu;
    if (s <= 0) continue;

    const intPn = p1.phiPn + t * dy;
    const intMn = p1.phiMn + t * dx;
    const dist = Math.abs(s - 1);
    if (dist < bestDist) {
      bestDist = dist;
      bestPhiPn = intPn;
      bestPhiMn = intMn;
      bestC = p1.c + t * (p2.c - p1.c);
    }
  }

  const demandLen = Math.sqrt(Pu ** 2 + Mu ** 2);
  const capLen = Math.sqrt(bestPhiPn ** 2 + bestPhiMn ** 2);
  const dcr = capLen > 0 ? demandLen / capLen : Infinity;

  return { phiPn: bestPhiPn, phiMn: bestPhiMn, dcr, c: bestC };
}

// ─── §18.10.6 SBZ triggers ───────────────────────────────────────────────

export interface SBZTriggerResult {
  required: boolean;
  strainTriggered: boolean;
  stressTriggered: boolean;
  triggerType: 'strain' | 'stress' | 'both' | 'none';
  c_demand: number;     // neutral axis depth from flexure (in)
  c_limit_strain: number; // ACI strain-based limit for c (in)
  sigma_max: number;    // computed extreme fiber stress (ksi)
  sigma_limit: number;  // 0.2*f'c limit (ksi)
  strainDetail: string;
  stressDetail: string;
}

/**
 * ACI 318-25 §18.10.6.2 — Strain-based SBZ trigger
 * SBZ required when: c/lw > lw / (600 × (1.5 × δu/hw))
 * Rearranged: c > lw² / (900 × δu/hw)
 *
 * ACI 318-25 §18.10.6.3 — Stress-based SBZ trigger
 * SBZ required when: σmax = Pu/Ag + Mu·(lw/2) / (0.7·Ig) > 0.2·f'c
 * (uses cracked-section effective Ig = 0.7×Ig,gross for ACI 318-25)
 */
export function sbzTrigger(
  lw: number,
  tw: number,
  hw: number,
  fc: number,
  c_demand: number,
  driftRatio: number,
  Pu: number,   // kips (compression positive)
  Mu: number    // kip-ft
): SBZTriggerResult {
  // §18.10.6.2 strain trigger
  // c_limit = lw / (600 × 1.5 × δu/hw) = lw² / (900 × δu/hw) × (1/lw) ... wait:
  // The ACI provision: SBZ required if c/lw > 1 / (600 × (δu/hw) × 1.5)
  // So c_limit = lw / (600 * 1.5 * driftRatio) = lw / (900 * driftRatio)
  const c_limit_strain = lw / (900 * driftRatio);
  const strainTriggered = c_demand > c_limit_strain;

  // §18.10.6.3 stress trigger
  const Ag = lw * tw; // in²
  const Ig = tw * lw ** 3 / 12; // gross moment of inertia (in⁴)
  const Ig_eff = 0.7 * Ig; // ACI 318-25 effective Ig for stress check
  const sigma_max = (Pu * 1000) / Ag + (Mu * 12000) * (lw / 2) / Ig_eff; // psi
  const sigma_limit = 0.2 * fc; // psi
  const stressTriggered = sigma_max > sigma_limit;

  const required = strainTriggered || stressTriggered;
  const triggerType = strainTriggered && stressTriggered ? 'both'
    : strainTriggered ? 'strain'
    : stressTriggered ? 'stress'
    : 'none';

  const strainDetail = `c_demand=${c_demand.toFixed(2)}" ${strainTriggered ? '>' : '≤'} c_limit=lw/(900·δu/hw)=${c_limit_strain.toFixed(2)}"`;
  const stressDetail = `σmax=${(sigma_max / 1000).toFixed(3)} ksi ${stressTriggered ? '>' : '≤'} 0.2f'c=${(sigma_limit / 1000).toFixed(3)} ksi`;

  return {
    required,
    strainTriggered,
    stressTriggered,
    triggerType,
    c_demand,
    c_limit_strain,
    sigma_max,
    sigma_limit,
    strainDetail,
    stressDetail,
  };
}

// ─── §18.10.6.4 SBZ geometry and confinement ─────────────────────────────

export interface SBZDesignResult {
  lbe: number;          // SBZ length (in), each boundary end
  bc: number;           // confined core dimension (in)
  Ach: number;          // confined core area (in²)
  Ash_req_1: number;    // from §18.10.6.4(f) option 1: 0.3*(Ag/Ach-1)*f'c/fyt
  Ash_req_2: number;    // from §18.10.6.4(f) option 2: 0.09*f'c/fyt
  Ash_req: number;      // governing (larger)
  Ash_prov: number;     // provided per spacing
  s_max_sbz: number;    // max tie spacing in SBZ (in)
  spacingOK: boolean;
  AshOK: boolean;
  warnings: DesignWarning[];
}

/**
 * ACI 318-25 §18.10.6.4 SBZ confinement design.
 * SBZ tie spacing: s ≤ min(6·db_long, 6")  (§18.10.6.4(e))
 * Ash/s ≥ max(0.3*(Ag/Ach-1)*f'c/fyt, 0.09*f'c/fyt)  (§18.10.6.4(f), same as column §18.7.5.3)
 * SBZ length: lbe ≥ max(c - 0.1·lw, c/2)  (§18.10.6.4(a))
 */
export function sbzDesign(
  lw: number,
  tw: number,
  fc: number,
  fyt: number,
  c_demand: number,
  wallRebar: WallRebarLayout
): SBZDesignResult {
  // SBZ length per end §18.10.6.4(a)
  const lbe = Math.max(c_demand - 0.1 * lw, c_demand / 2);

  // Confined core dimensions (to tie centerlines)
  const cover = 1.5;
  const tieDiam = getBarDiam(wallRebar.sbzTieBarSize ?? 4);
  const bc_lw = lbe - 2 * (cover + tieDiam / 2); // along wall length direction
  const bc_tw = tw - 2 * (cover + tieDiam / 2);  // along wall thickness

  // Use the more critical (smaller) dimension for Ash calc
  const bc = Math.min(bc_lw, bc_tw);
  const Ach = bc_lw * bc_tw;
  const Ag_confinement = lbe * tw;

  const fyt_psi = fyt;

  // §18.10.6.4(f) — Ash/sbc ≥ max(option1, option2)
  const Ash_ratio_1 = 0.3 * (Ag_confinement / Ach - 1) * fc / fyt_psi;
  const Ash_ratio_2 = 0.09 * fc / fyt_psi;
  const Ash_ratio_req = Math.max(Ash_ratio_1, Ash_ratio_2);

  const s_ties = wallRebar.sbzTieSpacing ?? 4;
  const Ash_req = Ash_ratio_req * bc * s_ties; // in²

  // Provided Ash
  const tieLegs = wallRebar.sbzTieLegs ?? 4;
  const Ash_prov = tieLegs * getBarArea(wallRebar.sbzTieBarSize ?? 4);

  // Maximum SBZ tie spacing §18.10.6.4(e)
  const db_long = getBarDiam(wallRebar.sbzBarSize ?? wallRebar.vertBarSize);
  const s_max_sbz = Math.min(6 * db_long, 6.0);

  const spacingOK = s_ties <= s_max_sbz + 0.001;
  const AshOK = Ash_prov >= Ash_req - 0.001;

  const warnings: DesignWarning[] = [];
  if (!spacingOK) {
    warnings.push(warn('ACI318-25-18.10.6.4e', `§18.10.6.4(e): SBZ tie spacing ${s_ties.toFixed(2)}" > s_max = min(6·db=${(6*db_long).toFixed(2)}", 6") = ${s_max_sbz.toFixed(2)}"`, 'error'));
  }
  if (!AshOK) {
    warnings.push(warn('ACI318-25-18.10.6.4f', `§18.10.6.4(f): SBZ Ash_prov=${Ash_prov.toFixed(3)} in² < Ash_req=${Ash_req.toFixed(3)} in²`, 'error'));
  }

  return {
    lbe: Math.max(lbe, 0),
    bc,
    Ach,
    Ash_req_1: Ash_ratio_1 * bc * s_ties,
    Ash_req_2: Ash_ratio_2 * bc * s_ties,
    Ash_req,
    Ash_prov,
    s_max_sbz,
    spacingOK,
    AshOK,
    warnings,
  };
}

// ─── master wall design function ─────────────────────────────────────────

export function designWallACI(
  section: SectionDimensions,
  material: MaterialProps,
  wallRebar: WallRebarLayout,
  load: LoadCase
): DesignResults {
  const lw = section.lw ?? section.b;
  const tw = section.tw ?? section.h;
  const hw = section.hw ?? (lw * 2); // default hw = 2*lw if not given
  const { fc, fy, fyt, Es, lambdaConcrete } = material;
  const driftRatio = wallRebar.driftRatio ?? 0.015;

  const warnings: DesignWarning[] = [];

  // 1. Reinforcement ratios
  const ratios = wallReinfRatios(tw, wallRebar);

  // 2. Min reinforcement §11.6
  const minReinf = checkMinReinf(ratios.rhoL, ratios.rhoT, hw, lw);
  warnings.push(...minReinf.warnings);

  // 3. Bar spacing §18.10.2.2
  const spacingCheck = checkWallSpacing(wallRebar.vertSpacing, wallRebar.horizSpacing, lw, tw);
  warnings.push(...spacingCheck.warnings);

  // 4. In-plane shear §18.10.4
  const shearResult = wallShear(lw, tw, hw, fc, lambdaConcrete, ratios.rhoT, fyt, load.Vu);
  if (shearResult.DCR > 1) warnings.push(warn('ACI318-25-18.10.4', `§18.10.4: In-plane shear NG: DCR = ${shearResult.DCR.toFixed(2)}`, 'error'));
  if (shearResult.governedByMax) warnings.push(warn('ACI318-25-18.10.4.4', '§18.10.4.4: Vn controlled by 10·Acv·√f\'c maximum limit'));

  // 5. P-M interaction §18.10.5
  const curve = wallInteractionCurve(lw, tw, fc, fy, Es, wallRebar);
  const Mu = load.Mu_pos > 0 ? load.Mu_pos : load.Mu_neg; // use governing moment
  const { phiPn, phiMn, dcr: dcr_PM, c: c_demand } = wallCapacityOnRay(curve, load.Pu, Math.abs(Mu));
  if (dcr_PM > 1) warnings.push(warn('ACI318-25-18.10.5', `§18.10.5: P-M interaction NG: DCR = ${dcr_PM.toFixed(2)}`, 'error'));

  // 6. SBZ trigger §18.10.6
  const sbz = sbzTrigger(lw, tw, hw, fc, c_demand, driftRatio, load.Pu, Math.abs(Mu));

  let sbzLength = 0;
  let sbzAshRequired = 0;
  let sbzAshProvided = 0;
  let dcr_sbzAsh = 0;

  if (sbz.required) {
    const sbzResult = sbzDesign(lw, tw, fc, fyt, c_demand, wallRebar);
    sbzLength = sbzResult.lbe;
    sbzAshRequired = sbzResult.Ash_req;
    sbzAshProvided = sbzResult.Ash_prov;
    dcr_sbzAsh = sbzAshRequired > 0 ? sbzAshRequired / sbzAshProvided : 0;
    warnings.push(...sbzResult.warnings);
    warnings.push(warn('ACI318-25-18.10.6', `§18.10.6: SBZ Required (${sbz.triggerType} trigger) — lbe = ${sbzResult.lbe.toFixed(1)}" each end`));
  }

  // Overall status
  const maxDCR = Math.max(shearResult.DCR, dcr_PM, dcr_sbzAsh);
  const status: DesignResults['status'] = maxDCR > 1 ? 'NG' : maxDCR > 0.9 ? 'Warning' : 'OK';

  return {
    loadCaseId: load.id,
    // Beam fields stubbed as 0 (not applicable for walls)
    Mn_pos: 0, Mn_neg: 0, phi_Mn_pos: 0, phi_Mn_neg: 0,
    DCR_flex_pos: 0, DCR_flex_neg: 0,
    Vc: 0, Vs: 0,
    Tcr: 0, Tu_threshold: 0, phi_Tn: 0, DCR_torsion: 0,
    As_req_pos: 0, As_req_neg: 0, As_min: 0, As_max: 0, Av_req: 0, Av_min_per_s: 0,
    // Wall-specific
    phi_Vn: shearResult.phi_Vn,
    DCR_shear: shearResult.DCR,
    phi_Vn_wall: shearResult.phi_Vn,
    phi_Mn_wall: phiMn,
    DCR_shear_wall: shearResult.DCR,
    DCR_flex_wall: dcr_PM,
    rhoL: ratios.rhoL,
    rhoT: ratios.rhoT,
    sbzRequired: sbz.required,
    sbzLength,
    sbzAshRequired,
    sbzAshProvided,
    DCR_sbzAsh: dcr_sbzAsh,
    alphaC: shearResult.alphaC,
    wallVnMax: shearResult.Vn_max,
    warnings,
    status,
  };
}
