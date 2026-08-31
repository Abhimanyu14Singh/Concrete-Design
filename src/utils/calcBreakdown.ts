/**
 * The ACI 318-19 Calc Sheet — a step-by-step derivation of everything the beam engine
 * computed, as structured data (clause ref, symbolic equation, substitution, result).
 *
 * THIS FILE MUST AGREE WITH `concreteDesign.ts`. It is not a second engine and it is not
 * a formatter over engine output: it re-derives the intermediate quantities so it can
 * show the working. That makes drift the standing risk here — change a formula in the
 * engine without changing it here and the panel and the sheet quietly print different
 * numbers for the same member, which is worse than either being wrong on its own.
 *
 * The places that have actually drifted before, and the rules that keep them honest:
 *
 *  • SHEAR ZONE. Capacity is read at the tie spacing of the zone the demand sits in
 *    (`tieSpacingAtX`), not at `ties.spacing` — which is the TIGHTEST zone, not a
 *    member-wide value. A sheet that used `ties.spacing` would overstate φVn mid-span.
 *
 *  • EFFECTIVE DEPTH. `d` is measured to the flexural tension face for THIS row's
 *    moment sense, so a negative-moment row uses the top-face d. With per-face covers
 *    set, using the bottom-face d for both senses is a silent error.
 *
 *  • SHARED CONSTANTS. Anything the engine exports is imported, never re-derived —
 *    `computeFlexure`, `computeShear`, `computeTorsion`, `zonedShearCheck` and the
 *    geometry helpers are all called directly. The two exceptions are `beta1` and
 *    `effectiveFlange` below, which are local copies of the identical functions in
 *    `concreteDesign.ts`. If you change either there, change it here too.
 *
 *  • ARGUMENTS MUST MATCH. `biaxialAlpha` (and any future tuning parameter) has to be
 *    the same value `designMember` was given. The caller passes both; they cannot be
 *    defaulted independently.
 *
 * Output is consumed by the on-screen Calc Sheet and by the PDF report, so it stays
 * plain text with no markup — see `CalcSection.chart` for the one exception.
 */
import { formatBarLabel } from './rebar';
import { beamAxialFlexure } from './axialFlexure';
import { biaxialCheck, DEFAULT_BIAXIAL_ALPHA } from './biaxial';
import type { MaterialProps, SectionDimensions, RebarLayout, LoadCase } from '../types';
import {
  getBarArea, getBarDiam, coverFor,
  effectiveDepthMulti, layerCentroidOffset, layerDepths,
  computeFlexure, computeShear, computeTorsion, torsionCrushing, zonedShearCheck,
  tieSpacingAtX, minSteelCheck, steelLimits, type CoverFace,
} from './concreteDesign';

/** One line of the derivation. Every step carries its clause reference — a Calc Sheet
 *  whose steps can't be traced back to the code is not a check, it's arithmetic. */
export interface CalcStep {
  ref: string;       // ACI 318-19 section reference
  label: string;     // Short description
  equation: string;  // Symbolic equation
  substitution: string; // Numbers plugged in
  result: string;    // Computed value with units
  note?: string;     // Optional footnote
}

/** A titled group of steps — one check (flexure, shear, torsion …) per section. */
export interface CalcSection {
  title: string;
  steps: CalcStep[];
  /**
   * A chart this section can open, shown as an icon in its header. The sheet
   * stays plain text — the icon is the only addition — so a section that has a
   * picture worth seeing can offer it without the printed sheet growing one.
   */
  chart?: { kind: 'pm' | 'biaxial'; label: string };
}

/** Fixed-decimal formatter for sheet text. The sheet is imperial throughout — an EC2
 *  project uses `calcBreakdownEC2.ts` instead, which does its own SI conversion. */
function fmt(n: number, dec = 2): string {
  return n.toFixed(dec);
}

/** β₁ per §22.2.2.4.3. LOCAL COPY of `concreteDesign.beta1` — keep the two identical. */
function beta1(fc: number): number {
  if (fc <= 4000) return 0.85;
  return Math.max(0.65, 0.85 - 0.05 * (fc - 4000) / 1000);
}

/** Effective flange width per §6.3.2. LOCAL COPY of `concreteDesign.effectiveFlange` —
 *  keep the two identical. `span` is in FEET; the clause limits are in inches. */
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

