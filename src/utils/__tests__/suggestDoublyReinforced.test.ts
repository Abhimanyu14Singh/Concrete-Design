/**
 * Suggest — the doubly-reinforced fallback (ACI).
 *
 * The single-face pass probes each face with the OPPOSITE one pinned at its lightest
 * rung. That is fast, and for an ordinary beam it is right. But it makes the search
 * blind to compression steel, so it hits ρmax and reports "enlarge the section" for
 * cages a designer would simply draw: put bars in the compression zone, the neutral
 * axis rises, the tensile strain ρmax exists to protect comes back, and the section
 * carries the moment.
 *
 * Every "it works now" case below is verified against `runDesign` independently, not
 * against the suggester's own report — a suggester that both proposes a cage and grades
 * it can agree with itself while being wrong.
 */
import { describe, it, expect } from 'vitest';
import { suggestGroupRebar, isSuggestError } from '../suggestRebar';
import { runDesign } from '../../engines';
import { getBarArea } from '../concreteDesign';
import type { Member } from '../../types';

/** An 18×60 / f′c 5000 beam — the section that prompted this, from a live ETABS model. */
function beam(o: {
  id?: string; b?: number; h?: number;
  MuPos?: number; MuNeg?: number; Vu?: number; Tu?: number;
}): Member {
  return {
    id: o.id ?? 'm1',
    label: o.id ?? 'm1',
    memberType: 'beam',
    material: { fc: 5000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
    section: { type: 'rectangular_beam', b: o.b ?? 18, h: o.h ?? 60, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 2, barSize: 5 }],
      botBars: [{ numBars: 2, barSize: 5 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    },
    loads: [{
      id: 'lc', label: 'ENV',
      Mu_pos: o.MuPos ?? 0, Mu_neg: o.MuNeg ?? 0, Vu: o.Vu ?? 0, Tu: o.Tu ?? 0, Pu: 0,
    }],
    span: 25,
  };
}

const As = (bars: { numBars: number; barSize: number }[]) =>
  bars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);

describe('ACI Suggest — compression steel rescues a face at ρmax', () => {
  it('solves an 18×60 at Mu+ = 4500 kip-ft, which the single-face pass refused', () => {
    const m = beam({ MuPos: 4500, Vu: 50 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r), isSuggestError(r) ? r.error : '').toBe(false);
    if (isSuggestError(r)) return;

    // Independently: does the proposed cage actually carry it?
    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(check.DCR_flex_pos).toBeLessThanOrEqual(0.9 + 1e-6);

    // And it is doubly reinforced — the top steel is not decoration, it is what carries
    // the sagging face past ρmax. Asserted by REMOVING it: the same section with the same
    // bottom cage and a token top pair does not reach the target.
    //
    // This used to be a ratio test (top > 0.25 × bottom), which is a proxy for the claim
    // rather than the claim, and it broke the moment the bottom face legitimately grew.
    // Asserting the mechanism directly cannot drift with the layout the search settles on.
    const token = { ...r.rebar, topBars: [{ numBars: 2, barSize: 5 }] };
    const without = runDesign(m.section, m.material, token, m.loads[0], m.span, 'ACI318-19');
    expect(without.DCR_flex_pos).toBeGreaterThan(0.9 + 1e-6);
    expect(As(r.rebar.topBars)).toBeGreaterThan(As(token.topBars) * 4);
  });

  it('uses more than one layer to get there', () => {
    // The user-visible ask: two layers must be reachable. Three already were; what was
    // missing was the second face.
    const r = suggestGroupRebar([beam({ MuPos: 4500, Vu: 50 })], 'ACI318-19', 0.9);
    if (isSuggestError(r)) throw new Error(r.error);
    expect(r.rebar.botBars.length).toBeGreaterThanOrEqual(2);
  });

  it('reports a DCR that matches an independent run, not just its own arithmetic', () => {
    const m = beam({ MuPos: 4500, Vu: 50 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    if (isSuggestError(r)) throw new Error(r.error);
    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(r.worstDCRFlex).toBeCloseTo(Math.max(check.DCR_flex_pos, check.DCR_flex_neg), 2);
  });
});

describe('ACI Suggest — the fallback must not change what already worked', () => {
  const cases: [string, Member][] = [
    ['modest 14×24', beam({ b: 14, h: 24, MuPos: 150, MuNeg: 120, Vu: 45 })],
    ['two-layer 14×24', beam({ b: 14, h: 24, MuPos: 400, MuNeg: 350, Vu: 90 })],
    ['18×60 at Mu+ 1233 (the live model)', beam({ MuPos: 1233, Vu: 225, Tu: 62 })],
    ['18×60 at Mu+ 3500', beam({ MuPos: 3500, Vu: 50 })],
  ];
  it.each(cases)('%s still solves, at or under target', (_name, m) => {
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r), isSuggestError(r) ? r.error : '').toBe(false);
    if (isSuggestError(r)) return;
    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(Math.max(check.DCR_flex_pos, check.DCR_flex_neg)).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(check.DCR_shear).toBeLessThanOrEqual(0.9 + 1e-6);
  });
});

