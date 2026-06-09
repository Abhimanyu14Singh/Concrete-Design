/**
 * ACI 318-19 Concrete Design Engine
 * Units: inches, psi, kips, kip-ft throughout.
 *
 * Key ACI 318-19 references:
 *   §22.2  Flexural strength assumptions
 *   §22.5  Shear strength (Table 22.5.5.1 — 2019 update with size effect)
 *   §22.7  Torsional strength
 *   §21.2  Strength reduction factors
 *   §9.6   Minimum reinforcement
 */

import type {
  MaterialProps,
  SectionDimensions,
  RebarLayout,
  LoadCase,
  DesignResults,
} from '../types';

// ── Bar property tables ────────────────────────────────────────────────────

const BAR_AREAS: Record<number, number> = {
  3: 0.11, 4: 0.20, 5: 0.31, 6: 0.44, 7: 0.60, 8: 0.79,
  9: 1.00, 10: 1.27, 11: 1.56, 14: 2.25, 18: 4.00,
};

// Nominal bar diameters per ASTM A615 (db = barNumber/8 inches exactly for #3–#11)
const BAR_DIAMS: Record<number, number> = {
  3: 0.375, 4: 0.500, 5: 0.625, 6: 0.750, 7: 0.875, 8: 1.000,
  9: 1.128, 10: 1.270, 11: 1.410, 14: 1.693, 18: 2.257,
};

export function getBarArea(size: number): number  { return BAR_AREAS[size] ?? 0; }
export function getBarDiam(size: number): number  { return BAR_DIAMS[size] ?? 0; }

function sumAs(bars: { numBars: number; barSize: number }[]): number {
  return bars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
}

// ── Section geometry helpers ───────────────────────────────────────────────

/**
 * Effective depth d from extreme compression fiber to centroid of
 * outermost tension/compression layer, using actual bar size.
 */
export function effectiveDepth(section: SectionDimensions, barSize: number): number {
  const h     = section.h ?? section.diameter ?? 12;
  const dStir = getBarDiam(section.stirrupDia);    // stirrup bar diameter (in)
  const dBar  = getBarDiam(barSize);               // longitudinal bar diameter (in)
  return h - section.coverClear - dStir - dBar / 2;
}

/**
 * Distance from extreme compression fiber to centroid of compression
 * reinforcement (used for P-M diagram, d').
 */
export function dPrime(section: SectionDimensions, compBarSize: number): number {
  const dStir = getBarDiam(section.stirrupDia);
  const dBar  = getBarDiam(compBarSize);
  return section.coverClear + dStir + dBar / 2;
}

/** β₁ stress block factor — ACI 318-19 §22.2.2.4.3 */
export function beta1(fc: number): number {
  if (fc <= 4000) return 0.85;
  return Math.max(0.65, 0.85 - 0.05 * (fc - 4000) / 1000);
}

/**
 * Effective flange width for T/L beams — ACI 318-19 §406.3.2.
 * span in feet → converted to inches internally.
 */
export function effectiveFlange(section: SectionDimensions, spanFt: number): number {
  const bw   = section.bw ?? section.b;
  const spanIn = spanFt * 12;
  if (section.type === 'T_beam') {
    // Interior beam: min of (bw + 16hf), (bw + span/4 centred), actual b
    return Math.min(bw + 16 * (section.hf ?? 0), spanIn / 4, section.b);
  }
  if (section.type === 'L_beam') {
    // Edge beam: min of (bw + 6hf), (bw + span/12), actual b
    return Math.min(bw + 6 * (section.hf ?? 0), spanIn / 12, section.b);
  }
  return section.b;
}

// ── φ factor (ACI 318-19 Table 21.2.2) ────────────────────────────────────

function phiFlex(et: number): number {
  if (et >= 0.005)  return 0.90;
  if (et <= 0.002)  return 0.65;
  // Linear interpolation in transition zone
  return 0.65 + (et - 0.002) * (0.25 / 0.003);
}

