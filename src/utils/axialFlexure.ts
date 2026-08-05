/**
 * ACI 318-19 axial–flexure (P-M) interaction for BEAM sections.
 *
 * Beams in a real frame carry axial load — tension from restrained shrinkage or
 * a tie/collector, compression from a transfer or a sloping member — and the
 * moment capacity moves with it. A pure-bending check on such a member reads
 * unconservatively: on the reference section (12×28, 4-#8 top / 8-#8 bottom)
 * S-Concrete reports an N-vs-M utilisation of 0.98 where pure flexure alone
 * gives 0.46.
 *
 * The model, validated against S-Concrete's ACI 318-19 output (see
 * __tests__/axialFlexure.test.ts, which pins all three reference examples):
 *
 *  • Moments are taken about the GEOMETRIC centroid of the gross concrete
 *    section — not the plastic centroid. This is what S-Concrete reports its
 *    moments about (its "Zbar" section property), and it is what makes the
 *    compression branch land on its numbers exactly. With the plastic centroid
 *    the compression branch is ~6% off.
 *
 *  • COMPRESSION branch (Pu > 0): strain compatibility. εcu = 0.003, the
 *    equivalent rectangular stress block (§22.2.2.4), every bar layer at its own
 *    depth with its own strain-compatible stress, concrete displaced by bars
 *    inside the block, φ from the extreme tension layer per §21.2.2, and the
 *    §22.4.2.1 cap φPn,max = 0.80·φ·[0.85f'c(Ag − Ast) + fy·Ast] for tied members.
 *
 *  • TENSION branch (Pu < 0): a straight line from the pure-flexure point to
 *    pure axial tension φPnt = 0.9·Ast·fy. Once the whole section is in tension
 *    the concrete contributes nothing, and the linear transition is both the
 *    code-accepted simplification and what S-Concrete does — it reproduces its
 *    φMn to the reported precision on Example 2.
 *
 *  • The pure-flexure anchor is NOT recomputed here: it is passed in from
 *    computeFlexure(), so a member with Pu = 0 keeps exactly the capacity it has
 *    always had and there is no step in φMn as Pu passes through zero. The
 *    compression branch is scaled by the same anchor for the same reason.
 *
 * Sign convention follows LoadCase.Pu: POSITIVE = compression.
 * Units are the engine's throughout: in, psi, kips, kip-ft.
 */

import type {
  BarGroup, InteractionPoint, MaterialProps, RebarLayout, SectionDimensions,
} from '../types';
import { beta1, effectiveFlange, getBarArea, layerDepths } from './concreteDesign';

/** One longitudinal bar layer, positioned from the COMPRESSION face. */
interface Layer { A: number; y: number }

const ECU = 0.003;
/** φ per §21.2.2 from the extreme tension-steel strain (Grade 60 limits). */
function phiFromStrain(et: number): number {
  return et >= 0.005 ? 0.9 : et <= 0.002 ? 0.65 : 0.65 + (et - 0.002) * (250 / 3);
}

export interface AxialFlexureResult {
  /** φPn,max — §22.4.2.1 compression cap (kips, +ve). */
  phiPnMax: number;
  /** φPnt — pure axial tension capacity (kips, NEGATIVE in the Pu convention). */
  phiPnTens: number;
  /** Design moment capacity at the applied Pu (kip-ft). */
  phiMnAtPu: number;
  /** Pure-flexure capacity this branch was anchored to (kip-ft). */
  phiMn0: number;
  /** Axial utilisation |Pu| / (the capacity in the direction of loading). */
  axialUtil: number;
  /**
   * Combined N-vs-M utilisation: the load vector (Pu, Mu) is scaled radially
   * until it meets the φ-interaction surface, and the utilisation is how far
   * along that ray the load sits. This is S-Concrete's "N vs M Util" and the
   * value that should govern.
   */
  nmUtil: number;
  /** The φ-surface point the ray meets (kips, kip-ft). */
  phiPnAtRay: number;
  phiMnAtRay: number;
  /** Sampled φ-surface for the calc sheet / chart, compression branch first. */
  points: InteractionPoint[];
}

