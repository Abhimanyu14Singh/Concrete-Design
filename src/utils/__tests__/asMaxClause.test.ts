/**
 * ACI 318-19 §9.3.3.1 — maximum flexural reinforcement.
 *
 * "For nonprestressed beams with Pu < 0.10·f′c·Ag, εt shall be at least εty + 0.003."
 *
 * Two separate questions: what the limit IS, and where it APPLIES.
 *
 * THE LIMIT STATE. Setting εt to the limit fixes c/d; equilibrium at that c gives the
 * steel it balances:
 *
 *     c        = d · 0.003/(0.003 + εty + 0.003)
 *     As,max   = 0.85·f′c·b·β₁·c / fy  =  0.85·β₁·(f′c/fy)·b·d·0.003/(0.006 + εty)
 *
 * WHICH DEPTH. §2.2 defines εt "in the extreme layer", which argues for dt, and this
 * was written on dt originally. It is on d — the tension-group centroid — by project
 * decision, to agree with S-CONCRETE. The evidence that S-CONCRETE measures at the
 * centroid is ten faces across `Examples/ACI` 3 and 5–8, whose reported As(max) each
 * back-solve to εt = εty + 0.003 at d exactly. d ≤ dt always, so this is the lower and
 * therefore safer of the two caps.
 *
 * The two coincide on any single-layer face, which is why several of the checks below
 * pass either way; the multi-layer cases are the ones that pin the choice.
 *
 * THE SCOPE. The limit was applied to every member regardless of axial load, but the
 * clause is explicitly about beams: above 0.10·f′c·Ag the member is a compression
 * member and the tension-controlled limit does not govern it. Calling such a member
 * "over-reinforced" against a beam limit is a false positive on precisely the members
 * that legitimately carry the most steel, so the verdict is now withheld there —
 * `As_max` itself is still computed and displayed.
 *
 * This is a DELIBERATE DIVERGENCE from S-CONCRETE, which applies the beam limit
 * whatever the axial load: `Examples/ACI` 6 and 7 carry 1000 and 500 kips of
 * compression against a 196 kip threshold and still report the plain beam As(max).
 * The divergence is defended by the clause's own opening words, not by agreement.
 *
 * (An earlier note here claimed the scope explained Example 1's As(max) = 9.05 in².
 * It does not — Examples 6 and 7 disprove it. That number remains underived.)
 */
import { describe, expect, it } from 'vitest';
import {
  beta1, computeFlexure, designMember, effectiveDepthMulti, getBarArea, layerDepths, steelLimits,
} from '../concreteDesign';
import type { BarGroup, LoadCase, MaterialProps, RebarLayout, SectionDimensions } from '../../types';

const gr60 = { fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const mat6: MaterialProps = { fc: 6000, ...gr60 };
const s28: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 28, coverClear: 1.5, stirrupDia: 5 };
const s40: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 40, coverClear: 1.5, stirrupDia: 5 };
const one8: BarGroup[] = [{ numBars: 4, barSize: 8 }];
const two8: BarGroup[] = [{ numBars: 4, barSize: 8 }, { numBars: 4, barSize: 8 }];
const b42: BarGroup[] = [{ numBars: 4, barSize: 8 }, { numBars: 2, barSize: 8 }];
const row = (o: Partial<LoadCase>): LoadCase =>
  ({ id: 'lc', label: 'ULS', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0, ...o } as LoadCase);

