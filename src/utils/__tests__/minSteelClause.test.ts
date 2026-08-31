/**
 * ACI 318-19 §9.6.1 — minimum flexural reinforcement, end to end.
 *
 * The clause itself is short:
 *
 *   §9.6.1.1  a minimum is required at every section where tension reinforcement
 *             is required by analysis
 *   §9.6.1.2  As,min = greater of (a) 3√f'c/fy·bw·d and (b) 200/fy·bw·d
 *   §9.6.1.3  if As provided is at least one-third greater than As required by
 *             analysis, §9.6.1.2 need not be satisfied
 *
 * Three separate defects lived in the space around it, and each is pinned below.
 *
 * 1. THE CALC SHEET RE-DERIVED IT and stopped at §9.6.1.2, so a beam the engine had
 *    exempted under §9.6.1.3 still drew "⚠ Provided As_bot < As_min" on the sheet.
 *    Panel silent, sheet warning, same beam and same load row.
 * 2. THE SHEET HAD NO TOP-FACE ROW at all — one step, computed on the bottom-face
 *    depth. A hogging-governed beam's minimum-steel check simply was not shown.
 * 3. OVERRIDE ROUTING SPLIT FLEXURE ON /negative/, but the steel-limit messages name
 *    the face instead ("Top steel …"), so every top-steel As,min and As,max warning
 *    in BOTH engines was filed under DCR_flex_pos. Reviewing sagging silently cleared
 *    a hogging warning; reviewing hogging could not clear it.
 */
import { describe, expect, it } from 'vitest';
import {
  designMember, minSteelCheck, steelLimits, effectiveDepthMulti,
} from '../concreteDesign';
import { generateBreakdown } from '../calcBreakdown';
import { warningOverrideKey } from '../overrides';
import type { LoadCase, MaterialProps, RebarLayout, SectionDimensions } from '../../types';

const mat: MaterialProps = { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
const sect: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 };
/** S-CONCRETE back-check #2's cage: two #7 layers each face, dz = 1". */
const heavy: RebarLayout = {
  topBars: [{ numBars: 3, barSize: 7 }, { numBars: 3, barSize: 7 }],
  botBars: [{ numBars: 3, barSize: 7 }, { numBars: 3, barSize: 7 }],
  ties: { barSize: 4, spacing: 6, legs: 2 },
  layerClearSpacing: 1.0,
};
/** 0.40 in² a face — below the ~0.92 in² raw minimum, so §9.6.1.3 is what saves it. */
const light: RebarLayout = {
  topBars: [{ numBars: 2, barSize: 4 }],
  botBars: [{ numBars: 2, barSize: 4 }],
  ties: { barSize: 4, spacing: 6, legs: 2 },
};
const row = (o: Partial<LoadCase>): LoadCase =>
  ({ id: 'lc', label: 'ULS', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0, ...o } as LoadCase);

const minSteps = (rebar: RebarLayout, load: LoadCase) =>
  generateBreakdown(sect, mat, rebar, load, 20)
    .flatMap(s => s.steps)
    .filter(s => s.ref?.includes('9.6.1.2'));
/** The parity idiom: read the number back out of what the sheet PRINTS. */
const printed = (text: string) => Number(/([\d.]+)\s*in²/.exec(text)?.[1]);

