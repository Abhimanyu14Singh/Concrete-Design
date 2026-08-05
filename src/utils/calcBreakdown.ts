/**
 * Generates a step-by-step ACI 318-19 calculation breakdown
 * as a structured array of steps with equation, substitution, and result.
 */
import { formatBarLabel } from './rebar';
import { beamAxialFlexure } from './axialFlexure';
import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase } from '../types';
import {
  getBarArea, getBarDiam, coverFor,
  effectiveDepthMulti, layerCentroidOffset,
  computeFlexure, computeShear, computeTorsion, torsionCrushing, zonedShearCheck,
  tieSpacingAtX, type CoverFace,
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
  // Mirror designMember exactly, or this sheet prints capacities the results
  // panel disagrees with: capacity is read at THIS row's tie zone (ties.spacing is
  // the tightest zone, not a member-wide value) and d is measured to the flexural
  // tension face for the row's moment sense.
  const zoneSpacing = tieSpacingAtX(rebar, load.x, span);
  const shearFace: CoverFace = load.Mu_neg > load.Mu_pos ? 'top' : 'bot';
  const bw = section.bw ?? b;
  const sClear = rebar.layerClearSpacing ?? 1.0;
  // Per-face cover, mirroring the engine (all equal unless the project splits them).
  const ccBot = coverFor(section, 'bot');
  const ccTop = coverFor(section, 'top');
  const ccSide = coverFor(section, 'side');
  const d = effectiveDepthMulti(section, rebar.botBars, sClear, 'bot');       // to bottom steel centroid
  const d_neg = effectiveDepthMulti(section, rebar.topBars, sClear, 'top');   // to top steel centroid
  const yBot = layerCentroidOffset(section, rebar.botBars, sClear, 'bot');
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
      substitution: ccTop === ccBot && ccBot === ccSide
        ? `cc = ${fmt(ccBot)}"`
        : `cc: top ${fmt(ccTop)}", bottom ${fmt(ccBot)}", side ${fmt(ccSide)}"`,
      result: ccTop === ccBot && ccBot === ccSide
        ? `${fmt(ccBot)} in`
        : `${fmt(ccTop)} / ${fmt(ccBot)} / ${fmt(ccSide)} in`,
    },
    {
      ref: 'ACI 318-19 §22.2.2',
      label: 'Effective depth (to bottom steel centroid)',
      equation: botLayers > 1 ? 'd = h − ȳs (area-weighted steel centroid)' : 'd = h − cc − d_stirrup − d_bar/2',
      substitution: botLayers > 1
        ? `ȳs = ${fmt(yBot)}" over ${botLayers} layers (clear layer spacing ${sClear}");  d = ${h} − ${fmt(yBot)}`
        : `d = ${h} − ${fmt(ccBot)} − ${fmt(getBarDiam(section.stirrupDia))} − ${fmt(getBarDiam(rebar.botBars[0]?.barSize ?? 8) / 2)}`,
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
      ref: 'ACI 318-19 Table 6.3.2.1',
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
      ref: 'ACI 318-19 §20.2.2.2',
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

  // ACI §25.2.1: min clear horizontal spacing within each layer
  {
    const Cc = ccSide + getBarDiam(section.stirrupDia);
    for (const [face, bars] of [['Bottom', rebar.botBars], ['Top', rebar.topBars]] as const) {
      for (const g of bars) {
        if (g.numBars <= 1) continue;
        const db = getBarDiam(g.barSize);
        const s_clear = (bw - 2 * Cc - g.numBars * db) / (g.numBars - 1);
        const s_req   = Math.max(1.0, db);
        rebarSteps.push({
          ref: 'ACI 318-19 §25.2.1',
          label: `Clear horizontal spacing — ${face.toLowerCase()} bars (${g.numBars}−${formatBarLabel(g.barSize)})`,
          equation: 's_clear = (bw − 2(cc + d_stir) − n·db) / (n − 1)  ≥ max(1", db)',
          substitution: `s_clear = (${fmt(bw)} − 2×${fmt(Cc)} − ${g.numBars}×${fmt(db, 3)}) / ${g.numBars - 1}  vs  ${fmt(s_req)}"`,
          result: `${fmt(s_clear)} in  ${s_clear >= s_req - 1e-9 ? '✓ OK' : '⚠ NG'}`,
        });
      }
    }
  }

  // Steel limits
  const rho_min = Math.max(3 * Math.sqrt(fc) / fy, 200 / fy);
  const As_min = rho_min * bw * d;
  const As_max = 0.85 * b1 * (fc / fy) * (0.003 / (0.003 + 0.004)) * bw * d;

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
      equation: 'As,max = 0.85β₁(f\'c/fy)(0.003/(0.003+0.004)) × bw × d',
      substitution: `0.85 × ${fmt(b1)} × (${fc}/${fy}) × (3/7) × ${fmt(bw)} × ${fmt(d)}`,
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
      ref: 'ACI 318-19 §21.2',
      label: 'Design moment capacity (negative)',
      equation: 'φMn⁻ = φ × Mn⁻  (φ same procedure as positive)',
      substitution: `φMn⁻ = ${fmt(phi_Mn_neg > 0 && Mn_neg > 0 ? phi_Mn_neg / Mn_neg : 0.9, 3)} × ${fmt(Mn_neg)}`,
      result: `φMn⁻ = ${fmt(phi_Mn_neg)} kip-ft`,
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
  const shear = computeShear(section, material, rebar, load.Pu, zoneSpacing, shearFace);
  const d_shear = shear.d_shear;
  const rho_w = As_bot / (bw * d_shear);
  const Av_min_s = shear.Av_min_per_s;
  const hasMinStirrups = sv > 0 && Av / sv >= Av_min_s;
  const lambda_s = hasMinStirrups ? 1.0 : Math.min(1.0, Math.sqrt(2 / (1 + 0.004 * d_shear)));
  const Vc = shear.Vc;
  // Same expression the engine uses (concreteDesign.computeShear): Nu in POUNDS so
  // the term lands in psi beside √f'c, capped at 0.05f'c per the Table 22.5.5.1
  // footnote. Re-deriving it by hand here is exactly how this sheet drifted from
  // the engine — keep the two in step.
  const nuTermRaw = load.Pu * 1000 / (6 * bw * h);
  const nuTerm = Math.min(nuTermRaw, 0.05 * fc);
  const nuCapped = nuTermRaw > 0.05 * fc;
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
      equation: hasMinStirrups
        ? 'Vc = max(2λ√f\'c, 8λρw^(1/3)√f\'c) × bw × d  [min stirrups provided]'
        : 'Vc = (8λλsρw^(1/3)√f\'c + Nu/6Ag) × bw × d',
      substitution: hasMinStirrups
        ? (() => {
            const Vc_a = (2 * lambdaConcrete * Math.sqrt(fc) + nuTerm) * bw * d_shear / 1000;
            const Vc_b2 = (8 * lambdaConcrete * Math.pow(Math.max(rho_w, 1e-6), 1/3) * Math.sqrt(fc) + nuTerm) * bw * d_shear / 1000;
            return `case (a) = ${fmt(Vc_a)} kips; case (b) = ${fmt(Vc_b2)} kips → governs: ${Vc_a >= Vc_b2 ? '(a)' : '(b)'}`;
          })()
        : `Vc = (8 × ${lambdaConcrete} × ${fmt(lambda_s, 3)} × ${fmt(rho_w, 5)}^(1/3) × √${fc} + ${fmt(nuTerm, 1)}) × ${fmt(bw)} × ${fmt(d_shear)} / 1000`,
      result: `Vc = ${fmt(Vc)} kips`,
      note: load.Pu !== 0
        ? `Axial term Nu/6Ag = ${fmt(nuTerm, 1)} psi (Pu = ${load.Pu} kips${nuCapped ? `, capped at 0.05f'c = ${fmt(0.05 * fc, 0)} psi` : ''})`
        : undefined,
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
      ref: 'ACI 318-19 §22.5.1.2',
      label: 'Cross-section crushing limit',
      equation: 'φVn,max = φ(Vc + 8√f\'c·bw·d)',
      substitution: `φVn,max = 0.75 × (${fmt(Vc)} + 8×√${fc} × ${fmt(bw)} × ${fmt(d_shear)} / 1000)`,
      result: `φVn,max = ${fmt(0.75 * (Vc + 8 * Math.sqrt(fc) * bw * d_shear / 1000))} kips  ${load.Vu <= 0.75 * (Vc + 8 * Math.sqrt(fc) * bw * d_shear / 1000) ? '✓ OK' : '✗ NG — enlarge section'}`,
      note: 'Upper bound on shear capacity regardless of stirrups',
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
  const torsion = computeTorsion(section, material, rebar, zoneSpacing, load.Pu);
  const crush = torsionCrushing(section, material, load.Vu, shear.Vc, load.Tu, shear.d_shear);
  const Acp = b * h;
  const Pcp = 2 * (b + h);
  const Tcr = torsion.Tcr;
  const Tu_thresh = torsion.Tu_threshold;
  const phi_Tn = torsion.phi_Tn;
  const DCR_torsion = phi_Tn > 0 ? load.Tu / phi_Tn : 0;

  // Closed-stirrup centerline geometry (matches engine)
  const dStir_2 = getBarDiam(section.stirrupDia) / 2;
  const cc_tor = ccSide + dStir_2;
  const x0_tor = b - 2 * cc_tor;
  const y0_tor = h - (ccTop + dStir_2) - (ccBot + dStir_2);
  const Aoh_tor = x0_tor * y0_tor;
  const Ao_tor  = 0.85 * Aoh_tor;

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
      ref: 'ACI 318-19 §22.7.6.1',
      label: 'Stirrup centerline dimensions',
      equation: 'x₀ = b − 2cc*, y₀ = h − 2cc*  (cc* = cover + d_st/2)',
      substitution: `cc* = ${fmt(cc_tor)}", x₀ = ${fmt(x0_tor)}", y₀ = ${fmt(y0_tor)}"`,
      result: `Aoh = ${fmt(Aoh_tor)} in², Ao = 0.85·Aoh = ${fmt(Ao_tor)} in²`,
    },
    // The §22.7.5.1 axial modifier only earns a line when there is axial load to
    // report; at Pu = 0 it is 1.000 and would just be noise on the sheet.
    ...(load.Pu !== 0 ? [{
      ref: 'ACI 318-19 §22.7.5.1',
      label: 'Axial modifier on torsional cracking',
      equation: "√(1 + Nu / (4·Ag·λ√f'c))   (Nu +ve compression)",
      substitution: `√(1 + ${fmt(load.Pu * 1000, 0)} / (4 × ${Acp} × ${lambdaConcrete}×√${fc}))`,
      result: `factor = ${fmt(torsion.axialFactor, 4)}`,
      note: load.Pu > 0
        ? 'Compression delays torsional cracking — Tcr and the neglect threshold both rise.'
        : 'Tension brings cracking forward — Tcr and the neglect threshold both fall.',
    }] : []),
    {
      ref: 'ACI 318-19 §22.7.5.1',
      label: 'Cracking torsion',
      equation: 'Tcr = 4λ√f\'c × Acp² / Pcp × √(1 + Nu/(4Ag·λ√f\'c)) / 12000',
      substitution: `Tcr = 4×${lambdaConcrete}×√${fc} × ${Acp}² / ${Pcp} × ${fmt(torsion.axialFactor, 4)} / 12000`,
      result: `Tcr = ${fmt(Tcr)} kip-ft`,
    },
    {
      ref: 'ACI 318-19 Table 22.7.4.1(a)',
      label: 'Threshold torsion (may neglect below this)',
      equation: "Tu,thresh = phi*lambda*sqrt(fc)*Acp^2/Pcp * sqrt(1 + Nu/(4Ag*lambda*sqrt(fc))) / 12000  (phi=0.75)",
      substitution: `Tu,thresh = 0.75×${lambdaConcrete}×√${fc} × ${Acp}² / ${Pcp} × ${fmt(torsion.axialFactor, 4)} / 12000`,
      result: `Tu,thresh = ${fmt(Tu_thresh)} kip-ft`,
      note: load.Tu <= Tu_thresh
        ? `✓ Tu = ${load.Tu} k-ft ≤ Tu,thresh — torsion may be neglected`
        : `⚠ Tu = ${load.Tu} k-ft > Tu,thresh — torsion must be designed for`,
    },
    {
      ref: 'ACI 318-19 §22.7.6.1',
      label: 'Design torsion capacity (closed stirrups)',
      equation: 'φTn = φ · 2·Ao · (At/s) · fyt · cotθ  (θ = 45°)',
      substitution: rebar.ties
        ? `φTn = 0.75 × 2 × ${fmt(Ao_tor)} × (${fmt(getBarArea(rebar.ties.barSize), 4)}/${sv}) × ${fyt} / 12000`
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
    {
      ref: 'ACI 318-19 §22.7.7.1',
      label: 'Cross-section limit — shear + torsion together',
      equation: "√[(Vu/bw·d)² + (Tu·ph/1.7Aoh²)²] ≤ φ(Vc/bw·d + 8λ√f'c)",
      substitution: `√(${fmt(crush.vu, 0)}² + ${fmt(crush.tu, 0)}²) = ${fmt(Math.hypot(crush.vu, crush.tu), 0)} psi  vs  ${fmt(crush.limit, 0)} psi`,
      result: `DCR = ${fmt(crush.util, 3)}  ${crush.util <= 1 ? '✓ OK' : '✗ NG — ENLARGE THE SECTION'}`,
      note: crush.util <= 1
        ? `Torsion headroom alongside Vu = ${fmt(load.Vu)} kips: Tu may reach ${fmt(crush.Tn_max)} kip-ft`
        : 'Diagonal compression crushes the web — extra stirrups cannot fix this, only a bigger section.',
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

  // ── Axial + flexure (§22.4) — only when the row actually carries axial ──
  // Shows the pure-bending capacity next to the capacity at Pu, so a reviewer
  // can see how much the axial load cost and where the governing number came from.
  if (load.Pu !== 0) {
    const pm = beamAxialFlexure(section, material, rebar, span, 'pos', flex.phi_Mn_pos, load.Pu, load.Mu_pos);
    const compression = load.Pu > 0;
    const cap = compression ? pm.phiPnMax : Math.abs(pm.phiPnTens);
    out.push({
      title: '8. Axial + Flexure Interaction (P-M)',
      steps: [
        {
          ref: compression ? 'ACI 318-19 §22.4.2.1' : 'ACI 318-19 §22.4.3.1',
          label: compression ? 'Axial compression capacity' : 'Axial tension capacity',
          equation: compression
            ? "φPn,max = 0.80·φ·[0.85f'c(Ag − Ast) + fy·Ast],  φ = 0.65 (tied)"
            : 'φPnt = φ·Ast·fy,  φ = 0.90',
          substitution: compression
            ? `0.80 × 0.65 × [0.85×${fc}×(Ag − Ast) + ${fy}×Ast]`
            : `0.90 × Ast × ${fy}`,
          result: `φPn = ${fmt(cap)} kips  vs  Pu = ${fmt(Math.abs(load.Pu))} kips ${compression ? '(comp.)' : '(tens.)'}  →  ${fmt(pm.axialUtil, 3)}`,
        },
        {
          ref: 'ACI 318-19 §22.4',
          label: 'Moment capacity at this axial load',
          equation: compression
            ? 'φMn read off the strain-compatibility P-M surface at Pu'
            : 'φMn = φMn0·(1 − |Pu|/φPnt)   — straight line to pure tension',
          substitution: `pure bending φMn0 = ${fmt(pm.phiMn0)} kip-ft;  Pu = ${fmt(load.Pu)} kips`,
          result: `φMn = ${fmt(pm.phiMnAtPu)} kip-ft  (${fmt(100 * pm.phiMnAtPu / (pm.phiMn0 || 1), 0)}% of pure bending)`,
          note: 'Moments are taken about the geometric centroid of the gross section.',
        },
        {
          ref: 'ACI 318-19 §22.4',
          label: 'Combined N-vs-M utilisation (governing)',
          equation: '(Pu, Mu) scaled radially onto the φ-interaction surface',
          substitution: `surface point: φPn = ${fmt(pm.phiPnAtRay)} kips, φMn = ${fmt(pm.phiMnAtRay)} kip-ft`,
          result: `util = ${fmt(pm.nmUtil, 3)}  ${pm.nmUtil <= 1 ? '✓ OK' : '✗ NG'}`,
          note: `Pure bending alone would read ${fmt(flex.phi_Mn_pos > 0 ? load.Mu_pos / flex.phi_Mn_pos : 0, 3)} — the axial load is what makes the difference.`,
        },
      ],
    });
  }

  // ── Zoned stirrups (thirds of span) — same engine call as the screen ──
  if (rebar.tieZones && rebar.ties) {
    const demands: [number, number, number] = zoneVu ?? [load.Vu, load.Vu, load.Vu];
    const zones = zonedShearCheck(section, material, rebar, demands, load.Pu, shearFace);
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
