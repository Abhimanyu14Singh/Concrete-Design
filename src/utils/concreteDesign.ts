/**
 * ACI 318-19 Concrete Design Engine — Beams Only
 * Units: inches, pounds (psi), kips, kip-ft unless noted
 */

import type {
  MaterialProps, SectionDimensions, RebarLayout, LoadCase,
  DesignResults, DesignWarning,
} from '../types';

// ── Bar tables (ASTM A615) ────────────────────────────────────────────────────
const BAR_AREAS: Record<number, number> = {
  3: 0.11, 4: 0.20, 5: 0.31, 6: 0.44, 7: 0.60, 8: 0.79, 9: 1.00,
  10: 1.27, 11: 1.56, 14: 2.25, 18: 4.00,
};
const BAR_DIAMS: Record<number, number> = {
  3: 0.375, 4: 0.500, 5: 0.625, 6: 0.750, 7: 0.875, 8: 1.000,
  9: 1.128, 10: 1.270, 11: 1.410, 14: 1.693, 18: 2.257,
};

export function getBarArea(size: number): number { return BAR_AREAS[size] ?? 0; }
export function getBarDiam(size: number): number { return BAR_DIAMS[size] ?? 0; }

function getRebarAs(bars: { numBars: number; barSize: number }[]): number {
  return bars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
}

// ── ACI §6.3.2 / §22.2 helpers ───────────────────────────────────────────────

/** β₁ stress-block factor per ACI §22.2.2.3 */
export function beta1(fc: number): number {
  if (fc <= 4000) return 0.85;
  return Math.max(0.65, 0.85 - 0.05 * (fc - 4000) / 1000);
}

/**
 * Effective depth: d = h − cc − d_stirrup − d_bar/2
 * Uses actual bar diameters, not bar size numbers.
 */
export function effectiveDepth(section: SectionDimensions, barSize: number): number {
  const h     = section.h ?? 12;
  const dStir = getBarDiam(section.stirrupDia);
  const dBar  = getBarDiam(barSize);
  return h - section.coverClear - dStir - dBar / 2;
}

/** Effective flange width for T/L beams per ACI Table 6.3.2.1 */
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

/** As_min and As_max per ACI §9.6.1.2 and §9.3.3.1 */
export function steelLimits(
  section: SectionDimensions,
  material: MaterialProps,
  d: number
): { As_min: number; As_max: number } {
  const { fc, fy } = material;
  const bw = section.bw ?? section.b;
  const rho_min = Math.max(3 * Math.sqrt(fc) / fy, 200 / fy);   // ACI §9.6.1.2
  const As_min  = rho_min * bw * d;
  // ACI §9.3.3.1: net tensile strain εt ≥ 0.004 → c/d = 3/7
  const As_max  = 0.85 * beta1(fc) * (fc / fy) * (0.003 / 0.007) * bw * d;
  return { As_min, As_max };
}

// ── Flexure ───────────────────────────────────────────────────────────────────

/** φ factor from net tensile strain per ACI Table 21.2.2 */
function phiFactor(et: number): number {
  if (et >= 0.005) return 0.9;
  if (et <= 0.002) return 0.65;
  return 0.65 + (et - 0.002) * (250 / 3);
}