describe('the formula lands on the tension-controlled boundary', () => {
  const cases: [string, SectionDimensions, MaterialProps, BarGroup[]][] = [
    ['12×28 f′c6000, two #8 layers', s28, mat6, two8],
    ['12×28 f′c6000, one #8 layer', s28, mat6, one8],
    ['12×40 f′c6000, 4+2-#8', s40, mat6, b42],
    ['12×24 f′c5000, two #7 layers', { type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 },
      { fc: 5000, ...gr60 }, [{ numBars: 3, barSize: 7 }, { numBars: 3, barSize: 7 }]],
  ];

  it.each(cases)('%s — εt at the centroid is exactly εty + 0.003 at As,max', (_n, sect, mat, bars) => {
    const { As_max } = steelLimits(sect, mat, 'bot', bars, 1.0);
    const d = effectiveDepthMulti(sect, bars, 1.0, 'bot');
    const ety = mat.fy / mat.Es;
    // Singly reinforced: a = As·fy/(0.85 f′c b), c = a/β₁, εt = 0.003(d − c)/c.
    const a = As_max * mat.fy / (0.85 * mat.fc * sect.b);
    const c = a / beta1(mat.fc);
    expect(0.003 * (d - c) / c).toBeCloseTo(ety + 0.003, 6);
  });

  it.each(cases)('%s — φ is still 0.90 there, so the cap never lands in the transition', (_n, sect, mat, bars) => {
    // Measured at dt the strain is at or above the limit, so a cage at As,max is
    // tension-controlled either way. Using d only makes the cap arrive sooner.
    const { As_max } = steelLimits(sect, mat, 'bot', bars, 1.0);
    const phiAt = (As: number) => computeFlexure(
      sect, mat, 0, As, 20, bars[0].barSize, bars[0].barSize, [],
      [{ numBars: As / getBarArea(bars[0].barSize), barSize: bars[0].barSize }], 1.0,
    ).phi_pos;
    expect(phiAt(As_max)).toBeCloseTo(0.9, 4);
  });

  it('is written on d, not dt — the multi-layer case that separates them', () => {
    const bars = b42, h = 40;
    const d = effectiveDepthMulti(s40, bars, 1.0, 'bot');
    const dt = h - Math.min(...layerDepths(s40, bars, 1.0, 'bot').map(l => l.y));
    const ety = 60000 / 29e6;
    const rho = 0.85 * beta1(6000) * (6000 / 60000) * (0.003 / (0.006 + ety));
    const { As_max } = steelLimits(s40, mat6, 'bot', bars, 1.0);
    expect(As_max).toBeCloseTo(rho * 12 * d, 4);
    expect(As_max).not.toBeCloseTo(rho * 12 * dt, 3);
    expect(d).toBeLessThan(dt);   // and d is the SMALLER, so the cap is the tighter one
  });

  it('each face is measured on its own depth', () => {
    // 12×28: the bottom has two layers and the top one, so their d differ and so do
    // their caps — which is the whole reason the two faces are computed separately.
    const bot = steelLimits(s28, mat6, 'bot', two8, 1.0).As_max;
    const top = steelLimits(s28, mat6, 'top', one8, 1.0).As_max;
    expect(bot).toBeLessThan(top);          // the two-layer face sits shallower
    expect(steelLimits(s40, mat6, 'bot', b42, 1.0).As_max).toBeGreaterThan(bot);
  });
});

