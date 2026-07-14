/**
 * ACI 318-19 short-column design — rectangular and circular sections,
 * biaxial bending (Pu + Mux + Muy) via Bresler reciprocal load method.
 *
 * Scope: cross-section strength only. The user supplies already-amplified
 * design forces (no slenderness / second-order analysis here).
 *
 * Units: in, psi, kips, kip-ft (matching utils/concreteDesign.ts).
 */

import type {
  MaterialProps, SectionDimensions, RebarLayout, LoadCase,
  DesignResults, DesignWarning, InteractionPoint,
} from '../../types';
import { getBarArea, getBarDiam, beta1 } from '../../utils/concreteDesign';
import {
  rectBarLayout, circBarLayout, circularSegment, grossArea,
  type BarPoint, type BarLayoutInput,
} from '../column/sectionModel';
import { biaxialPhiMrFromLayout } from './aciColumnBiaxial';

const EPS_CU = 0.003;

function barInput(rebar: RebarLayout): BarLayoutInput {
  const g = (bars: { numBars: number; barSize: number }[]) =>
    bars.map(b => ({ n: b.numBars, area: getBarArea(b.barSize), diam: getBarDiam(b.barSize) }));
  return { top: g(rebar.topBars), bot: g(rebar.botBars), side: g(rebar.sideBars ?? []) };
}

export function totalAst(rebar: RebarLayout): number {
  return [...rebar.topBars, ...rebar.botBars, ...(rebar.sideBars ?? [])]
    .reduce((s, b) => s + b.numBars * getBarArea(b.barSize), 0);
}

/** φ per ACI Table 21.2.2 (εty for Grade 60 ≈ fy/Es). */
function phiFactor(eps_t: number, eps_ty: number, spiral: boolean): number {
  const phiC = spiral ? 0.75 : 0.65;
  if (eps_t <= eps_ty) return phiC;
  if (eps_t >= eps_ty + 0.003) return 0.90;
  return phiC + (0.90 - phiC) * (eps_t - eps_ty) / 0.003;
}

interface SectionGeom {
  isCircular: boolean;
  b: number; h: number; D: number;
  Ag: number;
  bars: BarPoint[];
  dExtreme: number; // depth to extreme tension steel
}

function buildGeom(section: SectionDimensions, rebar: RebarLayout, swapAxes = false): SectionGeom {
  const isCircular = section.type === 'circular_column';
  const D = section.diameter ?? section.b;
  let b = section.b, h = section.h ?? section.b;
  if (swapAxes) [b, h] = [h, b];
  const tieD = getBarDiam(section.stirrupDia);
  const inp = barInput(rebar);
  const bars = isCircular
    ? circBarLayout(D, section.coverClear, tieD, inp)
    : rectBarLayout(h, section.coverClear, tieD, inp);
  const Ag = grossArea(isCircular, b, h, D);
  const dExtreme = bars.length > 0 ? Math.max(...bars.map(p => p.y)) : (isCircular ? 0.8 * D : 0.8 * h);
  return { isCircular, b, h, D, Ag, bars, dExtreme };
}

/**
 * P-M interaction curve by strain compatibility (εcu = 0.003 at compression
 * face, plane sections). Sweeps the neutral-axis depth c. Moments are taken
 * about the section mid-depth (plastic centroid for symmetric layouts).
 */
