/**
 * ACI 318-19 Concrete Design Engine — Beams Only
 * Units: inches, psi, kips, kip-ft unless noted
 */

import type {
  MaterialProps, SectionDimensions, RebarLayout, LoadCase,
  DesignResults, DesignWarning, ComboForces, BarGroup,
} from '../types';
import { biaxialCheck, DEFAULT_BIAXIAL_ALPHA } from './biaxial';
import { beamAxialFlexure } from './axialFlexure';

// ── Stirrup zones (thirds of the span) ───────────────────────────────────────

/**
 * Which third of the span station `x` falls in. THE single binning rule — every
 * caller must go through it, because two callers binning the same station
 * differently is a real defect class: `zoneShearDemands` used to bin the raw
 * `st.x` while the engines binned the 2-dp `x` stored on the LoadCase, so a
 * station at an exact third point (13.333333 vs 13.33 on a 40 ft beam) landed in
 * zone 1 in one path and zone 0 in the other — the headline DCR then used a
 * spacing the beam does not have at that section.
 *
 * The tolerance snaps a station sitting within span/3000 of a boundary onto it,
 * so the rounded and unrounded forms of the same station agree.
 */
export function zoneIndexAtX(x: number, spanFt: number): 0 | 1 | 2 {
  if (!(spanFt > 0) || !Number.isFinite(x)) return 0;
  const t = (x / spanFt) * 3;
  const nearest = Math.round(t);
  const snapped = Math.abs(t - nearest) < 1e-3 ? nearest : t;
  return Math.min(2, Math.max(0, Math.floor(snapped))) as 0 | 1 | 2;
}

/**
 * The loosest stirrup spacing anywhere on the member.
 *
 * `ties.spacing` is NOT this: the zone editors write `Math.min(...zones)` there,
 * i.e. the TIGHTEST (end-zone) value. Detailing limits (s_max) must judge the
 * worst zone, or a middle third at double the legal spacing raises no warning.
 */
export function worstTieSpacing(rebar: RebarLayout): number {
  return rebar.tieZones?.length
    ? Math.max(...rebar.tieZones.map(z => z.spacing))
    : (rebar.ties?.spacing ?? 0);
}

/**
 * Stirrup spacing actually present at station `x` — the spacing a demand acting
 * there must be checked against.
 *
 * Rows with no station position fall back to the worst zone, so an unlocated
 * demand is judged conservatively rather than against the tightest end zone.
 */
export function tieSpacingAtX(rebar: RebarLayout, x: number | undefined, spanFt: number): number {
  const zones = rebar.tieZones;
  if (zones && zones.length === 3 && x !== undefined && spanFt > 0) {
    return zones[zoneIndexAtX(x, spanFt)].spacing;
  }
  return worstTieSpacing(rebar);
}

/** Max |V| within each third of the span — drives the zoned stirrup check. */
export function zoneShearDemands(forces: ComboForces[], spanFt: number): [number, number, number] {
  const zones: [number, number, number] = [0, 0, 0];
  for (const cf of forces) {
    for (const st of cf.stations) {
      const zi = zoneIndexAtX(st.x, spanFt);
      const v = Math.abs(st.V);
      if (v > zones[zi]) zones[zi] = v;
    }
  }
  return zones;
}

// ── Bar tables (ASTM A615) ────────────────────────────────────────────────────
/** Utilisation at which the §22.7.7.1 cross-section check earns a heads-up —
 *  the same 0.9 the rest of the app treats as "near capacity". */
const NEAR_CRUSHING = 0.9;

const BAR_AREAS: Record<number, number> = {
  3: 0.11, 4: 0.20, 5: 0.31, 6: 0.44, 7: 0.60, 8: 0.79, 9: 1.00,
  10: 1.27, 11: 1.56, 14: 2.25, 18: 4.00,
};
const BAR_DIAMS: Record<number, number> = {
  3: 0.375, 4: 0.500, 5: 0.625, 6: 0.750, 7: 0.875, 8: 1.000,
  9: 1.128, 10: 1.270, 11: 1.410, 14: 1.693, 18: 2.257,
};

// Negative barSize = metric bar Ø in mm (e.g. -16 = Ø16); returns in²/in
export function getBarArea(size: number): number {
  if (size < 0) { const d = -size / 25.4; return Math.PI * d * d / 4; }
  return BAR_AREAS[size] ?? 0;
}
/** Nominal bar diameter in INCHES. Negative barSize = metric Ø mm, converted here. */
export function getBarDiam(size: number): number {
  if (size < 0) return -size / 25.4;
  return BAR_DIAMS[size] ?? 0;
}

function getRebarAs(bars: { numBars: number; barSize: number }[]): number {
  return bars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
}

// ── Cover ─────────────────────────────────────────────────────────────────────

/** Which face a cover / depth is measured from. */
export type CoverFace = 'top' | 'bot' | 'side';

/**
 * Clear cover to the stirrup at one face. Projects set top / bottom / side
 * cover independently in the settings dialog; sections written before that (and
 * every fixture in the test suite) carry only `coverClear`, which stays the
 * fallback so their results are unchanged.
 */
export function coverFor(section: SectionDimensions, face: CoverFace): number {
  const c = face === 'top' ? section.coverTop
    : face === 'side' ? section.coverSide
      : section.coverBottom;
  return c ?? section.coverClear;
}

/**
 * Distance from the extreme tension fiber to the area-weighted centroid of a
 * multi-layer bar group. Layers are listed outermost-first; layer i sits at
 * cc + dstir + Σ_{j<i}(dbar_j + sClear) + dbar_i/2 from the face.
 * For a single layer this reduces exactly to cc + dstir + dbar/2.
 * `face` picks which cover the stack starts from — bottom bars measure up from
 * the soffit, top bars measure down from the top.
 */
export function layerCentroidOffset(
  section: SectionDimensions,
  bars: BarGroup[],
  sClear = 1.0,
  face: CoverFace = 'bot',
): number {
  const dStir = getBarDiam(section.stirrupDia);
  const cover = coverFor(section, face);
  let edge = cover + dStir; // running offset to top of next layer
  let sumA = 0, sumAy = 0;
  for (const g of bars) {
    if (g.numBars <= 0) continue;
    const db = getBarDiam(g.barSize);
    const A  = g.numBars * getBarArea(g.barSize);
    sumA  += A;
    sumAy += A * (edge + db / 2);
    edge  += db + sClear;
  }
  if (sumA <= 0) return cover + dStir + getBarDiam(8) / 2;
  return sumAy / sumA;
}

/** Per-layer (area, depth-from-face) pairs for a multi-layer bar group. */
export function layerDepths(
  section: SectionDimensions,
  bars: BarGroup[],
  sClear = 1.0,
  face: CoverFace = 'bot',
): { A: number; y: number }[] {
  const dStir = getBarDiam(section.stirrupDia);
  let edge = coverFor(section, face) + dStir;
  const out: { A: number; y: number }[] = [];
  for (const g of bars) {
    if (g.numBars <= 0) continue;
    const db = getBarDiam(g.barSize);
    out.push({ A: g.numBars * getBarArea(g.barSize), y: edge + db / 2 });
    edge += db + sClear;
  }
  return out;
}

/** Effective depth to the centroid of a (possibly multi-layer) bar group. */
export function effectiveDepthMulti(
  section: SectionDimensions,
  bars: BarGroup[],
  sClear = 1.0,
  face: CoverFace = 'bot',
): number {
  const h = section.h ?? 12;
  return h - layerCentroidOffset(section, bars, sClear, face);
}

// ── ACI helpers ───────────────────────────────────────────────────────────────

/** β₁ stress-block factor per ACI 318-19 §22.2.2.4.3 */
export function beta1(fc: number): number {
  if (fc <= 4000) return 0.85;
  return Math.max(0.65, 0.85 - 0.05 * (fc - 4000) / 1000);
}

/**
 * φ for flexure per ACI 318-19 Table 21.2.2.
 *
 * TWO things this must get right, both of which have been wrong here before:
 *
 *  • `et` is the net tensile strain in the EXTREME layer of tension steel (at
 *    dt), not at the centroid of the group (at d). §21.2.2 is explicit, and on a
 *    two-layer cage the two differ by the layer spacing — enough to move φ.
 *
 *  • The transition band runs εty → εty + 0.003, so it MOVES WITH THE GRADE.
 *    Hard-coding Grade 60's 0.002 → 0.005 mis-states φ for Grade 80/100, which
 *    §20.2.2.4 permits for flexure (εty = 0.00276 / 0.00345, not 0.002).
 */
export function phiFlexure(et: number, fy: number, Es = 29_000_000): number {
  const ety = fy / (Es > 0 ? Es : 29_000_000);
  if (et >= ety + 0.003) return 0.9;
  if (et <= ety) return 0.65;
  return 0.65 + 0.25 * (et - ety) / 0.003;
}

