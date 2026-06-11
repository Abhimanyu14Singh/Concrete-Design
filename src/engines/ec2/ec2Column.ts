/**
 * EN 1992-1-1 short-column design — rectangular and circular sections,
 * biaxial bending per §5.8.9(4) eq (5.39).
 *
 * Boundary convention matches ec2Beam.ts: imperial in/out (in, psi, kips,
 * kip-ft), SI internal (mm, MPa, kN, kN·m). No φ factor — safety is in
 * γc = 1.5 / γs = 1.15; phi_* result fields hold design resistances.
 *
 * Scope: cross-section strength only (user supplies amplified forces).
 * Minimum eccentricity per §6.1(4): e0 = max(h/30, 20 mm).
 */

import type {
  MaterialProps, SectionDimensions, RebarLayout, LoadCase,
  DesignResults, DesignWarning, InteractionPoint,
} from '../../types';
import { getBarArea, getBarDiam } from '../../utils/concreteDesign';
import { lambdaEta, vRdc, vRds, vRdMax } from './ec2Beam';
import {
  rectBarLayout, circBarLayout, circularSegment, grossArea,
  type BarPoint, type BarLayoutInput,
} from '../column/sectionModel';

const IN_TO_MM = 25.4, PSI_TO_MPA = 0.00689476;
const KIP_TO_KN = 4.44822, KIPFT_TO_KNM = 1.35582, IN2_TO_MM2 = 645.16;
const GAMMA_C = 1.5, GAMMA_S = 1.15, ALPHA_CC = 1.0;
const EPS_CU2 = 0.0035;

function barInputSI(rebar: RebarLayout): BarLayoutInput {
  const g = (bars: { numBars: number; barSize: number }[]) =>
    bars.map(b => ({
      n: b.numBars,
      area: getBarArea(b.barSize) * IN2_TO_MM2,
      diam: getBarDiam(b.barSize) * IN_TO_MM,
    }));
  return { top: g(rebar.topBars), bot: g(rebar.botBars), side: g(rebar.sideBars ?? []) };
}

interface GeomSI {
  isCircular: boolean;
  b: number; h: number; D: number; // mm
  Ac: number;                       // mm²
  bars: BarPoint[];                 // mm / mm²
}

function buildGeomSI(section: SectionDimensions, rebar: RebarLayout, swapAxes = false): GeomSI {
  const isCircular = section.type === 'circular_column';
  const D = (section.diameter ?? section.b) * IN_TO_MM;
  let b = section.b * IN_TO_MM;
  let h = (section.h ?? section.b) * IN_TO_MM;
  if (swapAxes) [b, h] = [h, b];
  const cover = section.coverClear * IN_TO_MM;
  const tieD = getBarDiam(section.stirrupDia) * IN_TO_MM;
  const inp = barInputSI(rebar);
  const bars = isCircular
    ? circBarLayout(D, cover, tieD, inp)
    : rectBarLayout(h, cover, tieD, inp);
  return { isCircular, b, h, D, Ac: grossArea(isCircular, b, h, D), bars };
}

/**
 * N-M interaction curve by strain compatibility (εcu2 = 0.0035), rectangular
 * stress block η·fcd over λ·x. Returns points in IMPERIAL units (kips, kip-ft)
 * with phi = 1 so the shared InteractionPoint/chart pipeline works unchanged.
 */
