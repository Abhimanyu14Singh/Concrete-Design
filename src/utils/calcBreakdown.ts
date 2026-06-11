/**
 * Generates a step-by-step ACI 318-19 calculation breakdown
 * as a structured array of steps with equation, substitution, and result.
 */
import { formatBarLabel } from './rebar';
import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase } from '../types';
import {
  getBarArea, getBarDiam,
  effectiveDepthMulti, layerCentroidOffset,
  computeFlexure, computeShear, computeTorsion, zonedShearCheck,
} from './concreteDesign';

export interface CalcStep {
  ref: string;       // ACI 318-19 section reference
  label: string;     // Short description
  equation: string;  // Symbolic equation
  substitution: string; // Numbers plugged in
  result: string;    // Computed value with units
  note?: string;     // Optional footnote
}

export interface CalcSection {
  title: string;
  steps: CalcStep[];
}

function fmt(n: number, dec = 2): string {
  return n.toFixed(dec);
}

function beta1(fc: number): number {
  if (fc <= 4000) return 0.85;
  return Math.max(0.65, 0.85 - 0.05 * (fc - 4000) / 1000);
}

function effectiveFlange(section: SectionDimensions, span: number): number {
  if (section.type === 'T_beam') {
    const bw = section.bw ?? section.b;
    return Math.min(
      bw + 2 * 8 * (section.hf ?? 4),
      span * 12 / 4,
      section.b
    );
  }
  if (section.type === 'L_beam') {
    const bw = section.bw ?? section.b;
    return Math.min(bw + 6 * (section.hf ?? 4), span * 12 / 12, section.b);
  }
  return section.b;
}

