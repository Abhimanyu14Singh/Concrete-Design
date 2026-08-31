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
import { beta1, effectiveFlange, getBarArea, layerDepths, phiFlexure } from './concreteDesign';

/** One longitudinal bar layer, positioned from the COMPRESSION face. */
interface Layer { A: number; y: number }

const ECU = 0.003;

/** The P-M check for one (Pu, Mu) point, plus the sampled surface behind it. `nmUtil` is
 *  the value that governs — see its own note below. */
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

/** A sampled point on the compression branch, before the load is applied. */
interface RawPoint { phiP: number; phiM: number; P: number; M: number; phi: number; et: number; c: number }

/** The lerp one bracketing segment contributes. Shared so both lookups agree exactly. */
function segMn(a: RawPoint, b: RawPoint, targetP: number): number {
  const t = (targetP - a.phiP) / ((b.phiP - a.phiP) || 1e-12);
  return a.phiM + t * (b.phiM - a.phiM);
}

/**
 * φMn on a sampled compression branch at a target φPn — outermost crossing wins.
 *
 * The exhaustive scan. Correct for any branch shape, O(n), and the reference the fast
 * path below is required to match exactly.
 */
function interpAtScan(pts: RawPoint[], targetP: number): number | null {
  let best: number | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a.phiP - targetP) * (b.phiP - targetP) <= 0) {
      const m = segMn(a, b, targetP);
      if (best === null || m > best) best = m;
    }
  }
  return best;
}

/**
 * The same answer in O(log n), for a branch whose φPn never decreases.
 *
 * This is the hottest loop in the whole ACI pass. The radial ray solve bisects to
 * double precision — ~45 evaluations — and each one asked the 900-sample branch for
 * its capacity, so a member with axial load on every row spent hundreds of millions
 * of comparisons re-scanning a curve that had not changed.
 *
 * On a non-decreasing sequence the bracketing segments are exactly those with
 * `pts[i-1].phiP <= targetP <= pts[i].phiP`. Both halves of that are monotone in `i`,
 * so the qualifying segments form one CONTIGUOUS range and its two ends can be
 * binary-searched. Away from the §22.4.2.1 cap that range is a single segment; on the
 * cap's flat top it is the plateau, where several samples really do share one axial
 * load and the outermost-crossing rule has to look at all of them — the same work the
 * scan did, in the one case that needs it.
 *
 * `monotone` is CHECKED when the surface is built, never assumed: an exotic cage whose
 * branch doubles back would otherwise be handed the wrong crossing silently. That case
 * falls back to the scan.
 */
function interpAtSorted(pts: RawPoint[], targetP: number): number | null {
  const n = pts.length;
  if (n < 2) return null;
  // first index i in [1, n-1] with pts[i].phiP >= targetP
  let lo = 1, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].phiP >= targetP) hi = mid; else lo = mid + 1;
  }
  if (pts[lo].phiP < targetP) return null;      // targetP is above the whole branch
  const from = lo;
  // last index i in [1, n-1] with pts[i-1].phiP <= targetP
  lo = 1; hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid - 1].phiP <= targetP) lo = mid; else hi = mid - 1;
  }
  if (pts[lo - 1].phiP > targetP) return null;  // targetP is below the whole branch
  const to = lo;
  let best: number | null = null;
  for (let i = from; i <= to; i++) {
    const m = segMn(pts[i - 1], pts[i], targetP);
    if (best === null || m > best) best = m;
  }
  return best;
}

/**
 * The φ-interaction surface for one section, cage and bending sense.
 *
 * Everything here depends on the MEMBER, not on the load: the load only enters at
 * the radial ray solve in beamAxialFlexure below. That split is the whole point —
 * see the cache note on `surfaceFor`.
 */
interface Surface {
  phiPnMax: number;
  phiPnTens: number;
  /** φMn at any axial load, both branches. */
  phiMnAt: (P: number) => number;
  /** Sampled curve for the calc sheet and the N-vs-M window. SHARED — see surfaceFor. */
  points: InteractionPoint[];
}

