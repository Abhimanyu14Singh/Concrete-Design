/**
 * ACI 318-19 Concrete Design Engine — Beams Only
 * Units: inches, psi, kips, kip-ft unless noted
 */

import type {
  MaterialProps, SectionDimensions, RebarLayout, LoadCase,
  DesignResults, DesignWarning, ComboForces, BarGroup,
} from '../types';

/** Max |V| within each third of the span — drives the zoned stirrup check. */
export function zoneShearDemands(forces: ComboForces[], spanFt: number): [number, number, number] {
  const zones: [number, number, number] = [0, 0, 0];
  for (const cf of forces) {
    for (const st of cf.stations) {
      const zi = Math.min(2, Math.floor((st.x / spanFt) * 3));
      const v = Math.abs(st.V);
      if (v > zones[zi]) zones[zi] = v;
    }
  }
  return zones;
}

// ── Bar tables (ASTM A615) ────────────────────────────────────────────────────
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
export function getBarDiam(size: number): number {
  if (size < 0) return -size / 25.4;
  return BAR_DIAMS[size] ?? 0;
}

function getRebarAs(bars: { numBars: number; barSize: number }[]): number {
  return bars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
}

/**
 * Distance from the extreme tension fiber to the area-weighted centroid of a
 * multi-layer bar group. Layers are listed outermost-first; layer i sits at
 * cc + dstir + Σ_{j<i}(dbar_j + sClear) + dbar_i/2 from the face.
 * For a single layer this reduces exactly to cc + dstir + dbar/2.
 */
export function layerCentroidOffset(
  section: SectionDimensions,
  bars: BarGroup[],
  sClear = 1.0,
): number {
  const dStir = getBarDiam(section.stirrupDia);
  let edge = section.coverClear + dStir; // running offset to top of next layer
  let sumA = 0, sumAy = 0;
  for (const g of bars) {
    if (g.numBars <= 0) continue;
    const db = getBarDiam(g.barSize);
    const A  = g.numBars * getBarArea(g.barSize);
    sumA  += A;
    sumAy += A * (edge + db / 2);
    edge  += db + sClear;
  }
  if (sumA <= 0) return section.coverClear + dStir + getBarDiam(8) / 2;
  return sumAy / sumA;
}

/** Per-layer (area, depth-from-face) pairs for a multi-layer bar group. */
export function layerDepths(
  section: SectionDimensions,
  bars: BarGroup[],
  sClear = 1.0,
): { A: number; y: number }[] {
  const dStir = getBarDiam(section.stirrupDia);
  let edge = section.coverClear + dStir;
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
): number {
  const h = section.h ?? 12;
  return h - layerCentroidOffset(section, bars, sClear);
}

// ── ACI helpers ───────────────────────────────────────────────────────────────

/** β₁ stress-block factor per ACI 318-19 §22.2.2.4.3 */
export function beta1(fc: number): number {
  if (fc <= 4000) return 0.85;
  return Math.max(0.65, 0.85 - 0.05 * (fc - 4000) / 1000);
}

/**
 * Effective depth: d = h − cc − d_stirrup − d_bar/2
 * barSize: actual bar designation (8 for #8).
 */