// ── Steel limits ───────────────────────────────────────────────────────────

interface SteelLimits { As_min: number; As_max: number; }

export function steelLimits(
  section: SectionDimensions,
  material: MaterialProps,
  d: number
): SteelLimits {
  const { fc, fy } = material;
  const bw = section.bw ?? section.b;
  const rhoMin = Math.max(3 * Math.sqrt(fc) / fy, 200 / fy);   // ACI §9.6.1.2
  const As_min = rhoMin * bw * d;
  // Maximum steel limits section to net tensile strain ≥ 0.004 (ACI §9.3.3.1)
  // εt = 0.004 → c/d = 0.003/(0.003+0.004) = 3/7
  const As_max = beta1(fc) * (fc / fy) * (3 / 7) * bw * d;
  return { As_min, As_max };
}

// ── Flexural strength ──────────────────────────────────────────────────────

export interface FlexureResult {
  Mn_pos: number;   phi_Mn_pos: number;  a_pos: number;  et_pos: number;  phi_pos: number;
  Mn_neg: number;   phi_Mn_neg: number;  a_neg: number;  et_neg: number;  phi_neg: number;
  isT_behavior_pos: boolean;
}

/**
 * Nominal and design flexural strength for beams.
 * Handles rectangular sections and T/L beams (ACI §22.3).
 *
 * Positive moment: tension in bottom (As_bot), compression in top (T/L-beam uses beff).
 * Negative moment: tension in top (As_top), compression in web only (bw).
 */
export function computeFlexure(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  spanFt = 20
): FlexureResult {
  const { fc, fy } = material;
  const b1  = beta1(fc);
  const beff = effectiveFlange(section, spanFt);
  const bw   = section.bw ?? section.b;
  const hf   = section.hf ?? 0;

  const botBarSize = rebar.botBars[0]?.barSize ?? 8;
  const topBarSize = rebar.topBars[0]?.barSize ?? 8;
  const d_bot = effectiveDepth(section, botBarSize);
  const d_top = effectiveDepth(section, topBarSize);

  const As_bot = sumAs(rebar.botBars);
  const As_top = sumAs(rebar.topBars);

  // ── Positive moment (tension bottom, compression in flange) ──
  function calcPos() {
    if (As_bot <= 0) return { Mn: 0, a: 0, et: 1, phi: 0.9, isT: false };

    const isT = section.type === 'T_beam' || section.type === 'L_beam';
    const aRect = (As_bot * fy) / (0.85 * fc * beff); // assume rectangular first

    let a: number, Mn: number, isT_behavior: boolean;

    if (isT && aRect > hf && hf > 0) {
      // ── True T-section: stress block extends into web ──────────────
      // ACI 318-19 §22.3.3 — split into flange overhangs + web rectangle
      //   C_overhang = 0.85·f'c·(beff−bw)·hf
      //   C_web      = 0.85·f'c·bw·a
      //   T          = As·fy
      //   a = [As·fy − 0.85·f'c·(beff−bw)·hf] / (0.85·f'c·bw)
      a = (As_bot * fy - 0.85 * fc * (beff - bw) * hf) / (0.85 * fc * bw);

      if (a <= 0) {
        // Overhang force alone exceeds tension — treat as rectangular
        a = aRect;
        Mn = As_bot * fy * (d_bot - a / 2) / 12000;
        isT_behavior = false;
      } else {
        const C_overhang = 0.85 * fc * (beff - bw) * hf;
        const C_web      = 0.85 * fc * bw * a;
        // Moment about tension steel centroid (d_bot from top)
        Mn = (C_overhang * (d_bot - hf / 2) + C_web * (d_bot - a / 2)) / 12000;
        isT_behavior = true;
      }
    } else {
      // Rectangular behavior (full flange or solid section)
      a = aRect;
      Mn = As_bot * fy * (d_bot - a / 2) / 12000;
      isT_behavior = false;
    }

    const c  = a / b1;
    const et = (d_bot - c) > 0 ? 0.003 * (d_bot - c) / c : -0.003;
    return { Mn, a, et, phi: phiFlex(et), isT: isT_behavior };
  }

  // ── Negative moment (tension top, compression in web only) ───
  function calcNeg() {
    if (As_top <= 0) return { Mn: 0, a: 0, et: 1, phi: 0.9 };
    const a   = (As_top * fy) / (0.85 * fc * bw);
    const Mn  = As_top * fy * (d_top - a / 2) / 12000;
    const c   = a / b1;
    const et  = (d_top - c) > 0 ? 0.003 * (d_top - c) / c : -0.003;
    return { Mn, a, et, phi: phiFlex(et) };
  }

  const pos = calcPos();
  const neg = calcNeg();

  return {
    Mn_pos: pos.Mn,      phi_Mn_pos: pos.phi * pos.Mn,
    a_pos:  pos.a,       et_pos: pos.et,  phi_pos: pos.phi,
    Mn_neg: neg.Mn,      phi_Mn_neg: neg.phi * neg.Mn,
    a_neg:  neg.a,       et_neg: neg.et,  phi_neg: neg.phi,
    isT_behavior_pos: pos.isT,
  };
}