/**
 * Effective depth: d = h − cc − d_stirrup − d_bar/2
 * barSize: actual bar designation (8 for #8). `face` selects the cover the bar
 * is measured from (bottom steel by default).
 */
export function effectiveDepth(
  section: SectionDimensions, barSize: number, face: CoverFace = 'bot',
): number {
  const h = section.h ?? 12;
  const dStir = getBarDiam(section.stirrupDia);
  const dBar  = getBarDiam(barSize);
  return h - coverFor(section, face) - dStir - dBar / 2;
}

/** Effective flange width per ACI Table 6.3.2.1 */
export function effectiveFlange(section: SectionDimensions, spanFt: number): number {
  if (section.type === 'T_beam') {
    const bw = section.bw ?? section.b;
    const hf = section.hf ?? 4;
    return Math.min(bw + 2 * 8 * hf, spanFt * 12 / 4, section.b);
  }
  if (section.type === 'L_beam') {
    const bw = section.bw ?? section.b;
    const hf = section.hf ?? 4;
    return Math.min(bw + 6 * hf, spanFt * 12 / 12, section.b);
  }
  return section.b;
}

/**
 * As_min (§9.6.1.2) and As_max (§9.3.3.1) for the given flexural tension face.
 *
 * Both scale with depth, so the face matters once a project sets per-face covers: the
 * limits for TOP (negative-moment) steel must use the top-face depth. Defaulting to
 * 'bot' for both faces over-stated As,min for top steel by the cover difference
 * and flagged correctly-detailed members as NG.
 *
 * BOTH clauses are written on d, the centroid of the tension group.
 *
 * §9.6.1.2 always was. §9.3.3.1 used to be evaluated here on dt, the EXTREME tension
 * layer, which is the stricter reading of §2.2 ("net tensile strain in extreme layer
 * of longitudinal tension reinforcement") — and it is still, in my reading, the
 * literal one. It was changed to d on the project's instruction so the app agrees with
 * S-CONCRETE, which measures the limit at the centroid.
 *
 * The evidence for what S-CONCRETE does is unambiguous: across `Examples/ACI` 3 and
 * 5–8, ten faces, its reported As(max) back-solves to εt = εty + 0.003 measured at d,
 * exactly. Single-layer faces agree either way (d = dt); multi-layer faces differed by
 * the dt/d ratio, +1.8 % to +3.2 %, which is now gone.
 *
 * Using d is the more CONSERVATIVE of the two — d ≤ dt always, so the cap is lower and
 * the over-reinforced warning fires slightly earlier. That is the safe direction for a
 * limit, which is part of why the change is defensible even though §2.2 points the
 * other way.
 *
 * §9.3.3.1 IS SCOPED TO BEAMS. Its opening words are "For nonprestressed beams with
 * Pu < 0.10·f′c·Ag" — above that the member is a compression member and the
 * tension-controlled strain limit simply does not govern it. `asMaxApplies` reports
 * that test so a caller can tell "the cage exceeds the limit" from "the limit does not
 * apply here"; `As_max` itself is always returned, because the Calc Sheet still shows
 * the derivation and the member panel still shows the number.
 *
 * `Examples/ACI/Example 1` is the case: 12×28 carrying 1000 kips of compression
 * against a 0.10·f′c·Ag threshold of 201.6 kips. S-Concrete reports As(max) = 9.05
 * in² there against our beam-limit 7.22 — not because the formula differs but because
 * the clause has stopped applying, and we were applying it anyway.
 */
export function steelLimits(
  section: SectionDimensions,
  material: MaterialProps,
  face: CoverFace = 'bot',
  /**
   * The bars actually on this face. Both limits scale with d, and d is the
   * centroid of the REAL cage — a two-layer group sits shallower than the
   * single-#8-layer default. S-Concrete's As,min lands on the actual-d value to
   * the digit (12×28 4-#8/8-#8: 1.13 in² at d = 24.375", not 1.18 at 25.375"),
   * so the default here is a fallback for callers that have no layout, not the
   * intended input.
   */
  bars?: BarGroup[],
  sClear = 1.0,
  /** Factored axial load (kips, POSITIVE = compression) — only used for the
   *  §9.3.3.1 scope test. Omitted means 0, i.e. a plain beam. */
  Nu = 0,
) {
  const { fc, fy } = material;
  const Es = material.Es > 0 ? material.Es : 29_000_000;
  const bw = section.bw ?? section.b;
  const h  = section.h ?? 12;
  const d  = bars?.length
    ? effectiveDepthMulti(section, bars, sClear, face)
    : effectiveDepth(section, 8, face);
  const rho_min = Math.max(3 * Math.sqrt(fc) / fy, 200 / fy);
  const As_min  = rho_min * bw * d;
  // §9.3.3.1 — a nonprestressed beam must reach εt ≥ εty + 0.003 in its tension
  // reinforcement. Setting εt to that limit fixes c/d, hence a, hence As:
  //   c = d·0.003/(0.003 + εty + 0.003)  →  As,max = 0.85·β₁·(f'c/fy)·(c/d)·bw·d
  // εty comes from the grade, so the cap tightens as fy rises rather than sitting
  // at a fixed strain.
  const ety = fy / Es;
  const As_max  = 0.85 * beta1(fc) * (fc / fy) * (0.003 / (0.006 + ety)) * bw * d;
  // Compression only: axial TENSION leaves the member a beam, and the limit applies.
  const asMaxApplies = Nu < 0.10 * fc * bw * (section.h ?? 12) / 1000;
  return { As_min, As_max, asMaxApplies };
}

/**
 * The §9.6.1 minimum-steel verdict for ONE flexural face, in one place.
 *
 * Exported because the Calc Sheet has to reach the same answer the engine reached.
 * It used to re-derive §9.6.1.2 locally and stop there — printing the RAW minimum and
 * a "⚠ Provided As_bot < As,min" note on beams the engine had already exempted under
 * §9.6.1.3. Same beam, same load row, panel silent and sheet warning.
 *
 * §9.6.1.3: "If As provided at every section is at least one-third greater than As
 * required by analysis, 9.6.1.2 need not be satisfied." The baseline is therefore the
 * flexural requirement ALONE — `requiredAs` floors its result at As,min, and measuring
 * the exemption against a floored number would compare As,min with itself and the
 * exception would never apply.
 *
 * Expressed as a lowered threshold rather than a skipped check, which is the same test
 * (`As < min(As_min, 4/3·As_req)` fires exactly when As is below the minimum AND not
 * one-third clear of the demand) and leaves one number to report. S-Concrete reports
 * the reduced figure too — 0.71 in² where the raw minimum is 0.875 — so a reader
 * comparing the two tools sees the same kind of number.
 */
export function minSteelCheck(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  face: CoverFace,
  /** The moment acting on THIS face, kip-ft. Zero means the face carries no tension,
   *  and §9.6.1.1 asks for a minimum only where tension steel is required. */
  Mu_kft: number,
  span = 20,
  sClear = 1.0,
): { As_min: number; As_min_eff: number; As_req_raw: number; exempt: boolean } {
  const isTop = face === 'top';
  const bars = isTop ? rebar.topBars : rebar.botBars;
  const { As_min } = steelLimits(section, material, face, bars, sClear);

  // As required by analysis, unfloored. Hogging puts the flange in tension, so the
  // compression block is the web alone; sagging gets the effective flange.
  let As_req_raw = 0;
  if (Mu_kft > 0) {
    const { fc, fy } = material;
    const bw = section.bw ?? section.b;
    const d = bars?.length
      ? effectiveDepthMulti(section, bars, sClear, face)
      : effectiveDepth(section, 8, face);
    const buse = isTop ? bw : effectiveFlange(section, span);
    const Rn = (Mu_kft * 12000) / (0.9 * buse * d * d);
    const rho = (0.85 * fc / fy) * (1 - Math.sqrt(Math.max(0, 1 - 2 * Rn / (0.85 * fc))));
    As_req_raw = Math.max(0, rho) * buse * d;
  }

  const As_min_eff = As_req_raw > 0 ? Math.min(As_min, (4 / 3) * As_req_raw) : As_min;
  return { As_min, As_min_eff, As_req_raw, exempt: As_min_eff < As_min - 1e-9 };
}

// ── Flexure (ACI §22.3) ───────────────────────────────────────────────────────