export function computeFlexure(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  span = 20
): {
  phi_Mn_pos: number; phi_Mn_neg: number;
  Mn_pos: number;     Mn_neg: number;
  a_pos: number;      a_neg: number;
  phi_pos: number;    phi_neg: number;
  isT_behavior_pos: boolean;
} {
  const { fc, fy } = material;
  const b1  = beta1(fc);
  const bw  = section.bw ?? section.b;
  const beff = effectiveFlange(section, span);
  const hf   = section.hf ?? (section.h ?? 12);

  const botBarSize = rebar.botBars[0]?.barSize ?? 8;
  const topBarSize = rebar.topBars[0]?.barSize ?? 8;
  const As_bot = getRebarAs(rebar.botBars);
  const As_top = getRebarAs(rebar.topBars);
  const d_bot = effectiveDepth(section, botBarSize);
  const d_top = effectiveDepth(section, topBarSize);

  function calcMn(As: number, d: number, bFlange: number): {
    Mn: number; a: number; phi: number; isT: boolean;
  } {
    if (As <= 0) return { Mn: 0, a: 0, phi: 0.9, isT: false };

    let a = As * fy / (0.85 * fc * bFlange);
    let isT = false;

    if ((section.type === 'T_beam' || section.type === 'L_beam') && a > hf) {
      isT = true;
      const C_overhang = 0.85 * fc * (bFlange - bw) * hf;
      const As_web     = (As * fy - C_overhang) / fy;
      a                = As_web * fy / (0.85 * fc * bw) + hf;
      const a_web      = As_web * fy / (0.85 * fc * bw);
      const Mn_flange  = C_overhang * (d - hf / 2) / 12000;
      const Mn_web     = As_web * fy * (d - a_web / 2) / 12000;
      const Mn = Mn_flange + Mn_web;
      const c  = a / b1;
      const et = 0.003 * (d - c) / c;
      return { Mn, a, phi: phiFactor(et), isT };
    }

    const c  = a / b1;
    const et = 0.003 * (d - c) / c;
    const Mn = As * fy * (d - a / 2) / 12000;
    return { Mn, a, phi: phiFactor(et), isT };
  }

  const pos = calcMn(As_bot, d_bot, beff);
  const neg = calcMn(As_top, d_top, bw);

  return {
    Mn_pos:          pos.Mn,
    Mn_neg:          neg.Mn,
    phi_Mn_pos:      pos.phi * pos.Mn,
    phi_Mn_neg:      neg.phi * neg.Mn,
    a_pos:           pos.a,
    a_neg:           neg.a,
    phi_pos:         pos.phi,
    phi_neg:         neg.phi,
    isT_behavior_pos: pos.isT,
  };
}

// ── Shear ─────────────────────────────────────────────────────────────────────

export function computeShear(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  Nu = 0,
  botBarSize = 8
): {
  Vc: number; Vs: number; phi_Vn: number;
  Av_req: number; Av_prov: number;
  lambda_s: number; has_min_stirrups: boolean;
  Av_min_per_s: number; Av_prov_per_s: number;
  d_shear: number;
} {
  const { fc, fyt, lambdaConcrete } = material;
  const bw  = section.bw ?? section.b;
  const h   = section.h ?? 12;
  const d_raw = effectiveDepth(section, botBarSize);
  // ACI general rule: d ≥ 0.8h for shear calculations
  const d   = Math.max(d_raw, 0.8 * h);
  const phi = 0.75;

  const As_bot = getRebarAs(rebar.botBars);
  const rho_w  = As_bot / (bw * d);

  // Av_min/s per ACI §9.6.3.3
  const Av_min_per_s = Math.max(0.75 * Math.sqrt(fc), 50) * bw / fyt;

  const ties = rebar.ties;
  const Av_prov_per_s = ties ? (ties.legs * getBarArea(ties.barSize)) / ties.spacing : 0;

  const has_min_stirrups = Av_prov_per_s >= Av_min_per_s;

  // ACI Table 22.5.5.1: λs = 1.0 if min stirrups present; else size-effect reduction
  const lambda_s = has_min_stirrups
    ? 1.0
    : Math.min(1.0, Math.sqrt(2 / (1 + d / 10)));

  // ACI Eq. 22.5.5.1
  const Vc = (8 * lambdaConcrete * lambda_s * Math.pow(rho_w, 1/3) * Math.sqrt(fc)
              + Nu / (6 * bw * d)) * bw * d / 1000;

  let Vs = 0;
  let Av_prov = 0;
  if (ties) {
    Av_prov = ties.legs * getBarArea(ties.barSize);
    Vs = Av_prov * fyt * d / (ties.spacing * 1000);
  }

  const phi_Vn = phi * (Vc + Vs);
  const Av_req = 0;

  return { Vc, Vs, phi_Vn, Av_req, Av_prov, lambda_s, has_min_stirrups, Av_min_per_s, Av_prov_per_s, d_shear: d };
}

// ── Torsion ───────────────────────────────────────────────────────────────────