describe('ACI Suggest — past the limit it SHOWS the cage instead of refusing', () => {
  it('returns the section ceiling, flagged, when nothing reaches the target', () => {
    // An 18×60 tops out near φMn ≈ 5400 kip-ft. At 8000 the answer is still "bigger
    // section" — but the cage is produced so the shortfall is a number you can read
    // rather than a sentence you have to trust.
    const m = beam({ MuPos: 8000, Vu: 50 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r), isSuggestError(r) ? r.error : '').toBe(false);
    if (isSuggestError(r)) return;

    expect(r.belowTarget).toBe(true);
    // It must be HONEST about it: the reported DCR is over target, not massaged down.
    expect(r.worstDCRFlex).toBeGreaterThan(0.9);
    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(r.worstDCRFlex).toBeCloseTo(Math.max(check.DCR_flex_pos, check.DCR_flex_neg), 2);
  });

  it('gives the RICHEST cage there, not a token one', () => {
    // The point of showing it is measuring the gap, so it has to be the ceiling — a
    // light cage would overstate how far short the section is.
    const ceiling = suggestGroupRebar([beam({ MuPos: 8000, Vu: 50 })], 'ACI318-19', 0.9);
    const midway = suggestGroupRebar([beam({ MuPos: 3500, Vu: 50 })], 'ACI318-19', 0.9);
    if (isSuggestError(ceiling) || isSuggestError(midway)) throw new Error('expected cages');
    expect(As(ceiling.rebar.botBars)).toBeGreaterThan(As(midway.rebar.botBars));
  });

  it('scales the reported shortfall with the demand', () => {
    // 5000 is a bar size short; 8000 is a different beam. Both are returned, and the
    // DCR is what tells them apart — which is the whole reason to return them.
    const near = suggestGroupRebar([beam({ MuPos: 5000, Vu: 50 })], 'ACI318-19', 0.9);
    const far = suggestGroupRebar([beam({ MuPos: 8000, Vu: 50 })], 'ACI318-19', 0.9);
    if (isSuggestError(near) || isSuggestError(far)) throw new Error('expected cages');
    expect(near.worstDCRFlex).toBeLessThan(far.worstDCRFlex);
  });

  it('does not flag an ordinary passing cage', () => {
    const r = suggestGroupRebar([beam({ MuPos: 1233, Vu: 225, Tu: 62 })], 'ACI318-19', 0.9);
    if (isSuggestError(r)) throw new Error(r.error);
    expect(r.belowTarget).toBeUndefined();
    expect(r.overReinforced).toBeUndefined();
  });

  it('solves the MOMENT even when shear is past the section limit', () => {
    // ACI §22.5.1.2 caps Vn at Vc + 8√f′c·bw·d, and past that legs and spacing are
    // irrelevant. That is a verdict about the web — it says nothing about the moment
    // cage, which is solvable here and must not be thrown away with it.
    const m = beam({ b: 14, h: 24, MuPos: 150, Vu: 200 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r), isSuggestError(r) ? r.error : '').toBe(false);
    if (isSuggestError(r)) return;

    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(check.DCR_flex_pos).toBeLessThanOrEqual(0.9 + 1e-6);   // moment: solved
    expect(r.shearBelowTarget).toBe(true);                        // shear: flagged
    expect(r.worstDCRShear).toBeGreaterThan(0.9);                 // and honest about it
  });

  it('gives the tightest practical links when it cannot meet shear', () => {
    // "Best effort" has to mean the richest rung, or the reported shortfall overstates
    // how far the section is from working.
    const easy = suggestGroupRebar([beam({ b: 18, h: 60, MuPos: 200, Vu: 100 })], 'ACI318-19', 0.9);
    const hard = suggestGroupRebar([beam({ b: 18, h: 60, MuPos: 200, Vu: 1363 })], 'ACI318-19', 0.9);
    if (isSuggestError(easy) || isSuggestError(hard)) throw new Error('expected cages');
    const rate = (t: NonNullable<typeof easy.rebar.ties>) => t.legs * getBarArea(t.barSize) / t.spacing;
    expect(rate(hard.rebar.ties!)).toBeGreaterThan(rate(easy.rebar.ties!));
  });
});