describe('§9.6.1.2 — the formula', () => {
  it('is the greater of 3√f′c/fy and 200/fy, on the tension-group centroid d', () => {
    const d = effectiveDepthMulti(sect, heavy.botBars, 1.0, 'bot');
    expect(d).toBeCloseTo(20.625, 3);
    // At f′c = 5000, (a) 0.003536 governs over (b) 0.003333.
    const rho = Math.max(3 * Math.sqrt(5000) / 60000, 200 / 60000);
    expect(rho).toBeCloseTo(0.0035355, 6);
    expect(steelLimits(sect, mat, 'bot', heavy.botBars, 1.0).As_min)
      .toBeCloseTo(rho * 12 * d, 4);   // 0.8750 in², hand-checked
  });

  it('below f′c = 4444 psi it is 200/fy that governs — the max() is not decorative', () => {
    const low: MaterialProps = { ...mat, fc: 3000 };
    const d = effectiveDepthMulti(sect, heavy.botBars, 1.0, 'bot');
    expect(3 * Math.sqrt(3000) / 60000).toBeLessThan(200 / 60000);
    expect(steelLimits(sect, low, 'bot', heavy.botBars, 1.0).As_min)
      .toBeCloseTo((200 / 60000) * 12 * d, 4);
  });

  it('each face is measured on its OWN depth', () => {
    const deepBot: SectionDimensions = { ...sect, coverTop: 3.0 } as SectionDimensions;
    const top = steelLimits(deepBot, mat, 'top', [{ numBars: 2, barSize: 7 }], 1.0).As_min;
    const bot = steelLimits(deepBot, mat, 'bot', [{ numBars: 2, barSize: 7 }], 1.0).As_min;
    expect(top).toBeLessThan(bot);   // a deeper top cover means a shallower d
  });
});

describe('§9.6.1.3 — the one-third exception', () => {
  it('measures against As required by ANALYSIS, not the floored requirement', () => {
    // requiredAs() floors its result at As,min; measuring the exemption against that
    // would compare As,min with itself and the exception could never apply.
    const m = minSteelCheck(sect, mat, heavy, 'bot', 45, 20, 1.0);
    expect(m.As_req_raw).toBeLessThan(m.As_min);
    expect(m.As_min_eff).toBeCloseTo((4 / 3) * m.As_req_raw, 6);
    expect(m.exempt).toBe(true);
  });

  it('does not reduce the minimum once the demand is real', () => {
    const m = minSteelCheck(sect, mat, heavy, 'bot', 300, 20, 1.0);
    expect(m.exempt).toBe(false);
    expect(m.As_min_eff).toBeCloseTo(m.As_min, 6);
  });

  it('a face with no moment keeps the full minimum and raises no warning (§9.6.1.1)', () => {
    const m = minSteelCheck(sect, mat, heavy, 'top', 0, 20, 1.0);
    expect(m.As_req_raw).toBe(0);
    expect(m.As_min_eff).toBeCloseTo(m.As_min, 6);
    const r = designMember(sect, mat, light, row({ Mu_pos: 300 }), 20);
    // Mu_neg = 0 ⇒ no top-steel minimum warning even though 0.40 in² < 0.92 in².
    expect(r.warnings.filter(w => w.code === 'ACI §9.6.1.2' && /Top steel/.test(w.message))).toHaveLength(0);
  });

  it('a light cage under a tiny moment is exempt — no warning', () => {
    const r = designMember(sect, mat, light, row({ Mu_pos: 5, Mu_neg: 5, Vu: 10 }), 20);
    expect(r.warnings.filter(w => w.code === 'ACI §9.6.1.2')).toHaveLength(0);
  });
});

