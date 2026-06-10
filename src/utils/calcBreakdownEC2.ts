/**
 * Step-by-step Eurocode 2 (EN 1992-1-1) calculation sheet.
 * Mirrors the CalcSection/CalcStep shapes from calcBreakdown.ts so the
 * CalcBreakdownModal renders both codes identically. All values shown in SI.
 */

import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase } from '../types';
import type { CalcSection } from './calcBreakdown';
import { getBarArea, getBarDiam } from './concreteDesign';
import { lambdaEta, fctm, mRd, vRdc, vRds, vRdMax, tRd } from '../engines/ec2/ec2Beam';
import { formatBarLabel } from './rebar';

const IN_TO_MM = 25.4, PSI_TO_MPA = 0.00689476, KIP_TO_KN = 4.44822, KIPFT_TO_KNM = 1.35582, IN2_TO_MM2 = 645.16;

function f(n: number, dec = 1): string { return n.toFixed(dec); }

export function generateBreakdownEC2(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  _span = 20,
): CalcSection[] {
  const b = (section.bw ?? section.b) * IN_TO_MM;
  const h = (section.h ?? 12) * IN_TO_MM;
  const cover = section.coverClear * IN_TO_MM;
  const stirrupD = getBarDiam(section.stirrupDia) * IN_TO_MM;
  const botBarD = getBarDiam(rebar.botBars[0]?.barSize ?? 8) * IN_TO_MM;
  const d = h - cover - stirrupD - botBarD / 2;

  const fck = material.fc * PSI_TO_MPA;
  const fyk = material.fy * PSI_TO_MPA;
  const fywk = material.fyt * PSI_TO_MPA;
  const fcd = fck / 1.5;
  const fyd = fyk / 1.15;
  const fywd = fywk / 1.15;
  const { lambda, eta } = lambdaEta(fck);

  const As = rebar.botBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0) * IN2_TO_MM2;
  const MEd = load.Mu_pos * KIPFT_TO_KNM;
  const VEd = load.Vu * KIP_TO_KN;
  const TEd = load.Tu * KIPFT_TO_KNM;

  const botDesc = rebar.botBars.map(g => `${g.numBars}−${formatBarLabel(g.barSize)}`).join(' + ');

  const sections: CalcSection[] = [];

  // ── Materials & geometry ──
  sections.push({
    title: '1. Design Values (EN 1992-1-1 §2.4, §3.1)',
    steps: [
      { ref: '§3.1.6', label: 'Design compressive strength', equation: 'fcd = αcc·fck/γc', substitution: `1.0 × ${f(fck)} / 1.5`, result: `fcd = ${f(fcd)} MPa` },
      { ref: '§3.2.7', label: 'Design steel strength', equation: 'fyd = fyk/γs', substitution: `${f(fyk, 0)} / 1.15`, result: `fyd = ${f(fyd, 0)} MPa` },
      { ref: '§3.1.7', label: 'Stress block factors', equation: 'λ, η (fck ≤ 50 MPa)', substitution: `fck = ${f(fck)} MPa`, result: `λ = ${f(lambda, 2)}, η = ${f(eta, 2)}` },
      { ref: '—', label: 'Effective depth', equation: 'd = h − c − Øst − Øbar/2', substitution: `${f(h, 0)} − ${f(cover, 0)} − ${f(stirrupD, 1)} − ${f(botBarD / 2, 1)}`, result: `d = ${f(d, 0)} mm`, note: `Bottom steel: ${botDesc}, As = ${f(As, 0)} mm²` },
    ],
  });

  // ── Flexure ──
  const flex = mRd(As, d, b, fck, fcd, fyd);
  sections.push({
    title: '2. Flexural Resistance (§6.1)',
    steps: [
      { ref: '§6.1', label: 'Neutral axis depth', equation: 'x = As·fyd / (η·fcd·λ·b)', substitution: `${f(As, 0)} × ${f(fyd, 0)} / (${f(eta, 2)} × ${f(fcd)} × ${f(lambda, 2)} × ${f(b, 0)})`, result: `x = ${f(flex.x, 1)} mm` },
      { ref: '§6.1', label: 'Moment resistance', equation: 'M_Rd = As·fyd·(d − λx/2)', substitution: `${f(As, 0)} × ${f(fyd, 0)} × (${f(d, 0)} − ${f(lambda * flex.x / 2, 1)})`, result: `M_Rd = ${f(flex.MRd)} kN·m ${MEd <= flex.MRd ? '✓' : '✗'}`, note: `M_Ed = ${f(MEd)} kN·m → DCR = ${flex.MRd > 0 ? f(MEd / flex.MRd, 3) : '—'}` },
      { ref: '§5.5', label: 'Ductility check', equation: 'x/d ≤ 0.45', substitution: `${f(flex.x, 1)} / ${f(d, 0)}`, result: `x/d = ${f(flex.x / d, 3)} ${flex.x / d <= 0.45 ? '✓' : '✗'}` },
    ],
  });

  // ── Shear ──
  const VRdc_v = vRdc(b, d, As, fck);
  const z = 0.9 * d;
  const cotT = 2.5;
  const shearSteps: CalcSection['steps'] = [
    { ref: '§6.2.2', label: 'Resistance without stirrups', equation: 'V_Rd,c = [C_Rd,c·k·(100ρl·fck)^⅓]·bw·d', substitution: `k = ${f(Math.min(2, 1 + Math.sqrt(200 / d)), 2)}, ρl = ${f(Math.min(0.02, As / (b * d)) * 100, 2)}%`, result: `V_Rd,c = ${f(VRdc_v)} kN` },
  ];
  if (rebar.ties) {
    const Asw = rebar.ties.legs * getBarArea(rebar.ties.barSize) * IN2_TO_MM2;
    const s_mm = rebar.ties.spacing * IN_TO_MM;
    const VRds_v = vRds(Asw, s_mm, z, fywd, cotT);
    const VRdmax_v = vRdMax(b, z, fck, fcd, cotT);
    const VRd = Math.min(VRds_v, VRdmax_v);
    shearSteps.push(
      { ref: '§6.2.3', label: 'Stirrup resistance', equation: 'V_Rd,s = (Asw/s)·z·fywd·cotθ', substitution: `(${f(Asw, 0)}/${f(s_mm, 0)}) × ${f(z, 0)} × ${f(fywd, 0)} × ${cotT}`, result: `V_Rd,s = ${f(VRds_v)} kN`, note: `θ = 21.8° (cotθ = 2.5)` },
      { ref: '§6.2.3', label: 'Strut crushing limit', equation: 'V_Rd,max = bw·z·ν1·fcd/(cotθ+tanθ)', substitution: `ν1 = 0.6(1 − ${f(fck)}/250) = ${f(0.6 * (1 - fck / 250), 3)}`, result: `V_Rd,max = ${f(VRdmax_v)} kN` },
      { ref: '§6.2', label: 'Governing shear resistance', equation: 'V_Rd = min(V_Rd,s, V_Rd,max)', substitution: `min(${f(VRds_v)}, ${f(VRdmax_v)})`, result: `V_Rd = ${f(VRd)} kN ${VEd <= VRd ? '✓' : '✗'}`, note: `V_Ed = ${f(VEd)} kN → DCR = ${VRd > 0 ? f(VEd / VRd, 3) : '—'}` },
    );
  } else {
    shearSteps.push({ ref: '§6.2.1', label: 'Check', equation: 'V_Ed ≤ V_Rd,c', substitution: `${f(VEd)} vs ${f(VRdc_v)}`, result: VEd <= VRdc_v ? '✓ No shear reinforcement required' : '✗ Shear reinforcement required' });
  }
  sections.push({ title: '3. Shear Resistance (§6.2)', steps: shearSteps });

  // ── Torsion ──
  if (load.Tu > 0) {
    const AtLeg = getBarArea(rebar.ties?.barSize ?? 0) * IN2_TO_MM2;
    const s_mm = (rebar.ties?.spacing ?? 1) * IN_TO_MM;
    const t = tRd(b, h, rebar.ties ? AtLeg : 0, s_mm, fywd, fck, fcd, cotT);
    const TRd = Math.min(t.TRds, t.TRdMax);
    sections.push({
      title: '4. Torsional Resistance (§6.3)',
      steps: [
        { ref: '§6.3.2', label: 'Equivalent thin-wall section', equation: 't_ef = A/u, Ak', substitution: `A = ${f(b * h / 1e3, 0)}×10³ mm², u = ${f(2 * (b + h), 0)} mm`, result: `t_ef = ${f(t.tef, 0)} mm, Ak = ${f(t.Ak / 1e3, 0)}×10³ mm²` },
        { ref: '§6.3.2', label: 'Cracking torsion', equation: 'T_Rd,c = 2·Ak·t_ef·fctd', substitution: `fctd = ${f(fctm(fck) * 0.7 / 1.5, 2)} MPa`, result: `T_Rd,c = ${f(t.TRdc)} kN·m`, note: TEd <= t.TRdc ? 'T_Ed ≤ T_Rd,c — torsion may be neglected' : 'T_Ed > T_Rd,c — torsion design required' },
        { ref: '§6.3.2', label: 'Stirrup torsion resistance', equation: 'T_Rd,s = 2·Ak·(At/s)·fywd·cotθ', substitution: `2 × ${f(t.Ak / 1e3, 0)}×10³ × (${f(AtLeg, 0)}/${f(s_mm, 0)}) × ${f(fywd, 0)} × ${cotT}`, result: `T_Rd,s = ${f(t.TRds)} kN·m` },
        { ref: '§6.3.2', label: 'Strut crushing limit', equation: 'T_Rd,max = 2·ν·fcd·Ak·t_ef·sinθ·cosθ', substitution: `ν = ${f(0.6 * (1 - fck / 250), 3)}`, result: `T_Rd,max = ${f(t.TRdMax)} kN·m`, note: `T_Rd = ${f(TRd)} kN·m, T_Ed = ${f(TEd)} kN·m ${TEd <= Math.max(TRd, t.TRdc) ? '✓' : '✗'}` },
      ],
    });
  }

  // ── Detailing ──
  const AsMin = Math.max(0.26 * fctm(fck) / fyk, 0.0013) * b * d;
  const detailSteps: CalcSection['steps'] = [
    { ref: '§9.2.1.1', label: 'Minimum longitudinal steel', equation: 'As,min = max(0.26·fctm/fyk, 0.0013)·bt·d', substitution: `fctm = ${f(fctm(fck), 2)} MPa`, result: `As,min = ${f(AsMin, 0)} mm² ${As >= AsMin ? '✓' : '✗'}` },
    { ref: '§9.2.1.1', label: 'Maximum steel', equation: 'As,max = 0.04·Ac', substitution: `0.04 × ${f(b * h / 1e3, 0)}×10³`, result: `As,max = ${f(0.04 * b * h, 0)} mm² ${As <= 0.04 * b * h ? '✓' : '✗'}` },
  ];
  if (rebar.ties) {
    const Asw = rebar.ties.legs * getBarArea(rebar.ties.barSize) * IN2_TO_MM2;
    const s_mm = rebar.ties.spacing * IN_TO_MM;
    const rho_w = Asw / (s_mm * b);
    const rho_w_min = 0.08 * Math.sqrt(fck) / fywk;
    detailSteps.push(
      { ref: '§9.2.2(5)', label: 'Minimum shear reinforcement ratio', equation: 'ρw,min = 0.08·√fck/fywk', substitution: `0.08 × √${f(fck)} / ${f(fywk, 0)}`, result: `ρw = ${f(rho_w * 1000, 2)}‰ vs ρw,min = ${f(rho_w_min * 1000, 2)}‰ ${rho_w >= rho_w_min ? '✓' : '✗'}` },
      { ref: '§9.2.2(6)', label: 'Maximum stirrup spacing', equation: 's_max = 0.75·d', substitution: `0.75 × ${f(d, 0)}`, result: `s = ${f(s_mm, 0)} mm vs s_max = ${f(0.75 * d, 0)} mm ${s_mm <= 0.75 * d ? '✓' : '✗'}` },
    );
  }
  sections.push({ title: `${load.Tu > 0 ? 5 : 4}. Detailing (§9.2)`, steps: detailSteps });

  return sections;
}
