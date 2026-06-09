/**
 * ACI 318-19 Concrete Design Engine
 * All units: inches, pounds, kip-ft unless noted
 */

import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase, DesignResults } from '../types';

// Bar areas in²
const BAR_AREAS: Record<number, number> = {
  3: 0.11, 4: 0.20, 5: 0.31, 6: 0.44, 7: 0.60, 8: 0.79, 9: 1.00,
  10: 1.27, 11: 1.56, 14: 2.25, 18: 4.00,
};

// Bar diameters in inches
const BAR_DIAMS: Record<number, number> = {
  3: 0.375, 4: 0.500, 5: 0.625, 6: 0.750, 7: 0.875, 8: 1.000,
  9: 1.128, 10: 1.270, 11: 1.410, 14: 1.693, 18: 2.257,
};

export function getBarArea(size: number): number {
  return BAR_AREAS[size] ?? 0;
}

export function getBarDiam(size: number): number {
  return BAR_DIAMS[size] ?? 0;
}

function getRebarAs(bars: { numBars: number; barSize: number }[]): number {
  return bars.reduce((sum, g) => sum + g.numBars * getBarArea(g.barSize), 0);
}

function effectiveDepth(section: SectionDimensions, isTop: boolean): number {
  const cover = section.coverClear;
  const stirrupR = section.stirrupDia / 2;
  // assume outermost bar #8 as default if not specified → 0.5"
  const barR = 0.5;
  const d_cover = cover + stirrupR + barR;
  return (section.h ?? section.diameter ?? 12) - d_cover;
}

function beta1(fc: number): number {
  if (fc <= 4000) return 0.85;
  return Math.max(0.65, 0.85 - 0.05 * (fc - 4000) / 1000);
}

/** Compute effective width for T/L beam flanges */
function effectiveFlange(section: SectionDimensions, span: number): number {
  if (section.type === 'T_beam') {
    const bw = section.bw ?? section.b;
    return Math.min(
      bw + 2 * 8 * (section.hf ?? 4),  // ACI 406.3.2.1
      span * 12 / 4,
      section.b
    );
  }
  if (section.type === 'L_beam') {
    const bw = section.bw ?? section.b;
    return Math.min(
      bw + 6 * (section.hf ?? 4),
      span * 12 / 12,
      section.b
    );
  }
  return section.b;
}

/** ACI 318-19 Section 22.2 - Rectangular/T-beam flexural capacity */
export function computeFlexure(
  section: SectionDimensions,
  material: MaterialProps,
  As_top: number,
  As_bot: number,
  span = 20
): { phi_Mn_pos: number; phi_Mn_neg: number; Mn_pos: number; Mn_neg: number; a_pos: number; a_neg: number; phi_pos: number; phi_neg: number } {
  const { fc, fy } = material;
  const b1 = beta1(fc);
  const h = section.h ?? section.diameter ?? 12;

  const d_pos = effectiveDepth(section, false);
  const d_neg = effectiveDepth(section, true);

  const beff = effectiveFlange(section, span);
  const bw = section.bw ?? section.b;

  function calcMn(As: number, d: number, bFlange: number): { Mn: number; a: number; phi: number } {
    if (As <= 0) return { Mn: 0, a: 0, phi: 0.9 };

    // First try rectangular compression zone
    let a = (As * fy) / (0.85 * fc * bFlange);
    let hf = section.hf ?? h;

    // Check if T-section needed
    if ((section.type === 'T_beam' || section.type === 'L_beam') && a > hf) {
      // Compression in web too
      const Cf = 0.85 * fc * (bFlange - bw) * hf;
      const Cw_needed = As * fy - Cf;
      a = Cw_needed / (0.85 * fc * bw) + hf;
      // Simplified Mn for T-section
      const Mn_flange = Cf * (d - hf / 2) / 12000; // kip-ft
      const As_web = Cw_needed / fy;
      const a_web = (As - (bFlange - bw) * hf * 0.85 * fc / fy) * fy / (0.85 * fc * bw);
      const Mn_web = (As - (Cf / fy)) * fy * (d - a_web / 2) / 12000;
      const Mn = Mn_flange + Mn_web;
      const c = a / b1;
      const et = 0.003 * (d - c) / c;
      const phi = et >= 0.005 ? 0.9 : et <= 0.002 ? 0.65 : 0.65 + (et - 0.002) * (250 / 3);
      return { Mn, a, phi };
    }

    const c = a / b1;
    const et = 0.003 * (d - c) / c;
    const phi = et >= 0.005 ? 0.9 : et <= 0.002 ? 0.65 : 0.65 + (et - 0.002) * (250 / 3);
    const Mn = As * fy * (d - a / 2) / 12000; // kip-ft
    return { Mn, a, phi };
  }

  const pos = calcMn(As_bot, d_pos, beff);
  const neg = calcMn(As_top, d_neg, bw); // T-beam neg uses bw only

  return {
    Mn_pos: pos.Mn,
    Mn_neg: neg.Mn,
    phi_Mn_pos: pos.phi * pos.Mn,
    phi_Mn_neg: neg.phi * neg.Mn,
    a_pos: pos.a,
    a_neg: neg.a,
    phi_pos: pos.phi,
    phi_neg: neg.phi,
  };
}