export function computeTorsion(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout
): { Tcr: number; Tu_threshold: number; phi_Tn: number; Aoh: number; Ao: number; At_per_s: number; Ph: number } {
  const { fc, fyt, lambdaConcrete } = material;
  const b = section.b;
  const h = section.h ?? 12;
  const phi = 0.75;

  const Acp = b * h;
  const Pcp = 2 * (b + h);

  // ACI §22.7.4.1 — cracking torsion
  const Tcr = lambdaConcrete * Math.sqrt(fc) * Acp * Acp / Pcp / 12000;

  const Tu_threshold = Tcr / 4; // ACI §9.5.4.1

  const cover = section.coverClear + getBarDiam(section.stirrupDia);
  const x0  = b - 2 * cover;
  const y0  = h - 2 * cover;
  const Aoh = x0 * y0;
  const Ao  = 0.85 * Aoh;
  const Ph  = 2 * (x0 + y0);

  const ties = rebar.ties;
  const At_per_s = ties ? getBarArea(ties.barSize) / ties.spacing : 0;

  const phi_Tn = phi * 2 * Ao * At_per_s * fyt / 12000;

  return { Tcr, Tu_threshold, phi_Tn, Aoh, Ao, At_per_s, Ph };
}

// ── Required steel ────────────────────────────────────────────────────────────

export function requiredAs(
  Mu_kft: number,
  section: SectionDimensions,
  material: MaterialProps,
  isTop: boolean,
  span = 20
): number {
  const { fc, fy } = material;
  if (Mu_kft <= 0) return 0;

  const Mu   = Mu_kft * 12000;
  const botSize = 8;
  const d    = effectiveDepth(section, botSize);
  const beff = isTop ? (section.bw ?? section.b) : effectiveFlange(section, span);
  const phi  = 0.9;

  const Rn  = Mu / (phi * beff * d * d);
  let rho   = (0.85 * fc / fy) * (1 - Math.sqrt(1 - 2 * Rn / (0.85 * fc)));
  if (isNaN(rho) || rho < 0) rho = 0;

  const { As_min } = steelLimits(section, material, d);
  return Math.max(rho * beff * d, As_min);
}

// ── Full member design ────────────────────────────────────────────────────────