// ── Shear strength ─────────────────────────────────────────────────────────

export interface ShearResult {
  Vc: number; Vs: number; phi_Vn: number;
  lambda_s: number; rho_w: number;
  Av_min_per_s: number;  Av_prov_per_s: number;
  has_min_stirrups: boolean;
}

/**
 * ACI 318-19 Table 22.5.5.1 — Detailed shear equation with size effect.
 *
 * When Av ≥ Av,min:  λs = 1.0  (size effect waived)
 * When Av < Av,min:  λs = √(2/(1+0.004d)) ≤ 1.0
 */
export function computeShear(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  Nu = 0
): ShearResult {
  const { fc, fyt, lambdaConcrete } = material;
  const bw   = section.bw ?? section.b;
  const botBarSize = rebar.botBars[0]?.barSize ?? 8;
  const d    = effectiveDepth(section, botBarSize);
  const Ag   = section.b * (section.h ?? section.diameter ?? 12);

  const As_bot = sumAs(rebar.botBars);
  const rho_w  = As_bot / (bw * d);

  // Minimum stirrup area per unit length — ACI §9.6.3.3
  const Av_min_per_s = Math.max(0.75 * Math.sqrt(fc) / fyt, 50 / fyt) * bw; // in²/in

  // Provided stirrup area per unit length
  const ties = rebar.ties;
  const Av_prov = ties ? ties.legs * getBarArea(ties.barSize) : 0;
  const Av_prov_per_s = ties && ties.spacing > 0 ? Av_prov / ties.spacing : 0;
  const has_min_stirrups = Av_prov_per_s >= Av_min_per_s - 1e-9;

  // Size-effect factor λs — ACI 318-19 §22.5.5.1.3 (d in inches)
  // λs = √(2/(1 + d/10)) ≤ 1.0   (0.004 coefficient is for d in mm)
  // Applied only when Av < Av,min; when stirrups are adequate, λs = 1.0
  const lambda_s = has_min_stirrups ? 1.0 : Math.min(1.0, Math.sqrt(2 / (1 + d / 10)));

  // Vc — ACI 318-19 Table 22.5.5.1 (detailed equation)
  const Vc = (8 * lambdaConcrete * lambda_s * Math.pow(rho_w, 1 / 3) * Math.sqrt(fc)
              + Nu / (6 * Ag)) * bw * d / 1000;   // kips

  // Vs — ACI §22.5.8.5
  const Vs = ties && ties.spacing > 0
    ? (Av_prov * fyt * d) / (ties.spacing * 1000)
    : 0;

  const phi_Vn = 0.75 * (Vc + Vs);

  return { Vc, Vs, phi_Vn, lambda_s, rho_w, Av_min_per_s, Av_prov_per_s, has_min_stirrups };
}