export function aciInteractionCurve(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  nPoints = 40,
  swapAxes = false,
): InteractionPoint[] {
  const { fc, fy, Es } = material;
  const geom = buildGeom(section, rebar, swapAxes);
  const { isCircular, b, h, D, Ag, bars, dExtreme } = geom;
  const depth = isCircular ? D : h;
  const b1 = beta1(fc);
  const Ast = bars.reduce((s, p) => s + p.area, 0);
  const eps_ty = fy / Es;
  const spiral = rebar.tieType === 'spiral';

  const Pn0 = (0.85 * fc * (Ag - Ast) + fy * Ast) / 1000; // kips
  const rCap = spiral ? 0.85 : 0.80;
  const PnMax = rCap * Pn0;

  const points: InteractionPoint[] = [];

  // Pure tension anchor
  const Pnt = -Ast * fy / 1000;
  points.push({ c: 0, Pn: Pnt, Mn: 0, phi: 0.90, phiPn: 0.90 * Pnt, phiMn: 0, eps_t: 99 });

  // Sweep c from shallow (near pure bending) to deep (near pure compression)
  for (let i = 1; i <= nPoints; i++) {
    const c = (i / nPoints) * 1.5 * depth + 0.02 * depth;
    const a = Math.min(b1 * c, depth);

    let Cc: number, yC: number;
    if (isCircular) {
      const seg = circularSegment(a, D);
      Cc = 0.85 * fc * seg.A;
      yC = seg.yBar;
    } else {
      Cc = 0.85 * fc * a * b;
      yC = a / 2;
    }

    let P = Cc;                          // lb
    let M = Cc * (depth / 2 - yC);       // lb-in about mid-depth
    let eps_t = 0;

    for (const bar of bars) {
      const eps = EPS_CU * (c - bar.y) / c;
      let fs = Math.max(-fy, Math.min(fy, eps * Es));
      // Compression bar (fs > 0 in this sign convention) inside the stress
      // block displaces concrete already counted in Cc — deduct 0.85f'c.
      if (bar.y < a && fs > 0) fs -= 0.85 * fc;
      P += bar.area * fs;
      M += bar.area * fs * (depth / 2 - bar.y);
      if (bar.y >= dExtreme - 1e-9) eps_t = -eps; // tension positive
    }

    const Pn = P / 1000;          // kips
    const Mn = Math.abs(M) / 12000; // kip-ft
    const phi = phiFactor(Math.max(eps_t, 0), eps_ty, spiral);
    const phiPn = Math.min(phi * Pn, phi * PnMax);
    points.push({ c, Pn, Mn, phi, phiPn, phiMn: phi * Mn, eps_t });
  }

  // Pure compression anchor (capped)
  const phiC = spiral ? 0.75 : 0.65;
  points.push({ c: Infinity, Pn: Pn0, Mn: 0, phi: phiC, phiPn: phiC * PnMax, phiMn: 0, eps_t: -EPS_CU });

  return points;
}

/**
 * Capacity along the load ray from origin through (Mu, Pu) intersected with
 * the (φMn, φPn) polyline. DCR = |demand| / |capacity point on envelope|.
 */
export function capacityOnRay(
  curve: InteractionPoint[], Pu: number, Mu: number,
): { phiPnCap: number; phiMnCap: number; dcr: number } {
  const dLen = Math.hypot(Mu, Pu);
  if (dLen < 1e-9) return { phiPnCap: 0, phiMnCap: 0, dcr: 0 };

  // Pure axial special-case
  if (Math.abs(Mu) < 1e-9) {
    const PnAtM0 = Math.max(...curve.map(p => p.phiPn));
    return { phiPnCap: PnAtM0, phiMnCap: 0, dcr: PnAtM0 > 0 ? Pu / PnAtM0 : Infinity };
  }

  // Ray: (M, P) = t·(Mu, Pu), t > 0. Intersect each curve segment.
  let best: { t: number; M: number; P: number } | null = null;
  for (let i = 0; i < curve.length - 1; i++) {
    const M1 = curve[i].phiMn, P1 = curve[i].phiPn;
    const M2 = curve[i + 1].phiMn, P2 = curve[i + 1].phiPn;
    // Solve t·Mu = M1 + s(M2−M1), t·Pu = P1 + s(P2−P1), s ∈ [0,1]
    const det = Mu * (P1 - P2) - Pu * (M1 - M2);
    if (Math.abs(det) < 1e-12) continue;
    const t = (M1 * (P1 - P2) - P1 * (M1 - M2)) / det;
    const s = Mu !== 0 ? (t * Mu - M1) / (M2 - M1 || 1e-12) : (t * Pu - P1) / (P2 - P1 || 1e-12);
    if (t > 0 && s >= -1e-6 && s <= 1 + 1e-6) {
      if (!best || t > best.t) best = { t, M: t * Mu, P: t * Pu };
    }
  }
  if (!best) return { phiPnCap: 0, phiMnCap: 0, dcr: Infinity };
  const capLen = Math.hypot(best.M, best.P);
  return { phiPnCap: best.P, phiMnCap: best.M, dcr: capLen > 0 ? dLen / capLen : Infinity };
}

