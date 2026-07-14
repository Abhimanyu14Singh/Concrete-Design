/**
 * Step-by-step ACI 318-19 column calculation sheet (short column, biaxial).
 * Mirrors the CalcSection/CalcStep shapes so CalcBreakdownModal renders it.
 */

import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase } from '../types';
import type { CalcSection } from './calcBreakdown';
import { getBarArea, getBarDiam, beta1 } from './concreteDesign';
import { formatBarLabel } from './rebar';
import { grossArea } from '../engines/column/sectionModel';
import {
  aciInteractionCurve, aciBiaxialCheck, aciColumnShear, capacityOnRay,
  momentAtAxial, totalAst,
} from '../engines/aci/aciColumn';
import { spliceLengthIn } from './spliceLength';

function f(n: number, dec = 1): string { return n.toFixed(dec); }

export function generateColumnBreakdown(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
): CalcSection[] {
  const { fc, fy, Es } = material;
  const isCircular = section.type === 'circular_column';
  const D = section.diameter ?? section.b;
  const b = section.b, h = section.h ?? section.b;
  const Ag = grossArea(isCircular, b, h, D);
  const Ast = totalAst(rebar);
  const rho = Ast / Ag;
  const spiral = rebar.tieType === 'spiral';
  const b1 = beta1(fc);

  const Pu = load.Pu;
  const Mux = load.Mux ?? load.Mu_pos ?? 0;
  const Muy = load.Muy ?? 0;

  const allBars = [...rebar.topBars, ...rebar.botBars, ...(rebar.sideBars ?? [])];
  const barDesc = allBars.filter(g => g.numBars > 0)
    .map(g => `${g.numBars}−${formatBarLabel(g.barSize)}`).join(' + ');

  const sections: CalcSection[] = [];

  // ── 1. Geometry & reinforcement ──
  sections.push({
    title: '1. Section & Reinforcement',
    steps: [
      {
        ref: 'Input', label: 'Gross section area',
        equation: isCircular ? 'Ag = πD²/4' : 'Ag = b × h',
        substitution: isCircular ? `π × ${D}²/4` : `${b} × ${h}`,
        result: `Ag = ${f(Ag)} in²`,
      },
      {
        ref: 'Input', label: 'Longitudinal reinforcement',
        equation: 'Ast = Σ n·Ab',
        substitution: barDesc,
        result: `Ast = ${f(Ast, 2)} in²`,
      },
      {
        ref: 'ACI §10.6.1.1', label: 'Reinforcement ratio',
        equation: '0.01 ≤ ρg = Ast/Ag ≤ 0.08',
        substitution: `${f(Ast, 2)} / ${f(Ag)}`,
        result: `ρg = ${f(rho * 100, 2)}% ${rho >= 0.01 && rho <= 0.08 ? '✓' : '✗'}`,
      },
      {
        ref: 'ACI §22.2.2.4.3', label: 'Stress block factor',
        equation: 'β₁',
        substitution: `f'c = ${fc} psi`,
        result: `β₁ = ${f(b1, 3)}`,
      },
    ],
  });

  // ── 2. Axial capacity ──
  const Pn0 = (0.85 * fc * (Ag - Ast) + fy * Ast) / 1000;
  const rCap = spiral ? 0.85 : 0.80;
  const phiC = spiral ? 0.75 : 0.65;
  const phiPnMax = phiC * rCap * Pn0;
  const DCR_axial = phiPnMax > 0 ? Pu / phiPnMax : 0;

  sections.push({
    title: '2. Axial Capacity (§22.4.2)',
    steps: [
      {
        ref: 'ACI §22.4.2.2', label: 'Nominal axial strength P₀',
        equation: 'P₀ = 0.85f\'c(Ag − Ast) + fy·Ast',
        substitution: `0.85×${fc}×(${f(Ag)}−${f(Ast, 2)}) + ${fy}×${f(Ast, 2)}`,
        result: `P₀ = ${f(Pn0)} kips`,
      },
      {
        ref: 'ACI §22.4.2.1', label: `Maximum axial (${spiral ? 'spiral' : 'tied'})`,
        equation: `Pn,max = ${rCap}·P₀`,
        substitution: `${rCap} × ${f(Pn0)}`,
        result: `Pn,max = ${f(rCap * Pn0)} kips`,
      },
      {
        ref: 'ACI Table 21.2.2', label: 'Design axial capacity',
        equation: `φPn,max = ${phiC}·Pn,max`,
        substitution: `${phiC} × ${f(rCap * Pn0)}`,
        result: `φPn,max = ${f(phiPnMax)} kips`,
      },
      {
        ref: 'Design check', label: 'DCR — Axial',
        equation: 'DCR = Pu / φPn,max',
        substitution: `${Pu} / ${f(phiPnMax)}`,
        result: `DCR = ${f(DCR_axial, 3)} ${DCR_axial <= 1 ? '✓' : '✗'}`,
      },
    ],
  });

  // ── 3. P-M interaction ──
  const curveX = aciInteractionCurve(section, material, rebar);
  const curveY = !isCircular && Math.abs(Muy) > 0.5
    ? aciInteractionCurve(section, material, rebar, 40, true)
    : null;
  const phiMnAtPu = momentAtAxial(curveX, Pu);
  const M0 = momentAtAxial(curveX, 0);

  // Balanced point: max φMn region — find curve point with eps_t closest to fy/Es
  const eps_ty = fy / Es;
  const bal = curveX.reduce((best, p) =>
    Math.abs(p.eps_t - eps_ty) < Math.abs(best.eps_t - eps_ty) ? p : best, curveX[1]);

  sections.push({
    title: '3. P-M Interaction (§22.4, strain compatibility)',
    steps: [
      {
        ref: 'ACI §22.2', label: 'Method',
        equation: 'Plane sections, εcu = 0.003; sweep neutral axis c',
        substitution: `${curveX.length} points; ${isCircular ? 'circular segment compression block' : 'rectangular block a = β₁c'}`,
        result: `Curve generated`,
      },
      {
        ref: '—', label: 'Pure bending capacity (P = 0)',
        equation: 'φMn at φPn = 0',
        substitution: 'Interpolated on the curve',
        result: `φMn₀ = ${f(M0)} kip-ft`,
      },
      {
        ref: '—', label: 'Balanced point (εt = εty)',
        equation: 'cb = d·εcu/(εcu + εty)',
        substitution: `εty = fy/Es = ${f(eps_ty, 5)}`,
        result: `Pb ≈ ${f(bal.phiPn)} kips, Mb ≈ ${f(bal.phiMn)} kip-ft`,
      },
      {
        ref: '—', label: 'Moment capacity at applied Pu',
        equation: 'φMn(Pu)',
        substitution: `Pu = ${Pu} kips`,
        result: `φMn = ${f(phiMnAtPu)} kip-ft`,
      },
    ],
  });

  // ── 4. Biaxial check ──
  const biax = aciBiaxialCheck(curveX, curveY, Pu, Mux, Muy, isCircular);
  const biaxSteps: CalcSection['steps'] = [];

  if (isCircular) {
    const Mres = Math.hypot(Mux, Muy);
    biaxSteps.push({
      ref: '—', label: 'Resultant moment (circular — polar symmetry)',
      equation: 'Mu = √(Mux² + Muy²)',
      substitution: `√(${Mux}² + ${Muy}²)`,
      result: `Mu = ${f(Mres)} kip-ft`,
    });
  } else if (biax.method === 'bresler') {
    biaxSteps.push(
      {
        ref: '—', label: 'Uniaxial capacities along each load ray',
        equation: 'φPnx (with ey), φPny (with ex), φPn₀',
        substitution: `Mux = ${Mux}, Muy = ${Muy} kip-ft`,
        result: `φPnx = ${f(biax.phiPnx)}, φPny = ${f(biax.phiPny)}, φPn₀ = ${f(biax.phiPn0)} kips`,
      },
      {
        ref: 'Bresler', label: 'Reciprocal load equation',
        equation: '1/φPn = 1/φPnx + 1/φPny − 1/φPn₀',
        substitution: `1/${f(biax.phiPnx)} + 1/${f(biax.phiPny)} − 1/${f(biax.phiPn0)}`,
        result: `φPn = ${f(Pu / biax.DCR_PM)} kips`,
      },
    );
  } else if (biax.method === 'contour') {
    biaxSteps.push({
      ref: '—', label: 'Low axial (Pu < 0.1φPn₀) — SRSS moment contour',
      equation: 'DCR = √((Mux/φMnx)² + (Muy/φMny)²)',
      substitution: `φMnx = ${f(biax.phiMnx)}, φMny = ${f(biax.phiMny)} kip-ft`,
      result: `Bresler not valid at low axial`,
    });
  }

  biaxSteps.push({
    ref: 'Design check', label: `DCR — P-M interaction (${biax.method})`,
    equation: 'DCR ≤ 1.0',
    substitution: `Pu = ${Pu} kips, Mux = ${Mux}, Muy = ${Muy} kip-ft`,
    result: `DCR = ${f(biax.DCR_PM, 3)} ${biax.DCR_PM <= 1 ? '✓' : '✗'}`,
  });

  sections.push({ title: '4. Biaxial Bending Check', steps: biaxSteps });

  // ── 5. Shear ──
  const shear = aciColumnShear(section, material, rebar, load.Vu, Pu);
  const dShear = 0.8 * (isCircular ? D : h);
  sections.push({
    title: '5. Shear (§22.5)',
    steps: [
      {
        ref: 'ACI §22.5.2.2', label: 'Effective shear depth',
        equation: isCircular ? 'd = 0.8D' : 'd = 0.8h',
        substitution: `0.8 × ${isCircular ? D : h}`,
        result: `d = ${f(dShear)} in`,
      },
      {
        ref: 'ACI Table 22.5.5.1', label: 'Concrete shear with axial compression',
        equation: 'Vc = 2λ√f\'c·(1 + Nu/(2000Ag))·bw·d',
        substitution: `2×1×√${fc}×(1 + ${f(Math.max(Pu, 0) * 1000)}/(2000×${f(Ag)}))×${f(isCircular ? D : b)}×${f(dShear)}`,
        result: `Vc = ${f(shear.Vc)} kips`,
      },
      {
        ref: 'ACI §22.5.8.5', label: 'Tie shear contribution',
        equation: 'Vs = Av·fyt·d/s',
        substitution: rebar.ties
          ? `${rebar.ties.legs}×${f(getBarArea(rebar.ties.barSize), 2)}×${material.fyt}×${f(dShear)}/(${rebar.ties.spacing}×1000)`
          : 'No ties',
        result: `Vs = ${f(shear.Vs)} kips`,
      },
      {
        ref: 'Design check', label: 'DCR — Shear',
        equation: 'DCR = Vu / φ(Vc + Vs), φ = 0.75',
        substitution: `${load.Vu} / ${f(shear.phi_Vn)}`,
        result: `DCR = ${f(shear.DCR_shear, 3)} ${shear.DCR_shear <= 1 ? '✓' : '✗'}`,
      },
    ],
  });

  // ── 6. Detailing ──
  const maxLongD = Math.max(...allBars.map(g => getBarDiam(g.barSize)), 0);
  const nBars = allBars.reduce((s, g) => s + g.numBars, 0);
  const minBars = spiral ? 6 : 4;
  const detailSteps: CalcSection['steps'] = [
    {
      ref: 'ACI §10.7.3.1', label: 'Minimum bar count',
      equation: spiral ? '≥ 6 bars (spiral)' : '≥ 4 bars (tied)',
      substitution: `${nBars} bars provided`,
      result: `${nBars} ≥ ${minBars} ${nBars >= minBars ? '✓' : '✗'}`,
    },
  ];
  if (rebar.ties) {
    const tieD = getBarDiam(rebar.ties.barSize);
    const leastDim = isCircular ? D : Math.min(b, h);
    const sMax = Math.min(16 * maxLongD, 48 * tieD, leastDim);
    detailSteps.push({
      ref: 'ACI §25.7.2.1', label: 'Maximum tie spacing',
      equation: 's ≤ min(16db, 48dt, least dim)',
      substitution: `min(16×${f(maxLongD, 2)}, 48×${f(tieD, 2)}, ${f(leastDim)})`,
      result: `s = ${rebar.ties.spacing}" vs s_max = ${f(sMax)}" ${rebar.ties.spacing <= sMax ? '✓' : '✗'}`,
    });
  }
  // Compression lap splice for the governing (largest) longitudinal bar — columns
  // are compression members, so the §25.5.5.1 compression lap governs.
  const maxLongBar = allBars.filter(g => g.numBars > 0)
    .reduce((m, g) => getBarDiam(g.barSize) > getBarDiam(m) ? g.barSize : m, allBars[0]?.barSize ?? 8);
  const lsc = spliceLengthIn({ barSize: maxLongBar, spliceType: 'Compression', fcPsi: fc, fyPsi: fy, coverIn: section.coverClear, tieBarSize: rebar.ties?.barSize ?? section.stirrupDia });
  if (lsc != null) {
    detailSteps.push({
      ref: 'ACI §25.5.5.1', label: 'Compression lap splice',
      equation: fy <= 60000 ? 'l_sc = 0.0005·fy·db ≥ 12"' : 'l_sc = (0.0009·fy − 24)·db ≥ 12"',
      substitution: `${formatBarLabel(maxLongBar)}, fy = ${f(fy / 1000, 0)} ksi${fc < 3000 ? ", ×1.33 (f'c<3000)" : ''}`,
      result: `l_sc = ${f(lsc)} in (${f(lsc / getBarDiam(maxLongBar), 0)}·db)`,
    });
  }
  sections.push({ title: '6. Detailing (§10.7, §25.7)', steps: detailSteps });

  // sanity reference for capacityOnRay (used by engine; not displayed)
  void capacityOnRay;

  return sections;
}