// ── Torsional strength ─────────────────────────────────────────────────────

export interface TorsionResult {
  Tcr: number; Tu_threshold: number; phi_Tn: number;
  Aoh: number; Ao: number; ph: number;
}

/**
 * ACI 318-19 §22.7 — Torsion threshold and capacity.
 * Capacity uses actual stirrup area and spacing (At per leg, space truss θ=45°).
 */
export function computeTorsion(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout
): TorsionResult {
  const { fc, fyt, lambdaConcrete } = material;
  const b = section.b;
  const h = section.h ?? 12;

  // Gross section properties
  const Acp = b * h;
  const Pcp = 2 * (b + h);

  // Cracking torsion — ACI §22.7.4.1 (threshold = Tcr/4)
  const Tcr        = (lambdaConcrete * Math.sqrt(fc) * Acp ** 2 / Pcp) / 12000; // kip-ft
  const Tu_threshold = Tcr / 4;

  // Closed stirrup outline dimensions
  const dStir  = getBarDiam(section.stirrupDia);
  const x0     = b - 2 * (section.coverClear + dStir / 2);
  const y0     = h - 2 * (section.coverClear + dStir / 2);
  const Aoh    = x0 * y0;
  const Ao     = 0.85 * Aoh;
  const ph     = 2 * (x0 + y0);

  // Torsional capacity using actual stirrups — ACI §22.7.6.1 (θ = 45°)
  // φTn = φ · 2·Ao·(At/s)·fyt  where At = area of ONE LEG of closed stirrup
  const ties = rebar.ties;
  let phi_Tn = 0;
  if (ties && ties.spacing > 0) {
    const At_per_s = getBarArea(ties.barSize) / ties.spacing; // one leg, in²/in
    phi_Tn = 0.75 * 2 * Ao * At_per_s * fyt / 12000; // kip-ft
  }

  return { Tcr, Tu_threshold, phi_Tn, Aoh, Ao, ph };
}

// ── Required reinforcement ─────────────────────────────────────────────────

/**
 * Required tension steel for a given factored moment.
 * Returns the larger of the computed value and As,min.
 */
export function requiredAs(
  Mu_kft: number,
  section: SectionDimensions,
  material: MaterialProps,
  isTop: boolean,
  barSize: number,
  spanFt = 20
): number {
  const { fc, fy } = material;
  if (Mu_kft <= 0) return 0;

  const d     = effectiveDepth(section, barSize);
  const beff  = isTop ? (section.bw ?? section.b) : effectiveFlange(section, spanFt);
  const Mu    = Mu_kft * 12000; // lb-in

  // Mn = As·fy·(d − a/2), with a = As·fy/(0.85·f'c·beff)
  // Rearranges to quadratic: φ·0.85·f'c·beff·a² − φ·0.85·f'c·beff·2d·a + 2Mu = 0
  // Simplified: Rn = Mu/(φ·beff·d²); ρ = (0.85·f'c/fy)·(1−√(1−2Rn/(0.85·f'c)))
  const Rn  = Mu / (0.9 * beff * d * d);
  let rho   = (0.85 * fc / fy) * (1 - Math.sqrt(Math.max(0, 1 - 2 * Rn / (0.85 * fc))));
  if (!isFinite(rho) || rho < 0) rho = 0;

  const { As_min } = steelLimits(section, material, d);
  return Math.max(rho * beff * d, As_min);
}

// ── Full member design check ────────────────────────────────────────────────

