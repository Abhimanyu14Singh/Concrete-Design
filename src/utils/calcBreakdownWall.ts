/**
 * ACI 318-25 Shear Wall Calculation Breakdown
 * Generates step-by-step calculation sheets for display in CalcBreakdownModal
 */

import type { MaterialProps, SectionDimensions, WallRebarLayout, LoadCase } from '../types';
import {
  wallReinfRatios,
  checkMinReinf,
  checkWallSpacing,
  wallShear,
  wallInteractionCurve,
  wallCapacityOnRay,
  sbzTrigger,
  sbzDesign,
} from './wallDesign';
import { getBarArea, getBarDiam } from './concreteDesign';

export interface CalcStep {
  ref: string;
  label: string;
  equation: string;
  substitution: string;
  result: string;
  note?: string;
}

export interface CalcSection {
  title: string;
  steps: CalcStep[];
}

export function generateWallBreakdown(
  section: SectionDimensions,
  material: MaterialProps,
  wallRebar: WallRebarLayout,
  load: LoadCase
): CalcSection[] {
  const lw = section.lw ?? section.b;
  const tw = section.tw ?? section.h;
  const hw = section.hw ?? (lw * 2);
  const { fc, fy, fyt, Es, lambdaConcrete } = material;
  const driftRatio = wallRebar.driftRatio ?? 0.015;
  const n = wallRebar.numCurtains;

  const ratios = wallReinfRatios(tw, wallRebar);
  const minReinf = checkMinReinf(ratios.rhoL, ratios.rhoT, hw, lw);
  const spacingCheck = checkWallSpacing(wallRebar.vertSpacing, wallRebar.horizSpacing, lw, tw);
  const shearResult = wallShear(lw, tw, hw, fc, lambdaConcrete, ratios.rhoT, fyt, load.Vu);
  const curve = wallInteractionCurve(lw, tw, fc, fy, Es, wallRebar);
  const Mu = Math.abs(load.Mu_pos > 0 ? load.Mu_pos : load.Mu_neg);
  const { phiMn, dcr: dcr_PM, c: c_demand } = wallCapacityOnRay(curve, load.Pu, Mu);
  const sbz = sbzTrigger(lw, tw, hw, fc, c_demand, driftRatio, load.Pu, Mu);

  const Av_vert = n * getBarArea(wallRebar.vertBarSize);
  const Ah_horiz = n * getBarArea(wallRebar.horizBarSize);

  const sections: CalcSection[] = [];

  // ── Section 1: Wall Properties ────────────────────────────────────────────
  sections.push({
    title: '1. Wall Geometry',
    steps: [
      {
        ref: 'ACI 318-25 §18.10',
        label: 'Wall Length',
        equation: 'lw',
        substitution: `${lw}"`,
        result: `${lw} in = ${(lw / 12).toFixed(2)} ft`,
      },
      {
        ref: 'ACI 318-25 §18.10',
        label: 'Wall Thickness',
        equation: 'tw',
        substitution: `${tw}"`,
        result: `${tw} in`,
      },
      {
        ref: 'ACI 318-25 §18.10',
        label: 'Wall Height',
        equation: 'hw',
        substitution: `${hw}"`,
        result: `${hw} in = ${(hw / 12).toFixed(2)} ft`,
      },
      {
        ref: '§18.10',
        label: 'hw/lw ratio',
        equation: 'hw / lw',
        substitution: `${hw} / ${lw}`,
        result: (hw / lw).toFixed(2),
        note: hw / lw <= 1.5 ? 'Squat wall: αc = 3.0' : hw / lw >= 2.0 ? 'Slender wall: αc = 2.0' : 'Intermediate: αc interpolated',
      },
      {
        ref: '§18.10.4',
        label: 'Shear area Acv',
        equation: 'Acv = lw × tw',
        substitution: `${lw} × ${tw}`,
        result: `${(lw * tw).toFixed(0)} in²`,
      },
      {
        ref: '§22.4.2',
        label: 'Gross area Ag',
        equation: 'Ag = lw × tw',
        substitution: `${lw} × ${tw}`,
        result: `${(lw * tw).toFixed(0)} in²`,
      },
    ],
  });

  // ── Section 2: Material Properties ───────────────────────────────────────
  sections.push({
    title: '2. Material Properties',
    steps: [
      {
        ref: 'ACI 318-25',
        label: "Concrete strength f'c",
        equation: "f'c",
        substitution: `${fc} psi`,
        result: `${(fc / 1000).toFixed(1)} ksi`,
      },
      {
        ref: 'ACI 318-25',
        label: 'Steel yield strength fy',
        equation: 'fy',
        substitution: `${fy} psi`,
        result: `${(fy / 1000).toFixed(0)} ksi`,
      },
      {
        ref: 'ACI 318-25',
        label: 'Transverse steel fyt',
        equation: 'fyt',
        substitution: `${fyt} psi`,
        result: `${(fyt / 1000).toFixed(0)} ksi`,
      },
      {
        ref: 'ACI 318-25 §19.2.4',
        label: 'Lightweight factor λ',
        equation: 'λ',
        substitution: `${lambdaConcrete}`,
        result: lambdaConcrete === 1.0 ? '1.0 (NW concrete)' : `${lambdaConcrete} (LW concrete)`,
      },
      {
        ref: 'ACI 318-25 §25.4.2.3',
        label: 'Stress block β₁',
        equation: 'β₁ = 0.85 − 0.05(f\'c−4000)/1000 ≥ 0.65',
        substitution: `0.85 − 0.05(${fc}−4000)/1000`,
        result: Math.max(0.65, 0.85 - 0.05 * (fc - 4000) / 1000).toFixed(3),
      },
    ],
  });

  // ── Section 3: Reinforcement Ratios ──────────────────────────────────────
  const Av_vert_one = getBarArea(wallRebar.vertBarSize);
  const Ah_horiz_one = getBarArea(wallRebar.horizBarSize);

  sections.push({
    title: '3. Reinforcement Ratios (§11.6)',
    steps: [
      {
        ref: '§11.6.1',
        label: 'Vertical bar area (per curtain)',
        equation: 'Av_vert',
        substitution: `#${wallRebar.vertBarSize} bar`,
        result: `${Av_vert_one.toFixed(3)} in² (${n} curtains = ${Av_vert.toFixed(3)} in²)`,
      },
      {
        ref: '§11.6.1',
        label: 'Horizontal bar area (per curtain)',
        equation: 'Ah_horiz',
        substitution: `#${wallRebar.horizBarSize} bar`,
        result: `${Ah_horiz_one.toFixed(3)} in² (${n} curtains = ${Ah_horiz.toFixed(3)} in²)`,
      },
      {
        ref: '§11.6.1',
        label: 'Vertical (longitudinal) ratio ρl',
        equation: 'ρl = (n·Av) / (sv·tw)',
        substitution: `(${n}×${Av_vert_one.toFixed(3)}) / (${wallRebar.vertSpacing}×${tw})`,
        result: `${(ratios.rhoL * 100).toFixed(4)}%`,
        note: `ρl_min = ${(minReinf.rhoL_min * 100).toFixed(4)}% → ${ratios.rhoL >= minReinf.rhoL_min ? '✓ OK' : '✗ NG'}`,
      },
      {
        ref: '§11.6.1',
        label: 'Horizontal (transverse) ratio ρt',
        equation: 'ρt = (n·Ah) / (sh·tw)',
        substitution: `(${n}×${Ah_horiz_one.toFixed(3)}) / (${wallRebar.horizSpacing}×${tw})`,
        result: `${(ratios.rhoT * 100).toFixed(4)}%`,
        note: `ρt_min = ${(minReinf.rhoT_min * 100).toFixed(4)}% → ${ratios.rhoT >= minReinf.rhoT_min ? '✓ OK' : '✗ NG'}`,
      },
    ],
  });

  // ── Section 4: Bar Spacing Checks ─────────────────────────────────────────
  const s_max = Math.min(lw / 5, 3 * tw, 18);
  sections.push({
    title: '4. Bar Spacing Checks (§18.10.2.2)',
    steps: [
      {
        ref: '§18.10.2.2',
        label: 'Maximum allowable spacing',
        equation: 's_max = min(lw/5, 3·tw, 18")',
        substitution: `min(${(lw/5).toFixed(2)}", ${(3*tw).toFixed(2)}", 18")`,
        result: `${s_max.toFixed(2)}"`,
      },
      {
        ref: '§18.10.2.2',
        label: 'Vertical bar spacing',
        equation: 'sv ≤ s_max',
        substitution: `${wallRebar.vertSpacing}" ≤ ${s_max.toFixed(2)}"`,
        result: spacingCheck.sVert_ok ? '✓ OK' : '✗ NG',
      },
      {
        ref: '§18.10.2.2',
        label: 'Horizontal bar spacing',
        equation: 'sh ≤ s_max',
        substitution: `${wallRebar.horizSpacing}" ≤ ${s_max.toFixed(2)}"`,
        result: spacingCheck.sHoriz_ok ? '✓ OK' : '✗ NG',
      },
    ],
  });

  // ── Section 5: In-Plane Shear §18.10.4 ───────────────────────────────────
  sections.push({
    title: '5. In-Plane Shear Strength (§18.10.4)',
    steps: [
      {
        ref: '§18.10.4.3',
        label: 'αc coefficient',
        equation: 'αc: 3.0 (hw/lw ≤ 1.5), 2.0 (hw/lw ≥ 2.0), interpolate',
        substitution: `hw/lw = ${(hw/lw).toFixed(2)}`,
        result: shearResult.alphaC.toFixed(2),
      },
      {
        ref: '§18.10.4.1',
        label: 'Nominal shear strength Vn',
        equation: 'Vn = Acv · (αc·λ·√f\'c + ρt·fyt)',
        substitution: `${(lw*tw).toFixed(0)}·(${shearResult.alphaC.toFixed(2)}×${lambdaConcrete}×√${fc} + ${(ratios.rhoT*100).toFixed(4)}%×${fyt})`,
        result: `${shearResult.Vn.toFixed(1)} kips${shearResult.governedByMax ? ' → governed by max' : ''}`,
      },
      {
        ref: '§18.10.4.4',
        label: 'Maximum Vn limit',
        equation: 'Vn_max = 10·Acv·λ·√f\'c',
        substitution: `10×${(lw*tw).toFixed(0)}×${lambdaConcrete}×√${fc}`,
        result: `${shearResult.Vn_max.toFixed(1)} kips`,
      },
      {
        ref: '§21.2.1',
        label: 'Design shear strength φVn',
        equation: 'φVn = 0.75·Vn',
        substitution: `0.75 × ${shearResult.Vn.toFixed(1)}`,
        result: `${shearResult.phi_Vn.toFixed(1)} kips`,
      },
      {
        ref: '§18.10.4',
        label: 'Shear DCR',
        equation: 'DCR = Vu / φVn',
        substitution: `${load.Vu.toFixed(1)} / ${shearResult.phi_Vn.toFixed(1)}`,
        result: `${shearResult.DCR.toFixed(3)} ${shearResult.DCR <= 1 ? '✓ OK' : '✗ NG'}`,
      },
    ],
  });

  // ── Section 6: P-M Interaction §18.10.5 ──────────────────────────────────
  sections.push({
    title: '6. Flexure + Axial (P-M Interaction) (§18.10.5)',
    steps: [
      {
        ref: '§18.10.5',
        label: 'Method',
        equation: 'Strain compatibility, rectangular stress block, ACI §22.2',
        substitution: `εcu = 0.003, β₁ = ${Math.max(0.65, 0.85 - 0.05*(fc-4000)/1000).toFixed(3)}`,
        result: 'Wall section with distributed + boundary steel',
      },
      {
        ref: '§18.10.5',
        label: 'Applied axial demand Pu',
        equation: 'Pu',
        substitution: `${load.Pu.toFixed(1)} kips (compression +)`,
        result: `${load.Pu.toFixed(1)} kips`,
      },
      {
        ref: '§18.10.5',
        label: 'Applied moment demand Mu',
        equation: 'Mu',
        substitution: `${Mu.toFixed(1)} kip-ft`,
        result: `${Mu.toFixed(1)} kip-ft`,
      },
      {
        ref: '§18.10.5',
        label: 'Neutral axis depth c (at demand)',
        equation: 'c from interaction curve at (Pu, Mu)',
        substitution: `Pu=${load.Pu.toFixed(1)} kips, Mu=${Mu.toFixed(1)} kip-ft`,
        result: `${c_demand.toFixed(2)}"`,
      },
      {
        ref: '§18.10.5',
        label: 'φMn capacity at Pu',
        equation: 'φMn (from P-M curve)',
        substitution: `at Pu = ${load.Pu.toFixed(1)} kips`,
        result: `${phiMn.toFixed(1)} kip-ft`,
      },
      {
        ref: '§18.10.5',
        label: 'P-M DCR',
        equation: 'DCR = demand length / capacity length on interaction curve',
        substitution: `√(Pu²+Mu²) / √(φPn²+φMn²)`,
        result: `${dcr_PM.toFixed(3)} ${dcr_PM <= 1 ? '✓ OK' : '✗ NG'}`,
      },
    ],
  });

  // ── Section 7: SBZ Trigger §18.10.6 ──────────────────────────────────────
  sections.push({
    title: '7. Special Boundary Zone (SBZ) Trigger Check (§18.10.6)',
    steps: [
      {
        ref: '§18.10.6.2',
        label: 'Strain-based SBZ limit (c_limit)',
        equation: 'c_limit = lw / (600 × 1.5 × δu/hw)',
        substitution: `${lw} / (900 × ${driftRatio})`,
        result: `${sbz.c_limit_strain.toFixed(2)}"`,
        note: `Design drift ratio δu/hw = ${driftRatio}`,
      },
      {
        ref: '§18.10.6.2',
        label: 'Strain trigger check',
        equation: 'SBZ required if c > c_limit',
        substitution: `c = ${c_demand.toFixed(2)}" ${sbz.strainTriggered ? '>' : '≤'} c_limit = ${sbz.c_limit_strain.toFixed(2)}"`,
        result: sbz.strainTriggered ? '⚠ SBZ Required (strain)' : '✓ Not triggered by strain',
      },
      {
        ref: '§18.10.6.3',
        label: 'Extreme fiber stress σmax',
        equation: 'σmax = Pu/Ag + Mu·(lw/2) / (0.7·Ig)',
        substitution: `${load.Pu.toFixed(1)}k×1000/${(lw*tw).toFixed(0)} + ${Mu.toFixed(1)}k-ft×12000×${(lw/2).toFixed(1)}/(0.7×${(tw*lw**3/12).toFixed(0)})`,
        result: `${(sbz.sigma_max / 1000).toFixed(4)} ksi`,
      },
      {
        ref: '§18.10.6.3',
        label: 'Stress trigger check',
        equation: 'SBZ required if σmax > 0.2·f\'c',
        substitution: `${(sbz.sigma_max / 1000).toFixed(4)} ksi ${sbz.stressTriggered ? '>' : '≤'} 0.2×${(fc/1000).toFixed(1)} ksi = ${(sbz.sigma_limit/1000).toFixed(4)} ksi`,
        result: sbz.stressTriggered ? '⚠ SBZ Required (stress)' : '✓ Not triggered by stress',
      },
      {
        ref: '§18.10.6',
        label: 'SBZ Conclusion',
        equation: 'SBZ required if strain OR stress triggered',
        substitution: `trigger = ${sbz.triggerType}`,
        result: sbz.required ? `⚠ SBZ REQUIRED (${sbz.triggerType})` : '✓ SBZ Not Required',
      },
    ],
  });

  // ── Section 8: SBZ Confinement §18.10.6.4 ────────────────────────────────
  if (sbz.required) {
    const sbzResult = sbzDesign(lw, tw, fc, fyt, c_demand, wallRebar);
    const db_long = getBarDiam(wallRebar.sbzBarSize ?? wallRebar.vertBarSize);

    sections.push({
      title: '8. SBZ Confinement Design (§18.10.6.4)',
      steps: [
        {
          ref: '§18.10.6.4(a)',
          label: 'SBZ length lbe (each end)',
          equation: 'lbe ≥ max(c − 0.1·lw, c/2)',
          substitution: `max(${c_demand.toFixed(2)} − 0.1×${lw}, ${c_demand.toFixed(2)}/2)`,
          result: `${sbzResult.lbe.toFixed(2)}"`,
        },
        {
          ref: '§18.10.6.4(e)',
          label: 'Max SBZ tie spacing s_max',
          equation: 's_max = min(6·db_long, 6")',
          substitution: `min(6×${db_long.toFixed(3)}", 6") = min(${(6*db_long).toFixed(2)}", 6")`,
          result: `${sbzResult.s_max_sbz.toFixed(2)}" ${sbzResult.spacingOK ? '✓' : '✗'}`,
          note: `Provided s = ${(wallRebar.sbzTieSpacing ?? 4).toFixed(2)}"`,
        },
        {
          ref: '§18.10.6.4(f)',
          label: 'Ash_req option 1: 0.3·(Ag/Ach−1)·f\'c/fyt × bc·s',
          equation: 'Ash_1 = 0.3·(Ag/Ach−1)·f\'c/fyt·bc·s',
          substitution: `0.3×(${sbzResult.Ach > 0 ? (sbzResult.lbe * tw / sbzResult.Ach).toFixed(3) : '?'}−1)×${fc}/${fyt}×${sbzResult.bc.toFixed(2)}×${(wallRebar.sbzTieSpacing ?? 4)}`,
          result: `${sbzResult.Ash_req_1.toFixed(3)} in²`,
        },
        {
          ref: '§18.10.6.4(f)',
          label: 'Ash_req option 2: 0.09·f\'c/fyt × bc·s',
          equation: 'Ash_2 = 0.09·f\'c/fyt·bc·s',
          substitution: `0.09×${fc}/${fyt}×${sbzResult.bc.toFixed(2)}×${(wallRebar.sbzTieSpacing ?? 4)}`,
          result: `${sbzResult.Ash_req_2.toFixed(3)} in²`,
        },
        {
          ref: '§18.10.6.4(f)',
          label: 'Ash_req governing',
          equation: 'Ash_req = max(Ash_1, Ash_2)',
          substitution: `max(${sbzResult.Ash_req_1.toFixed(3)}, ${sbzResult.Ash_req_2.toFixed(3)})`,
          result: `${sbzResult.Ash_req.toFixed(3)} in²`,
        },
        {
          ref: '§18.10.6.4',
          label: 'Ash provided',
          equation: `Ash_prov = ${wallRebar.sbzTieLegs ?? 4} legs × A_tie`,
          substitution: `${wallRebar.sbzTieLegs ?? 4} × ${getBarArea(wallRebar.sbzTieBarSize ?? 4).toFixed(3)} in² per leg`,
          result: `${sbzResult.Ash_prov.toFixed(3)} in² ${sbzResult.AshOK ? '✓ OK' : '✗ NG'}`,
        },
        {
          ref: '§18.10.6.4',
          label: 'Ash DCR',
          equation: 'DCR = Ash_req / Ash_prov',
          substitution: `${sbzResult.Ash_req.toFixed(3)} / ${sbzResult.Ash_prov.toFixed(3)}`,
          result: `${(sbzResult.Ash_req / sbzResult.Ash_prov).toFixed(3)} ${sbzResult.AshOK ? '✓ OK' : '✗ NG'}`,
        },
      ],
    });
  }

  return sections;
}