/**
 * The surface, memoised across the load rows of a member.
 *
 * A member has MANY load rows — one per station per combo, often dozens — and
 * designMember calls beamAxialFlexure once per row per bending sense. The surface
 * that call builds costs 900 strain-compatibility solves and does not depend on the
 * load at all, so it was being rebuilt identically dozens of times per member. On a
 * 175-beam / 5,742-row model with axial load present that was 5.2 SECONDS of design
 * pass, against 30 ms for the same model under EC2 (which has no P-M path) — enough
 * to lock the UI up on every code switch, cage edit or group apply.
 *
 * Four entries is all it takes. designMember evaluates the senses in the order
 * pos, neg, pos, neg… down a member's rows, so a 2-entry cache would already hit
 * every time after the first row; 4 leaves room for a caller that interleaves two
 * members without turning the cache into a memory pool. Each surface retains its
 * 900-point `raw` array, so this is bounded on purpose.
 *
 * The key is a full value serialisation of every input. Enumerating the fields by
 * hand would be faster and would be a latent wrong-number bug the first time
 * someone adds a field to SectionDimensions that the math reads and the key does
 * not — a stale surface is far worse than a slow one. Stringifying two small
 * objects per row costs microseconds against the 900 solves it avoids.
 */
const SURFACE_CACHE: { key: string; surf: Surface }[] = [];
const SURFACE_CACHE_MAX = 4;

/** Drop every memoised surface. Tests use it to prove the cache changes no number. */
export function clearAxialFlexureCache(): void {
  SURFACE_CACHE.length = 0;
}

function surfaceFor(
  section: SectionDimensions, material: MaterialProps, rebar: RebarLayout,
  span: number, sense: 'pos' | 'neg', phiMn0: number,
): Surface {
  const key = JSON.stringify([section, material, rebar, span, sense, phiMn0]);
  const hit = SURFACE_CACHE.findIndex(e => e.key === key);
  if (hit >= 0) {
    const [entry] = SURFACE_CACHE.splice(hit, 1);
    SURFACE_CACHE.unshift(entry);
    return entry.surf;
  }
  const surf = buildSurface(section, material, rebar, span, sense, phiMn0);
  SURFACE_CACHE.unshift({ key, surf });
  if (SURFACE_CACHE.length > SURFACE_CACHE_MAX) SURFACE_CACHE.length = SURFACE_CACHE_MAX;
  return surf;
}

/**
 * Build the φ-interaction surface for one bending sense.
 *
 * `phiMn0` is the pure-flexure design capacity from computeFlexure for this
 * sense — the anchor the whole curve is pinned to.
 */