/** φMn at a given axial load level (linear interpolation along the curve). */
export function momentAtAxial(curve: InteractionPoint[], Pu: number): number {
  // curve is ordered from tension to compression in phiPn
  const sorted = [...curve].sort((a, b) => a.phiPn - b.phiPn);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b2 = sorted[i + 1];
    if (Pu >= a.phiPn && Pu <= b2.phiPn) {
      const t = (Pu - a.phiPn) / (b2.phiPn - a.phiPn || 1e-12);
      return a.phiMn + t * (b2.phiMn - a.phiMn);
    }
  }
  return 0;
}

export interface BiaxialResult {
  DCR_PM: number;
  phiPnx: number; phiPny: number; phiPn0: number;
  phiMnx: number; phiMny: number; // capacities at Pu
  method: 'uniaxial' | 'bresler' | 'contour' | 'circular-resultant';
}

/**
 * Biaxial check. Circular: resultant moment against the single curve.
 * Rectangular with both moments: Bresler reciprocal load (valid Pu ≥ 0.1φPn0);
 * below that, SRSS load-contour on the uniaxial moment DCRs.
 */
export function aciBiaxialCheck(
  curveX: InteractionPoint[],
  curveY: InteractionPoint[] | null,
  Pu: number, Mux: number, Muy: number,
  isCircular: boolean,
): BiaxialResult {
  const phiPn0 = Math.max(...curveX.map(p => p.phiPn));
  const phiMnx = momentAtAxial(curveX, Pu);
  const phiMny = curveY ? momentAtAxial(curveY, Pu) : phiMnx;

  if (isCircular) {
    const Mres = Math.hypot(Mux, Muy);
    const ray = capacityOnRay(curveX, Pu, Mres);
    return { DCR_PM: ray.dcr, phiPnx: ray.phiPnCap, phiPny: ray.phiPnCap, phiPn0, phiMnx, phiMny, method: 'circular-resultant' };
  }

  const hasX = Math.abs(Mux) > 0.5, hasY = Math.abs(Muy) > 0.5;

  if (!hasX || !hasY) {
    const curve = hasY && curveY ? curveY : curveX;
    const Mu = hasX ? Mux : Muy;
    const ray = capacityOnRay(curve, Pu, Math.abs(Mu));
    return { DCR_PM: ray.dcr, phiPnx: ray.phiPnCap, phiPny: ray.phiPnCap, phiPn0, phiMnx, phiMny, method: 'uniaxial' };
  }

  if (Pu < 0.1 * phiPn0) {
    // Bresler reciprocal invalid at low axial — SRSS of uniaxial moment DCRs
    const dx = phiMnx > 0 ? Mux / phiMnx : Infinity;
    const dy = phiMny > 0 ? Muy / phiMny : Infinity;
    return { DCR_PM: Math.hypot(dx, dy), phiPnx: 0, phiPny: 0, phiPn0, phiMnx, phiMny, method: 'contour' };
  }

  // Bresler: 1/φPn = 1/φPnx + 1/φPny − 1/φPn0
  const rayX = capacityOnRay(curveX, Pu, Math.abs(Mux));
  const rayY = capacityOnRay(curveY ?? curveX, Pu, Math.abs(Muy));
  const phiPnx = rayX.phiPnCap, phiPny = rayY.phiPnCap;
  if (phiPnx <= 0 || phiPny <= 0) {
    return { DCR_PM: Infinity, phiPnx, phiPny, phiPn0, phiMnx, phiMny, method: 'bresler' };
  }
  const inv = 1 / phiPnx + 1 / phiPny - 1 / phiPn0;
  const phiPn = inv > 0 ? 1 / inv : Infinity;
  return { DCR_PM: Pu / phiPn, phiPnx, phiPny, phiPn0, phiMnx, phiMny, method: 'bresler' };
}