export function effectiveDepth(section: SectionDimensions, barSize: number): number {
  const h = section.h ?? 12;
  const dStir = getBarDiam(section.stirrupDia);
  const dBar  = getBarDiam(barSize);
  return h - section.coverClear - dStir - dBar / 2;
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

/** As_min and As_max per ACI 318-19 §9.6.1 */
export function steelLimits(section: SectionDimensions, material: MaterialProps) {
  const { fc, fy } = material;
  const bw = section.bw ?? section.b;
  const d  = effectiveDepth(section, 8);
  const rho_min = Math.max(3 * Math.sqrt(fc) / fy, 200 / fy);
  const As_min  = rho_min * bw * d;
  // εt ≥ 0.004 limit (§9.3.3.1): c = 3d/7, As,max = 0.85·β₁·(f'c/fy)·(3/7)·bw·d
  const As_max  = 0.85 * beta1(fc) * (fc / fy) * (0.003 / (0.003 + 0.004)) * bw * d;
  return { As_min, As_max };
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
} {
  const { fc, fy } = material;
  const b1 = beta1(fc);
  const h  = section.h ?? 12;
  const beff = effectiveFlange(section, span);
  const bw   = section.bw ?? section.b;

  const d_pos = botBars?.length
    ? effectiveDepthMulti(section, botBars, layerClearSpacing)
    : effectiveDepth(section, botBarSize);
  const d_neg = topBars?.length
    ? effectiveDepthMulti(section, topBars, layerClearSpacing)
    : effectiveDepth(section, topBarSize);

  // d' for compression steel: distance from compression face to comp-steel centroid
  const d_prime_pos = topBars?.length
    ? layerCentroidOffset(section, topBars, layerClearSpacing)
    : effectiveDepth(section, topBarSize);  // fallback (rarely used)
  const d_prime_neg = botBars?.length
    ? layerCentroidOffset(section, botBars, layerClearSpacing)
    : section.coverClear + getBarDiam(section.stirrupDia) + getBarDiam(botBarSize) / 2;

  function calcMn(
    As: number, d: number, bFlange: number,
    As_prime = 0, d_prime = 0,
    compLayers?: { A: number; y: number }[],
  ): { Mn: number; a: number; phi: number } {
    if (As <= 0) return { Mn: 0, a: 0, phi: 0.9 };

    const hf = section.hf ?? h;

    // Doubly-reinforced rectangular section (As' > 0, no T/L flange, comp steel in compression zone)
    // First check via singly-reinforced c whether the "compression" steel is actually in compression.
    if (As_prime > 0 && section.type !== 'T_beam' && section.type !== 'L_beam') {
      const a_sr = (As * fy) / (0.85 * fc * bFlange);
      const c_sr = a_sr / b1;
      // Per-layer compression steel: each layer at its own depth with its own
      // strain-compatible stress (reduces to the lumped-centroid result for one layer)
      const layers = compLayers && compLayers.length > 0
        ? compLayers
        : [{ A: As_prime, y: d_prime }];
      if (c_sr > Math.min(...layers.map(l => l.y))) {
        // At least one comp layer is inside the compression zone — iterate equilibrium
        const Cs_of = (c: number) => layers.reduce((sum, l) => {
          const eps = 0.003 * (c - l.y) / c;
          const fs = Math.min(Math.max(eps * 29_000_000, -fy), fy);
          // displace concrete only where the bar sits inside the stress block
          const disp = l.y < b1 * c ? 0.85 * fc : 0;
          return sum + l.A * (fs - disp);
        }, 0);
        let a = (As * fy) / (0.85 * fc * bFlange);
        for (let i = 0; i < 80; i++) {
          const c = Math.max(a / b1, 1e-4);
          const a_new = (As * fy - Cs_of(c)) / (0.85 * fc * bFlange);
          if (Math.abs(a_new - a) < 1e-7) { a = a_new; break; }
          a = 0.5 * (a + a_new); // damped update for stability
        }
        a = Math.max(a, 0.001);
        const c = a / b1;
        const et = 0.003 * (d - c) / c;
        const phi = et >= 0.005 ? 0.9 : et <= 0.002 ? 0.65 : 0.65 + (et - 0.002) * (250 / 3);
        const Cc = 0.85 * fc * bFlange * a;
        const Ms = layers.reduce((sum, l) => {
          const eps = 0.003 * (c - l.y) / c;
          const fs = Math.min(Math.max(eps * 29_000_000, -fy), fy);
          const disp = l.y < b1 * c ? 0.85 * fc : 0;
          return sum + l.A * (fs - disp) * (d - l.y);
        }, 0);
        const Mn = (Cc * (d - a / 2) + Ms) / 12000;
        return { Mn, a, phi };
      }
      // Comp steel in tension zone — fall through to singly-reinforced
    }

    let a = (As * fy) / (0.85 * fc * bFlange);

    if ((section.type === 'T_beam' || section.type === 'L_beam') && a > hf) {
      // Flange + web compression split
      const Cf = 0.85 * fc * (bFlange - bw) * hf;
      const Cw = As * fy - Cf;
      const a_web = Cw / (0.85 * fc * bw);
      a = a_web + hf;
      const Mn_flange = Cf * (d - hf / 2) / 12000;
      const Mn_web    = Cw * (d - hf - a_web / 2) / 12000;
      const Mn = Mn_flange + Mn_web;
      const c = a / b1;
      const et = 0.003 * (d - c) / c;
      const phi = et >= 0.005 ? 0.9 : et <= 0.002 ? 0.65 : 0.65 + (et - 0.002) * (250 / 3);
      return { Mn, a, phi };
    }

    const c  = a / b1;
    const et = 0.003 * (d - c) / c;
    const phi = et >= 0.005 ? 0.9 : et <= 0.002 ? 0.65 : 0.65 + (et - 0.002) * (250 / 3);
    const Mn = As * fy * (d - a / 2) / 12000;
    return { Mn, a, phi };
  }

  const compLayersPos = topBars?.length ? layerDepths(section, topBars, layerClearSpacing) : undefined;
  const compLayersNeg = botBars?.length ? layerDepths(section, botBars, layerClearSpacing) : undefined;
  const pos = calcMn(As_bot, d_pos, beff, As_top, d_prime_pos, compLayersPos);
  const neg = calcMn(As_top, d_neg, bw, As_bot, d_prime_neg, compLayersNeg); // negative moment: web width only

  return {
    Mn_pos: pos.Mn,      Mn_neg: neg.Mn,
    phi_Mn_pos: pos.phi * pos.Mn,
    phi_Mn_neg: neg.phi * neg.Mn,
    a_pos: pos.a,        a_neg: neg.a,
    phi_pos: pos.phi,    phi_neg: neg.phi,
  };
}

// ── Shear (ACI §22.5) ─────────────────────────────────────────────────────────

export function computeShear(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  Nu = 0,
): { Vc: number; Vs: number; phi_Vn: number; Av_req: number; Av_prov: number; d_shear: number; Av_min_per_s: number; VsCapped: boolean } {
  const { fc, fyt, lambdaConcrete } = material;
  const bw  = section.bw ?? section.b;
  const h   = section.h ?? 12;
  const phi = 0.75;

  // d to the actual outermost bottom-bar centroid (multi-layer aware)
  const d_raw   = rebar.botBars?.length
    ? effectiveDepthMulti(section, rebar.botBars, rebar.layerClearSpacing ?? 1.0)
    : effectiveDepth(section, 8);
  const d_shear = Math.max(d_raw, 0.8 * h);

  const Av_min_per_s = Math.max(0.75 * Math.sqrt(fc) / fyt, 50 / fyt) * bw;

  const ties = rebar.ties;
  let Vs = 0;
  let Av_prov = 0;
  let VsCapped = false;
  if (ties) {
    Av_prov = ties.legs * getBarArea(ties.barSize);
    Vs = (Av_prov * fyt * d_shear) / (ties.spacing * 1000);
    // Vs ≤ 8√f'c·bw·d (ACI §22.5.1.2 upper limit on Vn − Vc)
    const VsMax = 8 * Math.sqrt(fc) * bw * d_shear / 1000;
    if (Vs > VsMax) { Vs = VsMax; VsCapped = true; }
  }

  const As_bot = getRebarAs(rebar.botBars);
  const rho_w  = As_bot / (bw * d_shear);

  // Bug 4 fix: λs only applies when Av/s < Av,min/s (ACI §22.5.5.1.1)
  const Av_s_prov = ties ? (ties.legs * getBarArea(ties.barSize)) / ties.spacing : 0;
  const hasMinStirrups = Av_s_prov >= Av_min_per_s;
  const lambda_s = hasMinStirrups ? 1.0 : Math.min(1.0, Math.sqrt(2 / (1 + 0.004 * d_shear)));

  const Ag = bw * h;

  // ACI Table 22.5.5.1: when Av/s ≥ Av,min/s use max(case a, case b); otherwise case b/c with λs
  const Nu_term = Nu / (6 * Ag);
  const Vc_b = (8 * lambdaConcrete * lambda_s * Math.pow(Math.max(rho_w, 1e-6), 1 / 3) * Math.sqrt(fc) + Nu_term) * bw * d_shear / 1000;
  let Vc: number;
  if (hasMinStirrups) {
    const Vc_a = (2 * lambdaConcrete * Math.sqrt(fc) + Nu_term) * bw * d_shear / 1000;
    Vc = Math.max(Vc_a, Vc_b);
    // Table 22.5.5.1 note: Vc ≤ 5λ√f'c·bw·d
    const Vc_cap = 5 * lambdaConcrete * Math.sqrt(fc) * bw * d_shear / 1000;
    if (Vc > Vc_cap) Vc = Vc_cap;
  } else {
    Vc = Vc_b;
  }

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
): ZoneShearResult[] {
  const zones = rebar.tieZones;
  if (!zones || !rebar.ties) return [];
  return zones.map((z, i) => {
    const zonedRebar: RebarLayout = { ...rebar, ties: { ...rebar.ties!, spacing: z.spacing } };
    const r = computeShear(section, material, zonedRebar, Nu);
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

export function computeTorsion(
  section: SectionDimensions,
  material: MaterialProps,
  rebar?: RebarLayout,
): { Tcr: number; Tu_threshold: number; phi_Tn: number; Ph: number } {
  const { fc, fyt, lambdaConcrete } = material;
  const b   = section.b;
  const h   = section.h ?? 12;
  const phi = 0.75;

  const Acp = b * h;
  const Pcp = 2 * (b + h);

  // True cracking torsion: Tcr = 4λ√f'c·Acp²/Pcp (ACI §22.7.4.1, Eq. 22.7.4.1a)
  const Tcr          = (4 * lambdaConcrete * Math.sqrt(fc) * Acp * Acp / Pcp) / 12000;
  // Threshold below which torsion may be neglected: φ·λ√f'c·Acp²/Pcp (= φ·Tcr/4)
  const Tu_threshold = phi * lambdaConcrete * Math.sqrt(fc) * Acp * Acp / Pcp / 12000;

  // Closed stirrup centerline geometry
  const cc      = section.coverClear + getBarDiam(section.stirrupDia) / 2;
  const x0      = b - 2 * cc;
  const y0      = h - 2 * cc;
  const Aoh     = x0 * y0;
  const Ao      = 0.85 * Aoh;
  const Ph      = 2 * (x0 + y0);

  // ACI §22.7.6.1: φTn = φ · 2·Ao · (At/s) · fyt  [θ = 45°, cot 45° = 1]
  // At = area of one leg of closed stirrup; use single leg per side
  let phi_Tn = 0;
  if (rebar?.ties && Ao > 0) {
    const At_s = getBarArea(rebar.ties.barSize) / rebar.ties.spacing; // in²/in per leg
    // Tn = 2·Ao·(At/s)·fyt — in²·(in²/in)·psi = lb-in → /12000 kip-ft
    phi_Tn = phi * 2 * Ao * At_s * fyt / 12000;
  }

  return { Tcr, Tu_threshold, phi_Tn, Ph };
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
  const d     = effectiveDepth(section, 8);
  const beff  = isTop ? (section.bw ?? section.b) : effectiveFlange(section, span);
  const phi   = 0.9;

  const Rn  = Mu / (phi * beff * d * d);
  let   rho = (0.85 * fc / fy) * (1 - Math.sqrt(Math.max(0, 1 - 2 * Rn / (0.85 * fc))));
  if (isNaN(rho) || rho < 0) rho = 0;

  const { As_min } = steelLimits(section, material);
  return Math.max(rho * beff * d, As_min);
}

// ── Full member design ────────────────────────────────────────────────────────

export function designMember(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  load: LoadCase,
  span = 20,
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
  const shear  = computeShear(section, material, rebar, load.Pu);
  const torsion = computeTorsion(section, material, rebar);

  const { As_min, As_max } = steelLimits(section, material);
  const d = shear.d_shear;

  const As_req_pos = requiredAs(load.Mu_pos, section, material, false, span);
  const As_req_neg = requiredAs(load.Mu_neg, section, material, true,  span);

  // Required Av/s (ACI §22.5.10.5)
  const Vu_net = Math.max(0, load.Vu - phi_v * shear.Vc);
  const Av_req = Vu_net > 0 ? Vu_net / (phi_v * fyt * d / 1000) : 0;

  // Minimum Av/s (ACI §9.6.3.3)
  const Av_min_per_s = Math.max(0.75 * Math.sqrt(fc) / fyt, 50 / fyt) * bw;

  // §9.6.1.3 exception: if As ≥ (4/3)·As_req_raw the min-steel check is satisfied.
  // Use raw (unfloored) As_req so the exception applies when Mu is tiny.
  function rawAs(Mu_kft: number, isTop: boolean): number {
    if (Mu_kft <= 0) return 0;
    const Mu_lb_in = Mu_kft * 12000;
    const faceBars = isTop ? rebar.topBars : rebar.botBars;
    const d_raw = faceBars?.length
      ? effectiveDepthMulti(section, faceBars, sClear)
      : effectiveDepth(section, 8);
    const buse  = isTop ? bw : effectiveFlange(section, span);
    const Rn = Mu_lb_in / (0.9 * buse * d_raw * d_raw);
    const rho = (0.85 * fc / fy) * (1 - Math.sqrt(Math.max(0, 1 - 2 * Rn / (0.85 * fc))));
    return Math.max(0, rho) * buse * d_raw;
  }
  const As_req_pos_raw = rawAs(load.Mu_pos, false);
  const As_req_neg_raw = rawAs(load.Mu_neg, true);
  const As_min_pos_eff = As_req_pos_raw > 0 ? Math.min(As_min, (4 / 3) * As_req_pos_raw) : As_min;
  const As_min_neg_eff = As_req_neg_raw > 0 ? Math.min(As_min, (4 / 3) * As_req_neg_raw) : As_min;

  // DCRs
  const DCR_flex_pos = flex.phi_Mn_pos > 0 ? load.Mu_pos / flex.phi_Mn_pos : 0;
  const DCR_flex_neg = flex.phi_Mn_neg > 0 ? load.Mu_neg / flex.phi_Mn_neg : 0;
  const DCR_shear    = shear.phi_Vn   > 0 ? load.Vu     / shear.phi_Vn    : 0;
  const DCR_torsion  = torsion.phi_Tn > 0 ? load.Tu     / torsion.phi_Tn  : 0;

  // ── Warnings ────────────────────────────────────────────────────────────────

  // Steel limits ACI §9.3.3 / §9.6.1.2
  if (As_bot > As_max)
    warnings.push({ code: 'ACI §9.3.3', message: `Bottom steel ${As_bot.toFixed(2)} in² > As_max ${As_max.toFixed(2)} in² — compression-controlled`, severity: 'error' });
  if (As_top > As_max)
    warnings.push({ code: 'ACI §9.3.3', message: `Top steel ${As_top.toFixed(2)} in² > As_max ${As_max.toFixed(2)} in²`, severity: 'error' });
  if (As_bot < As_min_pos_eff && load.Mu_pos > 0)
    warnings.push({ code: 'ACI §9.6.1.2', message: `Bottom steel ${As_bot.toFixed(2)} in² is below As,min ${As_min_pos_eff.toFixed(2)} in²`, severity: 'error' });
  if (As_top < As_min_neg_eff && load.Mu_neg > 0)
    warnings.push({ code: 'ACI §9.6.1.2', message: `Top steel ${As_top.toFixed(2)} in² is below As,min ${As_min_neg_eff.toFixed(2)} in²`, severity: 'error' });

  // Capacity exceedances
  if (DCR_flex_pos > 1)
    warnings.push({ code: 'ACI §22.3', message: `Positive flexure NG: DCR = ${DCR_flex_pos.toFixed(2)} (φMn+ = ${flex.phi_Mn_pos.toFixed(1)} kip-ft, Mu+ = ${load.Mu_pos} kip-ft)`, severity: 'error' });
  if (DCR_flex_neg > 1)
    warnings.push({ code: 'ACI §22.3', message: `Negative flexure NG: DCR = ${DCR_flex_neg.toFixed(2)} (φMn- = ${flex.phi_Mn_neg.toFixed(1)} kip-ft, Mu- = ${load.Mu_neg} kip-ft)`, severity: 'error' });
  if (DCR_shear > 1)
    warnings.push({ code: 'ACI §22.5', message: `Shear NG: DCR = ${DCR_shear.toFixed(2)} (φVn = ${shear.phi_Vn.toFixed(1)} kips, Vu = ${load.Vu} kips)`, severity: 'error' });

  // Shear reinforcement trigger ACI §9.6.3.1
  const Vu_trigger = phi_v * lambdaConcrete * Math.sqrt(fc) * bw * d / 1000;
  if (load.Vu > Vu_trigger && !rebar.ties)
    warnings.push({ code: 'ACI §9.6.3.1', message: `Min shear reinf required — Vu ${load.Vu.toFixed(1)} kips > φλ√f'c·bw·d = ${Vu_trigger.toFixed(1)} kips`, severity: 'error' });

  // Two-tier stirrup spacing ACI §9.7.6.2.2
  if (rebar.ties) {
    const heavy_threshold = phi_v * shear.Vc + 4 * phi_v * Math.sqrt(fc) * bw * d / 1000;
    const heavy = load.Vu > heavy_threshold;
    const s_max = heavy ? Math.min(d / 4, 12) : Math.min(d / 2, 24);
    if (rebar.ties.spacing > s_max)
      warnings.push({
        code: 'ACI §9.7.6.2.2',
        message: `${heavy ? 'Heavy shear' : 'Shear'}: s = ${rebar.ties.spacing}" > s_max = ${s_max.toFixed(1)}" (${heavy ? 'd/4 or 12"' : 'd/2 or 24"'})`,
        severity: heavy ? 'error' : 'warning',
      });
  }

  // Torsion stirrup spacing ACI §9.7.6.3.3
  if (load.Tu > torsion.Tu_threshold && rebar.ties && torsion.Ph > 0) {
    const s_max_tors = Math.min(torsion.Ph / 8, 12);
    if (rebar.ties.spacing > s_max_tors)
      warnings.push({ code: 'ACI §9.7.6.3.3', message: `Torsion: s = ${rebar.ties.spacing}" > s_max = ${s_max_tors.toFixed(1)}" (Ph/8 = ${(torsion.Ph / 8).toFixed(1)}")`, severity: 'warning' });
  }

  // Crack control ACI §24.3.2
  if (As_bot > 0 && load.Mu_pos > 0 && DCR_flex_pos > 0) {
    const Cc = section.coverClear + getBarDiam(section.stirrupDia) / 2;
    const fsmax = (2 / 3) * fy / 1000; // ksi
    const util = DCR_flex_pos;
    const fs = util >= 0.75 ? fsmax : util >= 0.5 ? fsmax * (0.5 + 2 * (util - 0.5)) : fsmax * util;
    if (fs > 1) {
      const s_max_crack = Math.min(600 / fs - 2.5 * Cc, 12 * (40 / fs));
      const numBars = rebar.botBars.reduce((s, g) => s + g.numBars, 0);
      const dBar = getBarDiam(rebar.botBars[0]?.barSize ?? 8);
      const s_actual = numBars > 1 ? (bw - 2 * Cc - dBar) / (numBars - 1) : 0;
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
      const Cc = section.coverClear + getBarDiam(section.stirrupDia);
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

  // Multi-layer checks: ACI §25.2.2 vertical clear spacing ≥ max(1", db); fit check
  for (const [face, bars] of [['Bottom', rebar.botBars], ['Top', rebar.topBars]] as const) {
    const layers = bars.filter(g => g.numBars > 0);
    if (layers.length < 2) continue;
    const dbMax = Math.max(...layers.map(g => getBarDiam(g.barSize)));
    const sReq  = Math.max(1.0, dbMax);
    if (sClear < sReq - 1e-9)
      warnings.push({
        code: 'ACI §25.2.2',
        message: `${face} bars: layer clear spacing ${sClear}" < required max(1", db = ${dbMax.toFixed(2)}") = ${sReq.toFixed(2)}"`,
        severity: 'warning',
      });
    const stack = section.coverClear + getBarDiam(section.stirrupDia)
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

  // Vs upper limit ACI §22.5.1.2
  if (shear.VsCapped)
    warnings.push({
      code: 'ACI §22.5.1.2',
      message: `Stirrup contribution capped at Vs,max = 8√f'c·bw·d = ${shear.Vs.toFixed(1)} kips — enlarge section instead of adding stirrups`,
      severity: 'warning',
    });

  // Face/skin steel ACI §9.7.2.3
  if (h > 36 && (!rebar.sideBars || rebar.sideBars.length === 0))
    warnings.push({ code: 'ACI §9.7.2.3', message: `h = ${h}" > 36" — skin reinforcement required on each face (ACI §9.7.2.3)`, severity: 'warning' });

  const maxDCR = Math.max(DCR_flex_pos, DCR_flex_neg, DCR_shear, DCR_torsion);
  // Status reflects ACTUAL issues, not raw utilization: NG when capacity is
  // exceeded (DCR > 1); Warning only when a real code message exists (error- or
  // warning-severity); otherwise OK — even at high (but passing) utilization.
  const hasMessage = warnings.length > 0;
  const status: DesignResults['status'] = maxDCR > 1 ? 'NG' : hasMessage ? 'Warning' : 'OK';

  return {
    loadCaseId: load.id,
    Mn_pos: flex.Mn_pos,   Mn_neg: flex.Mn_neg,
    phi_Mn_pos: flex.phi_Mn_pos, phi_Mn_neg: flex.phi_Mn_neg,
    DCR_flex_pos, DCR_flex_neg,
    Vc: shear.Vc, Vs: shear.Vs, phi_Vn: shear.phi_Vn, DCR_shear,
    Tcr: torsion.Tcr, Tu_threshold: torsion.Tu_threshold, phi_Tn: torsion.phi_Tn, DCR_torsion,
    // Report the effective bottom-face As,min (§9.6.1.3 exception applied)
    As_req_pos, As_req_neg, As_min: As_min_pos_eff, As_max, Av_req, Av_min_per_s,
    warnings, status,
  };
}