export function computeFlexure(
  section: SectionDimensions,
  material: MaterialProps,
  As_top: number,
  As_bot: number,
  span = 20,
  topBarSize = 8,
  botBarSize = 8,
  topBars?: BarGroup[],
  botBars?: BarGroup[],
  layerClearSpacing = 1.0,
): {
  phi_Mn_pos: number; phi_Mn_neg: number;
  Mn_pos: number;     Mn_neg: number;
  a_pos: number;      a_neg: number;
  phi_pos: number;    phi_neg: number;
  /** Which derivation produced `a` — the Calc Sheet must print the one that ran. */
  mode_pos: 'singly' | 'doubly' | 'flanged';
  mode_neg: 'singly' | 'doubly' | 'flanged';
} {
  const { fc, fy } = material;
  const Es = material.Es > 0 ? material.Es : 29_000_000;
  const b1 = beta1(fc);
  const h  = section.h ?? 12;
  const beff = effectiveFlange(section, span);
  const bw   = section.bw ?? section.b;

  // Sagging: tension steel is at the bottom, so d_pos is set by the BOTTOM
  // cover; hogging reads the TOP cover. Each d' mirrors it on the opposite face.
  const d_pos = botBars?.length
    ? effectiveDepthMulti(section, botBars, layerClearSpacing, 'bot')
    : effectiveDepth(section, botBarSize, 'bot');
  const d_neg = topBars?.length
    ? effectiveDepthMulti(section, topBars, layerClearSpacing, 'top')
    : effectiveDepth(section, topBarSize, 'top');

  // Depth to the EXTREME layer of tension steel (dt), which is what §21.2.2
  // measures εt at. On a single-layer cage dt = d; on a two-layer cage it is
  // deeper by the layer spacing, and using d there under-reads φ.
  const dt_pos = botBars?.length
    ? h - Math.min(...layerDepths(section, botBars, layerClearSpacing, 'bot').map(l => l.y))
    : d_pos;
  const dt_neg = topBars?.length
    ? h - Math.min(...layerDepths(section, topBars, layerClearSpacing, 'top').map(l => l.y))
    : d_neg;

  // d' for compression steel: distance from the COMPRESSION FACE to the
  // comp-steel centroid. The fallback must be that offset — not h − offset,
  // which is the depth of the bar from the opposite face and put the "compression"
  // steel near the tension fibre, silently disabling the doubly path.
  const d_prime_pos = topBars?.length
    ? layerCentroidOffset(section, topBars, layerClearSpacing, 'top')
    : coverFor(section, 'top') + getBarDiam(section.stirrupDia) + getBarDiam(topBarSize) / 2;
  const d_prime_neg = botBars?.length
    ? layerCentroidOffset(section, botBars, layerClearSpacing, 'bot')
    : coverFor(section, 'bot') + getBarDiam(section.stirrupDia) + getBarDiam(botBarSize) / 2;

  function calcMn(
    As: number, d: number, dt: number, bFlange: number,
    /**
     * Is the flange on the COMPRESSION side at this section? Sagging puts it
     * there; hogging puts it in tension, and the compression zone is then the
     * plain rectangular web. Getting this wrong is not academic: the flange
     * split ran for hogging with bFlange = bw, so Cf collapsed to zero while
     * `a = a_web + hf` still added the flange depth — reporting a stress block a
     * whole hf too deep and a lever arm a whole hf too short.
     */
    flangeInComp: boolean,
    As_prime = 0, d_prime = 0,
    compLayers?: { A: number; y: number }[],
  ): { Mn: number; a: number; phi: number; mode: 'singly' | 'doubly' | 'flanged' } {
    if (As <= 0) return { Mn: 0, a: 0, phi: 0.9, mode: 'singly' };

    const hf = section.hf ?? h;
    const a_sr = (As * fy) / (0.85 * fc * bFlange);
    // The compression zone only leaves the flange when the flange is the thing
    // being compressed in the first place.
    const flangeSplits = flangeInComp && a_sr > hf;

    // Doubly-reinforced rectangular compression zone (As' > 0, comp steel inside it).
    // First check via the singly-reinforced c whether the "compression" steel really is
    // in compression.
    if (As_prime > 0 && !flangeSplits) {
      const c_sr = a_sr / b1;
      // Per-layer compression steel: each layer at its own depth with its own
      // strain-compatible stress (reduces to the lumped-centroid result for one layer)
      const layers = compLayers && compLayers.length > 0
        ? compLayers
        : [{ A: As_prime, y: d_prime }];
      if (c_sr > Math.min(...layers.map(l => l.y))) {
        // At least one comp layer is inside the compression zone — solve equilibrium
        const Cs_of = (c: number) => layers.reduce((sum, l) => {
          const eps = 0.003 * (c - l.y) / c;
          const fs = Math.min(Math.max(eps * Es, -fy), fy);
          // displace concrete only where the bar sits inside the stress block
          const disp = l.y < b1 * c ? 0.85 * fc : 0;
          return sum + l.A * (fs - disp);
        }, 0);
        // Solve 0.85·f'c·b·a + Cs(c) = As·fy for c, by BISECTION.
        //
        // The natural-looking damped fixed point on `a` that used to sit here
        // (a ← ½[a + (As·fy − Cs(a/β₁))/(0.85f'c·b)]) diverges as soon as the
        // compression steel is comparable to the tension steel — hogging over a
        // beam with a heavy bottom cage, say. Cs is then so sensitive to c that
        // the map's slope exceeds 1, the loop oscillates, runs out of iterations
        // and returns whatever the last average happened to be: on a 60/12×24
        // T-beam with 6-#9 bottom it settled on a = 5.98" against a true 2.69".
        //
        // The residual is increasing in c (Cc grows linearly, every bar stress
        // grows with c) apart from the small step down where a bar crosses out
        // of the stress block, and it is bracketed for free: at c → 0 every bar
        // is in tension so it is −(As + As')·fy, and at large c it is unbounded
        // above. Bisection on that is unconditionally convergent.
        const resid = (c: number) => 0.85 * fc * bFlange * b1 * c + Cs_of(c) - As * fy;
        let lo = 1e-6, hi = Math.max(2 * h, 2 * c_sr) / b1;
        if (resid(hi) < 0) {
          lo = hi;                       // cannot equilibrate — take the deepest block
        } else {
          for (let i = 0; i < 100; i++) {
            const mid = 0.5 * (lo + hi);
            if (resid(mid) < 0) lo = mid; else hi = mid;
          }
        }
        const c = Math.max(0.5 * (lo + hi), 1e-4);
        const a = Math.max(b1 * c, 0.001);
        // Comp steel can push `a` back OUT of the flange (net Cs negative, when the
        // deeper comp layers sit below the axis and pull). The block would then be
        // narrower than beff below the flange and this solve no longer describes it,
        // so drop the compression-steel credit and keep the singly result, which is
        // inside the flange by construction (a_sr ≤ hf to have reached here).
        if (!(flangeInComp && a > hf)) {
          const phi = phiFlexure(0.003 * (dt - c) / c, fy, Es);
          const Cc = 0.85 * fc * bFlange * a;
          const Ms = layers.reduce((sum, l) => {
            const eps = 0.003 * (c - l.y) / c;
            const fs = Math.min(Math.max(eps * Es, -fy), fy);
            const disp = l.y < b1 * c ? 0.85 * fc : 0;
            return sum + l.A * (fs - disp) * (d - l.y);
          }, 0);
          const Mn = (Cc * (d - a / 2) + Ms) / 12000;
          return { Mn, a, phi, mode: 'doubly' };
        }
      }
      // Comp steel in tension zone — fall through to singly-reinforced
    }

    if (flangeSplits) {
      // Flange + web compression split
      const Cf = 0.85 * fc * (bFlange - bw) * hf;
      const Cw = As * fy - Cf;
      const a_web = Cw / (0.85 * fc * bw);
      const a = a_web + hf;
      const Mn_flange = Cf * (d - hf / 2) / 12000;
      const Mn_web    = Cw * (d - hf - a_web / 2) / 12000;
      const Mn = Mn_flange + Mn_web;
      const c = a / b1;
      return { Mn, a, phi: phiFlexure(0.003 * (dt - c) / c, fy, Es), mode: 'flanged' };
    }

    const a = a_sr;
    const c = a / b1;
    const Mn = As * fy * (d - a / 2) / 12000;
    return { Mn, a, phi: phiFlexure(0.003 * (dt - c) / c, fy, Es), mode: 'singly' };
  }

  const compLayersPos = topBars?.length ? layerDepths(section, topBars, layerClearSpacing, 'top') : undefined;
  const compLayersNeg = botBars?.length ? layerDepths(section, botBars, layerClearSpacing, 'bot') : undefined;
  const isFlanged = section.type === 'T_beam' || section.type === 'L_beam';
  // Sagging compresses the flange; hogging compresses the web only (bw).
  const pos = calcMn(As_bot, d_pos, dt_pos, beff, isFlanged, As_top, d_prime_pos, compLayersPos);
  const neg = calcMn(As_top, d_neg, dt_neg, bw, false, As_bot, d_prime_neg, compLayersNeg);

  return {
    Mn_pos: pos.Mn,      Mn_neg: neg.Mn,
    phi_Mn_pos: pos.phi * pos.Mn,
    phi_Mn_neg: neg.phi * neg.Mn,
    a_pos: pos.a,        a_neg: neg.a,
    phi_pos: pos.phi,    phi_neg: neg.phi,
    mode_pos: pos.mode,  mode_neg: neg.mode,
  };
}