export function designMember(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  spanFt = 20
): DesignResults {
  const warnings: string[] = [];

  const As_bot = sumAs(rebar.botBars);
  const As_top = sumAs(rebar.topBars);
  const botBarSize = rebar.botBars[0]?.barSize ?? 8;
  const topBarSize = rebar.topBars[0]?.barSize ?? 8;
  const d_bot  = effectiveDepth(section, botBarSize);
  const d_top  = effectiveDepth(section, topBarSize);

  const flex    = computeFlexure(section, material, rebar, spanFt);
  const shear   = computeShear(section, material, rebar, load.Pu > 0 ? load.Pu * 1000 : 0);
  const torsion = computeTorsion(section, material, rebar);

  const { As_min: As_min_bot, As_max: As_max_bot } = steelLimits(section, material, d_bot);
  const { As_min: As_min_top, As_max: As_max_top } = steelLimits(section, material, d_top);
  const As_min = Math.min(As_min_bot, As_min_top);
  const As_max = As_max_bot;

  const As_req_pos = requiredAs(load.Mu_pos, section, material, false, botBarSize, spanFt);
  const As_req_neg = requiredAs(load.Mu_neg, section, material, true,  topBarSize, spanFt);

  // Required Av/s from Vu exceeding φVc
  const phi_v   = 0.75;
  const Vu_net  = Math.max(0, load.Vu - phi_v * shear.Vc);
  const Av_req  = Vu_net > 0
    ? Vu_net / (phi_v * material.fyt * d_bot / 1000)
    : 0;

  // DCRs
  const DCR_flex_pos = flex.phi_Mn_pos > 0 ? load.Mu_pos / flex.phi_Mn_pos : 0;
  const DCR_flex_neg = flex.phi_Mn_neg > 0 ? load.Mu_neg / flex.phi_Mn_neg : 0;
  const DCR_shear    = shear.phi_Vn   > 0 ? load.Vu     / shear.phi_Vn    : 0;
  const DCR_torsion  = torsion.phi_Tn > 0 ? load.Tu     / torsion.phi_Tn  : 0;

  // Code warnings
  if (As_bot > As_max_bot)    warnings.push('Bottom steel exceeds As,max — over-reinforced (εt < 0.004)');
  if (As_top > As_max_top)    warnings.push('Top steel exceeds As,max — over-reinforced (εt < 0.004)');
  if (As_bot < As_min_bot && load.Mu_pos > 0) warnings.push(`Bottom steel ${As_bot.toFixed(2)} in² < As,min ${As_min_bot.toFixed(2)} in²`);
  if (As_top < As_min_top && load.Mu_neg > 0) warnings.push(`Top steel ${As_top.toFixed(2)} in² < As,min ${As_min_top.toFixed(2)} in²`);
  if (DCR_flex_pos > 1)       warnings.push(`Positive flexure FAILS: DCR = ${DCR_flex_pos.toFixed(2)}`);
  if (DCR_flex_neg > 1)       warnings.push(`Negative flexure FAILS: DCR = ${DCR_flex_neg.toFixed(2)}`);
  if (DCR_shear > 1)          warnings.push(`Shear FAILS: DCR = ${DCR_shear.toFixed(2)}`);
  if (!shear.has_min_stirrups && load.Vu > 0.5 * phi_v * shear.Vc)
    warnings.push('Minimum shear reinforcement required — ACI §9.6.3.1');
  if (load.Tu > torsion.Tu_threshold && torsion.phi_Tn === 0)
    warnings.push('Torsion exceeds threshold — closed stirrups required');

  const maxDCR = Math.max(DCR_flex_pos, DCR_flex_neg, DCR_shear);
  const status: DesignResults['status'] = maxDCR > 1 ? 'NG' : maxDCR > 0.9 ? 'Warning' : 'OK';

  return {
    loadCaseId: load.id,
    Mn_pos: flex.Mn_pos,  phi_Mn_pos: flex.phi_Mn_pos,
    Mn_neg: flex.Mn_neg,  phi_Mn_neg: flex.phi_Mn_neg,
    DCR_flex_pos, DCR_flex_neg,
    Vc: shear.Vc, Vs: shear.Vs, phi_Vn: shear.phi_Vn,
    DCR_shear,
    Tcr: torsion.Tcr, Tu_threshold: torsion.Tu_threshold, phi_Tn: torsion.phi_Tn,
    DCR_torsion,
    As_req_pos, As_req_neg, As_min, As_max,
    Av_req,
    warnings,
    status,
  };
}

