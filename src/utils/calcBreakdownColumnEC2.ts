/**
 * Step-by-step EN 1992-1-1 column calculation sheet (short column, biaxial
 * per §5.8.9(4)). Values shown in SI, results mirrored in imperial where useful.
 */

import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase } from '../types';
import type { CalcSection } from './calcBreakdown';
import { getBarArea, getBarDiam } from './concreteDesign';
import { formatBarLabel } from './rebar';
import { grossArea } from '../engines/column/sectionModel';
import {
  ec2InteractionCurve, ec2MomentAtAxial, biaxialExponent,
} from '../engines/ec2/ec2Column';
import { vRdc, vRds, vRdMax } from '../engines/ec2/ec2Beam';

const IN_TO_MM = 25.4, PSI_TO_MPA = 0.00689476;
const KIP_TO_KN = 4.44822, KIPFT_TO_KNM = 1.35582, IN2_TO_MM2 = 645.16;

function f(n: number, dec = 1): string { return n.toFixed(dec); }

export function generateColumnBreakdownEC2(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
): CalcSection[] {
  const isCircular = section.type === 'circular_column';
  const D = (section.diameter ?? section.b) * IN_TO_MM;
  const b = section.b * IN_TO_MM;
  const h = (section.h ?? section.b) * IN_TO_MM;
  const depth = isCircular ? D : h;
  const Ac = grossArea(isCircular, b, h, D);

  const fck = material.fc * PSI_TO_MPA;
  const fyk = material.fy * PSI_TO_MPA;
  const fywk = material.fyt * PSI_TO_MPA;
  const fcd = fck / 1.5;
  const fyd = fyk / 1.15;
  const fywd = fywk / 1.15;

  const allBars = [...rebar.topBars, ...rebar.botBars, ...(rebar.sideBars ?? [])];
  const As = allBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0) * IN2_TO_MM2;
  const barDesc = allBars.filter(g => g.numBars > 0)
    .map(g => `${g.numBars}−${formatBarLabel(g.barSize)}`).join(' + ');

  const NEd_kN = load.Pu * KIP_TO_KN;
  const NEd_N = NEd_kN * 1000;
  const e0 = Math.max(depth / 30, 20);
  const Mmin_kNm = NEd_kN * e0 / 1000;
  const MEdx_kNm = Math.max(Math.abs(load.Mux ?? load.Mu_pos ?? 0) * KIPFT_TO_KNM, NEd_kN > 0 ? Mmin_kNm : 0);
  const MEdy_kNm = Math.abs(load.Muy ?? 0) * KIPFT_TO_KNM;
  const VEd_kN = load.Vu * KIP_TO_KN;

  const sections: CalcSection[] = [];

  // ── 1. Design values ──
  sections.push({
    title: '1. Design Values (§2.4, §3.1)',
    steps: [
      { ref: '§3.1.6', label: 'Design compressive strength', equation: 'fcd = αcc·fck/γc', substitution: `1.0 × ${f(fck)} / 1.5`, result: `fcd = ${f(fcd)} MPa` },
      { ref: '§3.2.7', label: 'Design steel strength', equation: 'fyd = fyk/γs', substitution: `${f(fyk, 0)} / 1.15`, result: `fyd = ${f(fyd, 0)} MPa` },
      { ref: 'Input', label: 'Gross section', equation: isCircular ? 'Ac = πD²/4' : 'Ac = b·h', substitution: isCircular ? `π × ${f(D, 0)}²/4` : `${f(b, 0)} × ${f(h, 0)}`, result: `Ac = ${f(Ac / 1e3, 0)}×10³ mm²` },
      { ref: 'Input', label: 'Longitudinal steel', equation: 'As = Σn·Ab', substitution: barDesc, result: `As = ${f(As, 0)} mm² (ρ = ${f(As / Ac * 100, 2)}%)` },
      { ref: '§6.1(4)', label: 'Minimum eccentricity', equation: 'e₀ = max(h/30, 20mm)', substitution: `max(${f(depth, 0)}/30, 20)`, result: `e₀ = ${f(e0, 0)} mm → MEd,min = ${f(Mmin_kNm)} kN·m` },
    ],
  });

  // ── 2. Axial capacity ──
  const curveX = ec2InteractionCurve(section, material, rebar);
  const NRdMax_kips = Math.max(...curveX.map(p => p.phiPn));
  const NRdMax_kN = NRdMax_kips * KIP_TO_KN;
  const DCR_axial = NRdMax_kN > 0 ? NEd_kN / NRdMax_kN : 0;

  sections.push({
    title: '2. Axial Resistance',
    steps: [
      {
        ref: '§6.1', label: 'Maximum axial resistance',
        equation: 'NRd,max = fcd(Ac − As) + As·fyd',
        substitution: `${f(fcd)}×(${f(Ac / 1e3, 0)}×10³−${f(As, 0)}) + ${f(As, 0)}×${f(fyd, 0)}`,
        result: `NRd,max = ${f(NRdMax_kN, 0)} kN`,
      },
      {
        ref: 'Design check', label: 'DCR — Axial',
        equation: 'DCR = NEd / NRd,max',
        substitution: `${f(NEd_kN, 0)} / ${f(NRdMax_kN, 0)}`,
        result: `DCR = ${f(DCR_axial, 3)} ${DCR_axial <= 1 ? '✓' : '✗'}`,
      },
    ],
  });

  // ── 3. N-M interaction & biaxial ──
  const curveY = !isCircular && MEdy_kNm > 0.5
    ? ec2InteractionCurve(section, material, rebar, 40, true)
    : null;
  const MRdx_kNm = ec2MomentAtAxial(curveX, load.Pu) * KIPFT_TO_KNM;
  const MRdy_kNm = curveY ? ec2MomentAtAxial(curveY, load.Pu) * KIPFT_TO_KNM : MRdx_kNm;

  const biaxSteps: CalcSection['steps'] = [
    {
      ref: '§6.1', label: 'Method',
      equation: 'Strain compatibility, εcu2 = 0.0035; λ·η stress block; sweep x',
      substitution: isCircular ? 'Circular-segment compression block' : 'Rectangular block',
      result: 'N-M curve generated',
    },
    {
      ref: '—', label: 'Moment resistance at NEd (about x)',
      equation: 'MRdx = MRd(NEd)',
      substitution: `NEd = ${f(NEd_kN, 0)} kN`,
      result: `MRdx = ${f(MRdx_kNm)} kN·m`,
    },
  ];

  let DCR_PM: number;
  if (isCircular) {
    const Mres = Math.hypot(MEdx_kNm, MEdy_kNm);
    DCR_PM = MRdx_kNm > 0 ? Mres / MRdx_kNm : (Mres > 0 ? Infinity : 0);
    biaxSteps.push({
      ref: '—', label: 'Resultant moment (polar symmetry)',
      equation: 'MEd = √(MEdx² + MEdy²)',
      substitution: `√(${f(MEdx_kNm)}² + ${f(MEdy_kNm)}²)`,
      result: `MEd = ${f(Mres)} kN·m`,
    });
  } else if (MEdy_kNm < 0.5) {
    DCR_PM = MRdx_kNm > 0 ? MEdx_kNm / MRdx_kNm : (MEdx_kNm > 0 ? Infinity : 0);
  } else {
    const a = biaxialExponent(NRdMax_kN > 0 ? NEd_kN / NRdMax_kN : 0, false);
    const lhs = Math.pow(MEdx_kNm / MRdx_kNm, a) + Math.pow(MEdy_kNm / MRdy_kNm, a);
    DCR_PM = Math.pow(lhs, 1 / a);
    biaxSteps.push(
      {
        ref: '—', label: 'Moment resistance at NEd (about y)',
        equation: 'MRdy = MRd(NEd)',
        substitution: `NEd = ${f(NEd_kN, 0)} kN`,
        result: `MRdy = ${f(MRdy_kNm)} kN·m`,
      },
      {
        ref: '§5.8.9(4)', label: 'Biaxial exponent',
        equation: 'a interpolated on NEd/NRd: 0.1→1.0, 0.7→1.5, 1.0→2.0',
        substitution: `NEd/NRd = ${f(NEd_kN / NRdMax_kN, 3)}`,
        result: `a = ${f(a, 2)}`,
      },
      {
        ref: 'eq (5.39)', label: 'Biaxial interaction',
        equation: '(MEdx/MRdx)ᵃ + (MEdy/MRdy)ᵃ ≤ 1.0',
        substitution: `(${f(MEdx_kNm)}/${f(MRdx_kNm)})^${f(a, 2)} + (${f(MEdy_kNm)}/${f(MRdy_kNm)})^${f(a, 2)}`,
        result: `Σ = ${f(lhs, 3)} ${lhs <= 1 ? '✓' : '✗'}`,
      },
    );
  }

  biaxSteps.push({
    ref: 'Design check', label: 'DCR — N-M interaction',
    equation: 'DCR (1.0 = at capacity)',
    substitution: `MEdx = ${f(MEdx_kNm)}, MEdy = ${f(MEdy_kNm)} kN·m`,
    result: `DCR = ${f(DCR_PM, 3)} ${DCR_PM <= 1 ? '✓' : '✗'}`,
  });

  sections.push({ title: '3. N-M Interaction (§6.1, §5.8.9)', steps: biaxSteps });

  // ── 4. Shear ──
  const bw = isCircular ? D : b;
  const d = 0.8 * depth;
  const z = 0.9 * d;
  const cotT = 2.5;
  const sigma_cp = Ac > 0 ? Math.min(NEd_N / Ac, 0.2 * fcd) : 0;
  const VRdc_kN = vRdc(bw, d, As / 2, fck, NEd_N, Ac);
  let VRds_kN = 0, VRdmax_kN = 0;
  if (rebar.ties) {
    const Asw = rebar.ties.legs * getBarArea(rebar.ties.barSize) * IN2_TO_MM2;
    const s_mm = rebar.ties.spacing * IN_TO_MM;
    VRds_kN = vRds(Asw, s_mm, z, fywd, cotT);
    VRdmax_kN = vRdMax(bw, z, fck, fcd, cotT);
  }
  const VRd_kN = rebar.ties ? Math.min(VRds_kN, VRdmax_kN) : VRdc_kN;
  const DCR_shear = VRd_kN > 0 ? VEd_kN / VRd_kN : 0;

  const shearSteps: CalcSection['steps'] = [
    {
      ref: '§6.2.2', label: 'Axial stress contribution',
      equation: 'σcp = NEd/Ac ≤ 0.2fcd',
      substitution: `${f(NEd_N / 1e3, 0)}×10³ / ${f(Ac / 1e3, 0)}×10³`,
      result: `σcp = ${f(sigma_cp, 2)} MPa`,
    },
    {
      ref: '§6.2.2', label: 'Resistance without links',
      equation: 'V_Rd,c = [CRd,c·k(100ρl·fck)^⅓ + 0.15σcp]·bw·d',
      substitution: `bw = ${f(bw, 0)}, d = 0.8×${f(depth, 0)} = ${f(d, 0)} mm`,
      result: `V_Rd,c = ${f(VRdc_kN)} kN`,
    },
  ];
  if (rebar.ties) {
    shearSteps.push(
      {
        ref: '§6.2.3', label: 'Link resistance',
        equation: 'V_Rd,s = (Asw/s)·z·fywd·cotθ',
        substitution: `cotθ = 2.5`,
        result: `V_Rd,s = ${f(VRds_kN)} kN`,
      },
      {
        ref: '§6.2.3', label: 'Strut crushing limit',
        equation: 'V_Rd,max',
        substitution: `ν1 = ${f(0.6 * (1 - fck / 250), 3)}`,
        result: `V_Rd,max = ${f(VRdmax_kN)} kN`,
      },
    );
  }
  shearSteps.push({
    ref: 'Design check', label: 'DCR — Shear',
    equation: 'DCR = V_Ed / V_Rd',
    substitution: `${f(VEd_kN)} / ${f(VRd_kN)}`,
    result: `DCR = ${f(DCR_shear, 3)} ${DCR_shear <= 1 ? '✓' : '✗'}`,
  });
  sections.push({ title: '4. Shear (§6.2)', steps: shearSteps });

  // ── 5. Detailing §9.5 ──
  const AsMin = Math.max(0.10 * Math.max(NEd_N, 0) / fyd, 0.002 * Ac);
  const AsMax = 0.04 * Ac;
  const nBars = allBars.reduce((s, g) => s + g.numBars, 0);
  const minLongD = Math.min(...allBars.map(g => getBarDiam(g.barSize) * IN_TO_MM), Infinity);

  const detailSteps: CalcSection['steps'] = [
    {
      ref: '§9.5.2(2)', label: 'Minimum longitudinal steel',
      equation: 'As,min = max(0.10·NEd/fyd, 0.002Ac)',
      substitution: `max(0.10×${f(Math.max(NEd_N, 0) / 1e3, 0)}×10³/${f(fyd, 0)}, 0.002×${f(Ac / 1e3, 0)}×10³)`,
      result: `As,min = ${f(AsMin, 0)} mm² ${As >= AsMin ? '✓' : '✗'}`,
    },
    {
      ref: '§9.5.2(3)', label: 'Maximum steel',
      equation: 'As,max = 0.04Ac',
      substitution: `0.04 × ${f(Ac / 1e3, 0)}×10³`,
      result: `As,max = ${f(AsMax, 0)} mm² ${As <= AsMax ? '✓' : '✗'}`,
    },
    {
      ref: '§9.5.2(4)', label: 'Minimum bar count',
      equation: '≥ 4 bars',
      substitution: `${nBars} provided`,
      result: `${nBars} ≥ 4 ${nBars >= 4 ? '✓' : '✗'}`,
    },
  ];
  if (rebar.ties) {
    const leastDim = isCircular ? D : Math.min(b, h);
    const sMax = Math.min(20 * minLongD, leastDim, 400);
    const s_mm = rebar.ties.spacing * IN_TO_MM;
    detailSteps.push({
      ref: '§9.5.3(3)', label: 'Maximum transverse spacing',
      equation: 'scl,tmax = min(20Øbar,min, least dim, 400mm)',
      substitution: `min(20×${f(minLongD, 0)}, ${f(leastDim, 0)}, 400)`,
      result: `s = ${f(s_mm, 0)} mm vs ${f(sMax, 0)} mm ${s_mm <= sMax ? '✓' : '✗'}`,
    });
  }
  sections.push({ title: '5. Detailing (§9.5)', steps: detailSteps });

  return sections;
}
