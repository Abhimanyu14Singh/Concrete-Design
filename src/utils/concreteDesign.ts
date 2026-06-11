/**
 * ACI 318-19 Concrete Design Engine — Beams Only
 * Units: inches, psi, kips, kip-ft unless noted
 */

import type {
  MaterialProps, SectionDimensions, RebarLayout, LoadCase,
  DesignResults, DesignWarning, ComboForces,
} from '../types';

/** Max |V| within each third of the span — drives the zoned stirrup check. */
export function zoneShearDemands(forces: ComboForces[], spanFt: number): [number, number, number] {
  const zones: [number, number, number] = [0, 0, 0];
  for (const cf of forces) {
    for (const st of cf.stations) {
      const zi = Math.min(2, Math.floor((st.x / spanFt) * 3));
      const v = Math.abs(st.V);
      if (v > zones[zi]) zones[zi] = v;
    }
  }
  return zones;
}

// ── Bar tables (ASTM A615) ────────────────────────────────────────────────────
const BAR_AREAS: Record<number, number> = {
  3: 0.11, 4: 0.20, 5: 0.31, 6: 0.44, 7: 0.60, 8: 0.79, 9: 1.00,
  10: 1.27, 11: 1.56, 14: 2.25, 18: 4.00,
};
const BAR_DIAMS: Record<number, number> = {
  3: 0.375, 4: 0.500, 5: 0.625, 6: 0.750, 7: 0.875, 8: 1.000,
  9: 1.128, 10: 1.270, 11: 1.410, 14: 1.693, 18: 2.257,
};

// Negative barSize = metric bar Ø in mm (e.g. -16 = Ø16); returns in²/in
export function getBarArea(size: number): number {
  if (size < 0) { const d = -size / 25.4; return Math.PI * d * d / 4; }
  return BAR_AREAS[size] ?? 0;
}
export function getBarDiam(size: number): number {
  if (size < 0) return -size / 25.4;
  return BAR_DIAMS[size] ?? 0;
}

function getRebarAs(bars: { numBars: number; barSize: number }[]): number {
  return bars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
}

// ── ACI helpers ───────────────────────────────────────────────────────────────

/** β₁ stress-block factor per ACI 318-19 §22.2.2.4.3 */
export function beta1(fc: number): number {
  if (fc <= 4000) return 0.85;
  return Math.max(0.65, 0.85 - 0.05 * (fc - 4000) / 1000);
}

/**
 * Effective depth: d = h − cc − d_stirrup − d_bar/2
 * barSize: actual bar designation (8 for #8).
 */
export function effectiveDepth(section: SectionDimensions, barSize: number): number {
  const h = section.h ?? 12;
  const dStir = getBarDiam(section.stirrupDia);
  const dBar  = getBarDiam(barSize);
  return h - section.coverClear - dStir - dBar / 2;
}

/** Effective flange width per ACI Table 6.3.2.1 */
export function effectiveFlange(section: SectionDimensions, spanFt: number): number {
  if (section.type === 'T_beam') {
    const bw = section.bw ?? section.b;
    const hf = section.hf ?? 4;
    return Math.min(bw + 2 * 8 * hf, spanFt * 12 / 4, section.b);
  }
  if (section.type === 'L_beam') {
    const bw = section.bw ?? section.b;
    const hf = section.hf ?? 4;
    return Math.min(bw + 6 * hf, spanFt * 12 / 12, section.b);
  }
  return section.b;
}

/** As_min and As_max per ACI 318-19 §9.6.1 */
export function steelLimits(section: SectionDimensions, material: MaterialProps) {
  const { fc, fy } = material;
  const bw = section.bw ?? section.b;
  const d  = effectiveDepth(section, 8);
  const rho_min = Math.max(3 * Math.sqrt(fc) / fy, 200 / fy);
  const As_min  = rho_min * bw * d;
  const As_max  = 0.75 * beta1(fc) * (fc / fy) * (0.003 / (0.003 + 0.004)) * bw * d;
  return { As_min, As_max };
}

// ── Flexure (ACI §22.3) ───────────────────────────────────────────────────────