/** Column shear per ACI §22.5.5 with axial compression. Imperial in/out. */
export function aciColumnShear(
  section: SectionDimensions, material: MaterialProps, rebar: RebarLayout,
  Vu: number, Pu: number,
): { Vc: number; Vs: number; phi_Vn: number; DCR_shear: number } {
  const { fc, fyt, lambdaConcrete } = material;
  const isCircular = section.type === 'circular_column';
  const D = section.diameter ?? section.b;
  const bw = isCircular ? D : section.b;
  const h = isCircular ? D : (section.h ?? section.b);
  const d = 0.8 * h; // ACI §22.5.2.2 allows d = 0.8D circular; conservative for rect
  const Ag = grossArea(isCircular, section.b, h, D);
  const Nu_lb = Math.max(Pu, 0) * 1000;
  const phi = 0.75;

  // ACI Table 22.5.5.1 with axial term: Vc = 2λ√f'c(1 + Nu/(2000Ag))·bw·d
  const axialFactor = 1 + Nu_lb / (2000 * Ag);
  const Vc = 2 * lambdaConcrete * Math.sqrt(fc) * Math.min(axialFactor, 2.0) * bw * d / 1000;

  let Vs = 0;
  if (rebar.ties) {
    const Av = rebar.ties.legs * getBarArea(rebar.ties.barSize);
    Vs = (Av * fyt * d) / (rebar.ties.spacing * 1000);
    const VsMax = 8 * Math.sqrt(fc) * bw * d / 1000;
    Vs = Math.min(Vs, VsMax);
  }
  const phi_Vn = phi * (Vc + Vs);
  return { Vc, Vs, phi_Vn, DCR_shear: phi_Vn > 0 ? Vu / phi_Vn : (Vu > 0 ? Infinity : 0) };
}

/**
 * Column torsion per ACI §22.7, calibrated to S-Concrete (ported from
 * Column_Design_DW design_engine._phi_tcr / _phi_Tn). φTcr is the axial-dependent
 * elastic cracking-torsion threshold; φTn the closed-hoop capacity. Below
 * 0.25·φTcr torsion is negligible (ACI threshold). Imperial in/out (kip-ft).
 */
export function aciColumnTorsion(
  section: SectionDimensions, material: MaterialProps, rebar: RebarLayout,
  Tu: number, Pu: number,
): { phi_Tcr: number; Tu_threshold: number; phi_Tn: number; DCR_T: number; torsionActive: boolean } {
  const { fc, fyt } = material;
  const isCircular = section.type === 'circular_column';
  const D = section.diameter ?? section.b;
  const b = section.b, h = isCircular ? D : (section.h ?? section.b);
  const tieD = getBarDiam(section.stirrupDia);
  const cover = section.coverClear;
  const Ag = grossArea(isCircular, b, h, D);
  const pcp = isCircular ? Math.PI * D : 2 * (b + h);

  const sqEff = Math.sqrt(Math.min(fc, 10000));
  const sigma = (Math.max(Pu, 0) * 1000) / Ag; // psi, compression positive
  const phi_Tcr = (0.75 * sqEff * Ag * Ag) / pcp / 3000 * Math.sqrt(Math.max(0, 1 + sigma / (4 * sqEff)));
  const Tu_threshold = 0.25 * phi_Tcr;

  let phi_Tn = 0;
  if (rebar.ties) {
    const AbTie = getBarArea(rebar.ties.barSize);
    const Aoh = isCircular
      ? Math.PI * Math.pow(D / 2 - (cover + tieD / 2), 2)
      : Math.max(0, (b - 2 * (cover + tieD / 2)) * (h - 2 * (cover + tieD / 2)));
    phi_Tn = (0.75 * 2 * 0.85 * Aoh * (AbTie / Math.max(rebar.ties.spacing, 0.5)) * (fyt / 1000)) / 12;
  }
  const torsionActive = Tu > Tu_threshold;
  const DCR_T = torsionActive && phi_Tn > 0 ? Tu / phi_Tn : 0;
  return { phi_Tcr, Tu_threshold, phi_Tn, DCR_T, torsionActive };
}