/** ACI 318-19 Section 22.5 - Shear */
export function computeShear(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  Nu = 0
): { Vc: number; Vs: number; phi_Vn: number; Av_req: number; Av_prov: number } {
  const { fc, fyt, lambdaConcrete } = material;
  const bw = section.bw ?? section.b;
  const d = effectiveDepth(section, false);
  const phi = 0.75;

  const As_bot = getRebarAs(rebar.botBars);
  const rho_w = As_bot / (bw * d);

  // ACI 318-19 Table 22.5.5.1 (simplified with size factor)
  const lambda_s = Math.min(1.0, Math.sqrt(2 / (1 + 0.004 * d)));
  const Vc = (8 * lambdaConcrete * lambda_s * Math.pow(rho_w, 1/3) * Math.sqrt(fc) + Nu / (6 * bw * d)) * bw * d / 1000;

  // Stirrup shear capacity
  const ties = rebar.ties;
  let Vs = 0;
  let Av_prov = 0;
  if (ties) {
    Av_prov = ties.legs * getBarArea(ties.barSize);
    Vs = (Av_prov * fyt * d) / (ties.spacing * 1000); // kips
  }

  const phi_Vn = phi * (Vc + Vs);

  // Required Av/s for a given Vu (return per unit length, in²/in)
  // Will be set by caller
  const Av_req = 0;

  return { Vc, Vs, phi_Vn, Av_req, Av_prov };
}

/** ACI 318-19 Section 22.7 - Torsion */
export function computeTorsion(
  section: SectionDimensions,
  material: MaterialProps
): { Tcr: number; Tu_threshold: number; phi_Tn: number } {
  const { fc, fy, fyt, lambdaConcrete } = material;
  const b = section.b;
  const h = section.h ?? 12;
  const phi = 0.75;

  // Acp = gross area
  const Acp = b * h;
  // Pcp = perimeter
  const Pcp = 2 * (b + h);

  // Cracking torsion ACI 22.7.4
  const Tcr = (lambdaConcrete * Math.sqrt(fc) * Acp * Acp / Pcp) / 12000; // kip-ft

  // Threshold below which torsion can be neglected
  const Tu_threshold = Tcr / 4;

  // Simplified torsion capacity (space truss analogy, theta=45°)
  const cover = section.coverClear + section.stirrupDia;
  const x0 = b - 2 * cover;
  const y0 = h - 2 * cover;
  const Aoh = x0 * y0;
  const Ao = 0.85 * Aoh;

  const ties = section; // use stirrup info as placeholder
  // phi_Tn placeholder - full calc requires At and Al
  const phi_Tn = phi * 2 * Ao * 0.20 * fyt / (12000); // placeholder with #4 @12"

  return { Tcr, Tu_threshold, phi_Tn };
}