export function computeFlexure(
  section: SectionDimensions,
  material: MaterialProps,
  As_top: number,
  As_bot: number,
  span = 20,
  topBarSize = 8,
  botBarSize = 8,
): {
  phi_Mn_pos: number; phi_Mn_neg: number;
  Mn_pos: number;     Mn_neg: number;
  a_pos: number;      a_neg: number;
  phi_pos: number;    phi_neg: number;
} {
  const { fc, fy } = material;
  const b1 = beta1(fc);
  const h  = section.h ?? 12;
  const beff = effectiveFlange(section, span);
  const bw   = section.bw ?? section.b;

  const d_pos = effectiveDepth(section, botBarSize);
  const d_neg = effectiveDepth(section, topBarSize);

  function calcMn(As: number, d: number, bFlange: number): { Mn: number; a: number; phi: number } {
    if (As <= 0) return { Mn: 0, a: 0, phi: 0.9 };

    let a = (As * fy) / (0.85 * fc * bFlange);
    const hf = section.hf ?? h;

    if ((section.type === 'T_beam' || section.type === 'L_beam') && a > hf) {
      // Flange + web compression split
      const Cf = 0.85 * fc * (bFlange - bw) * hf;
      const Cw = As * fy - Cf;
      const a_web = Cw / (0.85 * fc * bw);
      a = a_web + hf;
      const Mn_flange = Cf * (d - hf / 2) / 12000;
      const Mn_web    = Cw * (d - hf - a_web / 2) / 12000;
      const Mn = Mn_flange + Mn_web;
      const c = a / b1;
      const et = 0.003 * (d - c) / c;
      const phi = et >= 0.005 ? 0.9 : et <= 0.002 ? 0.65 : 0.65 + (et - 0.002) * (250 / 3);
      return { Mn, a, phi };
    }

    const c  = a / b1;
    const et = 0.003 * (d - c) / c;
    const phi = et >= 0.005 ? 0.9 : et <= 0.002 ? 0.65 : 0.65 + (et - 0.002) * (250 / 3);
    const Mn = As * fy * (d - a / 2) / 12000;
    return { Mn, a, phi };
  }

  const pos = calcMn(As_bot, d_pos, beff);
  const neg = calcMn(As_top, d_neg, bw); // negative moment: web width only

  return {
    Mn_pos: pos.Mn,      Mn_neg: neg.Mn,
    phi_Mn_pos: pos.phi * pos.Mn,
    phi_Mn_neg: neg.phi * neg.Mn,
    a_pos: pos.a,        a_neg: neg.a,
    phi_pos: pos.phi,    phi_neg: neg.phi,
  };
}

// ── Shear (ACI §22.5) ─────────────────────────────────────────────────────────

export function computeShear(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  Nu = 0,
): { Vc: number; Vs: number; phi_Vn: number; Av_req: number; Av_prov: number; d_shear: number; Av_min_per_s: number } {
  const { fc, fyt, lambdaConcrete } = material;
  const bw  = section.bw ?? section.b;
  const h   = section.h ?? 12;
  const phi = 0.75;

  const d_raw   = effectiveDepth(section, 8);
  const d_shear = Math.max(d_raw, 0.8 * h);

  const Av_min_per_s = Math.max(0.75 * Math.sqrt(fc) / fyt, 50 / fyt) * bw;

  const ties = rebar.ties;
  let Vs = 0;
  let Av_prov = 0;
  if (ties) {
    Av_prov = ties.legs * getBarArea(ties.barSize);
    Vs = (Av_prov * fyt * d_shear) / (ties.spacing * 1000);
  }

  const As_bot = getRebarAs(rebar.botBars);
  const rho_w  = As_bot / (bw * d_shear);

  // Bug 4 fix: λs only applies when Av/s < Av,min/s (ACI §22.5.5.1.1)
  const Av_s_prov = ties ? (ties.legs * getBarArea(ties.barSize)) / ties.spacing : 0;
  const hasMinStirrups = Av_s_prov >= Av_min_per_s;
  const lambda_s = hasMinStirrups ? 1.0 : Math.min(1.0, Math.sqrt(2 / (1 + 0.004 * d_shear)));

  const Ag = bw * h;
  const Vc = (8 * lambdaConcrete * lambda_s * Math.pow(Math.max(rho_w, 1e-6), 1 / 3) * Math.sqrt(fc)
    + Nu / (6 * Ag)) * bw * d_shear / 1000;

  return { Vc, Vs, phi_Vn: phi * (Vc + Vs), Av_req: 0, Av_prov, d_shear, Av_min_per_s };
}