/**
 * Slenderness / stability check per ACI §6.6.4.4.2 (ported from
 * Column_Design_DW). Euler critical load Ncr = π²·EI/(k·Lu)² with the §6.6.4.4.4
 * stiffness EI = (0.2·Ec·Ig + Es·Ise)/(1+βdns), k = 1, βdns = 0.6. The column is
 * flagged slender when |Pu| > 0.75·Ncr — the engine designs the cross-section
 * for the supplied (assumed amplified) forces and does NOT add second-order
 * moments, so this is a warning to supply magnified demands. luIn = unbraced
 * length (in); pass 0/undefined to skip.
 */
export function aciColumnSlenderness(
  section: SectionDimensions, material: MaterialProps, rebar: RebarLayout,
  Pu: number, luIn: number,
): { Ncr: number; slender: boolean } {
  const { fc, Es } = material;
  if (!luIn || luIn <= 0) return { Ncr: Infinity, slender: false };
  const isCircular = section.type === 'circular_column';
  const D = section.diameter ?? section.b;
  const b = section.b, h = isCircular ? D : (section.h ?? section.b);
  const Ast = totalAst(rebar);
  const Ec = 57000 * Math.sqrt(fc);
  const betaD = 0.6;
  const edge = section.coverClear + getBarDiam(section.stirrupDia) + getBarDiam(rebar.topBars[0]?.barSize ?? 8) / 2;

  const ncrFor = (Ig: number, di: number): number => {
    const Ise = Ast * di * di;
    const EI = (0.2 * Ec * Ig + Es * Ise) / (1 + betaD);
    return (Math.PI * Math.PI * EI) / (luIn * luIn) / 1000; // kips
  };
  const Ncr = isCircular
    ? ncrFor(Math.PI * Math.pow(D, 4) / 64, D / 2 - edge)
    : Math.min(
        ncrFor((b * Math.pow(h, 3)) / 12, Math.abs(b / 2 - edge)),
        ncrFor((h * Math.pow(b, 3)) / 12, Math.abs(h / 2 - edge)),
      );
  return { Ncr, slender: Math.abs(Pu) > 0.75 * Ncr };
}