describe('§9.3.3.1 is scoped to beams — Pu < 0.10·f′c·Ag', () => {
  const threshold = 0.10 * 6000 * 12 * 28 / 1000;   // 201.6 kips for the 12×28

  it('the threshold is the clause’s own', () => expect(threshold).toBeCloseTo(201.6, 1));

  it('applies below it, including under axial tension', () => {
    expect(steelLimits(s28, mat6, 'bot', two8, 1.0, 0).asMaxApplies).toBe(true);
    expect(steelLimits(s28, mat6, 'bot', two8, 1.0, 200).asMaxApplies).toBe(true);
    expect(steelLimits(s28, mat6, 'bot', two8, 1.0, -500).asMaxApplies).toBe(true);
  });

  it('stops applying above it', () => {
    expect(steelLimits(s28, mat6, 'bot', two8, 1.0, 250).asMaxApplies).toBe(false);
    expect(steelLimits(s28, mat6, 'bot', two8, 1.0, 1000).asMaxApplies).toBe(false);
  });

  it('an over-reinforced BEAM is still flagged', () => {
    const heavy: RebarLayout = {
      topBars: one8,
      botBars: [{ numBars: 8, barSize: 11 }, { numBars: 8, barSize: 11 }],   // 24.96 in²
      ties: { barSize: 5, spacing: 9, legs: 2 }, layerClearSpacing: 1.0,
    };
    const r = designMember(s28, mat6, heavy, row({ Mu_pos: 100, Vu: 20, Pu: 0 }), 20);
    expect(r.warnings.some(w => w.code === 'ACI §9.3.3')).toBe(true);
  });

  it('the same cage above the threshold is NOT flagged — Example 1’s regime', () => {
    // The false positive: 1000 kips of compression makes this a compression member,
    // and §9.3.3.1 says nothing about it.
    const heavy: RebarLayout = {
      topBars: one8,
      botBars: [{ numBars: 8, barSize: 11 }, { numBars: 8, barSize: 11 }],
      ties: { barSize: 5, spacing: 9, legs: 2 }, layerClearSpacing: 1.0,
    };
    const r = designMember(s28, mat6, heavy, row({ Mu_pos: 100, Vu: 20, Pu: 1000 }), 20);
    expect(r.warnings.some(w => w.code === 'ACI §9.3.3')).toBe(false);
  });

  it('Example 1 itself carries no §9.3.3 warning', () => {
    // 12×28, 8-#8 bottom, 1000 kips compression — S-Concrete marks its As(max) row
    // "Acceptable", and so must we.
    const cage: RebarLayout = {
      topBars: one8, botBars: two8,
      ties: { barSize: 5, spacing: 9, legs: 2 }, layerClearSpacing: 1.0,
    };
    const r = designMember(s28, mat6, cage, row({ Mu_pos: 290, Vu: 60, Pu: 1000 }), 20);
    expect(r.warnings.filter(w => w.code === 'ACI §9.3.3')).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it('As_max is still REPORTED above the threshold — only the verdict is withheld', () => {
    // The Calc Sheet still shows the derivation and the panel still shows the number;
    // what changes is that neither calls the member over-reinforced.
    const lim = steelLimits(s28, mat6, 'bot', two8, 1.0, 1000);
    expect(lim.As_max).toBeGreaterThan(0);
    expect(lim.asMaxApplies).toBe(false);
  });
});

describe('the §9.3.3 warnings are PER FACE, each against its own limit', () => {
  // 14×28, f′c 5000. #11 bars so a modest count clears the cap, and the two faces are
  // given DIFFERENT depths (bottom stacked into two layers) so their limits differ —
  // which is the thing a single shared As,max would hide.
  const sect: SectionDimensions = { type: 'rectangular_beam', b: 14, h: 28, coverClear: 1.5, stirrupDia: 4 };
  const mat: MaterialProps = { fc: 5000, ...gr60 };
  const cage = (top: BarGroup[], bot: BarGroup[]): RebarLayout =>
    ({ topBars: top, botBars: bot, ties: { barSize: 4, spacing: 12, legs: 2 }, layerClearSpacing: 1.0 });
  const light: BarGroup[] = [{ numBars: 2, barSize: 11 }];                                   // 3.12 in²
  const heavy: BarGroup[] = [{ numBars: 3, barSize: 11 }, { numBars: 3, barSize: 11 }];      // 9.36 in², 2 layers
  const load = row({ Mu_pos: 200, Mu_neg: 200, Vu: 20 });
  const nine = (r: ReturnType<typeof designMember>) => r.warnings.filter(w => w.code === 'ACI §9.3.3');

  it('the two faces have DIFFERENT limits when their depths differ', () => {
    const r = designMember(sect, mat, cage(light, heavy), load, 20);
    expect(r.As_max).toBeDefined();
    expect(r.As_max_top).toBeDefined();
    expect(r.As_max).toBeLessThan(r.As_max_top!);   // stacked bottom sits shallower
  });

  it('an over-reinforced BOTTOM raises exactly one warning, naming the bottom', () => {
    const w = nine(designMember(sect, mat, cage(light, heavy), load, 20));
    expect(w).toHaveLength(1);
    expect(w[0].message).toMatch(/^Bottom steel/);
  });

  it('an over-reinforced TOP raises exactly one warning, naming the top', () => {
    const w = nine(designMember(sect, mat, cage(heavy, light), load, 20));
    expect(w).toHaveLength(1);
    expect(w[0].message).toMatch(/^Top steel/);
  });

  it('both over-reinforced raises TWO warnings, one per face', () => {
    const w = nine(designMember(sect, mat, cage(heavy, heavy), load, 20));
    expect(w).toHaveLength(2);
    expect(w.map(x => x.message.split(' ')[0]).sort()).toEqual(['Bottom', 'Top']);
  });

  it('each message quotes ITS OWN face’s limit, not the other’s', () => {
    // Same steel area on both faces but DIFFERENT depths — one layer on top, two on the
    // bottom — so the two limits differ and a shared number would be visible.
    const flatTop: BarGroup[] = [{ numBars: 6, barSize: 11 }];   // 9.36 in², one layer
    const r = designMember(sect, mat, cage(flatTop, heavy), load, 20);
    const w = nine(r);
    const quoted = (face: string) =>
      Number(/> As_max ([\d.]+)/.exec(w.find(x => x.message.startsWith(face))!.message)![1]);
    expect(quoted('Bottom')).toBeCloseTo(r.As_max!, 2);
    expect(quoted('Top')).toBeCloseTo(r.As_max_top!, 2);
    expect(quoted('Bottom')).not.toBeCloseTo(quoted('Top'), 2);
  });

  it('a face within its limit is silent even while the other is over', () => {
    const r = designMember(sect, mat, cage(light, heavy), load, 20);
    expect(nine(r).some(w => w.message.startsWith('Top'))).toBe(false);
  });

  it('is NOT gated on the moment — As,max is a section property', () => {
    // S-Concrete reports As′(max) for a face carrying no hogging at all (Example 1's
    // top face: As′(min) 0.00, As′(max) 7.38), so the cap is judged on the cage rather
    // than on one load row. Gating it on Mu was tried and backed out on that evidence.
    const w = nine(designMember(sect, mat, cage(heavy, heavy), row({ Vu: 20 }), 20));
    expect(w).toHaveLength(2);
  });
});