// ── Zoned shear (three stirrup spacings over thirds of the span) ─────────────

export interface ZoneShearResult {
  zone: 0 | 1 | 2;     // end / middle / end third
  spacing: number;     // stirrup spacing in this zone (in)
  Vu: number;          // max |V| demand within the zone (kips)
  phi_Vn: number;      // capacity with this zone's spacing (kips)
  DCR: number;
}

/**
 * Per-zone shear check for beams with `rebar.tieZones`. Each zone's capacity
 * comes from the same `computeShear` the single-spacing check uses, with the
 * zone's spacing substituted — so the calc sheet, diagrams, and results screen
 * all agree. `zoneVu` is the max |V| within each third (from station forces);
 * with no station data pass the single governing Vu for all three zones.
 */
export function zonedShearCheck(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  zoneVu: [number, number, number],
  Nu = 0,
): ZoneShearResult[] {
  const zones = rebar.tieZones;
  if (!zones || !rebar.ties) return [];
  return zones.map((z, i) => {
    const zonedRebar: RebarLayout = { ...rebar, ties: { ...rebar.ties!, spacing: z.spacing } };
    const r = computeShear(section, material, zonedRebar, Nu);
    return {
      zone: i as 0 | 1 | 2,
      spacing: z.spacing,
      Vu: zoneVu[i],
      phi_Vn: r.phi_Vn,
      DCR: r.phi_Vn > 0 ? zoneVu[i] / r.phi_Vn : 0,
    };
  });
}

// ── Torsion (ACI §22.7) ───────────────────────────────────────────────────────

export function computeTorsion(
  section: SectionDimensions,
  material: MaterialProps,
  rebar?: RebarLayout,
): { Tcr: number; Tu_threshold: number; phi_Tn: number; Ph: number } {
  const { fc, fyt, lambdaConcrete } = material;
  const b   = section.b;
  const h   = section.h ?? 12;
  const phi = 0.75;

  const Acp = b * h;
  const Pcp = 2 * (b + h);

  // Cracking torsion ACI §22.7.4.1
  const Tcr        = (lambdaConcrete * Math.sqrt(fc) * Acp * Acp / Pcp) / 12000;
  const Tu_threshold = Tcr / 4;

  // Closed stirrup centerline geometry
  const cc      = section.coverClear + getBarDiam(section.stirrupDia) / 2;
  const x0      = b - 2 * cc;
  const y0      = h - 2 * cc;
  const Aoh     = x0 * y0;
  const Ao      = 0.85 * Aoh;
  const Ph      = 2 * (x0 + y0);

  // ACI §22.7.6.1: φTn = φ · 2·Ao · (At/s) · fyt  [θ = 45°, cot 45° = 1]
  // At = area of one leg of closed stirrup; use single leg per side
  let phi_Tn = 0;
  if (rebar?.ties && Ao > 0) {
    const At_s = getBarArea(rebar.ties.barSize) / rebar.ties.spacing; // in²/in per leg
    phi_Tn = phi * 2 * Ao * At_s * fyt / 1000; // kip-ft (fyt in psi → /1000 kips, Ao in in² → /12 ft ... wait)
    // Actually: Tn = 2*Ao*At*fyt/s  (units: in²·in²/in·psi = in²·psi = lb-in → /12000 kip-ft)
    phi_Tn = phi * 2 * Ao * At_s * fyt / 12000;
  }

  return { Tcr, Tu_threshold, phi_Tn, Ph };
}

// ── Required steel ────────────────────────────────────────────────────────────

export function requiredAs(
  Mu_kft: number,
  section: SectionDimensions,
  material: MaterialProps,
  isTop: boolean,
  span = 20,
): number {
  if (Mu_kft <= 0) return 0;
  const { fc, fy } = material;
  const Mu    = Mu_kft * 12000; // lb-in
  const d     = effectiveDepth(section, 8);
  const beff  = isTop ? (section.bw ?? section.b) : effectiveFlange(section, span);
  const phi   = 0.9;

  const Rn  = Mu / (phi * beff * d * d);
  let   rho = (0.85 * fc / fy) * (1 - Math.sqrt(Math.max(0, 1 - 2 * Rn / (0.85 * fc))));
  if (isNaN(rho) || rho < 0) rho = 0;

  const { As_min } = steelLimits(section, material);
  return Math.max(rho * beff * d, As_min);
}