function buildSurface(
  section: SectionDimensions,
  material: MaterialProps,
  rebar: RebarLayout,
  span: number,
  sense: 'pos' | 'neg',
  phiMn0: number,
): Surface {
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
    const phi = phiFlexure(et, fy, Es);
    return { P, M: M / 12000, phi, et, phiP: Math.min(phi * P, phiPnMax), phiM: phi * M / 12000 };
  }

  // Sample the compression branch. c from a hair above zero (deep tension-
  // controlled) out to well past full-section compression.
  const N = 900;
  const raw: RawPoint[] = [];
  for (let i = 1; i <= N; i++) {
    const c = (i / N) * 4 * h;
    raw.push({ ...at(c), c });
  }
  // Pin the curve to computeFlexure's pure-flexure capacity so φMn is continuous
  // through Pu = 0. The factor is ~1.000 for any normally-proportioned beam; it
  // only absorbs the small difference between this strain-compatibility solve and
  // the closed-form solve computeFlexure uses.
  const phiM0Raw = interpAtScan(raw, 0);
  const scale = phiM0Raw && phiM0Raw > 0 ? phiMn0 / phiM0Raw : 1;
  for (const p of raw) { p.phiM *= scale; p.M *= scale; }

  /** φMn at any axial load, both branches. */
  // Does φPn ever fall as the neutral axis deepens? It should not — more concrete in
  // compression can only add axial capacity, and the §22.4.2.1 cap turns the top of the
  // branch into a flat plateau rather than a descent. Established here, once per surface,
  // so the ray solve can binary-search instead of rescanning 900 samples per step; a
  // branch that failed this keeps the exhaustive scan and is merely slow, never wrong.
  let monotone = true;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i].phiP < raw[i - 1].phiP) { monotone = false; break; }
  }
  const interpAt = monotone ? interpAtSorted : interpAtScan;

  // φMn at the §22.4.2.1 cap, worked out once.
  //
  // Above the cap the query below clamps to phiPnMax, so every such call asked for the
  // SAME number — and that is the one target the binary search cannot narrow, because
  // the cap is exactly where φPn goes flat and every sample on the plateau qualifies as
  // a crossing. The ray solve drives λ·Pu past the cap on most of its steps, so this was
  // the residual hot spot after the search went logarithmic: one clamped lookup, hundreds
  // of segments, tens of thousands of times. Hoisting it is exact — same array, same
  // target, same answer.
  const mnAtCap = Math.max(0, interpAt(raw, phiPnMax) ?? 0);

  function phiMnAt(P: number): number {
    if (P < 0) {
      // Straight line from pure flexure down to pure tension.
      const frac = 1 - Math.abs(P) / Math.abs(phiPnTens);
      return Math.max(0, phiMn0 * frac);
    }
    if (P === 0) return phiMn0;
    if (P >= phiPnMax) return mnAtCap;
    return Math.max(0, interpAt(raw, P) ?? 0);
  }

  // Sampled curve for the calc sheet and the N-vs-M window: compression branch plus the
  // tension leg. DISPLAY ONLY — every check above walks `raw` at full density, so this
  // stride cannot move a DCR.
  //
  // Every 10th, not every 30th. The chart interpolates between these samples to answer
  // "φMn at this axial load" under the crosshair, and a chord across a convex curve
  // always cuts the corner: at a 30-sample stride that read came out ~1% BELOW the φMn
  // the engine reported for the same load — small, but it is the picture and the number
  // beside it disagreeing, which is the one thing this array exists to prevent. The
  // error falls with the square of the stride, so 3× the samples is ~9× closer (~0.1%).
  const points: InteractionPoint[] = raw
    .filter((_, i) => i % 10 === 0)
    .map(p => ({
      c: p.c, Pn: p.P, Mn: p.M, phi: p.phi,
      phiPn: p.phiP, phiMn: p.phiM, eps_t: p.et,
    }));
  points.push({ c: 0, Pn: phiPnTens / 0.9, Mn: 0, phi: 0.9, phiPn: phiPnTens, phiMn: 0, eps_t: 0.05 });

  return { phiPnMax, phiPnTens, phiMnAt, points };
}

/**
 * Build the φ-interaction for one bending sense and evaluate it at (Pu, Mu).
 *
 * `phiMn0` is the pure-flexure design capacity from computeFlexure for this
 * sense — the anchor the whole curve is pinned to.
 *
 * The surface itself is memoised per member (see surfaceFor); only the radial ray
 * solve below is per-load, which is the part that actually depends on (Pu, Mu).
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
  const { phiPnMax, phiPnTens, phiMnAt, points } = surfaceFor(section, material, rebar, span, sense, phiMn0);

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
      // Bisect until the bracket is at double precision, then stop.
      //
      // This ran a fixed 200 iterations. A bisection on doubles is finished after
      // ~52 halvings — lo and hi become adjacent and every further iteration picks
      // the same midpoint — so roughly three quarters of the work was recomputing
      // an answer that could no longer move. Each iteration costs a phiMnAt, and
      // phiMnAt walks all 900 samples of the branch, so on a model with axial load
      // on every row this was the single hottest loop in the design pass.
      //
      // The break is on the bracket width, not an iteration count, so the answer is
      // the same one the 200-iteration loop converged to.
      for (let i = 0; i < 200; i++) {
        const mid = 0.5 * (lo + hi);
        if (resid(mid) >= 0) hi = mid; else lo = mid;
        if (hi - lo <= Math.abs(hi) * 1e-14) break;
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

  return {
    phiPnMax, phiPnTens, phiMn0,
    phiMnAtPu: phiMnAt(Pu),
    axialUtil, nmUtil, phiPnAtRay, phiMnAtRay,
    // SHARED with every other row of this member — the surface it came from is
    // memoised, so this is one array, not one per row. Read it; never mutate it.
    points,
  };
}

/** Total longitudinal steel area a section's cage provides (in²). */
export function totalLongitudinalAs(rebar: RebarLayout): number {
  const sum = (bars?: BarGroup[]) =>
    (bars ?? []).reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
  return sum(rebar.topBars) + sum(rebar.botBars);
}