/** Gross concrete area and geometric-centroid depth from the compression face. */
function grossSection(
  section: SectionDimensions, sense: 'pos' | 'neg',
): { Ag: number; yBar: number } {
  const h = section.h ?? 12;
  const bw = section.bw ?? section.b;
  const isFlanged = section.type === 'T_beam' || section.type === 'L_beam';
  if (!isFlanged) return { Ag: section.b * h, yBar: h / 2 };
  const hf = section.hf ?? 0;
  const bf = section.b;
  const Af = bf * hf, Aw = bw * (h - hf);
  const Ag = Af + Aw;
  // Sagging puts the flange at the compression face; hogging puts it at the far
  // (tension) face, so its depth from the compression face flips.
  const yF = sense === 'pos' ? hf / 2 : (h - hf) + hf / 2;
  const yW = sense === 'pos' ? hf + (h - hf) / 2 : (h - hf) / 2;
  return { Ag, yBar: (Af * yF + Aw * yW) / Ag };
}

/** Bar layers positioned from the compression face for the given bending sense. */
function layersFor(
  section: SectionDimensions, rebar: RebarLayout, sense: 'pos' | 'neg',
): Layer[] {
  const h = section.h ?? 12;
  const s = rebar.layerClearSpacing ?? 1.0;
  const compBars = sense === 'pos' ? rebar.topBars : rebar.botBars;
  const tensBars = sense === 'pos' ? rebar.botBars : rebar.topBars;
  const compFace = sense === 'pos' ? 'top' : 'bot';
  const tensFace = sense === 'pos' ? 'bot' : 'top';
  // Side/skin bars are deliberately excluded, exactly as computeFlexure excludes
  // them: they are crack-control steel, and counting them here would make the
  // Pu = 0 anchor disagree with the pure-flexure check sitting beside it.
  return [
    ...layerDepths(section, compBars, s, compFace).map(l => ({ A: l.A, y: l.y })),
    ...layerDepths(section, tensBars, s, tensFace).map(l => ({ A: l.A, y: h - l.y })),
  ].filter(l => l.A > 0);
}

/**
 * Build the φ-interaction for one bending sense and evaluate it at (Pu, Mu).
 *
 * `phiMn0` is the pure-flexure design capacity from computeFlexure for this
 * sense — the anchor the whole curve is pinned to.
 */