/** As_min and As_max per ACI 318-19 */
function steelLimits(section: SectionDimensions, material: MaterialProps) {
  const { fc, fy } = material;
  const bw = section.bw ?? section.b;
  const h = section.h ?? 12;
  const d = effectiveDepth(section, false);

  const rho_min = Math.max(3 * Math.sqrt(fc) / fy, 200 / fy);
  const As_min = rho_min * bw * d;
  const As_max = 0.75 * beta1(fc) * (fc / fy) * (0.003 / (0.003 + 0.004)) * bw * d;

  return { As_min, As_max };
}

/** Required tension steel for given Mu */
export function requiredAs(
  Mu_kft: number,
  section: SectionDimensions,
  material: MaterialProps,
  isTop: boolean,
  span = 20
): number {
  const { fc, fy } = material;
  if (Mu_kft <= 0) return 0;

  const Mu = Mu_kft * 12000; // lb-in
  const d = effectiveDepth(section, isTop);
  const beff = isTop ? (section.bw ?? section.b) : effectiveFlange(section, span);
  const phi = 0.9;

  // Iterative solution
  let Rn = Mu / (phi * beff * d * d);
  let rho = (0.85 * fc / fy) * (1 - Math.sqrt(1 - 2 * Rn / (0.85 * fc)));
  if (isNaN(rho) || rho < 0) rho = 0;

  const { As_min } = steelLimits(section, material);
  return Math.max(rho * beff * d, As_min);
}

/** Full member design */
export function designMember(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  span = 20
): DesignResults {
  const warnings: string[] = [];

  const As_top = getRebarAs(rebar.topBars);
  const As_bot = getRebarAs(rebar.botBars);

  const flex = computeFlexure(section, material, As_top, As_bot, span);
  const shear = computeShear(section, material, rebar, load.Pu);
  const torsion = computeTorsion(section, material);

  const { As_min, As_max } = steelLimits(section, material);

  // Required steel
  const As_req_pos = requiredAs(load.Mu_pos, section, material, false, span);
  const As_req_neg = requiredAs(load.Mu_neg, section, material, true, span);

  // Required Av/s
  const bw = section.bw ?? section.b;
  const d = effectiveDepth(section, false);
  const phi_v = 0.75;
  const { fyt } = material;
  const Vu_net = Math.max(0, load.Vu - phi_v * shear.Vc);
  const Av_req = Vu_net > 0 ? Vu_net / (phi_v * fyt * d / 1000) : 0;

  // DCRs
  const DCR_flex_pos = flex.phi_Mn_pos > 0 ? load.Mu_pos / flex.phi_Mn_pos : 0;
  const DCR_flex_neg = flex.phi_Mn_neg > 0 ? load.Mu_neg / flex.phi_Mn_neg : 0;
  const DCR_shear = shear.phi_Vn > 0 ? load.Vu / shear.phi_Vn : 0;
  const DCR_torsion = torsion.phi_Tn > 0 ? load.Tu / torsion.phi_Tn : 0;

  // Warnings
  if (As_bot > As_max) warnings.push('Bottom steel exceeds As_max (over-reinforced section)');
  if (As_top > As_max) warnings.push('Top steel exceeds As_max');
  if (As_bot < As_min && load.Mu_pos > 0) warnings.push('Bottom steel below As_min');
  if (As_top < As_min && load.Mu_neg > 0) warnings.push('Top steel below As_min');
  if (DCR_flex_pos > 1) warnings.push(`Positive flexure NG: DCR = ${DCR_flex_pos.toFixed(2)}`);
  if (DCR_flex_neg > 1) warnings.push(`Negative flexure NG: DCR = ${DCR_flex_neg.toFixed(2)}`);
  if (DCR_shear > 1) warnings.push(`Shear NG: DCR = ${DCR_shear.toFixed(2)}`);
  if (load.Vu > phi_v * shear.Vc && !rebar.ties) warnings.push('Minimum shear reinforcement required');

  const maxDCR = Math.max(DCR_flex_pos, DCR_flex_neg, DCR_shear, DCR_torsion);
  const status: DesignResults['status'] = maxDCR > 1 ? 'NG' : maxDCR > 0.9 ? 'Warning' : 'OK';

  return {
    loadCaseId: load.id,
    Mn_pos: flex.Mn_pos,
    Mn_neg: flex.Mn_neg,
    phi_Mn_pos: flex.phi_Mn_pos,
    phi_Mn_neg: flex.phi_Mn_neg,
    DCR_flex_pos,
    DCR_flex_neg,
    Vc: shear.Vc,
    Vs: shear.Vs,
    phi_Vn: shear.phi_Vn,
    DCR_shear,
    Tcr: torsion.Tcr,
    Tu_threshold: torsion.Tu_threshold,
    phi_Tn: torsion.phi_Tn,
    DCR_torsion,
    As_req_pos,
    As_req_neg,
    As_min,
    As_max,
    Av_req,
    warnings,
    status,
  };
}