// ── P-M interaction diagram ────────────────────────────────────────────────

/**
 * P-M interaction diagram for rectangular or circular columns.
 * Returns nominal and design (φ·Pn, φ·Mn) point pairs.
 * Sweeps c from h (pure compression) down to 0 (pure tension).
 */
export function computeInteractionDiagram(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  numPoints = 24
): { Pn: number; Mn: number; phiPn: number; phiMn: number; phi: number }[] {
  const { fc, fy } = material;
  const h     = section.h ?? section.diameter ?? 12;
  const b     = section.b;
  const b1    = beta1(fc);
  const isCirc = section.type === 'circular_column';
  const Ag    = isCirc ? Math.PI * h ** 2 / 4 : b * h;

  // ALL longitudinal bars (for column, top+bot groups are the full bar layout)
  const allBars = [...rebar.topBars, ...rebar.botBars];
  const As_total = sumAs(allBars);

  // Top/compression face bar layer (d' from top)
  const topBarSize = rebar.topBars[0]?.barSize ?? 9;
  const botBarSize = rebar.botBars[0]?.barSize ?? 9;
  const d_prime_val = dPrime(section, topBarSize);
  const d_tens      = effectiveDepth(section, botBarSize); // tension layer

  const As_comp = sumAs(rebar.topBars);
  const As_tens = sumAs(rebar.botBars);

  const points: { Pn: number; Mn: number; phiPn: number; phiMn: number; phi: number }[] = [];

  // ── Pure compression (upper bound) — ACI §22.4.2.1 ──
  const Pn0  = 0.85 * fc * (Ag - As_total) + fy * As_total; // lb
  const Pn0k = Pn0 / 1000;
  // Tied column: φ·Pn,max = 0.80·φ·Pn0 (ACI §22.4.2.1)
  points.push({ Pn: Pn0k, Mn: 0, phiPn: 0.65 * 0.80 * Pn0k, phiMn: 0, phi: 0.65 });

  // ── Sweep c from large to small ──
  for (let i = 1; i <= numPoints; i++) {
    const c = (h * (numPoints - i + 1)) / (numPoints + 1);
    const a = Math.min(b1 * c, h);

    // Strains
    const eps_comp = c > 0 ? 0.003 * (c - d_prime_val) / c : -0.003;
    const eps_tens = c > 0 ? 0.003 * (d_tens - c)       / c : 0.003;

    // Steel stresses (capped at fy)
    const fs_comp = Math.min(Math.max(eps_comp * 29e6, -fy), fy);
    const fs_tens = Math.min(Math.max(-eps_tens * 29e6, -fy), fy); // negative = tension

    // Forces (kips)
    const Cc = 0.85 * fc * a * b / 1000;
    const Cs = As_comp * (fs_comp - 0.85 * fc) / 1000;
    const Ts = As_tens * fs_tens / 1000; // negative when in tension

    const Pn = Cc + Cs + Ts;

    // Moment about section centroid h/2
    const Mn = (
      Cc * (h / 2 - a / 2)
      + Cs * (h / 2 - d_prime_val)
      - Ts * (d_tens - h / 2)
    ) / 12; // kip-ft

    const et   = eps_tens > 0 ? eps_tens : 0; // net tensile strain for φ
    const phi  = phiFlex(et);
    points.push({ Pn, Mn: Math.abs(Mn), phiPn: phi * Pn, phiMn: phi * Math.abs(Mn), phi });
  }

  // ── Pure tension ──
  const Pn_ten = -As_total * fy / 1000;
  points.push({ Pn: Pn_ten, Mn: 0, phiPn: 0.9 * Pn_ten, phiMn: 0, phi: 0.9 });

  return points;
}