export function designMember(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  span = 20
): DesignResults {
  const warnings: DesignWarning[] = [];

  const botBarSize = rebar.botBars[0]?.barSize ?? 8;
  const topBarSize = rebar.topBars[0]?.barSize ?? 8;

  const As_top = getRebarAs(rebar.topBars);
  const As_bot = getRebarAs(rebar.botBars);

  const flex    = computeFlexure(section, material, rebar, span);
  const shear   = computeShear(section, material, rebar, load.Pu, botBarSize);
  const torsion = computeTorsion(section, material, rebar);

  const d      = effectiveDepth(section, botBarSize);
  const d_shear = shear.d_shear; // d with 0.8h lower bound
  const h      = section.h ?? 12;
  const bw     = section.bw ?? section.b;
  const { As_min, As_max } = steelLimits(section, material, d);

  const As_req_pos = requiredAs(load.Mu_pos, section, material, false, span);
  const As_req_neg = requiredAs(load.Mu_neg, section, material, true, span);

  // Required Av/s
  const phi_v = 0.75;
  const Vu_net = Math.max(0, load.Vu - phi_v * shear.Vc);
  const Av_req = Vu_net > 0 ? Vu_net / (phi_v * material.fyt * d_shear / 1000) : 0;

  // DCRs
  const DCR_flex_pos = flex.phi_Mn_pos > 0 ? load.Mu_pos / flex.phi_Mn_pos : 0;
  const DCR_flex_neg = flex.phi_Mn_neg > 0 ? load.Mu_neg / flex.phi_Mn_neg : 0;
  const DCR_shear    = shear.phi_Vn    > 0 ? load.Vu     / shear.phi_Vn    : 0;
  const DCR_torsion  = torsion.phi_Tn  > 0 ? load.Tu     / torsion.phi_Tn  : 0;

  // ── Warnings ──────────────────────────────────────────────────────────────

  // Steel limits
  if (As_bot > As_max)
    warnings.push({ code: 'ACI §9.3.3.1', message: `Bottom steel ${As_bot.toFixed(2)} in² exceeds As_max ${As_max.toFixed(2)} in² (over-reinforced, εt < 0.004)`, severity: 'error' });
  if (As_top > As_max)
    warnings.push({ code: 'ACI §9.3.3.1', message: `Top steel ${As_top.toFixed(2)} in² exceeds As_max ${As_max.toFixed(2)} in²`, severity: 'error' });
  if (As_bot < As_min && load.Mu_pos > 0)
    warnings.push({ code: 'ACI §9.6.1.2', message: `Bottom steel ${As_bot.toFixed(2)} in² below As_min ${As_min.toFixed(2)} in²`, severity: 'warning' });
  if (As_top < As_min && load.Mu_neg > 0)
    warnings.push({ code: 'ACI §9.6.1.2', message: `Top steel ${As_top.toFixed(2)} in² below As_min ${As_min.toFixed(2)} in²`, severity: 'warning' });

  // Capacity failures
  if (DCR_flex_pos > 1)
    warnings.push({ code: 'ACI §22.3', message: `Positive flexure NG: Mu ${load.Mu_pos.toFixed(1)} kip-ft > φMn ${flex.phi_Mn_pos.toFixed(1)} kip-ft (DCR = ${DCR_flex_pos.toFixed(2)})`, severity: 'error' });
  if (DCR_flex_neg > 1)
    warnings.push({ code: 'ACI §22.3', message: `Negative flexure NG: Mu ${load.Mu_neg.toFixed(1)} kip-ft > φMn ${flex.phi_Mn_neg.toFixed(1)} kip-ft (DCR = ${DCR_flex_neg.toFixed(2)})`, severity: 'error' });
  if (DCR_shear > 1)
    warnings.push({ code: 'ACI §22.5', message: `Shear NG: Vu ${load.Vu.toFixed(1)} kips > φVn ${shear.phi_Vn.toFixed(1)} kips (DCR = ${DCR_shear.toFixed(2)})`, severity: 'error' });
  if (DCR_torsion > 1 && load.Tu > torsion.Tu_threshold)
    warnings.push({ code: 'ACI §22.7', message: `Torsion NG: Tu ${load.Tu.toFixed(1)} kip-ft > φTn ${torsion.phi_Tn.toFixed(1)} kip-ft (DCR = ${DCR_torsion.toFixed(2)})`, severity: 'error' });

  // Min shear reinforcement — ACI §9.6.3.1: required when Vu > φλ√f'c·bw·d
  const Vu_min_trigger = phi_v * material.lambdaConcrete * Math.sqrt(material.fc) * bw * d_shear / 1000;
  if (load.Vu > Vu_min_trigger && !rebar.ties)
    warnings.push({ code: 'ACI §9.6.3.1', message: `Minimum transverse reinforcement required (Vu=${load.Vu.toFixed(1)}k > φλ√f'c·bw·d=${Vu_min_trigger.toFixed(1)}k) but no stirrups provided`, severity: 'error' });
  if (rebar.ties && shear.Av_prov_per_s < shear.Av_min_per_s && load.Vu > Vu_min_trigger)
    warnings.push({ code: 'ACI §9.6.3.3', message: `Av/s = ${shear.Av_prov_per_s.toFixed(4)} in²/in < Av_min/s = ${shear.Av_min_per_s.toFixed(4)} in²/in`, severity: 'warning' });

  // Stirrup spacing limits — two tiers per ACI §9.7.6.2.2
  if (rebar.ties) {
    // Heavy shear threshold: Vu > φVc + 4φ√f'c·bw·d
    const heavy_threshold = phi_v * shear.Vc + 4 * phi_v * Math.sqrt(material.fc) * bw * d_shear / 1000;
    if (load.Vu > heavy_threshold) {
      const s_max = Math.min(d_shear / 4, 12);
      if (rebar.ties.spacing > s_max)
        warnings.push({ code: 'ACI §9.7.6.2.2', message: `Heavy shear: stirrup spacing ${rebar.ties.spacing}" exceeds max = min(d/4, 12") = ${s_max.toFixed(1)}" [Vu > φVc+4φ√f'c·bw·d]`, severity: 'error' });
    } else {
      const s_max = Math.min(d_shear / 2, 24);
      if (rebar.ties.spacing > s_max)
        warnings.push({ code: 'ACI §9.7.6.2.2', message: `Stirrup spacing ${rebar.ties.spacing}" exceeds max = min(d/2, 24") = ${s_max.toFixed(1)}"`, severity: 'warning' });
    }

    // Torsion spacing limit per ACI §9.7.6.3.3
    if (load.Tu > torsion.Tu_threshold) {
      const s_max_tors = Math.min(torsion.Ph / 8, 12);
      if (rebar.ties.spacing > s_max_tors)
        warnings.push({ code: 'ACI §9.7.6.3.3', message: `Torsion: stirrup spacing ${rebar.ties.spacing}" exceeds max = min(Ph/8, 12") = ${s_max_tors.toFixed(1)}"`, severity: 'warning' });
    }
  }

  // Torsion threshold notice
  if (load.Tu > 0 && load.Tu <= torsion.Tu_threshold)
    warnings.push({ code: 'ACI §9.5.4.1', message: `Tu = ${load.Tu.toFixed(2)} kip-ft is below threshold ${torsion.Tu_threshold.toFixed(2)} kip-ft — torsion may be neglected`, severity: 'warning' });

  // Crack control (ACI §24.3.2) — S_max = 600/fs - 2.5*Cc ≤ 12*(40/fs)
  const fsmax_ksi = (2 / 3) * material.fy / 1000; // ksi, ACI 318-19
  const Cc = section.coverClear + getBarDiam(section.stirrupDia); // cover to tension steel centroid

  function fsFromUtil(util: number): number {
    const u = Math.max(0, Math.min(1, util));
    if (u >= 0.75) return fsmax_ksi;
    if (u >= 0.5)  return 0.5 * fsmax_ksi + 2 * fsmax_ksi * (u - 0.5);
    return fsmax_ksi * u;
  }

  const util_pos = flex.phi_Mn_pos > 0 ? load.Mu_pos / flex.phi_Mn_pos : 0;
  const util_neg = flex.phi_Mn_neg > 0 ? load.Mu_neg / flex.phi_Mn_neg : 0;

  // Estimate c-to-c bar spacing from section geometry
  const nBot = rebar.botBars.reduce((s, g) => s + g.numBars, 0);
  const nTop = rebar.topBars.reduce((s, g) => s + g.numBars, 0);
  const dbot = getBarDiam(botBarSize);
  const dtop = getBarDiam(topBarSize);
  // available clear width between extreme bars
  const s_bot_ctc = nBot > 1 ? (bw - 2 * Cc - dbot) / (nBot - 1) : (bw - 2 * Cc);
  const s_top_ctc = nTop > 1 ? (bw - 2 * Cc - dtop) / (nTop - 1) : (bw - 2 * Cc);

  if (load.Mu_pos > 0 && util_pos > 0) {
    const fs = fsFromUtil(util_pos);
    if (fs > 0) {
      const s_max_crack = Math.min(600 / fs - 2.5 * Cc, 12 * (40 / fs));
      if (s_bot_ctc > s_max_crack)
        warnings.push({ code: 'ACI §24.3.2', message: `Crack control: bottom bar c-to-c spacing ${s_bot_ctc.toFixed(1)}" exceeds max ${s_max_crack.toFixed(1)}" (fs=${fs.toFixed(1)} ksi)`, severity: 'warning' });
    }
  }
  if (load.Mu_neg > 0 && util_neg > 0) {
    const fs = fsFromUtil(util_neg);
    if (fs > 0) {
      const s_max_crack = Math.min(600 / fs - 2.5 * Cc, 12 * (40 / fs));
      if (s_top_ctc > s_max_crack)
        warnings.push({ code: 'ACI §24.3.2', message: `Crack control: top bar c-to-c spacing ${s_top_ctc.toFixed(1)}" exceeds max ${s_max_crack.toFixed(1)}" (fs=${fs.toFixed(1)} ksi)`, severity: 'warning' });
    }
  }

  // Face steel (ACI §9.7.2.3) — required when h > 36"
  if (h > 36) {
    const fs_face = fsmax_ksi; // conservative
    const s_max_face = Math.min(600 / fs_face - 2.5 * Cc, 12 * (40 / fs_face));
    if (!rebar.sideBars || rebar.sideBars.length === 0)
      warnings.push({ code: 'ACI §9.7.2.3', message: `Face (skin) steel required: h=${h}" > 36". Add side bars with spacing ≤ ${s_max_face.toFixed(1)}"`, severity: 'warning' });
  }

  const maxDCR   = Math.max(DCR_flex_pos, DCR_flex_neg, DCR_shear, DCR_torsion);
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
    Av_min_per_s: shear.Av_min_per_s,
    warnings,
    status,
  };
}