/** P-M interaction diagram for columns (circular & rectangular) */
export function computeInteractionDiagram(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  numPoints = 20
): { Pn: number; Mn: number; phi: number }[] {
  const { fc, fy } = material;
  const b = section.b;
  const h = section.h ?? section.diameter ?? 12;
  const Ag = section.type === 'circular_column'
    ? Math.PI * (section.diameter ?? 12) ** 2 / 4
    : b * h;

  const As_total = getRebarAs([...rebar.topBars, ...rebar.botBars]);
  const d = effectiveDepth(section, false);
  const d_prime = section.coverClear + section.stirrupDia + getBarDiam(rebar.topBars[0]?.barSize ?? 8) / 2;

  const points: { Pn: number; Mn: number; phi: number }[] = [];

  // Pure compression (tied column)
  const Pn_max = 0.80 * (0.85 * fc * (Ag - As_total) + fy * As_total) / 1000;
  points.push({ Pn: Pn_max, Mn: 0, phi: 0.65 });

  for (let i = 1; i <= numPoints; i++) {
    const c = (d * (numPoints - i + 1)) / numPoints;
    const a = beta1(fc) * c;
    const b1_ = beta1(fc);

    // Strain in tension steel
    const es_bot = 0.003 * (d - c) / c;
    // Strain in compression steel
    const es_top = 0.003 * (c - d_prime) / c;

    const fs_bot = Math.min(Math.max(es_bot * 29e6, -fy), fy);
    const fs_top = Math.min(Math.max(es_top * 29e6, -fy), fy);

    const As_t = getRebarAs(rebar.botBars);
    const As_c = getRebarAs(rebar.topBars);

    const Cc = 0.85 * fc * Math.min(a, h) * b / 1000;
    const Cs = As_c * (fs_top - 0.85 * fc) / 1000;
    const Ts = As_t * fs_bot / 1000;

    const Pn = Cc + Cs - Ts;
    const Mn = (Cc * (h / 2 - Math.min(a, h) / 2) + Cs * (h / 2 - d_prime) + Ts * (d - h / 2)) / 12;

    const et = es_bot;
    const phi = et >= 0.005 ? 0.9 : et <= 0.002 ? 0.65 : 0.65 + (et - 0.002) * (250 / 3);

    points.push({ Pn, Mn: Math.abs(Mn), phi });
  }

  // Pure tension
  const Pn_ten = -As_total * fy / 1000;
  points.push({ Pn: Pn_ten, Mn: 0, phi: 0.9 });

  return points;
}