/** Longitudinal + tie detailing checks per ACI §10.6/§10.7/§25.7. */
export function aciColumnDetailing(
  section: SectionDimensions, rebar: RebarLayout,
): DesignWarning[] {
  const warnings: DesignWarning[] = [];
  const isCircular = section.type === 'circular_column';
  const D = section.diameter ?? section.b;
  const h = isCircular ? D : (section.h ?? section.b);
  const Ag = grossArea(isCircular, section.b, h, D);
  const Ast = totalAst(rebar);
  const rho = Ast / Ag;
  const spiral = rebar.tieType === 'spiral';

  if (rho < 0.01)
    warnings.push({ code: 'ACI §10.6.1.1', message: `ρg = ${(rho * 100).toFixed(2)}% < 1% minimum longitudinal steel`, severity: 'error' });
  if (rho > 0.08)
    warnings.push({ code: 'ACI §10.6.1.1', message: `ρg = ${(rho * 100).toFixed(2)}% > 8% maximum longitudinal steel`, severity: 'error' });

  const nBars = [...rebar.topBars, ...rebar.botBars, ...(rebar.sideBars ?? [])]
    .reduce((s, b) => s + b.numBars, 0);
  const minBars = spiral ? 6 : 4;
  if (nBars < minBars)
    warnings.push({ code: 'ACI §10.7.3.1', message: `${nBars} bars < ${minBars} minimum (${spiral ? 'spiral' : 'tied'})`, severity: 'error' });

  if (rebar.ties) {
    const allBars = [...rebar.topBars, ...rebar.botBars, ...(rebar.sideBars ?? [])];
    const maxLongD = Math.max(...allBars.map(b => getBarDiam(b.barSize)), 0);
    const maxLongSize = Math.max(...allBars.map(b => Math.abs(b.barSize) >= 25.4 ? 11 : b.barSize), 0);
    const tieD = getBarDiam(rebar.ties.barSize);

    // §25.7.2.2: ties ≥ #3 for long bars ≤ #10; ≥ #4 otherwise
    const minTieD = maxLongSize <= 10 ? getBarDiam(3) : getBarDiam(4);
    if (tieD < minTieD - 1e-9)
      warnings.push({ code: 'ACI §25.7.2.2', message: `Tie Ø${(tieD).toFixed(3)}" < required minimum ${minTieD.toFixed(3)}"`, severity: 'warning' });

    // §25.7.2.1: s ≤ min(16db, 48dtie, least dimension)
    const leastDim = isCircular ? D : Math.min(section.b, h);
    const sMax = Math.min(16 * maxLongD, 48 * tieD, leastDim);
    if (rebar.ties.spacing > sMax + 1e-9)
      warnings.push({ code: 'ACI §25.7.2.1', message: `Tie spacing ${rebar.ties.spacing}" > s_max = min(16db, 48dt, least dim) = ${sMax.toFixed(1)}"`, severity: 'error' });
  } else {
    warnings.push({ code: 'ACI §10.7.6', message: 'No transverse reinforcement (ties/spiral) defined', severity: 'error' });
  }

  // §25.2.3 clear spacing / single-layer fit (rectangular) — ported from
  // Column_Design_DW clear_spacing_min_col / needs_two_layers.
  if (!isCircular) {
    const tieD = getBarDiam(section.stirrupDia);
    const longD = getBarDiam(rebar.topBars[0]?.barSize ?? 8);
    const clearMin = Math.max(1.5, 1.5 * longD); // ACI §25.2.3
    const nFace = rebar.topBars.reduce((s, b) => s + b.numBars, 0);
    if (nFace > 1) {
      const span = section.b - 2 * (section.coverClear + tieD + longD / 2); // centreline span
      const clear = span / (nFace - 1) - longD;
      if (clear < clearMin - 1e-6)
        warnings.push({
          code: 'ACI §25.2.3',
          message: `Clear bar spacing ${clear.toFixed(2)}" < ${clearMin.toFixed(2)}" min — bars won't fit one layer; use a second layer or larger section`,
          severity: 'warning',
        });
    }
  }

  return warnings;
}