export function beamAxialFlexure(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  span: number,
  sense: 'pos' | 'neg',
  phiMn0: number,
  Pu: number,
  Mu: number,
): AxialFlexureResult {
  const { fc, fy, Es } = material;
  const h = section.h ?? 12;
  const bw = section.bw ?? section.b;
  const b1 = beta1(fc);
  const k = 0.85 * fc;
  // Sagging engages the flange; hogging compresses the web only — the same split
  // computeFlexure makes.
  const bComp = sense === 'pos' ? effectiveFlange(section, span) : bw;
  const hf = section.hf ?? h;
  const isFlanged = section.type === 'T_beam' || section.type === 'L_beam';

  const layers = layersFor(section, rebar, sense);
  const Ast = layers.reduce((s, l) => s + l.A, 0);
  const { Ag, yBar } = grossSection(section, sense);

  const P0 = k * (Ag - Ast) + Ast * fy;
  const phiPnMax = 0.80 * 0.65 * P0 / 1000;          // §22.4.2.1, tied
  const phiPnTens = -0.9 * Ast * fy / 1000;          // whole cage yielding in tension

  /** Concrete compression force and its centroid for a block depth `a`. */
  function concrete(a: number): { C: number; yC: number } {
    if (sense === 'pos' && isFlanged && a > hf) {
      const Cf = k * bComp * hf;
      const Cw = k * bw * (a - hf);
      return { C: Cf + Cw, yC: (Cf * (hf / 2) + Cw * (hf + (a - hf) / 2)) / (Cf + Cw) };
    }
    return { C: k * bComp * a, yC: a / 2 };
  }

  /** (φPn, φMn) at a neutral-axis depth c — the compression branch. */
  function at(c: number): { phiP: number; phiM: number; P: number; M: number; phi: number; et: number } {
    const a = Math.min(b1 * c, h);
    const { C, yC } = concrete(a);
    let F = 0, M = C * (yBar - yC);
    for (const l of layers) {
      const eps = ECU * (c - l.y) / c;
      let fs = Math.max(-fy, Math.min(fy, eps * Es));
      if (eps > 0 && l.y < a) fs -= k;      // displace the concrete the bar occupies
      F += l.A * fs;
      M += l.A * fs * (yBar - l.y);
    }
    const P = (C + F) / 1000;
    const dExt = Math.max(...layers.map(l => l.y));
    const et = ECU * (dExt - c) / c;
    const phi = phiFromStrain(et);
    return { P, M: M / 12000, phi, et, phiP: Math.min(phi * P, phiPnMax), phiM: phi * M / 12000 };
  }

  // Sample the compression branch. c from a hair above zero (deep tension-
  // controlled) out to well past full-section compression.
  const N = 900;
  const raw: { phiP: number; phiM: number; P: number; M: number; phi: number; et: number; c: number }[] = [];
  for (let i = 1; i <= N; i++) {
    const c = (i / N) * 4 * h;
    raw.push({ ...at(c), c });
  }
  // Pin the curve to computeFlexure's pure-flexure capacity so φMn is continuous
  // through Pu = 0. The factor is ~1.000 for any normally-proportioned beam; it
  // only absorbs the small difference between this strain-compatibility solve and
  // the closed-form solve computeFlexure uses.
  const phiM0Raw = interpAt(raw, 0);
  const scale = phiM0Raw && phiM0Raw > 0 ? phiMn0 / phiM0Raw : 1;
  for (const p of raw) { p.phiM *= scale; p.M *= scale; }

  /** φMn on the sampled compression branch at a target φPn. */
  function interpAt(
    pts: { phiP: number; phiM: number }[], targetP: number,
  ): number | null {
    let best: number | null = null;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], bb = pts[i];
      if ((a.phiP - targetP) * (bb.phiP - targetP) <= 0) {
        const t = (targetP - a.phiP) / ((bb.phiP - a.phiP) || 1e-12);
        const m = a.phiM + t * (bb.phiM - a.phiM);
        if (best === null || m > best) best = m;
      }
    }
    return best;
  }

  /** φMn at any axial load, both branches. */
  function phiMnAt(P: number): number {
    if (P < 0) {
      // Straight line from pure flexure down to pure tension.
      const frac = 1 - Math.abs(P) / Math.abs(phiPnTens);
      return Math.max(0, phiMn0 * frac);
    }
    if (P === 0) return phiMn0;
    return Math.max(0, interpAt(raw, Math.min(P, phiPnMax)) ?? 0);
  }

  // Radial scaling: grow (Pu, Mu) until it meets the φ-surface. util is how far
  // along that ray the applied load sits.
  let nmUtil = 0, phiPnAtRay = 0, phiMnAtRay = phiMn0;
  if (Mu > 0 || Pu !== 0) {
    // Solve λ from  λ·Mu = φMn(λ·Pu)  by bisection — φMn is monotonic in P on
    // each branch, so the residual changes sign exactly once.
    const resid = (lam: number) => lam * Mu - phiMnAt(lam * Pu);
    let lo = 1e-6, hi = 1;
    // Grow hi until the load vector is outside the surface.
    for (let i = 0; i < 200 && resid(hi) < 0; i++) hi *= 1.5;
    if (resid(hi) >= 0) {
      for (let i = 0; i < 200; i++) {
        const mid = 0.5 * (lo + hi);
        if (resid(mid) >= 0) hi = mid; else lo = mid;
      }
      const lam = 0.5 * (lo + hi);
      nmUtil = lam > 0 ? 1 / lam : 0;
      phiPnAtRay = lam * Pu;
      phiMnAtRay = lam * Mu;
    }
  }
  // Pure axial with no moment: the ray degenerates, so utilisation is the axial ratio.
  const axialCap = Pu >= 0 ? phiPnMax : Math.abs(phiPnTens);
  const axialUtil = axialCap > 0 ? Math.abs(Pu) / axialCap : 0;
  if (Mu <= 0) { nmUtil = axialUtil; phiPnAtRay = Math.sign(Pu) * axialCap; phiMnAtRay = 0; }

  // Sampled curve for the calc sheet: compression branch plus the tension leg.
  const points: InteractionPoint[] = raw
    .filter((_, i) => i % 30 === 0)
    .map(p => ({
      c: p.c, Pn: p.P, Mn: p.M, phi: p.phi,
      phiPn: p.phiP, phiMn: p.phiM, eps_t: p.et,
    }));
  points.push({ c: 0, Pn: phiPnTens / 0.9, Mn: 0, phi: 0.9, phiPn: phiPnTens, phiMn: 0, eps_t: 0.05 });

  return {
    phiPnMax, phiPnTens, phiMn0,
    phiMnAtPu: phiMnAt(Pu),
    axialUtil, nmUtil, phiPnAtRay, phiMnAtRay,
    points,
  };
}

/** Total longitudinal steel area a section's cage provides (in²). */
export function totalLongitudinalAs(rebar: RebarLayout): number {
  const sum = (bars?: BarGroup[]) =>
    (bars ?? []).reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
  return sum(rebar.topBars) + sum(rebar.botBars);
}