describe('the Calc Sheet prints what the engine decided', () => {
  it('exempt beam: the sheet reports the REDUCED figure and does not warn', () => {
    // The regression. Before: sheet printed the raw 0.92 in² and "⚠ Provided As_bot <
    // As_min" while designMember raised nothing at all.
    const load = row({ Mu_pos: 5, Mu_neg: 5, Vu: 10 });
    const eng = designMember(sect, mat, light, load, 20);
    expect(eng.warnings.filter(w => w.code === 'ACI §9.6.1.2')).toHaveLength(0);

    const bot = minSteps(light, load)[0];
    expect(printed(bot.result)).toBeCloseTo(eng.As_min!, 2);
    expect(bot.note).not.toMatch(/⚠/);
    expect(bot.substitution).toMatch(/9\.6\.1\.3/);   // and it SHOWS why
  });

  it('non-exempt beam: the sheet reports the raw minimum, still matching the engine', () => {
    const load = row({ Mu_pos: 300 });
    const eng = designMember(sect, mat, heavy, load, 20);
    const bot = minSteps(heavy, load)[0];
    expect(printed(bot.result)).toBeCloseTo(eng.As_min!, 2);
    expect(bot.substitution).not.toMatch(/9\.6\.1\.3/);
  });

  it('a genuinely short cage warns in BOTH places', () => {
    // Big enough moment that §9.6.1.3 cannot rescue it.
    const load = row({ Mu_pos: 120 });
    const eng = designMember(sect, mat, light, load, 20);
    expect(eng.warnings.some(w => w.code === 'ACI §9.6.1.2' && /Bottom steel/.test(w.message))).toBe(true);
    expect(minSteps(light, load)[0].note).toMatch(/⚠/);
  });

  it('both faces get a row, each on its own depth', () => {
    const steps = minSteps(heavy, row({ Mu_pos: 300, Mu_neg: 300 }));
    expect(steps).toHaveLength(2);
    expect(steps[0].label).toMatch(/bottom/i);
    expect(steps[1].label).toMatch(/top/i);
    const eng = designMember(sect, mat, heavy, row({ Mu_pos: 300, Mu_neg: 300 }), 20);
    expect(printed(steps[0].result)).toBeCloseTo(eng.As_min!, 2);
    expect(printed(steps[1].result)).toBeCloseTo(eng.As_min_top!, 2);
  });

  it('the top row reports the HOGGING verdict, not a copy of the sagging one', () => {
    // Sagging heavy, hogging trivial: the two faces must disagree.
    const load = row({ Mu_pos: 300, Mu_neg: 4 });
    const steps = minSteps(heavy, load);
    expect(steps[1].substitution).toMatch(/9\.6\.1\.3/);   // top exempt…
    expect(steps[0].substitution).not.toMatch(/9\.6\.1\.3/); // …bottom not
  });
});

describe('override routing knows which face a warning belongs to', () => {
  it('names the face rather than guessing from the word "negative"', () => {
    const cases: [string, string, string][] = [
      ['ACI §9.6.1.2', 'Top steel 0.40 in² is below As,min 0.92 in²', 'DCR_flex_neg'],
      ['ACI §9.6.1.2', 'Bottom steel 0.40 in² is below As,min 0.92 in²', 'DCR_flex_pos'],
      ['ACI §9.3.3', 'Top steel 6.20 in² > As_max 5.45 in²', 'DCR_flex_neg'],
      ['ACI §9.3.3', 'Bottom steel 6.20 in² > As_max 5.45 in² — compression-controlled', 'DCR_flex_pos'],
      // EC2 uses the same wording for the same clause family.
      ['EC2 §9.2.1.1', 'Top steel 320 mm² < As,min = 410 mm²', 'DCR_flex_neg'],
      ['EC2 §9.2.1.1', 'Bottom steel 320 mm² < As,min = 410 mm²', 'DCR_flex_pos'],
    ];
    for (const [code, message, key] of cases) {
      expect(warningOverrideKey(code, message), `${code} — ${message}`).toBe(key);
    }
  });

  it('capacity messages still route on their own wording', () => {
    expect(warningOverrideKey('ACI §22.3', 'Negative flexure NG: DCR = 1.20')).toBe('DCR_flex_neg');
    expect(warningOverrideKey('ACI §22.3', 'Positive flexure NG: DCR = 1.20')).toBe('DCR_flex_pos');
    expect(warningOverrideKey('EC2 §6.1', 'Negative flexure NG: M_Ed = 400 kN·m > M_Rd = 380')).toBe('DCR_flex_neg');
  });

  it('a real hogging beam files its warning under the hogging key', () => {
    // End to end: the engine's own message, through the real classifier.
    const r = designMember(sect, mat, light, row({ Mu_neg: 120 }), 20);
    const w = r.warnings.find(x => x.code === 'ACI §9.6.1.2')!;
    expect(w.message).toMatch(/^Top steel/);
    expect(warningOverrideKey(w.code, w.message)).toBe('DCR_flex_neg');
  });
});