// ── Shear (ACI §22.5) ─────────────────────────────────────────────────────────

export function computeShear(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  Nu = 0,
  /**
   * Stirrup spacing to design with, overriding `rebar.ties.spacing`. Callers pass
   * the spacing of the zone the demand actually sits in (see `tieSpacingAtX`);
   * `ties.spacing` alone is the TIGHTEST zone and would credit end-zone capacity
   * to a mid-span demand.
   */
  spacingOverride?: number,
  /**
   * Flexural TENSION face at this section. ACI §22.5 measures d to the centroid of
   * the longitudinal tension steel, which for hogging shear at a support is the TOP
   * steel. Hard-coding 'bot' overstated d at exactly the section where shear governs
   * once a project set a deeper top cover, making Vc, Vs, s_max and the §9.6.3.1
   * trigger all unconservative.
   */
  tensionFace: CoverFace = 'bot',
): { Vc: number; Vs: number; phi_Vn: number; Av_req: number; Av_prov: number; d_shear: number; Av_min_per_s: number; VsCapped: boolean } {
  const { fc, fyt, lambdaConcrete } = material;
  const bw  = section.bw ?? section.b;
  const h   = section.h ?? 12;
  const phi = 0.75;

  // d to the actual outermost tension-bar centroid (multi-layer aware).
  // A face with NO bars cannot define d or ρw, so fall back to the opposite face
  // rather than collapsing them: `getRebarAs([])` is 0, which would drive ρw to the
  // 1e-6 clamp and take Vc — and so the whole shear check — to nearly zero on any
  // hogging row of a member detailed without top steel.
  const faceBars = tensionFace === 'top' ? rebar.topBars : rebar.botBars;
  const tensionBars = faceBars?.length ? faceBars : (tensionFace === 'top' ? rebar.botBars : rebar.topBars);
  const dFace: CoverFace = faceBars?.length ? tensionFace : (tensionFace === 'top' ? 'bot' : 'top');
  const d_raw   = tensionBars?.length
    ? effectiveDepthMulti(section, tensionBars, rebar.layerClearSpacing ?? 1.0, dFace)
    : effectiveDepth(section, 8, dFace);
  const d_shear = Math.max(d_raw, 0.8 * h);

  const Av_min_per_s = Math.max(0.75 * Math.sqrt(fc) / fyt, 50 / fyt) * bw;

  const ties = rebar.ties;
  // The spacing every stirrup term below is built from.
  const s_eff = spacingOverride ?? ties?.spacing ?? 0;
  let Vs = 0;
  let Av_prov = 0;
  let VsCapped = false;
  if (ties && s_eff > 0) {
    Av_prov = ties.legs * getBarArea(ties.barSize);
    Vs = (Av_prov * fyt * d_shear) / (s_eff * 1000);
    // Vs ≤ 8√f'c·bw·d (ACI §22.5.1.2 upper limit on Vn − Vc)
    const VsMax = 8 * Math.sqrt(fc) * bw * d_shear / 1000;
    if (Vs > VsMax) { Vs = VsMax; VsCapped = true; }
  }

  // ρw in Table 22.5.5.1 is the ratio of the same tension steel d is measured to.
  const As_tension = getRebarAs(tensionBars);
  const rho_w  = As_tension / (bw * d_shear);

  // Bug 4 fix: λs only applies when Av/s < Av,min/s (ACI §22.5.5.1.1)
  const Av_s_prov = ties && s_eff > 0 ? (ties.legs * getBarArea(ties.barSize)) / s_eff : 0;
  const hasMinStirrups = Av_s_prov >= Av_min_per_s;
  const lambda_s = hasMinStirrups ? 1.0 : Math.min(1.0, Math.sqrt(2 / (1 + 0.004 * d_shear)));

  const Ag = bw * h;

  // ACI Table 22.5.5.1: when Av/s ≥ Av,min/s use max(case a, case b); otherwise case b/c with λs
  //
  // Nu/(6·Ag) is a STRESS and sits beside √f'c, so it must be in psi — i.e. Nu in
  // POUNDS. `load.Pu` is in kips (see DesignResults), so it is scaled here. Passing
  // kips straight in made the term 1000× too small: the axial effect all but
  // vanished (a 1000 kip load moved φVn by 0.1 kip), which understates Vc for
  // compression and — the dangerous direction — fails to remove the concrete
  // contribution the code deletes under axial TENSION.
  //
  // Table 22.5.5.1 footnote caps the term at 0.05f'c; the EC2 twin does the same
  // through σcp (ec2Beam.ts vRdc), which is where this was modelled from.
  const Nu_term = Math.min(Nu * 1000 / (6 * Ag), 0.05 * fc);
  const Vc_b = (8 * lambdaConcrete * lambda_s * Math.pow(Math.max(rho_w, 1e-6), 1 / 3) * Math.sqrt(fc) + Nu_term) * bw * d_shear / 1000;
  let Vc: number;
  if (hasMinStirrups) {
    const Vc_a = (2 * lambdaConcrete * Math.sqrt(fc) + Nu_term) * bw * d_shear / 1000;
    Vc = Math.max(Vc_a, Vc_b);
  } else {
    Vc = Vc_b;
  }
  // Table 22.5.5.1's limit — Vc ≤ 5λ√f'c·bw·d — sits under the WHOLE table, so it
  // binds expression (c) as well as (a) and (b). It used to be applied only inside
  // the has-minimum-stirrups branch, which left the axial term free to run away on a
  // member detailed without them: Nu/(6Ag) is capped at 0.05f'c, but 8λs·ρw^⅓√f'c +
  // 0.05f'c clears 5√f'c on any well-reinforced web, and the error is unconservative.
  //
  // S-Concrete applies it: Example 1 (1000 kip compression, 12×28, f'c 6000) reports
  // ØVcz = 85.0 kips, which is 0.75 × 5√6000·bw·d exactly — the uncapped value would
  // have been 99.8.
  const Vc_cap = 5 * lambdaConcrete * Math.sqrt(fc) * bw * d_shear / 1000;
  if (Vc > Vc_cap) Vc = Vc_cap;
  // Enough axial tension drives both expressions negative — the concrete
  // contribution is then zero, not a negative capacity to be subtracted.
  if (Vc < 0) Vc = 0;

  return { Vc, Vs, phi_Vn: phi * (Vc + Vs), Av_req: 0, Av_prov, d_shear, Av_min_per_s, VsCapped };
}

// ── Zoned shear (three stirrup spacings over thirds of the span) ─────────────

export interface ZoneShearResult {
  zone: 0 | 1 | 2;     // end / middle / end third
  spacing: number;     // stirrup spacing in this zone (in)
  Vu: number;          // max |V| demand within the zone (kips)
  phi_Vn: number;      // capacity with this zone's spacing (kips)
  DCR: number;
}

/**
 * Per-zone shear check for beams with `rebar.tieZones`. Each zone's capacity
 * comes from the same `computeShear` the single-spacing check uses, with the
 * zone's spacing substituted — so the calc sheet, diagrams, and results screen
 * all agree. `zoneVu` is the max |V| within each third (from station forces);
 * with no station data pass the single governing Vu for all three zones.
 */
export function zonedShearCheck(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  zoneVu: [number, number, number],
  Nu = 0,
  /** Must match the face designMember used for the headline row, or this table
   *  reports a different d (and so a different DCR) for the very same zone. */
  tensionFace: CoverFace = 'bot',
): ZoneShearResult[] {
  const zones = rebar.tieZones;
  if (!zones || !rebar.ties) return [];
  return zones.map((z, i) => {
    const zonedRebar: RebarLayout = { ...rebar, ties: { ...rebar.ties!, spacing: z.spacing } };
    const r = computeShear(section, material, zonedRebar, Nu, z.spacing, tensionFace);
    return {
      zone: i as 0 | 1 | 2,
      spacing: z.spacing,
      Vu: zoneVu[i],
      phi_Vn: r.phi_Vn,
      DCR: r.phi_Vn > 0 ? zoneVu[i] / r.phi_Vn : 0,
    };
  });
}

// ── Torsion (ACI §22.7) ───────────────────────────────────────────────────────