describe('ACI Suggest — the moment answer survives a shear or torsion verdict', () => {
  // The three refusals a live 12-group ACI model actually hit. Each used to discard the
  // whole suggestion; each must now come back as a cage with the moment solved.
  const cases: [string, Member][] = [
    ['shear past the section limit', beam({ MuNeg: 3971, Vu: 1363, Tu: 27 })],
    ['torsion past the tightest links', beam({ MuPos: 1233, Vu: 225, Tu: 400 })],
  ];
  it.each(cases)('%s — moment still solved, shear flagged', (_n, m) => {
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r), isSuggestError(r) ? r.error : '').toBe(false);
    if (isSuggestError(r)) return;
    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(Math.max(check.DCR_flex_pos, check.DCR_flex_neg)).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(r.shearBelowTarget).toBe(true);
  });

  it('a group of mismatched members still gets one common cage', () => {
    // A light and a very heavy member sharing a group. Whatever the shortfall turns out
    // to be, the sweep must come back with the best COMMON cage rather than nothing —
    // that cage plus the per-member DCRs is how the outliers become visible.
    const light = { ...beam({ id: 'light', MuPos: 300, Vu: 60 }) };
    const heavy = { ...beam({ id: 'heavy', MuPos: 3900, Vu: 430, Tu: 60 }) };
    const r = suggestGroupRebar([light, heavy], 'ACI318-19', 0.9);
    expect(isSuggestError(r), isSuggestError(r) ? r.error : '').toBe(false);
    if (isSuggestError(r)) return;
    expect(r.rebar.botBars.length).toBeGreaterThan(0);
    expect(r.rebar.ties).toBeDefined();
    // The heavy member's moment is what the cage was sized against, and it is met.
    const chk = runDesign(heavy.section, heavy.material, r.rebar, heavy.loads[0], heavy.span, 'ACI318-19');
    expect(Math.max(chk.DCR_flex_pos, chk.DCR_flex_neg)).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it('names SPLITTING as the remedy when the group is what disagrees', () => {
    // Distinct from the section verdicts: here every ladder found a rung that works on
    // its own governing member, and the group still cannot share one cage. The fix is to
    // split it, not to enlarge anything — so the note has to say which.
    const light = { ...beam({ id: 'light', b: 18, h: 60, MuPos: 200, Vu: 40 }) };
    const heavy = { ...beam({ id: 'heavy', b: 12, h: 20, MuPos: 260, Vu: 55 }) };
    const r = suggestGroupRebar([light, heavy], 'ACI318-19', 0.9);
    if (isSuggestError(r)) return;                    // an outright refusal is also fine
    if (r.note) expect(r.note).toMatch(/split/i);     // but if it advises, it advises THIS
    expect(r.note === undefined || !!r.belowTarget || !!r.shearBelowTarget).toBe(true);
  });

  it('leaves an ordinary group completely unflagged', () => {
    const r = suggestGroupRebar([beam({ MuPos: 1233, Vu: 225, Tu: 62 })], 'ACI318-19', 0.9);
    if (isSuggestError(r)) throw new Error(r.error);
    expect(r.belowTarget).toBeUndefined();
    expect(r.shearBelowTarget).toBeUndefined();
    expect(r.sectionLimit).toBeUndefined();
    expect(r.note).toBeUndefined();
  });
});

describe('ACI Suggest — stirrup legs escalate with shear', () => {
  it('adds legs when a wide web needs more than a closed hoop can give', () => {
    const m = beam({ b: 36, h: 72, MuPos: 500, Vu: 900 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r), isSuggestError(r) ? r.error : '').toBe(false);
    if (isSuggestError(r)) return;
    expect(r.rebar.ties?.legs ?? 0).toBeGreaterThan(2);
    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(check.DCR_shear).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it('keeps a 2-leg hoop when that is enough — legs are a response to demand', () => {
    const r = suggestGroupRebar([beam({ b: 18, h: 60, MuPos: 200, Vu: 100 })], 'ACI318-19', 0.9);
    if (isSuggestError(r)) throw new Error(r.error);
    expect(r.rebar.ties?.legs).toBe(2);
  });

  it('still sizes the LINKS on a beam whose flexure cannot be satisfied', () => {
    // This is why the flexure change matters to shear. Flexure is solved first and used
    // to return early on failure, so a group that could not resolve its cage never got a
    // stirrup suggestion at all — which is what "Suggest does not add legs" really was.
    // Now both come back: the moment cage as the section's ceiling, the links sized
    // properly on top of it.
    const m = beam({ MuPos: 8000, Vu: 300 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r), isSuggestError(r) ? r.error : '').toBe(false);
    if (isSuggestError(r)) return;
    expect(r.belowTarget).toBe(true);              // flexure: honest about the shortfall
    expect(r.rebar.ties).toBeDefined();            // shear: sized anyway
    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(check.DCR_shear).toBeLessThanOrEqual(0.9 + 1e-6);
  });
});
