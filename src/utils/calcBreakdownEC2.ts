/**
 * Step-by-step Eurocode 2 (EN 1992-1-1) calculation sheet.
 * Mirrors the CalcSection/CalcStep shapes from calcBreakdown.ts so the
 * CalcBreakdownModal renders both codes identically. All values shown in SI.
 */

import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase, CrackControlParams } from '../types';
import { DEFAULT_CRACK_PARAMS } from '../types';
import type { CalcSection } from './calcBreakdown';
import { coverFor, getBarArea, getBarDiam, tieSpacingAtX, zoneIndexAtX } from './concreteDesign';
import { lambdaEta, fctm, mRd, vRdc, vRds, vRdMax, tRd, crackWidth, sideFaceCrackWidth, ecm, creepCoefficient, layerCentroidMm } from '../engines/ec2/ec2Beam';
import { formatBarLabel } from './rebar';

const IN_TO_MM = 25.4, PSI_TO_MPA = 0.00689476, KIP_TO_KN = 4.44822, KIPFT_TO_KNM = 1.35582, IN2_TO_MM2 = 645.16;

function f(n: number, dec = 1): string { return n.toFixed(dec); }

export function generateBreakdownEC2(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  _span = 20,
  crackIn: CrackControlParams = DEFAULT_CRACK_PARAMS,
  slsComboName?: string,
  cotTheta = 2.5,   // EC2 §6.2.3 strut angle, matches the engine's cotθ
): CalcSection[] {
  // Merge with defaults so partial objects from old saves don't crash on missing fields.
  const crack: CrackControlParams = { ...DEFAULT_CRACK_PARAMS, ...crackIn };
  const b = (section.bw ?? section.b) * IN_TO_MM;
  const h = (section.h ?? 12) * IN_TO_MM;
  // Per-face cover, mirroring the engine: bottom-face depths off `cover`, the
  // hogging depth off `coverTop`. Both collapse to coverClear when the project
  // uses one cover throughout.
  const cover = coverFor(section, 'bot') * IN_TO_MM;
  const coverTop = coverFor(section, 'top') * IN_TO_MM;
  const stirrupD = getBarDiam(section.stirrupDia) * IN_TO_MM;
  const botBarD = getBarDiam(rebar.botBars[0]?.barSize ?? 8) * IN_TO_MM;
  // Effective depth = distance to the CENTROID of all tension-bar layers (matches the
  // engine and S-Concrete), not just the outer layer. `d` (bottom) governs +M / shear /
  // detailing; `dTop` (hogging effective depth) governs −M.
  const layerClear = (rebar.layerClearSpacing ?? 1.0) * IN_TO_MM;
  const d = h - layerCentroidMm(rebar.botBars, cover, stirrupD, layerClear);
  const dTop = h - layerCentroidMm(rebar.topBars, coverTop, stirrupD, layerClear);

  const fck = material.fc * PSI_TO_MPA;
  const fyk = material.fy * PSI_TO_MPA;
  const fywk = material.fyt * PSI_TO_MPA;
  const fcd = 0.85 * fck / 1.5;
  const fyd = fyk / 1.15;
  const fywd = fywk / 1.15;
  const { lambda, eta } = lambdaEta(fck);

  const As = rebar.botBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0) * IN2_TO_MM2;
  const MEd = load.Mu_pos * KIPFT_TO_KNM;
  const VEd = load.Vu * KIP_TO_KN;
  const TEd = load.Tu * KIPFT_TO_KNM;

  // Two tie spacings, exactly as the engine splits them (see designMemberEC2):
  //   • CAPACITY for this load row → the zone its station sits in.
  //   • DETAILING limits (s_max, ρw) → the worst (widest) zone, member-wide.
  // The sheet used to print worst-zone capacities for every row while the engine
  // reported the row's own zone, so the stamped calculation contradicted the DCR
  // shown beside it — neither number could be defended in a review.
  const worstSpacing = rebar.tieZones
    ? Math.max(...rebar.tieZones.map(z => z.spacing))
    : (rebar.ties?.spacing ?? 0);
  const worstSpacing_mm = worstSpacing * IN_TO_MM;
  const zoneSpacing = tieSpacingAtX(rebar, load.x, _span);
  const zoneSpacing_mm = zoneSpacing * IN_TO_MM;
  const zonedNote = rebar.tieZones
    ? ` (worst of zoned spacings ${rebar.tieZones.map(z => `${z.spacing}"`).join('/')})`
    : '';
  const zoneNote = rebar.tieZones
    ? load.x !== undefined && _span > 0
      ? ` (zone ${zoneIndexAtX(load.x, _span) + 1} of ${rebar.tieZones.map(z => `${z.spacing}"`).join('/')} at x = ${load.x.toFixed(2)} ft)`
      : ` (no station on this row → worst of ${rebar.tieZones.map(z => `${z.spacing}"`).join('/')})`
    : '';

  const botDesc = rebar.botBars.map(g => `${g.numBars}−${formatBarLabel(g.barSize)}`).join(' + ');

  const sections: CalcSection[] = [];

  // ── Materials & geometry ──
  sections.push({
    title: '1. Design Values (EN 1992-1-1 §2.4, §3.1)',
    steps: [
      { ref: '§3.1.6', label: 'Design compressive strength', equation: 'fcd = αcc·fck/γc', substitution: `0.85 × ${f(fck)} / 1.5`, result: `fcd = ${f(fcd)} MPa` },
      { ref: '§3.2.7', label: 'Design steel strength', equation: 'fyd = fyk/γs', substitution: `${f(fyk, 0)} / 1.15`, result: `fyd = ${f(fyd, 0)} MPa` },
      { ref: '§3.1.7', label: 'Stress block factors', equation: 'λ, η (fck ≤ 50 MPa)', substitution: `fck = ${f(fck)} MPa`, result: `λ = ${f(lambda, 2)}, η = ${f(eta, 2)}` },
      { ref: '§6.1', label: 'Effective depth (layer centroid)', equation: 'd = h − centroid of the tension-bar layers', substitution: `bottom ${botDesc} → centroid ${f(h - d, 0)} mm from face`, result: `d = ${f(d, 0)} mm${rebar.topBars.some(g => g.numBars > 0) ? `  ·  d_top (hog) = ${f(dTop, 0)} mm` : ''}`, note: `Area-weighted over ALL layers (not just the outer bar); As = ${f(As, 0)} mm²` },
    ],
  });

  // ── Flexure ──
  const As_top = rebar.topBars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0) * IN2_TO_MM2;
  const topBarD = getBarDiam(rebar.topBars[0]?.barSize ?? 8) * IN_TO_MM;
  const MEd_neg = load.Mu_neg * KIPFT_TO_KNM;
  const topDesc = rebar.topBars.map(g => `${g.numBars}−${formatBarLabel(g.barSize)}`).join(' + ');
  // Opposite-face bars act as compression steel (doubly-reinforced §6.1).
  // Each d' is measured from the face its compression steel sits at, matching the
  // engine — reading `cover` (bottom) for the top steel made the printed M_Rd⁺
  // diverge from the results panel as soon as a project set per-face covers.
  const dCompPos = coverTop + stirrupD + topBarD / 2; // +M: top steel in compression
  const dCompNeg = cover + stirrupD + botBarD / 2;    // −M: bottom steel in compression

  // Credit the compression steel (top bars under +M, bottom bars under −M): the
  // NA is solved from strain compatibility rather than assuming a singly-reinforced
  // As·fyd·(d − λx/2), which would ignore the opposite-face cage and overstate x.
  const flex = mRd(As, d, b, fck, fcd, fyd, undefined, undefined, As_top, dCompPos);
  const flex_neg = mRd(As_top, dTop, b, fck, fcd, fyd, undefined, undefined, As, dCompNeg);
  const compNote = (sigmaComp: number, AsComp: number, dC: number, yields: boolean) =>
    AsComp > 0 && sigmaComp > 0
      ? `A's = ${f(AsComp, 0)} mm² @ d' = ${f(dC, 0)} mm, σ'sc = ${f(sigmaComp, 0)} MPa${yields ? ' (yields)' : ' (elastic)'}`
      : `A's = 0 (singly reinforced)`;

  const flexSteps: CalcSection['steps'] = [
    { ref: '§6.1', label: 'Bottom steel (positive moment, tension at bottom)', equation: 'As,bot', substitution: `${botDesc}, As = ${f(As, 0)} mm²`, result: `As,bot = ${f(As, 0)} mm²` },
    { ref: '§6.1', label: 'Neutral axis depth (positive)', equation: "η·fcd·b·λx + A's·σ'sc = As·fyd", substitution: `As = ${f(As, 0)} mm²; ${compNote(flex.sigmaComp, As_top, dCompPos, flex.compYields)}`, result: `x = ${f(flex.x, 1)} mm (x/d = ${f(flex.x / d, 3)})` },
    { ref: '§6.1', label: 'M_Rd positive', equation: "M_Rd = η·fcd·b·λx·(d − λx/2) + A's·σ'sc·(d − d')", substitution: `z = ${f(flex.z, 0)} mm${flex.tensionYields ? '' : ' · tension steel below yield (over-reinforced)'}`, result: `M_Rd⁺ = ${f(flex.MRd)} kN·m ${MEd <= flex.MRd ? '✓' : '✗'}`, note: `M_Ed⁺ = ${f(MEd)} kN·m → DCR = ${flex.MRd > 0 ? f(MEd / flex.MRd, 3) : '—'}` },
    { ref: '§5.5', label: 'Ductility check (positive)', equation: 'x/d ≤ 0.45 (fck ≤ 50 MPa)', substitution: `${f(flex.x, 1)} / ${f(d, 0)}`, result: `x/d = ${f(flex.x / d, 3)} ${flex.x / d <= 0.45 ? '✓' : '✗'}` },
  ];

  if (As_top > 0) {
    flexSteps.push(
      { ref: '§6.1', label: 'Top steel (negative moment, tension at top)', equation: 'As,top', substitution: `${topDesc}, As,top = ${f(As_top, 0)} mm²`, result: `As,top = ${f(As_top, 0)} mm²` },
      { ref: '§6.1', label: 'Neutral axis depth (negative)', equation: "η·fcd·b·λx + A's·σ'sc = As,top·fyd", substitution: `As,top = ${f(As_top, 0)} mm²; ${compNote(flex_neg.sigmaComp, As, dCompNeg, flex_neg.compYields)}`, result: `x = ${f(flex_neg.x, 1)} mm (x/d = ${f(flex_neg.x / dTop, 3)})` },
      { ref: '§6.1', label: 'M_Rd negative', equation: "M_Rd⁻ = η·fcd·b·λx·(d_top − λx/2) + A's·σ'sc·(d_top − d')", substitution: `z = ${f(flex_neg.z, 0)} mm; bottom bars A's = ${f(As, 0)} mm² credited in compression${flex_neg.tensionYields ? '' : ' · tension steel below yield'}`, result: `M_Rd⁻ = ${f(flex_neg.MRd)} kN·m ${MEd_neg <= flex_neg.MRd ? '✓' : '✗'}`, note: `d_top = ${f(dTop, 0)} mm (top-layer centroid) · M_Ed⁻ = ${f(MEd_neg)} kN·m → DCR = ${flex_neg.MRd > 0 ? f(MEd_neg / flex_neg.MRd, 3) : '—'}` },
    );
  }

  sections.push({ title: '2. Flexural Resistance (§6.1)', steps: flexSteps });

  // ── Shear ──
  const VRdc_v = vRdc(b, d, As, fck);
  const z = 0.9 * d;
  const cotT = cotTheta;
  const thetaDeg = (Math.atan(1 / cotT) * 180 / Math.PI).toFixed(1);
  const shearSteps: CalcSection['steps'] = [
    { ref: '§6.2.2', label: 'Resistance without stirrups', equation: 'V_Rd,c = [C_Rd,c·k·(100ρl·fck)^⅓]·bw·d', substitution: `k = ${f(Math.min(2, 1 + Math.sqrt(200 / d)), 2)}, ρl = ${f(Math.min(0.02, As / (b * d)) * 100, 2)}%`, result: `V_Rd,c = ${f(VRdc_v)} kN` },
  ];
  let VRd_kN = VRdc_v;
  if (rebar.ties) {
    const Asw = rebar.ties.legs * getBarArea(rebar.ties.barSize) * IN2_TO_MM2;
    const s_mm = zoneSpacing_mm;   // capacity at THIS row's zone, as the engine does
    const VRds_v = vRds(Asw, s_mm, z, fywd, cotT);
    const VRdmax_v = vRdMax(b, z, fck, fcd, cotT);
    VRd_kN = Math.min(VRds_v, VRdmax_v);
    shearSteps.push(
      { ref: '§6.2.3', label: 'Stirrup resistance', equation: 'V_Rd,s = (Asw/s)·z·fywd·cotθ', substitution: `(${f(Asw, 0)}/${f(s_mm, 0)}) × ${f(z, 0)} × ${f(fywd, 0)} × ${cotT}`, result: `V_Rd,s = ${f(VRds_v)} kN`, note: `θ = ${thetaDeg}° (cotθ = ${cotT})${zoneNote}` },
      { ref: '§6.2.3', label: 'Strut crushing limit', equation: 'V_Rd,max = bw·z·ν1·fcd/(cotθ+tanθ)', substitution: `ν1 = 0.6(1 − ${f(fck)}/250) = ${f(0.6 * (1 - fck / 250), 3)}`, result: `V_Rd,max = ${f(VRdmax_v)} kN` },
      { ref: '§6.2', label: 'Governing shear resistance', equation: 'V_Rd = min(V_Rd,s, V_Rd,max)', substitution: `min(${f(VRds_v)}, ${f(VRdmax_v)})`, result: `V_Rd = ${f(VRd_kN)} kN ${VEd <= VRd_kN ? '✓' : '✗'}`, note: `V_Ed = ${f(VEd)} kN → DCR = ${VRd_kN > 0 ? f(VEd / VRd_kN, 3) : '—'}` },
    );
  } else {
    shearSteps.push({ ref: '§6.2.1', label: 'Check', equation: 'V_Ed ≤ V_Rd,c', substitution: `${f(VEd)} vs ${f(VRdc_v)}`, result: VEd <= VRdc_v ? '✓ No shear reinforcement required' : '✗ Shear reinforcement required' });
  }
  sections.push({ title: '3. Shear Resistance (§6.2)', steps: shearSteps });

  // ── Torsion ──
  if (load.Tu > 0) {
    const AtLeg = getBarArea(rebar.ties?.barSize ?? 0) * IN2_TO_MM2;
    // Torsion capacity, like shear, is read at this row's zone (engine parity).
    const s_mm = rebar.ties ? zoneSpacing_mm : IN_TO_MM;
    // t_ef's §6.3.2(1) floor is set by the GOVERNING (deepest-cover) face — t_ef is
    // one section-wide wall thickness, so it cannot be bound to a single face.
    const coverToCentre = Math.max(cover, coverTop, coverFor(section, 'side') * IN_TO_MM)
      + stirrupD + botBarD / 2;
    const t = tRd(b, h, rebar.ties ? AtLeg : 0, s_mm, fywd, fck, fcd, cotT, coverToCentre);
    const TRd = Math.min(t.TRds, t.TRdMax);
    sections.push({
      title: '4. Torsional Resistance (§6.3)',
      steps: [
        { ref: '§6.3.2', label: 'Equivalent thin-wall section', equation: 't_ef = A/u, Ak', substitution: `A = ${f(b * h / 1e3, 0)}×10³ mm², u = ${f(2 * (b + h), 0)} mm`, result: `t_ef = ${f(t.tef, 0)} mm, Ak = ${f(t.Ak / 1e3, 0)}×10³ mm²` },
        { ref: '§6.3.2', label: 'Cracking torsion', equation: 'T_Rd,c = 2·Ak·t_ef·fctd', substitution: `fctd = ${f(fctm(fck) * 0.7 / 1.5, 2)} MPa`, result: `T_Rd,c = ${f(t.TRdc)} kN·m`, note: TEd <= t.TRdc ? 'T_Ed ≤ T_Rd,c — torsion may be neglected' : 'T_Ed > T_Rd,c — torsion design required' },
        { ref: '§6.3.2', label: 'Stirrup torsion resistance', equation: 'T_Rd,s = 2·Ak·(At/s)·fywd·cotθ', substitution: `2 × ${f(t.Ak / 1e3, 0)}×10³ × (${f(AtLeg, 0)}/${f(s_mm, 0)}) × ${f(fywd, 0)} × ${cotT}`, result: `T_Rd,s = ${f(t.TRds)} kN·m` },
        { ref: '§6.3.2', label: 'Strut crushing limit', equation: 'T_Rd,max = 2·ν·fcd·Ak·t_ef·sinθ·cosθ', substitution: `ν = ${f(0.6 * (1 - fck / 250), 3)}`, result: `T_Rd,max = ${f(t.TRdMax)} kN·m`, note: `T_Rd = ${f(TRd)} kN·m, T_Ed = ${f(TEd)} kN·m ${TEd <= Math.max(TRd, t.TRdc) ? '✓' : '✗'}` },
        {
          ref: '§6.3.2(5)', label: 'V+T combined interaction',
          equation: '(V_Ed/V_Rd) + (T_Ed/T_Rd) ≤ 1.0',
          substitution: `(${f(VEd)}/${f(VRd_kN)}) + (${f(TEd)}/${f(TRd)})`,
          result: `${f(VRd_kN > 0 ? VEd / VRd_kN : 0, 3)} + ${f(TRd > 0 ? TEd / TRd : 0, 3)} = ${f((VRd_kN > 0 ? VEd / VRd_kN : 0) + (TRd > 0 ? TEd / TRd : 0), 3)} ${(VRd_kN > 0 ? VEd / VRd_kN : 0) + (TRd > 0 ? TEd / TRd : 0) <= 1 ? '✓' : '✗'}`,
        },
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
    const s_mm = worstSpacing_mm;
    const rho_w = Asw / (s_mm * b);
    const rho_w_min = 0.08 * Math.sqrt(fck) / fywk;
    detailSteps.push(
      { ref: '§9.2.2(5)', label: 'Minimum shear reinforcement ratio', equation: 'ρw,min = 0.08·√fck/fywk', substitution: `0.08 × √${f(fck)} / ${f(fywk, 0)}`, result: `ρw = ${f(rho_w * 1000, 2)}‰ vs ρw,min = ${f(rho_w_min * 1000, 2)}‰ ${rho_w >= rho_w_min ? '✓' : '✗'}`, note: zonedNote ? `evaluated at${zonedNote}` : undefined },
      { ref: '§9.2.2(6)', label: 'Maximum stirrup spacing', equation: 's_max = 0.75·d', substitution: `0.75 × ${f(d, 0)}`, result: `s = ${f(s_mm, 0)} mm vs s_max = ${f(0.75 * d, 0)} mm ${s_mm <= 0.75 * d ? '✓' : '✗'}`, note: zonedNote ? `worst zone${zonedNote}` : undefined },
    );
    // §9.2.3(2) — closed TORSION links get a tighter spacing cap, but only once the
    // section is torsion-cracked (T_Ed > T_Rd,c); below that the shear rule governs.
    if (load.Tu > 0) {
      const AtLeg = getBarArea(rebar.ties.barSize) * IN2_TO_MM2;
      const tDet = tRd(b, h, AtLeg, s_mm, fywd, fck, fcd, cotT);
      if (TEd > tDet.TRdc) {
        const u8 = 2 * (b + h) / 8;
        const sMaxTor = Math.min(u8, 0.75 * d, Math.min(b, h));
        detailSteps.push(
          { ref: '§9.2.3(2)', label: 'Maximum torsion link spacing', equation: 's_max = min(u/8, 0.75·d, least dim)', substitution: `min(${f(u8, 0)}, ${f(0.75 * d, 0)}, ${f(Math.min(b, h), 0)})`, result: `s = ${f(s_mm, 0)} mm vs s_max = ${f(sMaxTor, 0)} mm ${s_mm <= sMaxTor + 0.5 ? '✓' : '✗'}`, note: zonedNote ? `worst zone${zonedNote}` : undefined },
        );
      }
    }
  }
  sections.push({ title: `${load.Tu > 0 ? 5 : 4}. Detailing (§9.2)`, steps: detailSteps });

  // ── Crack width §7.3.4 ──
  const Es_MPa = material.Es * PSI_TO_MPA;
  // Creep-adjusted modular ratio αe = Es / (Ecm/(1+φ)), φ from Annex B (long-term).
  const h0_mm = 2 * (b * h) / (2 * (b + h));
  const phiCreep = crack.creepPhi ?? creepCoefficient(fck, crack.creepRH ?? 50, crack.creepT0 ?? 28, 25550, h0_mm, crack.cementClass ?? 'N');
  const Ec_eff = (material.Ec ? material.Ec * PSI_TO_MPA : ecm(fck)) / (1 + phiCreep);
  const alpha_e = Es_MPa / Ec_eff;
  // M_qp precedence mirrors the engine (ec2Beam.ts): use the resolved SLS combo
  // moment (kip-ft → kN·m) when present, else the qpFactor × M_Ed ratio fallback.
  const posFromCombo = crack.Mqp_pos !== undefined;
  const negFromCombo = crack.Mqp_neg !== undefined;
  const Mqp_pos = posFromCombo ? crack.Mqp_pos! * KIPFT_TO_KNM : crack.qpFactor * MEd;
  const Mqp_neg = negFromCombo ? crack.Mqp_neg! * KIPFT_TO_KNM : crack.qpFactor * MEd_neg;
  const usingCombo = posFromCombo || negFromCombo;
  const crackSectionNum = load.Tu > 0 ? 6 : 5;
  const crackSteps: CalcSection['steps'] = [];

  function addFaceSteps(
    faceLabel: string, Mqp: number, As_f: number, barD_f: number,
    b_f: number, d_f: number, AsComp_f: number, dComp_f: number,
    wLimit: number, fromCombo = false,
    /** Clear cover to THIS face — the §7.3.4 `c`. Defaults to the bottom cover. */
    cover_f = cover,
  ) {
    if (Mqp <= 0 || As_f <= 0) return;
    // Ecm must carry the project's Ec override, or the sheet prints a wk derived
    // from the code Ecm right below an αe derived from the override.
    const cw = crackWidth(Mqp, As_f, barD_f, b_f, h, d_f, cover_f + stirrupD, fck, Es_MPa, crack.kt,
      { AsComp: AsComp_f, dComp: dComp_f, phi: phiCreep, Ecm: material.Ec ? material.Ec * PSI_TO_MPA : undefined });
    // Quasi-permanent moment + cracking check are shown for every face.
    crackSteps.push(
      fromCombo
        ? { ref: '§7.3.4', label: `${faceLabel}: quasi-permanent moment`, equation: 'M_qp = M_Ed (SLS combo)', substitution: slsComboName ? `quasi-permanent combo "${slsComboName}"` : 'selected SLS combo', result: `M_qp = ${f(Mqp)} kN·m` }
        : { ref: '§7.3.4', label: `${faceLabel}: quasi-permanent moment`, equation: 'M_qp = ψ·M_Ed', substitution: `${f(crack.qpFactor, 2)} × ${f(Mqp / crack.qpFactor)}`, result: `M_qp = ${f(Mqp)} kN·m` },
      { ref: '§7.1', label: `${faceLabel}: cracking moment (transformed uncracked)`, equation: 'M_cr = fctm·Iu/(h − xu)', substitution: `αe = ${f(alpha_e, 2)} (φ = ${f(phiCreep, 2)}), fctm = ${f(fctm(fck), 2)} MPa`, result: `M_cr = ${f(cw.Mcr)} kN·m → ${cw.cracked ? 'M_qp > M_cr ⇒ CRACKED' : 'M_qp ≤ M_cr ⇒ UNCRACKED'}` },
    );
    if (!cw.cracked) {
      crackSteps.push({ ref: '§7.3.1', label: `${faceLabel}: crack DCR`, equation: 'section uncracked', substitution: `M_qp = ${f(Mqp)} ≤ M_cr = ${f(cw.Mcr)} kN·m`, result: 'wk = 0 → DCR = 0 ✓ OK (no crack)' });
      return;
    }
    const srStep = cw.srEq === '7.14'
      ? { ref: 'eq (7.14) gov', label: `${faceLabel}: max crack spacing`, equation: 'sr,max = min[ eq(7.11), 1.3(h − x) ]', substitution: `upper bound governs; h−x = ${f(h - cw.x, 0)} mm`, result: `sr,max = ${f(cw.sr_max, 0)} mm` }
      : { ref: 'eq (7.11) gov', label: `${faceLabel}: max crack spacing`, equation: 'sr,max = min[ k3·c + k1·k2·k4·Ø/ρp,eff , 1.3(h−x) ]', substitution: `c = ${f(cover_f + stirrupD, 0)} mm, Ø = ${f(barD_f, 0)} mm, k1 = 0.8, k2 = 0.5, k3 = 3.4, k4 = 0.425`, result: `sr,max = ${f(cw.sr_max, 0)} mm` };
    const dcr = wLimit > 0 ? cw.wk / wLimit : 0;
    crackSteps.push(
      { ref: '§7.3.4', label: `${faceLabel}: cracked NA & steel stress`, equation: 'transformed cracked section incl. compression steel', substitution: `x = ${f(cw.x, 0)} mm, As' = ${f(AsComp_f, 0)} mm² @ d' = ${f(dComp_f, 0)} mm, αe = ${f(alpha_e, 2)}`, result: `σs = ${f(cw.sigma_s, 0)} MPa` },
      { ref: '§7.3.2(3)', label: `${faceLabel}: effective reinforcement ratio`, equation: 'ρp,eff = As/(Ac,eff − As)', substitution: `hc,ef = min(2.5(h−d), (h−x)/3, h/2)`, result: `ρp,eff = ${f(cw.rho_p_eff * 100, 2)}%` },
      srStep,
      { ref: 'eq (7.8)', label: `${faceLabel}: crack width`, equation: 'wk = sr,max·(εsm − εcm)', substitution: `kt = ${f(crack.kt, 1)} (${crack.kt === 0.4 ? 'long-term' : 'short-term'})`, result: `wk = ${f(cw.wk, 3)} mm vs limit ${f(wLimit, 2)} mm` },
      { ref: '§7.3.1', label: `${faceLabel}: crack DCR`, equation: 'DCR = wk / w_max', substitution: `${f(cw.wk, 3)} / ${f(wLimit, 2)}`, result: `DCR = ${f(dcr, 3)} ${dcr <= 1 ? '✓ OK' : '✗ NG'}` },
    );
  }

  // Same per-face rule as dCompPos in the flexure section above — this file was
  // computing the identical quantity two different ways.
  const dComp_pos = coverTop + stirrupD + topBarD / 2; // +M: top steel in compression
  const dComp_neg = cover + stirrupD + botBarD / 2; // −M: bottom steel in compression
  addFaceSteps('Bottom face (+M)', Mqp_pos, As, botBarD, b, d, As_top, dComp_pos, crack.wLimitBot, posFromCombo);
  addFaceSteps('Top face (−M)', Mqp_neg, As_top, topBarD, b, dTop, As, dComp_neg, crack.wLimitTop, negFromCombo, coverTop);

  // Side face (skin reinforcement) — PRECISE layered-section method (EC2 §7.3.4):
  //   one cracked transformed section holding the top, bottom AND skin bars, so
  //   the skin-bar stress is read straight off the section (no chord interpolation)
  //   and the skin steel's own stiffness is credited. k2 = 0.5 (bending). This
  //   calls the SAME sideFaceCrackWidth() the engine DCR uses — the two can no
  //   longer drift (they had: engine 0.5 vs this sheet's old 1.0).
  if (rebar.sideBars && rebar.sideBars.length > 0) {
    const firstSideG = rebar.sideBars[0];
    const sideBarD = getBarDiam(firstSideG.barSize) * IN_TO_MM;
    const As_per_bar = getBarArea(firstSideG.barSize) * IN2_TO_MM2;
    const totalSideBars = rebar.sideBars.reduce((s, g) => s + g.numBars, 0);
    if (As_per_bar > 0 && totalSideBars > 0) {
      const sf = sideFaceCrackWidth({
        // `cover` places the skin bars vertically; `coverSide` is the §7.3.4 cover
        // for the side-face terms. Ecm carries the project override (engine parity).
        b, h, cover, coverSide: coverFor(section, 'side') * IN_TO_MM, stirrupD,
        Ecm: material.Ec ? material.Ec * PSI_TO_MPA : undefined,
        fck, Es: Es_MPa, kt: crack.kt, phi: phiCreep,
        As_top, d_top: dTop, As_bot: As, d_bot: d, botBarD,
        sideBarD, As_perBar: As_per_bar, nPerFace: totalSideBars,
        s_v: firstSideG.spacing != null && firstSideG.spacing > 0 ? firstSideG.spacing * IN_TO_MM : undefined,
        Mqp_pos, Mqp_neg,
      });
      const dcr_side = crack.wLimitFace > 0 ? sf.wk / crack.wLimitFace : 0;
      crackSteps.push({
        ref: '§7.3.4', label: 'Side face: layered cracked section',
        equation: `all longitudinal bars in one section — top + bottom + ${sf.nSkinLevels} skin level${sf.nSkinLevels === 1 ? '' : 's'}`,
        substitution: `M_qp (${sf.useHogging ? '−M, top tension' : '+M, bot tension'}) = ${f(sf.govMqp)} kN·m, αe = ${f(sf.alpha_e, 2)}`,
        result: sf.cracked ? `x = ${f(sf.x, 0)} mm, σs,chord = ${f(sf.sigma_chord, 0)} MPa` : `M_qp ≤ M_cr = ${f(sf.Mcr)} kN·m ⇒ uncracked`,
      });
      if (sf.cracked) {
        crackSteps.push(
          { ref: '§7.3.4', label: 'Side face: stress at critical skin bar', equation: 'σs,skin = αe·M·(y − x) / Icr  (direct off the section)', substitution: `y = ${f(sf.y_crit, 0)} mm from comp. face, x = ${f(sf.x, 0)} mm`, result: `σs,skin = ${f(sf.sigma_skin, 0)} MPa` },
          { ref: '§7.3.2(3)', label: 'Side face: effective reinforcement ratio', equation: 'ρp,eff = As_bar / (sv × hc,eff)', substitution: `As_bar = ${f(As_per_bar, 0)} mm², sv = ${f(sf.s_v, 0)} mm, hc,eff = ${f(sf.hc_side, 0)} mm`, result: `ρp,eff = ${f(sf.rho_side * 100, 3)}%` },
          { ref: 'eq (7.11)', label: 'Side face: max crack spacing (k2 = 0.5, bending)', equation: 'sr,max = k3·c + k1·k2·k4·Ø/ρp,eff', substitution: `k2 = 0.50, c = ${f(coverFor(section, 'side') * IN_TO_MM + stirrupD, 0)} mm, Ø = ${f(sideBarD, 0)} mm`, result: `sr,max = ${f(sf.sr_side, 0)} mm` },
          { ref: 'eq (7.8)', label: 'Side face: crack width', equation: 'wk = sr,max·(εsm − εcm)', substitution: `kt = ${f(crack.kt, 1)}, (εsm − εcm) = ${f(sf.eps * 1000, 3)}‰`, result: `wk = ${f(sf.wk, 3)} mm vs limit ${f(crack.wLimitFace, 2)} mm` },
          { ref: '§7.3.1', label: 'Side face: crack DCR', equation: 'DCR = wk / w_max', substitution: `${f(sf.wk, 3)} / ${f(crack.wLimitFace, 2)}`, result: `DCR = ${f(dcr_side, 3)} ${dcr_side <= 1 ? '✓ OK' : '✗ NG'}` },
        );
      } else {
        crackSteps.push({ ref: '§7.3.1', label: 'Side face: crack DCR', equation: 'section uncracked', substitution: `M_qp = ${f(sf.govMqp)} ≤ M_cr = ${f(sf.Mcr)} kN·m`, result: 'wk = 0 → DCR = 0 ✓ OK (no crack)' });
      }
    }
  } else if (h > 1000) {
    crackSteps.push({
      ref: '§7.3.3', label: 'Side face — deep beam',
      equation: 'Skin reinforcement required for h > 1000 mm',
      substitution: `h = ${f(h, 0)} mm > 1000 mm`,
      result: '⚠ No side bars defined',
    });
  }

  if (crackSteps.length > 0) {
    const title = usingCombo && slsComboName
      ? `${crackSectionNum}. Crack Width (§7.3.4) — SLS combo "${slsComboName}"`
      : `${crackSectionNum}. Crack Width (§7.3.4)`;
    sections.push({ title, steps: crackSteps });
  }

  return sections;
}