// ── Full member design ────────────────────────────────────────────────────────

export function designMember(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  span = 20,
): DesignResults {
  const warnings: DesignWarning[] = [];
  const { fc, fy, fyt, lambdaConcrete } = material;
  const bw      = section.bw ?? section.b;
  const h       = section.h ?? 12;
  const phi_v   = 0.75;

  const As_top = getRebarAs(rebar.topBars);
  const As_bot = getRebarAs(rebar.botBars);

  const flex   = computeFlexure(section, material, As_top, As_bot, span);
  const shear  = computeShear(section, material, rebar, load.Pu);
  const torsion = computeTorsion(section, material, rebar);

  const { As_min, As_max } = steelLimits(section, material);
  const d = shear.d_shear;

  const As_req_pos = requiredAs(load.Mu_pos, section, material, false, span);
  const As_req_neg = requiredAs(load.Mu_neg, section, material, true,  span);

  // Required Av/s (ACI §22.5.10.5)
  const Vu_net = Math.max(0, load.Vu - phi_v * shear.Vc);
  const Av_req = Vu_net > 0 ? Vu_net / (phi_v * fyt * d / 1000) : 0;

  // Minimum Av/s (ACI §9.6.3.3)
  const Av_min_per_s = Math.max(0.75 * Math.sqrt(fc) / fyt, 50 / fyt) * bw;

  // DCRs
  const DCR_flex_pos = flex.phi_Mn_pos > 0 ? load.Mu_pos / flex.phi_Mn_pos : 0;
  const DCR_flex_neg = flex.phi_Mn_neg > 0 ? load.Mu_neg / flex.phi_Mn_neg : 0;
  const DCR_shear    = shear.phi_Vn   > 0 ? load.Vu     / shear.phi_Vn    : 0;
  const DCR_torsion  = torsion.phi_Tn > 0 ? load.Tu     / torsion.phi_Tn  : 0;

  // ── Warnings ────────────────────────────────────────────────────────────────

  // Steel limits ACI §9.3.3 / §9.6.1.2
  if (As_bot > As_max)
    warnings.push({ code: 'ACI §9.3.3', message: `Bottom steel ${As_bot.toFixed(2)} in² > As_max ${As_max.toFixed(2)} in² — compression-controlled`, severity: 'error' });
  if (As_top > As_max)
    warnings.push({ code: 'ACI §9.3.3', message: `Top steel ${As_top.toFixed(2)} in² > As_max ${As_max.toFixed(2)} in²`, severity: 'error' });
  if (As_bot < As_min && load.Mu_pos > 0)
    warnings.push({ code: 'ACI §9.6.1.2', message: `Bottom steel ${As_bot.toFixed(2)} in² is below As_min ${As_min.toFixed(2)} in²`, severity: 'error' });
  if (As_top < As_min && load.Mu_neg > 0)
    warnings.push({ code: 'ACI §9.6.1.2', message: `Top steel ${As_top.toFixed(2)} in² is below As_min ${As_min.toFixed(2)} in²`, severity: 'error' });

  // Capacity exceedances
  if (DCR_flex_pos > 1)
    warnings.push({ code: 'ACI §22.3', message: `Positive flexure NG: DCR = ${DCR_flex_pos.toFixed(2)} (φMn+ = ${flex.phi_Mn_pos.toFixed(1)} kip-ft, Mu+ = ${load.Mu_pos} kip-ft)`, severity: 'error' });
  if (DCR_flex_neg > 1)
    warnings.push({ code: 'ACI §22.3', message: `Negative flexure NG: DCR = ${DCR_flex_neg.toFixed(2)} (φMn- = ${flex.phi_Mn_neg.toFixed(1)} kip-ft, Mu- = ${load.Mu_neg} kip-ft)`, severity: 'error' });
  if (DCR_shear > 1)
    warnings.push({ code: 'ACI §22.5', message: `Shear NG: DCR = ${DCR_shear.toFixed(2)} (φVn = ${shear.phi_Vn.toFixed(1)} kips, Vu = ${load.Vu} kips)`, severity: 'error' });

  // Shear reinforcement trigger ACI §9.6.3.1
  const Vu_trigger = phi_v * lambdaConcrete * Math.sqrt(fc) * bw * d / 1000;
  if (load.Vu > Vu_trigger && !rebar.ties)
    warnings.push({ code: 'ACI §9.6.3.1', message: `Min shear reinf required — Vu ${load.Vu.toFixed(1)} kips > φλ√f'c·bw·d = ${Vu_trigger.toFixed(1)} kips`, severity: 'error' });

  // Two-tier stirrup spacing ACI §9.7.6.2.2
  if (rebar.ties) {
    const heavy_threshold = phi_v * shear.Vc + 4 * phi_v * Math.sqrt(fc) * bw * d / 1000;
    const heavy = load.Vu > heavy_threshold;
    const s_max = heavy ? Math.min(d / 4, 12) : Math.min(d / 2, 24);
    if (rebar.ties.spacing > s_max)
      warnings.push({
        code: 'ACI §9.7.6.2.2',
        message: `${heavy ? 'Heavy shear' : 'Shear'}: s = ${rebar.ties.spacing}" > s_max = ${s_max.toFixed(1)}" (${heavy ? 'd/4 or 12"' : 'd/2 or 24"'})`,
        severity: heavy ? 'error' : 'warning',
      });
  }

  // Torsion stirrup spacing ACI §9.7.6.3.3
  if (load.Tu > torsion.Tu_threshold && rebar.ties && torsion.Ph > 0) {
    const s_max_tors = Math.min(torsion.Ph / 8, 12);
    if (rebar.ties.spacing > s_max_tors)
      warnings.push({ code: 'ACI §9.7.6.3.3', message: `Torsion: s = ${rebar.ties.spacing}" > s_max = ${s_max_tors.toFixed(1)}" (Ph/8 = ${(torsion.Ph / 8).toFixed(1)}")`, severity: 'warning' });
  }

  // Crack control ACI §24.3.2
  if (As_bot > 0 && load.Mu_pos > 0 && DCR_flex_pos > 0) {
    const Cc = section.coverClear + getBarDiam(section.stirrupDia) / 2;
    const fsmax = (2 / 3) * fy / 1000; // ksi
    const util = DCR_flex_pos;
    const fs = util >= 0.75 ? fsmax : util >= 0.5 ? fsmax * (0.5 + 2 * (util - 0.5)) : fsmax * util;
    if (fs > 1) {
      const s_max_crack = Math.min(600 / fs - 2.5 * Cc, 12 * (40 / fs));
      const numBars = rebar.botBars.reduce((s, g) => s + g.numBars, 0);
      const dBar = getBarDiam(rebar.botBars[0]?.barSize ?? 8);
      const s_actual = numBars > 1 ? (bw - 2 * Cc - dBar) / (numBars - 1) : 0;
      if (s_actual > s_max_crack && s_max_crack > 0)
        warnings.push({ code: 'ACI §24.3.2', message: `Crack control: bar spacing ${s_actual.toFixed(1)}" > S_max ${s_max_crack.toFixed(1)}" at fs ≈ ${fs.toFixed(0)} ksi`, severity: 'warning' });
    }
  }

  // Face/skin steel ACI §9.7.2.3
  if (h > 36 && (!rebar.sideBars || rebar.sideBars.length === 0))
    warnings.push({ code: 'ACI §9.7.2.3', message: `h = ${h}" > 36" — skin reinforcement required on each face (ACI §9.7.2.3)`, severity: 'warning' });

  const maxDCR = Math.max(DCR_flex_pos, DCR_flex_neg, DCR_shear, DCR_torsion);
  const hasCriticalWarning = warnings.some(w => w.severity === 'error');
  const status: DesignResults['status'] = maxDCR > 1 ? 'NG' : (maxDCR > 0.9 || hasCriticalWarning) ? 'Warning' : 'OK';

  return {
    loadCaseId: load.id,
    Mn_pos: flex.Mn_pos,   Mn_neg: flex.Mn_neg,
    phi_Mn_pos: flex.phi_Mn_pos, phi_Mn_neg: flex.phi_Mn_neg,
    DCR_flex_pos, DCR_flex_neg,
    Vc: shear.Vc, Vs: shear.Vs, phi_Vn: shear.phi_Vn, DCR_shear,
    Tcr: torsion.Tcr, Tu_threshold: torsion.Tu_threshold, phi_Tn: torsion.phi_Tn, DCR_torsion,
    As_req_pos, As_req_neg, As_min, As_max, Av_req, Av_min_per_s,
    warnings, status,
  };
}