export function ec2InteractionCurve(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  nPoints = 40,
  swapAxes = false,
): InteractionPoint[] {
  const fck = material.fc * PSI_TO_MPA;
  const fyk = material.fy * PSI_TO_MPA;
  const Es = material.Es * PSI_TO_MPA;
  const fcd = ALPHA_CC * fck / GAMMA_C;
  const fyd = fyk / GAMMA_S;
  const { lambda, eta } = lambdaEta(fck);

  const geom = buildGeomSI(section, rebar, swapAxes);
  const { isCircular, b, D, Ac, bars } = geom;
  const depth = isCircular ? D : geom.h;
  const As = bars.reduce((s, p) => s + p.area, 0);

  // NRd,max — εc2 plateau, no ACI-style 0.8 cap (min eccentricity handles it)
  const NRdMax_kN = (fcd * (Ac - As) + As * fyd) / 1000;

  const toKip = (kn: number) => kn / KIP_TO_KN;
  const toKipFt = (knm: number) => knm / KIPFT_TO_KNM;

  const points: InteractionPoint[] = [];

  // Pure tension anchor
  const Nt_kN = -As * fyd / 1000;
  points.push({ c: 0, Pn: toKip(Nt_kN), Mn: 0, phi: 1, phiPn: toKip(Nt_kN), phiMn: 0, eps_t: 99 });

  for (let i = 1; i <= nPoints; i++) {
    const x = (i / nPoints) * 1.5 * depth + 0.02 * depth; // NA depth (mm)
    const a = Math.min(lambda * x, depth);

    let Cc: number, yC: number;
    if (isCircular) {
      const seg = circularSegment(a, D);
      Cc = eta * fcd * seg.A;
      yC = seg.yBar;
    } else {
      Cc = eta * fcd * a * b;
      yC = a / 2;
    }

    let N = Cc;                       // N
    let M = Cc * (depth / 2 - yC);    // N·mm about mid-depth
    let eps_t = 0;
    const dExt = bars.length > 0 ? Math.max(...bars.map(p => p.y)) : 0.8 * depth;

    for (const bar of bars) {
      const eps = EPS_CU2 * (x - bar.y) / x;
      let fs = Math.max(-fyd, Math.min(fyd, eps * Es));
      if (bar.y < a && fs > 0) fs -= eta * fcd; // displaced concrete
      N += bar.area * fs;
      M += bar.area * fs * (depth / 2 - bar.y);
      if (bar.y >= dExt - 1e-9) eps_t = -eps;
    }

    const NRd_kN = Math.min(N / 1000, NRdMax_kN);
    const MRd_kNm = Math.abs(M) / 1e6;
    points.push({
      c: x / IN_TO_MM,
      Pn: toKip(N / 1000), Mn: toKipFt(MRd_kNm),
      phi: 1,
      phiPn: toKip(NRd_kN), phiMn: toKipFt(MRd_kNm),
      eps_t,
    });
  }

  // Pure compression anchor
  points.push({ c: Infinity, Pn: toKip(NRdMax_kN), Mn: 0, phi: 1, phiPn: toKip(NRdMax_kN), phiMn: 0, eps_t: -EPS_CU2 });

  return points;
}

/** MRd (kip-ft) at axial load NEd (kips) — linear interpolation on the curve. */
export function ec2MomentAtAxial(curve: InteractionPoint[], NEd: number): number {
  const sorted = [...curve].sort((a, b) => a.phiPn - b.phiPn);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b2 = sorted[i + 1];
    if (NEd >= a.phiPn && NEd <= b2.phiPn) {
      const t = (NEd - a.phiPn) / (b2.phiPn - a.phiPn || 1e-12);
      return a.phiMn + t * (b2.phiMn - a.phiMn);
    }
  }
  return 0;
}

/** Biaxial exponent a per §5.8.9(4): rect interpolated on NEd/NRd, circular = 2. */
export function biaxialExponent(NRatio: number, isCircular: boolean): number {
  if (isCircular) return 2.0;
  const r = Math.min(Math.max(NRatio, 0), 1);
  if (r <= 0.1) return 1.0;
  if (r <= 0.7) return 1.0 + (r - 0.1) / 0.6 * 0.5;   // 0.1→1.0, 0.7→1.5
  return 1.5 + (r - 0.7) / 0.3 * 0.5;                  // 0.7→1.5, 1.0→2.0
}