/**
 * Closed-stirrup centreline geometry — the basis of every torsion quantity.
 *
 * The width shrinks by the two SIDE covers, the depth by the top and bottom
 * covers (all three equal unless the project sets them separately, which is the
 * legacy behaviour). Shared by the §22.7.6 capacity and the §22.7.7.1
 * cross-section check so the two can never drift apart.
 *
 *   Aoh = area enclosed by the stirrup centreline  (ACI §2.2)
 *   Ao  = 0.85·Aoh                                  (§22.7.6.1.1)
 *   Ph  = perimeter of that centreline
 */
export function closedStirrupGeometry(
  section: SectionDimensions,
): { x0: number; y0: number; Aoh: number; Ao: number; Ph: number } {
  const b = section.b;
  const h = section.h ?? 12;
  const dStir_2 = getBarDiam(section.stirrupDia) / 2;
  const x0 = b - 2 * (coverFor(section, 'side') + dStir_2);
  const y0 = h - (coverFor(section, 'top') + dStir_2) - (coverFor(section, 'bot') + dStir_2);
  const Aoh = x0 * y0;
  return { x0, y0, Aoh, Ao: 0.85 * Aoh, Ph: 2 * (x0 + y0) };
}

/**
 * ACI 318-19 §22.7.7.1 — cross-sectional dimensions for combined shear and
 * torsion. Shear and torsion both put diagonal compression into the web, and
 * past a limit the concrete crushes no matter how many stirrups are added. For
 * a SOLID section the two stresses combine as a root-sum-square:
 *
 *   √[(Vu/(bw·d))² + (Tu·ph/(1.7·Aoh²))²]  ≤  φ·(Vc/(bw·d) + 8λ√f'c)
 *
 * Every term is a stress in psi. Failing it means ENLARGE THE SECTION — extra
 * links do not help, which is why it is reported separately from the §22.7.6
 * torsion capacity.
 *
 * λ is carried on the 8√f'c term for consistency with §22.5 (ACI prints the
 * equation without it; including it only ever makes lightweight concrete more
 * conservative, and is a no-op at λ = 1).
 *
 * `Vc` is the UNFACTORED concrete shear from computeShear — so the axial load
 * already baked into it flows through to this check too.
 */
export function torsionCrushing(
  section: SectionDimensions,
  material: MaterialProps,
  Vu: number,   // kips
  Vc: number,   // kips, unfactored
  Tu: number,   // kip-ft
  d: number,    // in — the same effective depth the shear check used
): { util: number; Tn_max: number; vu: number; tu: number; limit: number } {
  const { fc, lambdaConcrete } = material;
  const bw = section.bw ?? section.b;
  const { Aoh, Ph } = closedStirrupGeometry(section);
  const bd = bw * d;
  if (bd <= 0 || Aoh <= 0 || Ph <= 0) return { util: 0, Tn_max: 0, vu: 0, tu: 0, limit: 0 };

  const vu = (Vu * 1000) / bd;                                  // psi
  const tu = (Tu * 12000) * Ph / (1.7 * Aoh * Aoh);             // psi
  const limit = 0.75 * ((Vc * 1000) / bd + 8 * lambdaConcrete * Math.sqrt(fc));
  const util = limit > 0 ? Math.hypot(vu, tu) / limit : 0;

  // Torsion that would exactly exhaust the section alongside this Vu — the
  // headroom left after shear has taken its share. Zero once shear alone
  // already reaches the limit.
  const rem = limit * limit - vu * vu;
  const Tn_max = rem > 0 ? Math.sqrt(rem) * 1.7 * Aoh * Aoh / Ph / 12000 : 0;

  return { util, Tn_max, vu, tu, limit };
}

/**
 * Torsion per ACI 318-19 §22.7 — cracking torque, the threshold below which torsion may
 * be neglected (§22.7.4), and the design capacity φTn from the closed stirrups.
 *
 * Two details that matter to callers: capacity uses the CLOSED-stirrup spacing at the
 * demand's own station (pass `spacingOverride` for a zoned member, exactly as
 * `computeShear` does), and axial load feeds the §22.7.5.1 modifier — compression raises
 * the cracking torque, so omitting Nu is the conservative default rather than a no-op.
 */
export function computeTorsion(
  section: SectionDimensions,
  material: MaterialProps,
  rebar?: RebarLayout,
  /** Closed-stirrup spacing at the demand's station — see `computeShear`. */
  spacingOverride?: number,
  /**
   * Factored axial load acting with Tu (kips, POSITIVE = compression, matching
   * LoadCase.Pu and ACI's own sign convention for Nu). Drives the §22.7.5.1
   * modifier below. Defaults to 0, which reproduces the no-axial formulas exactly.
   */
  Nu = 0,
): { Tcr: number; Tu_threshold: number; phi_Tn: number; Ph: number; axialFactor: number } {
  const { fc, fyt, lambdaConcrete } = material;
  const b   = section.b;
  const h   = section.h ?? 12;
  const phi = 0.75;

  const Acp = b * h;
  const Pcp = 2 * (b + h);

  /**
   * ACI §22.7.5.1 / Table 22.7.4.1(a) axial modifier √(1 + Nu/(4·Ag·λ√f'c)).
   *
   * Compression delays torsional cracking and tension brings it forward, so
   * omitting this overstates both the cracking torsion AND the threshold below
   * which torsion may be neglected — on the reference 12×28 under 50 kips of
   * tension, φTcr read 27.3 kip-ft against S-Concrete's 19.7.
   *
   * Nu sits beside a force (4·Ag·λ√f'c is in lb) so it must be in POUNDS;
   * LoadCase.Pu is kips, hence the ×1000 — the same unit trap the shear
   * Nu/(6·Ag) term fell into. For a SOLID section Acp is the area enclosed by
   * the outside perimeter, i.e. the gross area, so it doubles as Ag here.
   * Enough tension drives the radicand negative: the concrete's torsional
   * resistance is then gone, not imaginary.
   */
  const lamSqrtFc = lambdaConcrete * Math.sqrt(fc);
  const axialFactor = Math.sqrt(Math.max(0, 1 + (Nu * 1000) / (4 * Acp * lamSqrtFc)));

  // True cracking torsion: Tcr = 4λ√f'c·(Acp²/Pcp)·√(1 + Nu/(4Ag·λ√f'c))
  const Tcr          = (4 * lamSqrtFc * Acp * Acp / Pcp) * axialFactor / 12000;
  // Threshold below which torsion may be neglected: φ·λ√f'c·Acp²/Pcp (= φ·Tcr/4)
  const Tu_threshold = phi * lamSqrtFc * Acp * Acp / Pcp * axialFactor / 12000;

  const { Ao, Ph } = closedStirrupGeometry(section);

  // ACI §22.7.6.1: φTn = φ · 2·Ao · (At/s) · fyt  [θ = 45°, cot 45° = 1]
  // At = area of one leg of closed stirrup; use single leg per side
  let phi_Tn = 0;
  const s_eff = spacingOverride ?? rebar?.ties?.spacing ?? 0;
  if (rebar?.ties && Ao > 0 && s_eff > 0) {
    const At_s = getBarArea(rebar.ties.barSize) / s_eff; // in²/in per leg
    // Tn = 2·Ao·(At/s)·fyt — in²·(in²/in)·psi = lb-in → /12000 kip-ft
    phi_Tn = phi * 2 * Ao * At_s * fyt / 12000;
  }

  return { Tcr, Tu_threshold, phi_Tn, Ph, axialFactor };
}

// ── Required steel ────────────────────────────────────────────────────────────

export function requiredAs(
  Mu_kft: number,
  section: SectionDimensions,
  material: MaterialProps,
  isTop: boolean,
  span = 20,
): number {
  if (Mu_kft <= 0) return 0;
  const { fc, fy } = material;
  const Mu    = Mu_kft * 12000; // lb-in
  const d     = effectiveDepth(section, 8, isTop ? 'top' : 'bot');
  const beff  = isTop ? (section.bw ?? section.b) : effectiveFlange(section, span);
  const phi   = 0.9;

  const Rn  = Mu / (phi * beff * d * d);
  let   rho = (0.85 * fc / fy) * (1 - Math.sqrt(Math.max(0, 1 - 2 * Rn / (0.85 * fc))));
  if (isNaN(rho) || rho < 0) rho = 0;

  // Same face as `d` above — the bottom-face floor is built from a deeper d and
  // would overstate the top-steel requirement by the cover difference.
  const { As_min } = steelLimits(section, material, isTop ? 'top' : 'bot');
  return Math.max(rho * beff * d, As_min);
}

// ── Full member design ────────────────────────────────────────────────────────