export function generateBreakdown(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  span = 20,
  zoneVu?: [number, number, number],  // max |V| per span third (station forces)
): CalcSection[] {
  const { fc, fy, fyt, lambdaConcrete } = material;
  const h = section.h ?? 12;
  const b = section.b;
  const bw = section.bw ?? b;
  const sClear = rebar.layerClearSpacing ?? 1.0;
  const d = effectiveDepthMulti(section, rebar.botBars, sClear);       // to bottom steel centroid
  const d_neg = effectiveDepthMulti(section, rebar.topBars, sClear);   // to top steel centroid
  const yBot = layerCentroidOffset(section, rebar.botBars, sClear);
  const botLayers = rebar.botBars.filter(g => g.numBars > 0).length;
  const b1 = beta1(fc);
  const beff = effectiveFlange(section, span);

  const As_top = rebar.topBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
  const As_bot = rebar.botBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
  const Av = rebar.ties ? rebar.ties.legs * getBarArea(rebar.ties.barSize) : 0;
  const sv = rebar.ties?.spacing ?? 0;

  const isT = section.type === 'T_beam' || section.type === 'L_beam';

  // ── Section properties ──────────────────────────────────────────────
  const sectionSteps: CalcStep[] = [
    {
      ref: 'ACI 318-19 §20.6.1',
      label: 'Clear cover',
      equation: 'cc = given',
      substitution: `cc = ${section.coverClear}"`,
      result: `${section.coverClear} in`,
    },
    {
      ref: 'ACI 318-19 §22.2.2',
      label: 'Effective depth (to bottom steel centroid)',
      equation: botLayers > 1 ? 'd = h − ȳs (area-weighted steel centroid)' : 'd = h − cc − d_stirrup − d_bar/2',
      substitution: botLayers > 1
        ? `ȳs = ${fmt(yBot)}" over ${botLayers} layers (clear layer spacing ${sClear}");  d = ${h} − ${fmt(yBot)}`
        : `d = ${h} − ${section.coverClear} − ${fmt(getBarDiam(section.stirrupDia))} − ${fmt(getBarDiam(rebar.botBars[0]?.barSize ?? 8) / 2)}`,
      result: `${fmt(d)} in`,
      note: botLayers > 1
        ? 'Multi-layer tension steel — d measured to the area-weighted centroid (same as results engine)'
        : `Outermost bottom bar ${formatBarLabel(rebar.botBars[0]?.barSize ?? 8)} — same as results engine`,
    },
    {
      ref: 'ACI 318-19 §22.2.2.4.3',
      label: 'β₁ factor (stress block)',
      equation: 'β₁ = 0.85 − 0.05(f\'c − 4000)/1000  [min 0.65]',
      substitution: fc <= 4000
        ? `f'c = ${fc} psi ≤ 4000 → β₁ = 0.85`
        : `β₁ = 0.85 − 0.05(${fc} − 4000)/1000 = ${fmt(b1, 3)}`,
      result: fmt(b1, 3),
    },
  ];

  if (isT) {
    sectionSteps.push({
      ref: 'ACI 318-19 §406.3.2.1',
      label: 'Effective flange width',
      equation: 'beff = min(bw + 16hf, L/4, b)',
      substitution: `min(${bw} + 16×${section.hf ?? 5}, ${span * 12}/4, ${b}) = min(${bw + 16 * (section.hf ?? 5)}, ${span * 3}, ${b})`,
      result: `${fmt(beff)} in`,
    });
  }

  // ── Material checks ──────────────────────────────────────────────────
  const materialSteps: CalcStep[] = [
    {
      ref: 'Input',
      label: 'Concrete compressive strength',
      equation: "f'c",
      substitution: `f'c = ${fc} psi`,
      result: `${fc / 1000} ksi`,
    },
    {
      ref: 'Input',
      label: 'Reinforcement yield strength',
      equation: 'fy',
      substitution: `fy = ${fy} psi`,
      result: `${fy / 1000} ksi`,
    },
    {
      ref: 'ACI 318-19 §26.4.1',
      label: 'Lambda (density factor)',
      equation: 'λ',
      substitution: `λ = ${lambdaConcrete}`,
      result: lambdaConcrete === 1.0 ? '1.0 (normal-weight)' : `${lambdaConcrete} (lightweight)`,
    },
    {
      ref: 'ACI 318-19 §21.2.1',
      label: 'Modulus of elasticity — steel',
      equation: 'Es = 29,000,000 psi',
      substitution: 'Per ACI 318-19',
      result: '29,000 ksi',
    },
  ];

  // ── Reinforcement ────────────────────────────────────────────────────
  const topBarDesc = rebar.topBars.map(g => `${g.numBars}−${formatBarLabel(g.barSize)}`).join(' + ');
  const botBarDesc = rebar.botBars.map(g => `${g.numBars}−${formatBarLabel(g.barSize)}`).join(' + ');

  const rebarSteps: CalcStep[] = [
    {
      ref: 'Input',
      label: 'Top (compression) reinforcement',
      equation: 'As\' = ΣnᵢAᵢ',
      substitution: rebar.topBars.map(g => `${g.numBars}×${getBarArea(g.barSize)}`).join(' + '),
      result: `${fmt(As_top)} in² (${topBarDesc})`,
    },
    {
      ref: 'Input',
      label: 'Bottom (tension) reinforcement',
      equation: 'As = ΣnᵢAᵢ',
      substitution: rebar.botBars.map(g => `${g.numBars}×${getBarArea(g.barSize)}`).join(' + '),
      result: `${fmt(As_bot)} in² (${botBarDesc})`,
    },
  ];

  if (botLayers > 1 || rebar.topBars.filter(g => g.numBars > 0).length > 1) {
    const allLayers = [...rebar.topBars, ...rebar.botBars].filter(g => g.numBars > 0);
    const dbMax = Math.max(...allLayers.map(g => getBarDiam(g.barSize)));
    const sReq = Math.max(1.0, dbMax);
    rebarSteps.push({
      ref: 'ACI 318-19 §25.2.2',
      label: 'Vertical clear spacing between bar layers',
      equation: 's_layer ≥ max(1", db)',
      substitution: `s_layer = ${sClear}"  vs  max(1", ${fmt(dbMax)}") = ${fmt(sReq)}"`,
      result: `${sClear} in  ${sClear >= sReq ? '✓ OK' : '⚠ NG'}`,
    });
  }

  if (rebar.ties) {
    rebarSteps.push({
      ref: 'Input',
      label: 'Shear reinforcement (stirrups/ties)',
      equation: 'Av = n_legs × A_bar',
      substitution: `${rebar.ties.legs} legs × ${getBarArea(rebar.ties.barSize)} in² @ ${sv}" spacing`,
      result: `Av = ${fmt(Av, 3)} in², s = ${sv}"`,
    });
  }

  // Steel limits
  const rho_min = Math.max(3 * Math.sqrt(fc) / fy, 200 / fy);
  const As_min = rho_min * bw * d;
  const As_max = 0.75 * b1 * (fc / fy) * (0.003 / (0.003 + 0.004)) * bw * d;

  rebarSteps.push(
    {
      ref: 'ACI 318-19 §9.6.1.2',
      label: 'Minimum flexural steel',
      equation: 'As,min = max(3√f\'c/fy, 200/fy) × bw × d',
      substitution: `max(3×√${fc}/${fy}, 200/${fy}) × ${fmt(bw)} × ${fmt(d)} = ${fmt(rho_min, 5)} × ${fmt(bw)} × ${fmt(d)}`,
      result: `${fmt(As_min)} in²`,
      note: As_bot < As_min ? '⚠ Provided As_bot < As_min' : '✓ As_bot ≥ As_min',
    },
    {
      ref: 'ACI 318-19 §9.3.3.1',
      label: 'Maximum flexural steel (net strain εt ≥ 0.004)',
      equation: 'As,max = 0.75β₁(f\'c/fy)(0.003/(0.003+0.004)) × bw × d',
      substitution: `0.75 × ${fmt(b1)} × (${fc}/${fy}) × (3/7) × ${fmt(bw)} × ${fmt(d)}`,
      result: `${fmt(As_max)} in²`,
      note: As_bot > As_max ? '⚠ Provided As_bot > As_max (over-reinforced!)' : '✓ As_bot ≤ As_max',
    }
  );

  // ── Flexure — engine call (identical numbers to the results screen) ──
  const flex = computeFlexure(section, material, As_top, As_bot, span,
    rebar.topBars[0]?.barSize ?? 8, rebar.botBars[0]?.barSize ?? 8,
    rebar.topBars, rebar.botBars, sClear);
  const a_pos = flex.a_pos;
  const c_pos = a_pos / b1;
  const et_pos = c_pos > 0 ? 0.003 * (d - c_pos) / c_pos : 99;
  const phi_pos = flex.phi_pos;
  const Mn_pos = flex.Mn_pos;
  const phi_Mn_pos = flex.phi_Mn_pos;
  const DCR_pos = phi_Mn_pos > 0 ? load.Mu_pos / phi_Mn_pos : 0;

  const flexPosSteps: CalcStep[] = [
    {
      ref: 'ACI 318-19 §22.2.2',
      label: 'Depth of stress block (positive moment)',
      equation: 'a = As·fy / (0.85·f\'c·beff)',
      substitution: `a = ${fmt(As_bot)} × ${fy} / (0.85 × ${fc} × ${fmt(beff)})`,
      result: `a = ${fmt(a_pos)} in`,
    },
    {
      ref: 'ACI 318-19 §22.2.2.4',
      label: 'Neutral axis depth',
      equation: 'c = a / β₁',
      substitution: `c = ${fmt(a_pos)} / ${fmt(b1)}`,
      result: `c = ${fmt(c_pos)} in`,
    },
    {
      ref: 'ACI 318-19 §21.2.2',
      label: 'Net tensile strain',
      equation: 'εt = 0.003 × (d − c) / c',
      substitution: `εt = 0.003 × (${fmt(d)} − ${fmt(c_pos)}) / ${fmt(c_pos)}`,
      result: `εt = ${fmt(et_pos, 4)}`,
      note: et_pos >= 0.005 ? 'Tension-controlled (εt ≥ 0.005)' : et_pos >= 0.004 ? 'Transition zone (0.002 < εt < 0.005)' : '⚠ Compression-controlled (εt ≤ 0.002)',
    },
    {
      ref: 'ACI 318-19 Table 21.2.2',
      label: 'Strength reduction factor φ (flexure)',
      equation: 'φ = 0.90 if εt ≥ 0.005; interpolate if transition',
      substitution: et_pos >= 0.005 ? `εt = ${fmt(et_pos, 4)} ≥ 0.005 → φ = 0.90` : `φ = 0.65 + (εt − 0.002)(250/3) = ${fmt(phi_pos, 3)}`,
      result: `φ = ${fmt(phi_pos, 3)}`,
    },
    {
      ref: 'ACI 318-19 §22.3.2',
      label: 'Nominal moment capacity',
      equation: 'Mn = As·fy·(d − a/2)',
      substitution: `Mn = ${fmt(As_bot)} × ${fy} × (${fmt(d)} − ${fmt(a_pos / 2)}) / 12,000`,
      result: `Mn = ${fmt(Mn_pos)} kip-ft`,
    },
    {
      ref: 'ACI 318-19 §21.2',
      label: 'Design moment capacity (positive)',
      equation: 'φMn = φ × Mn',
      substitution: `φMn = ${fmt(phi_pos, 3)} × ${fmt(Mn_pos)}`,
      result: `φMn⁺ = ${fmt(phi_Mn_pos)} kip-ft`,
    },
    {
      ref: 'Design check',
      label: 'DCR — Positive flexure',
      equation: 'DCR = Mu / φMn',
      substitution: `DCR = ${load.Mu_pos} / ${fmt(phi_Mn_pos)}`,
      result: `DCR = ${fmt(DCR_pos, 3)}  ${DCR_pos <= 1 ? '✓ OK' : '✗ NG'}`,
      note: `Mu⁺ = ${load.Mu_pos} kip-ft`,
    },
  ];

  // ── Flexure — negative moment (engine values) ────────────────────────
  const a_neg = flex.a_neg;
  const Mn_neg = flex.Mn_neg;
  const phi_Mn_neg = flex.phi_Mn_neg;
  const DCR_neg = phi_Mn_neg > 0 ? load.Mu_neg / phi_Mn_neg : 0;

  const flexNegSteps: CalcStep[] = [
    {
      ref: 'ACI 318-19 §22.2.2',
      label: 'Depth of stress block (negative moment)',
      equation: 'a = As\'·fy / (0.85·f\'c·bw)',
      substitution: `a = ${fmt(As_top)} × ${fy} / (0.85 × ${fc} × ${fmt(bw)})`,
      result: `a = ${fmt(a_neg)} in`,
      note: 'Negative moment: compression in web only (bw used)',
    },
    {
      ref: 'ACI 318-19 §22.3.2',
      label: 'Nominal moment (negative)',
      equation: 'Mn⁻ = As\'·fy·(d − a/2)',
      substitution: `Mn⁻ = ${fmt(As_top)} × ${fy} × (${fmt(d_neg)} − ${fmt(a_neg / 2)}) / 12,000`,
      result: `Mn⁻ = ${fmt(Mn_neg)} kip-ft`,
    },
    {
      ref: 'Design check',
      label: 'DCR — Negative flexure',
      equation: 'DCR = Mu⁻ / φMn⁻',
      substitution: `DCR = ${load.Mu_neg} / ${fmt(phi_Mn_neg)}`,
      result: `DCR = ${fmt(DCR_neg, 3)}  ${DCR_neg <= 1 ? '✓ OK' : '✗ NG'}`,
    },
  ];

  // ── Shear — engine call (identical numbers to the results screen) ────
  const shear = computeShear(section, material, rebar, load.Pu);
  const d_shear = shear.d_shear;
  const rho_w = As_bot / (bw * d_shear);
  const Av_min_s = shear.Av_min_per_s;
  const hasMinStirrups = sv > 0 && Av / sv >= Av_min_s;
  const lambda_s = hasMinStirrups ? 1.0 : Math.min(1.0, Math.sqrt(2 / (1 + 0.004 * d_shear)));
  const Vc = shear.Vc;
  const Vs = shear.Vs;
  const phi_v = 0.75;
  const phi_Vn = shear.phi_Vn;
  const DCR_shear = phi_Vn > 0 ? load.Vu / phi_Vn : 0;

  const shearSteps: CalcStep[] = [
    {
      ref: 'ACI 318-19 §22.5.2.1',
      label: 'Effective shear depth',
      equation: 'd = max(d_flex, 0.8h)',
      substitution: `d = max(${fmt(d)}, 0.8×${h})`,
      result: `d = ${fmt(d_shear)} in`,
    },
    {
      ref: 'ACI 318-19 Table 22.5.5.1',
      label: 'Longitudinal steel ratio',
      equation: 'ρw = As / (bw × d)',
      substitution: `ρw = ${fmt(As_bot)} / (${fmt(bw)} × ${fmt(d_shear)})`,
      result: `ρw = ${fmt(rho_w, 5)}`,
    },
    {
      ref: 'ACI 318-19 §22.5.5.1.3',
      label: 'Size effect factor',
      equation: 'λs = min(1.0, √(2/(1+0.004d)))  [waived if Av/s ≥ Av,min/s]',
      substitution: hasMinStirrups
        ? `Av/s = ${fmt(Av / sv, 4)} ≥ Av,min/s = ${fmt(Av_min_s, 4)} → λs = 1.0`
        : `λs = min(1.0, √(2/(1+0.004×${fmt(d_shear)})))`,
      result: `λs = ${fmt(lambda_s, 4)}`,
      note: hasMinStirrups ? 'Size effect waived — minimum stirrups provided' : 'Size effect applies (Av/s < Av,min/s)',
    },
    {
      ref: 'ACI 318-19 Table 22.5.5.1',
      label: 'Concrete shear strength',
      equation: 'Vc = (8λλsρw^(1/3)√f\'c + Nu/6Ag) × bw × d',
      substitution: `Vc = (8 × ${lambdaConcrete} × ${fmt(lambda_s, 3)} × ${fmt(rho_w, 5)}^(1/3) × √${fc} + ${fmt(load.Pu / (6 * bw * h), 4)}) × ${fmt(bw)} × ${fmt(d_shear)} / 1000`,
      result: `Vc = ${fmt(Vc)} kips`,
      note: load.Pu !== 0 ? `Includes axial term Nu/6Ag with Pu = ${load.Pu} kips` : undefined,
    },
    {
      ref: 'ACI 318-19 §22.5.8.5',
      label: 'Steel shear strength',
      equation: 'Vs = Av·fyt·d / s',
      substitution: sv > 0
        ? `Vs = ${fmt(Av, 3)} × ${fyt} × ${fmt(d_shear)} / (${sv} × 1000)`
        : 'No stirrups provided',
      result: `Vs = ${fmt(Vs)} kips`,
    },
    {
      ref: 'ACI 318-19 Table 21.2.1',
      label: 'φ factor for shear',
      equation: 'φ = 0.75',
      substitution: 'Per ACI 318-19 §21.2.1',
      result: 'φv = 0.75',
    },
    {
      ref: 'ACI 318-19 §22.5.1.1',
      label: 'Design shear capacity',
      equation: 'φVn = φ(Vc + Vs)',
      substitution: `φVn = 0.75 × (${fmt(Vc)} + ${fmt(Vs)})`,
      result: `φVn = ${fmt(phi_Vn)} kips`,
    },
    {
      ref: 'Design check',
      label: 'DCR — Shear',
      equation: 'DCR = Vu / φVn',
      substitution: `DCR = ${load.Vu} / ${fmt(phi_Vn)}`,
      result: `DCR = ${fmt(DCR_shear, 3)}  ${DCR_shear <= 1 ? '✓ OK' : '✗ NG'}`,
      note: `Vu = ${load.Vu} kips`,
    },
  ];

  // Check min stirrup requirement
  const Vc_phi = phi_v * Vc;
  if (load.Vu > Vc_phi / 2) {
    const Av_min = Av_min_s;
    shearSteps.push({
      ref: 'ACI 318-19 §9.6.3.3',
      label: 'Minimum shear reinforcement',
      equation: 'Av,min/s = max(0.75√f\'c/fyt, 50/fyt) × bw',
      substitution: `max(0.75×√${fc}/${fyt}, 50/${fyt}) × ${fmt(bw)}`,
      result: `Av,min/s = ${fmt(Av_min, 4)} in²/in`,
      note: sv > 0 && Av / sv >= Av_min ? `✓ Provided Av/s = ${fmt(Av / sv, 4)} ≥ Av,min/s` : '⚠ Check minimum stirrup requirement',
    });
  }

  // ── Torsion — engine call (identical numbers to the results screen) ──
  const torsion = computeTorsion(section, material, rebar);
  const Acp = b * h;
  const Pcp = 2 * (b + h);
  const Tcr = torsion.Tcr;
  const Tu_thresh = torsion.Tu_threshold;
  const phi_Tn = torsion.phi_Tn;
  const DCR_torsion = phi_Tn > 0 ? load.Tu / phi_Tn : 0;

  const torsionSteps: CalcStep[] = [
    {
      ref: 'ACI 318-19 §22.7.4.1',
      label: 'Gross section area',
      equation: 'Acp = b × h',
      substitution: `Acp = ${b} × ${h}`,
      result: `Acp = ${Acp} in²`,
    },
    {
      ref: 'ACI 318-19 §22.7.4.1',
      label: 'Gross section perimeter',
      equation: 'Pcp = 2(b + h)',
      substitution: `Pcp = 2(${b} + ${h})`,
      result: `Pcp = ${Pcp} in`,
    },
    {
      ref: 'ACI 318-19 §22.7.4.1',
      label: 'Threshold torsion (cracking)',
      equation: 'Tcr = λ√f\'c × Acp² / Pcp / 12000',
      substitution: `Tcr = ${lambdaConcrete}×√${fc} × ${Acp}² / ${Pcp} / 12000`,
      result: `Tcr = ${fmt(Tcr)} kip-ft`,
    },
    {
      ref: 'ACI 318-19 §22.7.4.1',
      label: 'Torsion threshold (may neglect)',
      equation: 'Tu,thresh = Tcr / 4',
      substitution: `Tu,thresh = ${fmt(Tcr)} / 4`,
      result: `Tu,thresh = ${fmt(Tu_thresh)} kip-ft`,
      note: load.Tu <= Tu_thresh
        ? `✓ Tu = ${load.Tu} k-ft ≤ Tu,thresh — torsion may be neglected`
        : `⚠ Tu = ${load.Tu} k-ft > Tu,thresh — torsion must be designed for`,
    },
    {
      ref: 'ACI 318-19 §22.7.6.1',
      label: 'Design torsion capacity (closed stirrups)',
      equation: 'φTn = φ · 2·Ao · (At/s) · fyt',
      substitution: rebar.ties
        ? `φTn = 0.75 × 2 × Ao × (${getBarArea(rebar.ties.barSize)}/${sv}) × ${fyt} / 12000`
        : 'No closed stirrups provided',
      result: `φTn = ${fmt(phi_Tn)} kip-ft`,
    },
    {
      ref: 'Design check',
      label: 'DCR — Torsion',
      equation: 'DCR = Tu / φTn',
      substitution: `DCR = ${load.Tu} / ${fmt(phi_Tn)}`,
      result: `DCR = ${fmt(DCR_torsion, 3)}  ${DCR_torsion <= 1 ? '✓ OK' : '✗ NG'}`,
    },
  ];

  const out: CalcSection[] = [
    { title: '1. Section Properties', steps: sectionSteps },
    { title: '2. Material Properties', steps: materialSteps },
    { title: '3. Reinforcement', steps: rebarSteps },
    { title: '4. Flexure — Positive Moment', steps: flexPosSteps },
    { title: '5. Flexure — Negative Moment', steps: flexNegSteps },
    { title: '6. Shear', steps: shearSteps },
    { title: '7. Torsion', steps: torsionSteps },
  ];

  // ── Zoned stirrups (thirds of span) — same engine call as the screen ──
  if (rebar.tieZones && rebar.ties) {
    const demands: [number, number, number] = zoneVu ?? [load.Vu, load.Vu, load.Vu];
    const zones = zonedShearCheck(section, material, rebar, demands, load.Pu);
    const zoneLabel = ['End zone (0–L/3)', 'Middle zone (L/3–2L/3)', 'End zone (2L/3–L)'];
    out.push({
      title: '8. Shear by Stirrup Zone (thirds of span)',
      steps: zones.map((z, i) => ({
        ref: 'ACI 318-19 §22.5',
        label: zoneLabel[i],
        equation: 'DCR = Vu,zone / φVn(s_zone)',
        substitution: `s = ${z.spacing}"  →  φVn = ${fmt(z.phi_Vn)} kips;  Vu,zone = ${fmt(z.Vu)} kips`,
        result: `DCR = ${fmt(z.DCR, 3)}  ${z.DCR <= 1 ? '✓ OK' : '✗ NG'}`,
        note: zoneVu ? 'Vu,zone = max |V| within this third (station forces)' : 'No station forces — governing Vu applied to all zones',
      })),
    });
  }

  return out;
}