/**
 * Build the full ACI Calc Sheet for ONE member and ONE load case.
 *
 * `zoneVu` carries the per-third shear envelope from the imported station forces; pass
 * it whenever the member has stirrup zones, or the zoned-shear section can only report
 * the demand of the single row being shown. `biaxialAlpha` must match what
 * `designMember` was called with — see the file header.
 */
export function generateBreakdown(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  span = 20,
  zoneVu?: [number, number, number],  // max |V| per span third (station forces)
  /** Bresler contour exponent — must be the same value designMember was given,
   *  or the sheet prints a utilisation the results panel disagrees with. */
  biaxialAlpha: number = DEFAULT_BIAXIAL_ALPHA,
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
  // dt — the EXTREME layer of tension steel, which is where §21.2.2 measures εt.
  // On a one-layer cage dt = d; on a two-layer cage it is deeper, and the engine
  // uses dt, so the sheet must too.
  const dtOf = (bars: typeof rebar.botBars, face: CoverFace, fallback: number) => {
    const ls = layerDepths(section, bars, sClear, face);
    return ls.length ? h - Math.min(...ls.map(l => l.y)) : fallback;
  };
  const dt = dtOf(rebar.botBars, 'bot', d);
  const dt_neg = dtOf(rebar.topBars, 'top', d_neg);
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

  // NO §25.2.2 ROW. The vertical clear-spacing VERDICT was removed from the engine —
  // it demanded max(1", db) between layers, which is §25.2.1's horizontal rule, where the
  // clause itself asks only for a flat 1 in. See `designMember`. `layerClearSpacing` is
  // still printed above as part of the effective-depth derivation, because it places the
  // inner layers and so moves d; what is gone is the pass/fail beside it.
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

  // Steel limits. BOTH are written on d, the tension-group centroid — §9.3.3.1 was
  // evaluated on dt (the extreme layer) until the project chose to match S-CONCRETE,
  // which measures the strain limit at the centroid. See `steelLimits`.
  //
  // As,min comes from the ENGINE's `minSteelCheck`, not a second derivation here. The
  // sheet used to compute the raw §9.6.1.2 figure and judge the cage against it, so a
  // beam the engine had exempted under §9.6.1.3 still drew a warning triangle on the
  // sheet — panel silent, sheet warning, same beam and same load row.
  const rho_min = Math.max(3 * Math.sqrt(fc) / fy, 200 / fy);
  const minBot = minSteelCheck(section, material, rebar, 'bot', load.Mu_pos, span, sClear);
  const minTop = minSteelCheck(section, material, rebar, 'top', load.Mu_neg, span, sClear);
  const As_min = minBot.As_min;
  const etyLim = fy / (material.Es > 0 ? material.Es : 29_000_000);
  // From the ENGINE, not a second derivation — same reason as As,min above. Both faces,
  // because the engine warns on each against its own limit and they differ whenever the
  // depths do.
  const maxBot = steelLimits(section, material, 'bot', rebar.botBars, sClear, load.Pu);
  const maxTop = steelLimits(section, material, 'top', rebar.topBars, sClear, load.Pu);
  const As_max = maxBot.As_max;

  /** One As,min row. BOTH faces get one — the engine warns on each separately, and a
   *  hogging-governed beam used to have its own check missing from the sheet entirely. */
  const minSteelStep = (
    m: ReturnType<typeof minSteelCheck>, faceLabel: string, dFace: number, AsFace: number, MuFace: number,
  ) => ({
    ref: 'ACI 318-19 §9.6.1.2',
    label: `Minimum flexural steel — ${faceLabel}`,
    equation: "As,min = max(3√f'c/fy, 200/fy) × bw × d",
    substitution: `max(3×√${fc}/${fy}, 200/${fy}) × ${fmt(bw)} × ${fmt(dFace)} = ${fmt(rho_min, 5)} × ${fmt(bw)} × ${fmt(dFace)}`
      + (m.exempt
        ? ` — §9.6.1.3: As,req by analysis = ${fmt(m.As_req_raw)} in², (4/3)×that = ${fmt(m.As_min_eff)} in² < ${fmt(m.As_min)} in², so the lower figure governs`
        : ''),
    result: m.exempt
      ? `${fmt(m.As_min_eff)} in²  (§9.6.1.2 alone gives ${fmt(m.As_min)})`
      : `${fmt(m.As_min)} in²`,
    note: MuFace <= 0
      ? '— no moment on this face; §9.6.1.1 asks for a minimum only where tension steel is required'
      : AsFace < m.As_min_eff
        ? `⚠ Provided ${fmt(AsFace)} in² < As,min ${fmt(m.As_min_eff)} in²`
        : `✓ Provided ${fmt(AsFace)} in² ≥ As,min ${fmt(m.As_min_eff)} in²`,
  });

  /** One As,max row per face, each on its own depth. Not gated on the moment: As,max
   *  asks whether the cage would be compression-controlled if this face were the tension
   *  face, which is a property of the section rather than of one load row. */
  const maxSteelStep = (
    m: ReturnType<typeof steelLimits>, faceLabel: string, dFace: number, AsFace: number,
  ) => ({
    ref: 'ACI 318-19 §9.3.3.1',
    label: `Maximum flexural steel — ${faceLabel} (εt ≥ εty + 0.003 = ${fmt(etyLim + 0.003, 4)})`,
    equation: "As,max = 0.85β₁(f'c/fy)(0.003/(0.003 + εty + 0.003)) × bw × d",
    substitution: `0.85 × ${fmt(b1)} × (${fc}/${fy}) × (0.003/${fmt(0.006 + etyLim, 5)}) × ${fmt(bw)} × ${fmt(dFace)}`,
    result: `${fmt(m.As_max)} in²`,
    note: !m.asMaxApplies
      ? `— Pu = ${fmt(load.Pu ?? 0)} kips ≥ 0.10·f′c·Ag = ${fmt(0.10 * fc * bw * h / 1000)} kips: §9.3.3.1 is scoped to beams, so this limit does not apply here`
      : AsFace > m.As_max
          ? `⚠ Provided ${fmt(AsFace)} in² > As,max ${fmt(m.As_max)} in² — over-reinforced`
          : `✓ Provided ${fmt(AsFace)} in² ≤ As,max ${fmt(m.As_max)} in²`,
  });

  rebarSteps.push(
    minSteelStep(minBot, 'bottom face (sagging)', d, As_bot, load.Mu_pos),
    minSteelStep(minTop, 'top face (hogging)', d_neg, As_top, load.Mu_neg),
    maxSteelStep(maxBot, 'bottom face', d, As_bot),
    maxSteelStep(maxTop, 'top face', d_neg, As_top),
  );

  // ── Flexure — engine call (identical numbers to the results screen) ──
  const flex = computeFlexure(section, material, As_top, As_bot, span,
    rebar.topBars[0]?.barSize ?? 8, rebar.botBars[0]?.barSize ?? 8,
    rebar.topBars, rebar.botBars, sClear);
  const Es = material.Es > 0 ? material.Es : 29_000_000;
  const ety = fy / Es;

  /**
   * The flexure derivation for one bending sense.
   *
   * The engine has THREE derivations for `a` and the sheet must print the one
   * that actually ran. It used to print `a = As·fy/(0.85 f'c b)` unconditionally
   * while showing the engine's `a`, so on any beam with compression steel in the
   * compression zone — i.e. most beams — the substitution shown did not produce
   * the result shown (12×28, 8-#8/4-#8: it read 6.20" over a printed 4.12").
   */
  function flexSteps(sense: 'pos' | 'neg'): CalcStep[] {
    const isPos = sense === 'pos';
    const sup = isPos ? '⁺' : '⁻';
    const As_t = isPos ? As_bot : As_top;                       // tension steel
    const As_c = isPos ? As_top : As_bot;                       // compression steel
    const dSense = isPos ? d : d_neg;
    const dtSense = isPos ? dt : dt_neg;
    const dPrime = layerCentroidOffset(section, isPos ? rebar.topBars : rebar.botBars,
      sClear, isPos ? 'top' : 'bot');
    const mode = isPos ? flex.mode_pos : flex.mode_neg;
    // Sagging compresses the flange; hogging compresses the web only.
    const bComp = isPos ? beff : bw;
    const bLabel = isPos ? (isT ? 'beff' : 'b') : 'bw';
    const a = isPos ? flex.a_pos : flex.a_neg;
    const c = b1 > 0 ? a / b1 : 0;
    const et = c > 0 ? 0.003 * (dtSense - c) / c : 99;
    const phi = isPos ? flex.phi_pos : flex.phi_neg;
    const Mn = isPos ? flex.Mn_pos : flex.Mn_neg;
    const phiMn = isPos ? flex.phi_Mn_pos : flex.phi_Mn_neg;
    const Mu = isPos ? load.Mu_pos : load.Mu_neg;
    const DCR = phiMn > 0 ? Mu / phiMn : 0;
    const hf = section.hf ?? h;

    const steps: CalcStep[] = [];

    if (mode === 'doubly') {
      steps.push({
        ref: 'ACI 318-19 §22.2.2',
        label: `Depth of stress block (${isPos ? 'positive' : 'negative'} moment) — doubly reinforced`,
        equation: 'Solve  0.85·f\'c·b·a + ΣAs\'ᵢ(f\'sᵢ − 0.85f\'c) = As·fy,  f\'sᵢ = min(Es·0.003(c−dᵢ)/c, fy)',
        substitution: `As = ${fmt(As_t)} in², As' = ${fmt(As_c)} in² at d' = ${fmt(dPrime)}", ${bLabel} = ${fmt(bComp)}"`,
        result: `a = ${fmt(a)} in`,
        note: 'Compression steel lies inside the stress block, so a is solved from equilibrium — it is NOT As·fy/(0.85f\'c·b).',
      });
    } else if (mode === 'flanged') {
      const Cf = 0.85 * fc * (bComp - bw) * hf / 1000;
      const Cw = As_t * fy / 1000 - Cf;
      const a_web = Cw * 1000 / (0.85 * fc * bw);
      steps.push({
        ref: 'ACI 318-19 §22.2.2',
        label: 'Depth of stress block — T/L flange + web split',
        equation: 'Cf = 0.85f\'c(beff − bw)hf;  a = hf + (As·fy − Cf)/(0.85·f\'c·bw)',
        substitution: `Cf = ${fmt(Cf)} kip, Cw = ${fmt(Cw)} kip, a_web = ${fmt(a_web)}" + hf = ${fmt(hf)}"`,
        result: `a = ${fmt(a)} in`,
        note: 'Stress block runs past the flange, so the compression zone is flange + web.',
      });
    } else {
      steps.push({
        ref: 'ACI 318-19 §22.2.2',
        label: `Depth of stress block (${isPos ? 'positive' : 'negative'} moment)`,
        equation: `a = As·fy / (0.85·f'c·${bLabel})`,
        substitution: `a = ${fmt(As_t)} × ${fy} / (0.85 × ${fc} × ${fmt(bComp)})`,
        result: `a = ${fmt(a)} in`,
        note: isPos
          ? undefined
          : `Negative moment: compression in ${isT ? 'the web only (bw used) — the flange is in tension' : 'the rectangular section'}`,
      });
    }

    steps.push(
      {
        ref: 'ACI 318-19 §22.2.2.4',
        label: 'Neutral axis depth',
        equation: 'c = a / β₁',
        substitution: `c = ${fmt(a)} / ${fmt(b1)}`,
        result: `c = ${fmt(c)} in`,
      },
      {
        ref: 'ACI 318-19 §21.2.2',
        label: 'Net tensile strain (extreme tension layer)',
        equation: 'εt = 0.003 × (dt − c) / c',
        substitution: `εt = 0.003 × (${fmt(dtSense)} − ${fmt(c)}) / ${fmt(c)}`,
        result: `εt = ${fmt(et, 4)}`,
        note: et >= ety + 0.003
          ? `Tension-controlled (εt ≥ εty + 0.003 = ${fmt(ety + 0.003, 4)})`
          : et > ety
            ? `Transition zone (${fmt(ety, 4)} < εt < ${fmt(ety + 0.003, 4)})`
            : `⚠ Compression-controlled (εt ≤ εty = ${fmt(ety, 4)})`,
      },
      {
        ref: 'ACI 318-19 Table 21.2.2',
        label: 'Strength reduction factor φ (flexure)',
        equation: 'φ = 0.90 if εt ≥ εty + 0.003; φ = 0.65 + 0.25(εt − εty)/0.003 in transition',
        substitution: et >= ety + 0.003
          ? `εt = ${fmt(et, 4)} ≥ ${fmt(ety + 0.003, 4)} → φ = 0.90`
          : `φ = 0.65 + 0.25(${fmt(et, 4)} − ${fmt(ety, 4)})/0.003 = ${fmt(phi, 3)}`,
        result: `φ = ${fmt(phi, 3)}`,
        note: `εty = fy/Es = ${fy}/${Es} = ${fmt(ety, 5)}`,
      },
    );

    if (mode === 'doubly') {
      steps.push({
        ref: 'ACI 318-19 §22.3.2',
        label: `Nominal moment capacity${isPos ? '' : ' (negative)'}`,
        equation: 'Mn = 0.85f\'c·b·a(d − a/2) + ΣAs\'ᵢ(f\'sᵢ − 0.85f\'c)(d − dᵢ)',
        substitution: `Cc = ${fmt(0.85 * fc * bComp * a / 1000)} kip at (${fmt(dSense)} − ${fmt(a / 2)})", plus the compression-steel couple`,
        result: `Mn${sup} = ${fmt(Mn)} kip-ft`,
        note: 'Moments taken about the tension-steel centroid, each compression layer at its own strain.',
      });
    } else if (mode === 'flanged') {
      steps.push({
        ref: 'ACI 318-19 §22.3.2',
        label: 'Nominal moment capacity — flange + web',
        equation: 'Mn = Cf(d − hf/2) + Cw(d − hf − a_web/2)',
        substitution: `d = ${fmt(dSense)}", hf = ${fmt(hf)}", a = ${fmt(a)}"`,
        result: `Mn${sup} = ${fmt(Mn)} kip-ft`,
      });
    } else {
      steps.push({
        ref: 'ACI 318-19 §22.3.2',
        label: `Nominal moment capacity${isPos ? '' : ' (negative)'}`,
        equation: 'Mn = As·fy·(d − a/2)',
        substitution: `Mn = ${fmt(As_t)} × ${fy} × (${fmt(dSense)} − ${fmt(a / 2)}) / 12,000`,
        result: `Mn${sup} = ${fmt(Mn)} kip-ft`,
      });
    }

    steps.push(
      {
        ref: 'ACI 318-19 §21.2',
        label: `Design moment capacity (${isPos ? 'positive' : 'negative'})`,
        equation: `φMn${sup} = φ × Mn${sup}`,
        substitution: `φMn${sup} = ${fmt(phi, 3)} × ${fmt(Mn)}`,
        result: `φMn${sup} = ${fmt(phiMn)} kip-ft`,
      },
      {
        ref: 'Design check',
        label: `DCR — ${isPos ? 'Positive' : 'Negative'} flexure`,
        equation: `DCR = Mu${sup} / φMn${sup}`,
        substitution: `DCR = ${Mu} / ${fmt(phiMn)}`,
        result: `DCR = ${fmt(DCR, 3)}  ${DCR <= 1 ? '✓ OK' : '✗ NG'}`,
        note: isPos ? `Mu⁺ = ${load.Mu_pos} kip-ft` : undefined,
      },
    );
    return steps;
  }

  const flexPosSteps = flexSteps('pos');
  const flexNegSteps = flexSteps('neg');

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
  const Vs = shear.Vs;                    // AFTER the §22.5.1.2 ceiling
  // The uncapped value and the ceiling itself, so the sheet can show both and say which
  // one the capacity came from. Same expression `computeShear` caps with — note it
  // carries no λ, matching the clause and the engine.
  const VsMax = 8 * Math.sqrt(fc) * bw * d_shear / 1000;
  const VsRaw = sv > 0 ? Av * fyt * d_shear / (sv * 1000) : 0;
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
      // The RAW value the formula above produces. `shear.Vs` is already capped, so
      // printing it here would show a substitution that does not produce its own result
      // whenever the ceiling binds — the next step is where the cap is applied and said.
      result: `Vs = ${fmt(VsRaw)} kips`,
    },
    {
      ref: 'ACI 318-19 §22.5.1.2',
      label: 'Upper limit on the stirrup contribution',
      equation: "Vs ≤ Vs,max = 8√f'c·bw·d",
      substitution: `Vs,max = 8 × √${fc} × ${fmt(bw)} × ${fmt(d_shear)} / 1000`,
      result: shear.VsCapped
        ? `Vs,max = ${fmt(VsMax)} kips  — Vs CAPPED, capacity taken as ${fmt(Vs)} kips`
        : `Vs,max = ${fmt(VsMax)} kips  ✓ not governing (Vs = ${fmt(Vs)} kips)`,
      // This used to be a WARNING on the member. It is a property of the section, not a
      // defect: once Vs is at its ceiling, more or tighter links add no capacity, and if
      // φVn still covers Vu the beam is perfectly good. Reaching the ceiling is worth
      // KNOWING — it tells you which lever has stopped working — so it is reported here
      // rather than flagged there. Breaching it is a different matter and still an error:
      // see the crushing-limit step below.
      note: shear.VsCapped
        ? 'The stirrups have reached their ceiling — closer spacing or bigger links add no '
          + 'shear capacity from here. Not a failure on its own: only φVn vs Vu decides that.'
        : 'Ceiling on what stirrups can contribute, whatever the spacing.',
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
      // The number S-Concrete headlines as "V & T Util", and the only one of the three
      // that sees the SUM: §22.7.6.1's transverse demand is (A_v + 2A_t)/s, so a cage
      // can clear Shear and Torsion singly and still be short of links. Suppressed
      // below φ·T_th, where §22.7.1.1 permits torsion to be neglected outright.
      ref: 'ACI 318-19 §22.7.6.1',
      label: 'Combined shear + torsion on the links',
      equation: 'V&T util = Vu/φVn + Tu/φTn   — the same legs carry both, so the demands add',
      substitution: load.Tu > Tu_thresh
        ? `V&T = ${fmt(DCR_shear, 3)} + ${fmt(DCR_torsion, 3)}`
        : `Tu = ${fmt(load.Tu)} kip-ft ≤ φ·T_th = ${fmt(Tu_thresh)} kip-ft — §22.7.1.1 permits torsion to be neglected`,
      result: load.Tu > Tu_thresh
        ? `V&T util = ${fmt(DCR_shear + DCR_torsion, 3)}  ${DCR_shear + DCR_torsion <= 1 ? '✓ OK' : '✗ NG — more links needed'}`
        : `V&T util = ${fmt(DCR_shear, 3)} (shear alone)  ${DCR_shear <= 1 ? '✓ OK' : '✗ NG'}`,
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
      chart: { kind: 'pm', label: 'Show the P-M interaction curve' },
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

  // ── Biaxial bending (Bresler load contour) — only with a minor-axis moment ──
  // Deliberately silent on an ordinary beam: a member bent about one axis has no
  // biaxial check to show, and a section reading "Muy = 0, util = 0" on every
  // sheet would be noise that trains people to skip it.
  const biax = biaxialCheck(section, material, rebar, load, span, biaxialAlpha);
  if (biax) {
    const a = biax.alpha;
    out.push({
      title: '9. Biaxial Bending (Bresler load contour)',
      chart: { kind: 'biaxial', label: 'Show the P-M-M interaction contour' },
      steps: [
        {
          ref: 'Resultant',
          label: 'Applied moments about both axes',
          equation: 'Mres = √(Mux² + Muy²),  θ = atan2(Muy, Mux)',
          substitution: `√(${fmt(biax.Mux)}² + ${fmt(biax.Muy)}²)`,
          result: `Mres = ${fmt(biax.Mres)} kip-ft at θ = ${fmt(biax.theta, 1)}° from the major axis`,
        },
        {
          ref: 'ACI 318-19 §22.4',
          label: 'Uniaxial capacity about each axis (at this Pu)',
          equation: 'φMnx from the major-axis check; φMny from the section on its side',
          substitution: `minor axis: b×h swapped to ${fmt(section.h ?? 12)}×${fmt(section.b)} in, As ${fmt(biax.AsTotal)} in² split ${fmt(biax.AsPerSide)} in² per side face`,
          result: `φMnx = ${fmt(biax.phiMnx)} kip-ft,  φMny = ${fmt(biax.phiMny)} kip-ft`,
          note: 'The minor-axis steel is taken as half the total longitudinal area on each side face — the BarGroup model does not record where each bar sits across the width, so the exact side-face area is not recoverable. This is the approximation the contour is paired with.',
        },
        {
          ref: 'ACI 318-19 R22.4.2.1',
          label: 'Interaction contour (governing)',
          equation: '(|Mux|/φMnx)^α + (|Muy|/φMny)^α ≤ 1.0',
          substitution: `(${fmt(Math.abs(biax.Mux))}/${fmt(biax.phiMnx)})^${a} + (${fmt(Math.abs(biax.Muy))}/${fmt(biax.phiMny)})^${a}`,
          result: `util = ${fmt(biax.util, 3)}  ${biax.util <= 1 ? '✓ OK' : '✗ NG'}`,
          note: `α = ${a}. At α = 1.0 the contour is a straight line between the two axes, which is always conservative; the PCA range for rectangular sections with symmetric steel is 1.15–1.5. This is a contour interpolated between two uniaxial capacities, not an inclined-neutral-axis section analysis — expect a few percent against tools that re-integrate the section at θ.`,
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