/** Full EC2 short-column check for one load case. Imperial in/out. */
export function designColumnEC2(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
): DesignResults {
  const warnings: DesignWarning[] = [];
  const isCircular = section.type === 'circular_column';

  const fck = material.fc * PSI_TO_MPA;
  const fyk = material.fy * PSI_TO_MPA;
  const fywk = material.fyt * PSI_TO_MPA;
  const fcd = ALPHA_CC * fck / GAMMA_C;
  const fyd = fyk / GAMMA_S;
  const fywd = fywk / GAMMA_S;

  const geom = buildGeomSI(section, rebar);
  const { b, h, D, Ac } = geom;
  const depth = isCircular ? D : h;
  const As_mm2 = geom.bars.reduce((s, p) => s + p.area, 0);

  const NEd = load.Pu; // kips
  const NEd_kN = NEd * KIP_TO_KN;
  const NEd_N = NEd_kN * 1000;

  // Min eccentricity §6.1(4): e0 = max(h/30, 20mm) → MEd ≥ NEd·e0
  const e0_mm = Math.max(depth / 30, 20);
  const Mmin_kipft = (NEd_kN * e0_mm / 1000) / KIPFT_TO_KNM; // kN·m → kip-ft
  let MEdx = Math.max(Math.abs(load.Mux ?? load.Mu_pos ?? 0), NEd > 0 ? Mmin_kipft : 0);
  let MEdy = Math.abs(load.Muy ?? 0);

  // ── Interaction curves ──
  const curveX = ec2InteractionCurve(section, material, rebar);
  const curveY = !isCircular && MEdy > 0.5
    ? ec2InteractionCurve(section, material, rebar, 40, true)
    : null;

  const NRdMax = Math.max(...curveX.map(p => p.phiPn)); // kips
  const MRdx = ec2MomentAtAxial(curveX, NEd);
  const MRdy = curveY ? ec2MomentAtAxial(curveY, NEd) : MRdx;

  // ── Biaxial check §5.8.9(4) eq (5.39) ──
  let DCR_PM: number;
  let exponent = 2.0;
  if (isCircular) {
    const Mres = Math.hypot(MEdx, MEdy);
    DCR_PM = MRdx > 0 ? Mres / MRdx : (Mres > 0 ? Infinity : 0);
  } else if (MEdy < 0.5) {
    DCR_PM = MRdx > 0 ? MEdx / MRdx : (MEdx > 0 ? Infinity : 0);
  } else {
    exponent = biaxialExponent(NRdMax > 0 ? NEd / NRdMax : 0, false);
    const lhs =
      Math.pow(MRdx > 0 ? MEdx / MRdx : Infinity, exponent) +
      Math.pow(MRdy > 0 ? MEdy / MRdy : Infinity, exponent);
    DCR_PM = Math.pow(lhs, 1 / exponent); // length-like ratio: 1.0 = at capacity
  }

  const DCR_axial = NRdMax > 0 ? NEd / NRdMax : (NEd > 0 ? Infinity : 0);

  // ── Shear §6.2 with axial compression term ──
  const bw = isCircular ? D : b;
  const d = 0.8 * depth;
  const z = 0.9 * d;
  const cotT = 2.5;
  const VRdc_kN = vRdc(bw, d, As_mm2 / 2, fck, NEd_N, Ac); // half steel on tension side
  let VRds_kN = 0, VRdmax_kN = 0;
  if (rebar.ties) {
    const Asw = rebar.ties.legs * getBarArea(rebar.ties.barSize) * IN2_TO_MM2;
    const s_mm = rebar.ties.spacing * IN_TO_MM;
    VRds_kN = vRds(Asw, s_mm, z, fywd, cotT);
    VRdmax_kN = vRdMax(bw, z, fck, fcd, cotT);
  }
  const VRd_kN = rebar.ties ? Math.min(VRds_kN, VRdmax_kN) : VRdc_kN;
  const VEd_kN = load.Vu * KIP_TO_KN;
  const DCR_shear = VRd_kN > 0 ? VEd_kN / VRd_kN : (VEd_kN > 0 ? Infinity : 0);

  // ── Detailing §9.5 ──
  const AsMin = Math.max(0.10 * Math.max(NEd_N, 0) / fyd, 0.002 * Ac);
  const AsMax = 0.04 * Ac;
  if (As_mm2 < AsMin)
    warnings.push({ code: 'EC2 §9.5.2(2)', message: `As = ${As_mm2.toFixed(0)} mm² < As,min = max(0.10·NEd/fyd, 0.002Ac) = ${AsMin.toFixed(0)} mm²`, severity: 'error' });
  if (As_mm2 > AsMax)
    warnings.push({ code: 'EC2 §9.5.2(3)', message: `As = ${As_mm2.toFixed(0)} mm² > As,max = 0.04Ac = ${AsMax.toFixed(0)} mm²`, severity: 'error' });

  const allBars = [...rebar.topBars, ...rebar.botBars, ...(rebar.sideBars ?? [])];
  const nBars = allBars.reduce((s, g) => s + g.numBars, 0);
  if (nBars < 4)
    warnings.push({ code: 'EC2 §9.5.2(4)', message: `${nBars} bars < 4 minimum`, severity: 'error' });
  const minBarD = Math.min(...allBars.map(g => getBarDiam(g.barSize) * IN_TO_MM), Infinity);
  if (minBarD < 8)
    warnings.push({ code: 'EC2 §9.5.2(1)', message: `Longitudinal bar Ø${minBarD.toFixed(0)}mm < Ø8 minimum`, severity: 'warning' });

  if (rebar.ties) {
    const tieD_mm = getBarDiam(rebar.ties.barSize) * IN_TO_MM;
    const maxLongD_mm = Math.max(...allBars.map(g => getBarDiam(g.barSize) * IN_TO_MM), 0);
    const minLongD_mm = Math.min(...allBars.map(g => getBarDiam(g.barSize) * IN_TO_MM), Infinity);
    if (tieD_mm < Math.max(6, maxLongD_mm / 4))
      warnings.push({ code: 'EC2 §9.5.3(1)', message: `Tie Ø${tieD_mm.toFixed(0)}mm < max(6mm, Øbar/4) = ${Math.max(6, maxLongD_mm / 4).toFixed(0)}mm`, severity: 'warning' });
    const leastDim = isCircular ? D : Math.min(b, h);
    const sMax = Math.min(20 * minLongD_mm, leastDim, 400);
    const s_mm = rebar.ties.spacing * IN_TO_MM;
    if (s_mm > sMax)
      warnings.push({ code: 'EC2 §9.5.3(3)', message: `Transverse spacing ${s_mm.toFixed(0)}mm > scl,tmax = min(20·Øbar,min, least dim, 400mm) = ${sMax.toFixed(0)}mm`, severity: 'error' });
  } else {
    warnings.push({ code: 'EC2 §9.5.3', message: 'No transverse reinforcement defined', severity: 'error' });
  }

  if (DCR_PM > 1)
    warnings.push({ code: 'EC2 §5.8.9', message: `Biaxial N-M interaction NG: DCR = ${DCR_PM.toFixed(2)}`, severity: 'error' });
  if (DCR_shear > 1)
    warnings.push({ code: 'EC2 §6.2', message: `Shear NG: V_Ed = ${VEd_kN.toFixed(1)} kN > V_Rd = ${VRd_kN.toFixed(1)} kN`, severity: 'error' });
  if (DCR_axial > 1)
    warnings.push({ code: 'EC2 §6.1', message: `Axial NG: N_Ed = ${NEd_kN.toFixed(0)} kN > N_Rd,max = ${(NRdMax * KIP_TO_KN).toFixed(0)} kN`, severity: 'error' });

  const maxDCR = Math.max(DCR_PM, DCR_shear, DCR_axial);
  const hasError = warnings.some(w => w.severity === 'error');
  const status: DesignResults['status'] = maxDCR > 1 ? 'NG' : (maxDCR > 0.9 || hasError) ? 'Warning' : 'OK';

  const toKip = (kn: number) => kn / KIP_TO_KN;

  return {
    loadCaseId: load.id,
    Mn_pos: 0, Mn_neg: 0, phi_Mn_pos: 0, phi_Mn_neg: 0,
    DCR_flex_pos: 0, DCR_flex_neg: 0,
    Vc: toKip(VRdc_kN), Vs: toKip(VRds_kN), phi_Vn: toKip(VRd_kN), DCR_shear,
    Tcr: 0, Tu_threshold: 0, phi_Tn: 0, DCR_torsion: 0,
    As_req_pos: 0, As_req_neg: 0,
    As_min: AsMin / IN2_TO_MM2, As_max: AsMax / IN2_TO_MM2,
    Av_req: 0, Av_min_per_s: 0,
    phi_Pn: NRdMax,
    phi_Pn_max: NRdMax,
    phi_Mnx: MRdx,
    phi_Mny: MRdy,
    phi_Mn_col: MRdx,
    DCR_axial,
    DCR_PM,
    interaction: curveX,
    warnings, status,
  };
}