/** Full ACI 318-19 short-column check for one load case. */
export function designColumnACI(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  span?: number,
): DesignResults {
  const isCircular = section.type === 'circular_column';
  const Pu = load.Pu;
  const Mux = load.Mux ?? load.Mu_pos ?? 0;
  const Muy = load.Muy ?? 0;

  const curveX = aciInteractionCurve(section, material, rebar);
  const curveY = !isCircular && Math.abs(Muy) > 0.5
    ? aciInteractionCurve(section, material, rebar, 40, true)
    : null;

  const phiPnMax = Math.max(...curveX.map(p => p.phiPn));
  const biax = aciBiaxialCheck(curveX, curveY, Pu, Mux, Muy, isCircular);
  const shear = aciColumnShear(section, material, rebar, load.Vu, Pu);
  const tors = aciColumnTorsion(section, material, rebar, load.Tu ?? 0, Pu);
  const slen = aciColumnSlenderness(section, material, rebar, Pu, (span ?? 0) * 12);
  const warnings = aciColumnDetailing(section, rebar);

  // Combined shear + torsion (single Vu): VT_util = DCR_shear + DCR_torsion
  // (the dz+dt form of the S-Concrete V&T interaction for one shear direction).
  const VT_util = shear.DCR_shear + tors.DCR_T;

  // Prefer the rotating-NA resultant-moment method (calibrated vs S-Concrete) for
  // the rectangular biaxial path; fall back to Bresler (aciBiaxialCheck) if the
  // layout doesn't map or Pu is outside the solver's range.
  let DCR_PM = biax.DCR_PM;
  let phiMnCol = biax.phiMnx;
  let pmMethod: string = biax.method;
  let thetaDeg: number | undefined;
  if (!isCircular && Math.abs(Mux) > 0.5 && Math.abs(Muy) > 0.5) {
    const theta = Math.atan2(Math.abs(Muy), Math.abs(Mux));
    const phiMrR = biaxialPhiMrFromLayout(section, material, rebar, Pu, theta);
    if (phiMrR && phiMrR > 0) {
      DCR_PM = Math.hypot(Mux, Muy) / phiMrR;
      phiMnCol = phiMrR;
      pmMethod = 'rotating-na';
      thetaDeg = Math.round((90 + Math.atan2(Math.abs(Mux), Math.abs(Muy)) * 180 / Math.PI) % 360);
    }
  }

  const DCR_axial = phiPnMax > 0 ? Pu / phiPnMax : (Pu > 0 ? Infinity : 0);

  if (DCR_PM > 1)
    warnings.push({ code: 'ACI §22.4', message: `P-M interaction NG: DCR = ${DCR_PM.toFixed(2)} (${pmMethod})`, severity: 'error' });
  if (shear.DCR_shear > 1)
    warnings.push({ code: 'ACI §22.5', message: `Shear NG: DCR = ${shear.DCR_shear.toFixed(2)}`, severity: 'error' });
  if (DCR_axial > 1)
    warnings.push({ code: 'ACI §22.4.2', message: `Axial NG: Pu = ${Pu} kips > φPn,max = ${phiPnMax.toFixed(0)} kips`, severity: 'error' });
  if (VT_util > 1)
    warnings.push({ code: 'ACI §22.7', message: `Shear+torsion NG: V&T util = ${VT_util.toFixed(2)} (DCR_T = ${tors.DCR_T.toFixed(2)})`, severity: 'error' });
  if (slen.slender)
    warnings.push({ code: 'ACI §6.6.4.4.2', message: `Column is slender (|Pu| = ${Math.abs(Pu).toFixed(0)} k > 0.75·Ncr = ${(0.75 * slen.Ncr).toFixed(0)} k) — supply moment-magnified demands; the engine checks the cross-section only`, severity: 'warning' });

  const maxDCR = Math.max(DCR_PM, shear.DCR_shear, DCR_axial, VT_util);
  const hasError = warnings.some(w => w.severity === 'error');
  const status: DesignResults['status'] = maxDCR > 1 ? 'NG' : (maxDCR > 0.9 || hasError) ? 'Warning' : 'OK';

  return {
    loadCaseId: load.id,
    // beam fields zeroed
    Mn_pos: 0, Mn_neg: 0, phi_Mn_pos: 0, phi_Mn_neg: 0,
    DCR_flex_pos: 0, DCR_flex_neg: 0,
    Vc: shear.Vc, Vs: shear.Vs, phi_Vn: shear.phi_Vn, DCR_shear: shear.DCR_shear,
    Tcr: tors.phi_Tcr, Tu_threshold: tors.Tu_threshold, phi_Tn: tors.phi_Tn, DCR_torsion: tors.DCR_T,
    phi_Tcr: tors.phi_Tcr, VT_util,
    As_req_pos: 0, As_req_neg: 0,
    As_min: 0.01 * grossArea(isCircular, section.b, section.h ?? section.b, section.diameter ?? section.b),
    As_max: 0.08 * grossArea(isCircular, section.b, section.h ?? section.b, section.diameter ?? section.b),
    Av_req: 0, Av_min_per_s: 0,
    // column fields
    phi_Pn: phiPnMax,
    phi_Pn_max: phiPnMax,
    phi_Mnx: biax.phiMnx,
    phi_Mny: biax.phiMny,
    phi_Mn_col: phiMnCol,
    theta_deg: thetaDeg,
    DCR_axial,
    DCR_PM,
    interaction: curveX,
    warnings, status,
  };
}