export function designMember(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  span = 20,
  /** Bresler contour exponent for the biaxial check. Project setting; 1.0 = linear
   *  and conservative. Ignored unless the load carries a minor-axis moment. */
  biaxialAlpha: number = DEFAULT_BIAXIAL_ALPHA,
): DesignResults {
  const warnings: DesignWarning[] = [];
  const { fc, fy, fyt, lambdaConcrete } = material;
  const bw      = section.bw ?? section.b;
  const h       = section.h ?? 12;
  const phi_v   = 0.75;

  const As_top = getRebarAs(rebar.topBars);
  const As_bot = getRebarAs(rebar.botBars);

  const sClear = rebar.layerClearSpacing ?? 1.0;
  const flex   = computeFlexure(section, material, As_top, As_bot, span,
    rebar.topBars[0]?.barSize ?? 8, rebar.botBars[0]?.barSize ?? 8,
    rebar.topBars, rebar.botBars, sClear);
  // Zoned stirrups: `ties.spacing` holds the TIGHTEST (end-zone) value, so two
  // different spacings matter and must not be confused —
  //   • capacity for THIS load row → the zone containing its station (load.x).
  //     The demand and the steel resisting it are then the same section.
  //   • detailing limits (s_max)   → the WORST (loosest) zone, which is a
  //     property of the member, not of any one station.
  // Rows with no station fall back to the worst zone (conservative).
  const zoneSpacing  = tieSpacingAtX(rebar, load.x, span);
  const worstSpacing = worstTieSpacing(rebar);

  // Shear d is measured to the flexural TENSION steel at this section — the top
  // bars where the row is hogging (the support, where shear peaks).
  const shearFace: CoverFace = load.Mu_neg > load.Mu_pos ? 'top' : 'bot';
  const shear   = computeShear(section, material, rebar, load.Pu, zoneSpacing, shearFace);
  const torsion = computeTorsion(section, material, rebar, zoneSpacing, load.Pu);
  // §22.7.7.1 cross-section limit — needs the shear result, so it runs after it.
  const crushing = torsionCrushing(section, material, load.Vu, shear.Vc, load.Tu, shear.d_shear);

  // Per-face limits: As,min/As,max scale with d, which differs top vs bottom once
  // the project sets per-face covers.
  const { As_min, As_max, asMaxApplies } = steelLimits(section, material, 'bot', rebar.botBars, sClear, load.Pu);
  const { As_min: As_min_top, As_max: As_max_top } = steelLimits(section, material, 'top', rebar.topBars, sClear, load.Pu);
  const d = shear.d_shear;
  // Member-level detailing d — §9.6.3.1's trigger and §9.7.6.2.2's s_max describe
  // the MEMBER, so they must not swing with which face a given row puts in tension
  // (a hogging row with a deeper top-face d would otherwise raise the trigger and
  // suppress a "min shear reinf required" error a sagging row reports). Take the
  // smaller of the two faces: the conservative one for both limits.
  const d_detail = Math.min(
    computeShear(section, material, rebar, load.Pu, zoneSpacing, 'bot').d_shear,
    computeShear(section, material, rebar, load.Pu, zoneSpacing, 'top').d_shear,
  );

  const As_req_pos = requiredAs(load.Mu_pos, section, material, false, span);
  const As_req_neg = requiredAs(load.Mu_neg, section, material, true,  span);

  // Required Av/s (ACI §22.5.10.5)
  const Vu_net = Math.max(0, load.Vu - phi_v * shear.Vc);
  const Av_req = Vu_net > 0 ? Vu_net / (phi_v * fyt * d / 1000) : 0;

  // Minimum Av/s (ACI §9.6.3.3)
  const Av_min_per_s = Math.max(0.75 * Math.sqrt(fc) / fyt, 50 / fyt) * bw;

  // §9.6.1.2 + the §9.6.1.3 one-third exception, per face. Shared with the Calc Sheet
  // via `minSteelCheck` so the two cannot print different verdicts for one beam.
  const minPos = minSteelCheck(section, material, rebar, 'bot', load.Mu_pos, span, sClear);
  const minNeg = minSteelCheck(section, material, rebar, 'top', load.Mu_neg, span, sClear);
  const As_min_pos_eff = minPos.As_min_eff;
  const As_min_neg_eff = minNeg.As_min_eff;

  // DCRs
  // ── Axial–flexure interaction (ACI §22.4) ──────────────────────────────────
  // A beam carrying axial load does not have its pure-bending moment capacity.
  // With Pu ≠ 0 the reported φMn becomes the capacity AT that axial load and the
  // governing check is the combined N-vs-M utilisation. Pu = 0 skips all of this
  // and keeps the pure-flexure capacity untouched.
  const pm = load.Pu !== 0
    ? {
      pos: beamAxialFlexure(section, material, rebar, span, 'pos', flex.phi_Mn_pos, load.Pu, load.Mu_pos),
      neg: beamAxialFlexure(section, material, rebar, span, 'neg', flex.phi_Mn_neg, load.Pu, load.Mu_neg),
    }
    : undefined;

  const phi_Mn_pos = pm ? pm.pos.phiMnAtPu : flex.phi_Mn_pos;
  const phi_Mn_neg = pm ? pm.neg.phiMnAtPu : flex.phi_Mn_neg;

  const DCR_flex_pos = phi_Mn_pos > 0 ? load.Mu_pos / phi_Mn_pos : 0;
  const DCR_flex_neg = phi_Mn_neg > 0 ? load.Mu_neg / phi_Mn_neg : 0;
  const DCR_shear    = shear.phi_Vn   > 0 ? load.Vu     / shear.phi_Vn    : 0;
  const DCR_torsion  = torsion.phi_Tn > 0 ? load.Tu     / torsion.phi_Tn  : 0;
  /**
   * Combined shear + torsion on the LINKS — ACI §22.7.6.1, and the number S-Concrete
   * headlines as "V & T Util".
   *
   * The same stirrup legs resist both actions, so the required areas add:
   * (A_v + 2A_t)/s. Dividing that by what is provided is the same thing as adding the
   * two utilisations, which is exactly what S-Concrete prints — it reproduces on all
   * four reference examples, including the one that fails:
   *
   *   Ex 1  0.374 + 0     = 0.374     Ex 3  0.483 + 0     = 0.483
   *   Ex 2  0.556 + 0     = 0.556     Ex 4  0.226 + 2.844 = 3.070
   *
   * Neither DCR_shear nor DCR_torsion sees the sum: each credits the FULL stirrup to
   * its own action, so a beam carrying real shear and real torsion could pass both and
   * still be short of links. EC2 has carried this as `VT_util` from the start; ACI had
   * no equivalent.
   *
   * Gated on §22.7.1.1 — below φ·T_th torsion may be neglected outright, and adding a
   * utilisation the code says to ignore would over-report. Above it, VT_util ≥
   * DCR_shear always, so a shear-only member is never made to look worse.
   */
  const torsionDesignedFor = load.Tu > torsion.Tu_threshold;
  const VT_util = torsionDesignedFor ? DCR_shear + DCR_torsion : DCR_shear;
  // Governing combined utilisation across both bending senses.
  const DCR_PM = pm ? Math.max(pm.pos.nmUtil, pm.neg.nmUtil) : undefined;
  const axialUtil = pm ? pm.pos.axialUtil : undefined;

  // ── Biaxial bending (Bresler load contour) ─────────────────────────────────
  // Only runs when a minor-axis moment is actually present: a uniaxially-loaded
  // beam — which is nearly every beam in a normal model — must not acquire a
  // second utilisation out of nowhere. See utils/biaxial.ts for the method and
  // its assumptions.
  const biax = biaxialCheck(section, material, rebar, load, span, biaxialAlpha);
  const NM_util = biax?.util;

  // ── Warnings ────────────────────────────────────────────────────────────────

  // Steel limits ACI §9.3.3 / §9.6.1.2
  // PER FACE, and only where the face is in flexural TENSION.
  //
  // Each face is compared against its OWN limit — `As_max` is built from botBars on the
  // bottom depth, `As_max_top` from topBars on the top depth — so an asymmetric cage is
  // judged correctly on both sides rather than against one shared number.
  //
  // NOT gated on the moment, unlike §9.6.1.2 above. As,max asks whether this cage would
  // be compression-controlled IF this face were the tension face — a property of the
  // section and its steel, not of one load row. S-Concrete reports it that way: on
  // `Examples/ACI/Example 1` the top face carries no hogging at all, and its As'(min)
  // is duly reported as 0.00, but its As'(max) is still a real 7.38 in². Gating this on
  // Mu was tried and backed out on that evidence.
  //
  // The axial scope DOES apply: above 0.10·f′c·Ag the member is a compression member and
  // §9.3.3.1 says nothing about it — see `steelLimits`.
  if (asMaxApplies && As_bot > As_max)
    warnings.push({ code: 'ACI §9.3.3', message: `Bottom steel ${As_bot.toFixed(2)} in² > As_max ${As_max.toFixed(2)} in² — compression-controlled`, severity: 'error' });
  if (asMaxApplies && As_top > As_max_top)
    warnings.push({ code: 'ACI §9.3.3', message: `Top steel ${As_top.toFixed(2)} in² > As_max ${As_max_top.toFixed(2)} in² — compression-controlled`, severity: 'error' });
  if (As_bot < As_min_pos_eff && load.Mu_pos > 0)
    warnings.push({ code: 'ACI §9.6.1.2', message: `Bottom steel ${As_bot.toFixed(2)} in² is below As,min ${As_min_pos_eff.toFixed(2)} in²`, severity: 'error' });
  if (As_top < As_min_neg_eff && load.Mu_neg > 0)
    warnings.push({ code: 'ACI §9.6.1.2', message: `Top steel ${As_top.toFixed(2)} in² is below As,min ${As_min_neg_eff.toFixed(2)} in²`, severity: 'error' });

  // Combined shear + torsion links (§22.7.6.1). Reported separately from DCR_shear and
  // DCR_torsion because it is the only one of the three that sees the SUM, and a cage
  // can clear both singly and still be short. Error-severity and fixable with more
  // links — unlike §22.7.7.1 above it, which caps the concrete and needs a bigger web.
  if (torsionDesignedFor && VT_util > 1)
    warnings.push({
      code: 'ACI §22.7.6.1',
      message: `Combined shear + torsion links NG: V&T utilisation = ${VT_util.toFixed(2)} `
        + `(shear ${DCR_shear.toFixed(2)} + torsion ${DCR_torsion.toFixed(2)}) — the same stirrup legs carry both, so the demands add`,
      severity: 'error',
    });

  // Capacity exceedances
  if (DCR_flex_pos > 1)
    warnings.push({ code: 'ACI §22.3', message: `Positive flexure NG: DCR = ${DCR_flex_pos.toFixed(2)} (φMn+ = ${flex.phi_Mn_pos.toFixed(1)} kip-ft, Mu+ = ${load.Mu_pos} kip-ft)`, severity: 'error' });
  if (DCR_flex_neg > 1)
    warnings.push({ code: 'ACI §22.3', message: `Negative flexure NG: DCR = ${DCR_flex_neg.toFixed(2)} (φMn- = ${flex.phi_Mn_neg.toFixed(1)} kip-ft, Mu- = ${load.Mu_neg} kip-ft)`, severity: 'error' });
  if (DCR_shear > 1)
    warnings.push({ code: 'ACI §22.5', message: `Shear NG: DCR = ${DCR_shear.toFixed(2)} (φVn = ${shear.phi_Vn.toFixed(1)} kips, Vu = ${load.Vu} kips)`, severity: 'error' });

  // Axial load on a BEAM member. This engine checks flexure as pure bending —
  // φMn ignores Pu entirely, and there is no P-M interaction surface (that lives
  // in the column engine). Pu only reaches the §22.5 shear check via Nu/(6Ag).
  // Past ACI's own beam/column threshold that silently understates the demand:
  // on the reference section a member S-Concrete reports at N-vs-M 0.98 reads
  // here as flexure 0.46. Say so rather than let the number stand unqualified.
  // Combined axial + flexure (§22.4). The interaction IS checked now, so these
  // report a real exceedance rather than warning that the check is missing.
  if (pm) {
    const cap = load.Pu >= 0 ? pm.pos.phiPnMax : Math.abs(pm.pos.phiPnTens);
    const sense = load.Pu >= 0 ? 'compression' : 'tension';
    if (Math.abs(load.Pu) > cap)
      warnings.push({
        code: load.Pu >= 0 ? 'ACI §22.4.2.1' : 'ACI §22.4.3.1',
        message: `Axial ${sense} Pu = ${Math.abs(load.Pu).toFixed(0)} kips > φPn = ${cap.toFixed(0)} kips — section inadequate in axial alone`,
        severity: 'error',
      });
    else if (DCR_PM !== undefined && DCR_PM > 1)
      warnings.push({
        code: 'ACI §22.4',
        message: `Combined axial + flexure NG: N-vs-M utilisation = ${DCR_PM.toFixed(2)} (Pu = ${load.Pu.toFixed(0)} kips with Mu = ${Math.max(load.Mu_pos, load.Mu_neg).toFixed(0)} kip-ft). φMn at this axial load is ${phi_Mn_pos.toFixed(0)} kip-ft vs ${flex.phi_Mn_pos.toFixed(0)} kip-ft in pure bending.`,
        severity: 'error',
      });
  }

  // Shear reinforcement trigger ACI §9.6.3.1
  const Vu_trigger = phi_v * lambdaConcrete * Math.sqrt(fc) * bw * d_detail / 1000;
  if (load.Vu > Vu_trigger && !rebar.ties)
    warnings.push({ code: 'ACI §9.6.3.1', message: `Min shear reinf required — Vu ${load.Vu.toFixed(1)} kips > φλ√f'c·bw·d = ${Vu_trigger.toFixed(1)} kips`, severity: 'error' });

  // Two-tier stirrup spacing ACI §9.7.6.2.2
  if (rebar.ties) {
    const heavy_threshold = phi_v * shear.Vc + 4 * phi_v * Math.sqrt(fc) * bw * d_detail / 1000;
    const heavy = load.Vu > heavy_threshold;
    const s_max = heavy ? Math.min(d_detail / 4, 12) : Math.min(d_detail / 2, 24);
    // Judge the LOOSEST zone: reading ties.spacing (the tightest) let a middle
    // third at double the legal spacing pass with no warning at all.
    if (worstSpacing > s_max)
      warnings.push({
        code: 'ACI §9.7.6.2.2',
        message: `${heavy ? 'Heavy shear' : 'Shear'}: s = ${worstSpacing}" > s_max = ${s_max.toFixed(1)}" (${heavy ? 'd/4 or 12"' : 'd/2 or 24"'})${rebar.tieZones ? ' — worst of the zoned spacings' : ''}`,
        severity: heavy ? 'error' : 'warning',
      });
  }

  // Biaxial bending — the Bresler contour. Only present when a minor-axis moment
  // was supplied, so this never fires on an ordinary uniaxially-loaded beam.
  if (biax && biax.util > 1)
    warnings.push({
      code: 'ACI R22.4.2.1',
      message: `Biaxial bending: (Mux/φMnx)^α + (Muy/φMny)^α = ${biax.util.toFixed(2)} > 1.0 — Mux ${biax.Mux.toFixed(0)}/${biax.phiMnx.toFixed(0)}, Muy ${biax.Muy.toFixed(0)}/${biax.phiMny.toFixed(0)} kip-ft (α = ${biax.alpha}, Bresler load contour)`,
      severity: 'error',
    });
  else if (biax && biax.util > NEAR_CRUSHING)
    warnings.push({
      code: 'ACI R22.4.2.1',
      message: `Biaxial bending at ${(100 * biax.util).toFixed(0)}% of the interaction contour (α = ${biax.alpha}) — resultant M ${biax.Mres.toFixed(0)} kip-ft at ${biax.theta.toFixed(0)}° from the major axis`,
      severity: 'warning',
    });

  // Cross-section limit for combined shear + torsion ACI §22.7.7.1. Distinct
  // from the §22.7.6 capacity check: this one cannot be fixed with more links.
  if (crushing.util > 1)
    warnings.push({
      code: 'ACI §22.7.7.1',
      message: `Cross-section inadequate for combined shear + torsion: √(vu² + vt²) = ${Math.hypot(crushing.vu, crushing.tu).toFixed(0)} psi > φ(Vc/bw·d + 8λ√f'c) = ${crushing.limit.toFixed(0)} psi (utilisation ${crushing.util.toFixed(2)}) — ENLARGE THE SECTION; more stirrups will not help`,
      severity: 'error',
    });
  else if (load.Tu > 0 && crushing.util > NEAR_CRUSHING)
    warnings.push({
      code: 'ACI §22.7.7.1',
      message: `Combined shear + torsion at ${(100 * crushing.util).toFixed(0)}% of the cross-section limit — only ${crushing.Tn_max.toFixed(1)} kip-ft of torsion fits alongside Vu = ${load.Vu.toFixed(1)} kips`,
      severity: 'warning',
    });

  // Torsion stirrup spacing ACI §9.7.6.3.3 — worst zone, as above.
  if (load.Tu > torsion.Tu_threshold && rebar.ties && torsion.Ph > 0) {
    const s_max_tors = Math.min(torsion.Ph / 8, 12);
    if (worstSpacing > s_max_tors)
      warnings.push({ code: 'ACI §9.7.6.3.3', message: `Torsion: s = ${worstSpacing}" > s_max = ${s_max_tors.toFixed(1)}" (Ph/8 = ${(torsion.Ph / 8).toFixed(1)}")${rebar.tieZones ? ' — worst of the zoned spacings' : ''}`, severity: 'warning' });
  }

  // Crack control ACI §24.3.2
  if (As_bot > 0 && load.Mu_pos > 0 && DCR_flex_pos > 0) {
    // cc in the §24.3.2 spacing limit is measured to the TENSION face (bottom
    // steel here); the spacing actually achieved is set by the SIDE cover.
    const Cc = coverFor(section, 'bot') + getBarDiam(section.stirrupDia) / 2;
    const CcSide = coverFor(section, 'side') + getBarDiam(section.stirrupDia) / 2;
    const fsmax = (2 / 3) * fy / 1000; // ksi
    const util = DCR_flex_pos;
    const fs = util >= 0.75 ? fsmax : util >= 0.5 ? fsmax * (0.5 + 2 * (util - 0.5)) : fsmax * util;
    if (fs > 1) {
      const s_max_crack = Math.min(600 / fs - 2.5 * Cc, 12 * (40 / fs));
      const numBars = rebar.botBars.reduce((s, g) => s + g.numBars, 0);
      const dBar = getBarDiam(rebar.botBars[0]?.barSize ?? 8);
      const s_actual = numBars > 1 ? (bw - 2 * CcSide - dBar) / (numBars - 1) : 0;
      if (s_actual > s_max_crack && s_max_crack > 0)
        warnings.push({ code: 'ACI §24.3.2', message: `Crack control: bar spacing ${s_actual.toFixed(1)}" > S_max ${s_max_crack.toFixed(1)}" at fs ≈ ${fs.toFixed(0)} ksi`, severity: 'warning' });
    }
  }

  // Min horizontal clear spacing within each bar layer ACI §25.2.1: ≥ max(1", db)
  // (4/3·d_agg not tracked; using max(1", db) as hagg=0.75" gives same limit)
  for (const [face, bars] of [['Bottom', rebar.botBars], ['Top', rebar.topBars]] as const) {
    for (const g of bars) {
      if (g.numBars <= 1) continue;
      const db = getBarDiam(g.barSize);
      // Bars sit between the stirrup legs, so the width available is set by the
      // side cover.
      const Cc = coverFor(section, 'side') + getBarDiam(section.stirrupDia);
      const s_clear = (bw - 2 * Cc - g.numBars * db) / (g.numBars - 1);
      const s_req   = Math.max(1.0, db);
      if (s_clear < s_req - 1e-9)
        warnings.push({
          code: 'ACI §25.2.1',
          message: `${face} bars: clear horizontal spacing ${s_clear.toFixed(2)}" < required max(1", db = ${db.toFixed(3)}") = ${s_req.toFixed(2)}"`,
          severity: 'warning',
        });
    }
  }

  // Multi-layer geometry: does the stack physically fit?
  //
  // THE §25.2.2 VERTICAL CLEAR-SPACING WARNING WAS REMOVED HERE, DELIBERATELY.
  // It required `max(1", db)` between layers, which is §25.2.1's HORIZONTAL rule
  // borrowed for the vertical direction. §25.2.2 asks only for "a clear spacing between
  // layers of at least 1 in." — a flat inch, with no bar-diameter term — so the check was
  // firing on a limit the clause does not set: every stacked #9 or larger detailed at the
  // ordinary 1" gap came back flagged. S-CONCRETE agrees; its reports print
  // "dz (min) 1.0 in" against #5 bars and accept dz = 1.0.
  //
  // `layerClearSpacing` remains a real input — it places the inner layers and therefore
  // moves d — and the fit check below still refuses a stack the section cannot hold. It
  // is only the spacing VERDICT that is gone. Restoring it means one push here against
  // `sClear < 1.0`, plus a Calc Sheet row; do not reinstate the max(1", db) form.
  for (const [face, bars] of [['Bottom', rebar.botBars], ['Top', rebar.topBars]] as const) {
    const layers = bars.filter(g => g.numBars > 0);
    if (layers.length < 2) continue;
    const stack = coverFor(section, face === 'Bottom' ? 'bot' : 'top') + getBarDiam(section.stirrupDia)
      + layers.reduce((s, g) => s + getBarDiam(g.barSize), 0) + sClear * (layers.length - 1);
    if (stack >= h / 2)
      warnings.push({
        code: 'GEOM',
        message: `${face} bar layers occupy ${stack.toFixed(1)}" ≥ h/2 = ${(h / 2).toFixed(1)}" — section cannot fit this layout`,
        severity: 'error',
      });
  }

  // Cross-section crushing limit ACI §22.5.1.2: Vu > φ(Vc + 8√f'c·bw·d) → enlarge section
  const phi_Vn_max = phi_v * (shear.Vc + 8 * lambdaConcrete * Math.sqrt(fc) * bw * d / 1000);
  if (load.Vu > phi_Vn_max)
    warnings.push({
      code: 'ACI §22.5.1.2',
      message: `Cross-section inadequate for shear: Vu = ${load.Vu.toFixed(1)} kips > φVn,max = ${phi_Vn_max.toFixed(1)} kips — enlarge section`,
      severity: 'error',
    });

  // NO WARNING FOR THE Vs CEILING (§22.5.1.2), DELIBERATELY.
  //
  // `shear.VsCapped` says the stirrup contribution has reached 8√f'c·bw·d, so more or
  // tighter links buy no further capacity. That is a fact about the section, not a defect
  // in the design: if φVn still covers Vu the beam is fine, and flagging it puts an amber
  // chip on a passing member whose only sin is that its shear DCR has stopped moving.
  // The condition is REPORTED instead — see the "Upper limit on the stirrup contribution"
  // step in `calcBreakdown`, which prints Vs,max beside the raw Vs and says which one the
  // capacity was taken from.
  //
  // The genuine failure keeps its warning: the §22.5.1.2 error above fires when Vu
  // exceeds φVn,max, i.e. when the ceiling is not merely reached but breached. That one
  // always accompanies a shear DCR over 1, and it is what tells the reader the answer is
  // a bigger section rather than more links — Suggest reads it for exactly that.

  // Face/skin steel ACI §9.7.2.3
  if (h > 36 && (!rebar.sideBars || rebar.sideBars.length === 0))
    warnings.push({ code: 'ACI §9.7.2.3', message: `h = ${h}" > 36" — skin reinforcement required on each face (ACI §9.7.2.3)`, severity: 'warning' });

  const maxDCR = Math.max(DCR_flex_pos, DCR_flex_neg, DCR_shear, DCR_torsion, VT_util, DCR_PM ?? 0, NM_util ?? 0, crushing.util);
  // Status reflects ACTUAL issues, not raw utilization: NG when capacity is
  // exceeded (DCR > 1); Warning only when a real code message exists (error- or
  // warning-severity); otherwise OK — even at high (but passing) utilization.
  const hasMessage = warnings.length > 0;
  const status: DesignResults['status'] = maxDCR > 1 ? 'NG' : hasMessage ? 'Warning' : 'OK';

  return {
    loadCaseId: load.id,
    // With axial load these are the capacities AT Pu; without it they are the
    // pure-flexure values computeFlexure returned, unchanged.
    Mn_pos: pm ? phi_Mn_pos / (flex.phi_pos || 0.9) : flex.Mn_pos,
    Mn_neg: pm ? phi_Mn_neg / (flex.phi_neg || 0.9) : flex.Mn_neg,
    phi_Mn_pos, phi_Mn_neg,
    DCR_flex_pos, DCR_flex_neg,
    ...(pm ? {
      DCR_PM,
      DCR_axial: load.Pu >= 0 ? axialUtil : 0,
      DCR_axial_tens: load.Pu < 0 ? axialUtil : 0,
      phi_Pn_max: pm.pos.phiPnMax,
      phi_Pn: load.Pu >= 0 ? pm.pos.phiPnMax : pm.pos.phiPnTens,
      phi_Mnx: phi_Mn_pos,
      interaction: pm.pos.points,
    } : {}),
    ...(biax ? { NM_util, biaxial: biax } : {}),
    Vc: shear.Vc, Vs: shear.Vs, phi_Vn: shear.phi_Vn, DCR_shear,
    Tcr: torsion.Tcr, Tu_threshold: torsion.Tu_threshold, phi_Tn: torsion.phi_Tn, DCR_torsion, VT_util,
    DCR_crushing: crushing.util, phi_Tn_max: crushing.Tn_max,
    // Report the effective bottom-face As,min (§9.6.1.3 exception applied)
    As_req_pos, As_req_neg, As_min: As_min_pos_eff, As_min_top: As_min_neg_eff, As_max, As_max_top, Av_req, Av_min_per_s,
    warnings, status,
  };
}
