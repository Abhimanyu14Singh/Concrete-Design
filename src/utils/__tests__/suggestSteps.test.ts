/**
 * Suggest — the step trace, and the guarantee behind it.
 *
 * The search makes three decisions in sequence (flexural cage → links → detailing) but
 * they are COUPLED: the link diameter sits between the cover and the longitudinal bars,
 * so a bigger link shrinks d and raises a flexural DCR that was already settled. Solved
 * naively, shear silently invalidates flexure and the group verification then blames
 * "mixed sections" for an arithmetic mismatch inside the suggester.
 *
 * The fix is to size flexure against the WORST link the shear stage can pick, which makes
 * the two true together by construction. These tests pin that — the flexural DCR must not
 * degrade from one stage to the next — and pin the trace that makes it checkable.
 */
import { describe, it, expect } from 'vitest';
import { suggestGroupRebar, isSuggestError } from '../suggestRebar';
import type { Member } from '../../types';

const beam = (o: {
  b?: number; h?: number; MuPos?: number; MuNeg?: number; Vu?: number; Tu?: number;
}): Member => ({
  id: 'm', label: 'm', memberType: 'beam',
  material: { fc: 5000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
  section: { type: 'rectangular_beam', b: o.b ?? 18, h: o.h ?? 60, coverClear: 1.5, stirrupDia: 4 },
  rebar: {
    topBars: [{ numBars: 2, barSize: 5 }], botBars: [{ numBars: 2, barSize: 5 }],
    ties: { barSize: 4, spacing: 6, legs: 2 },
  },
  loads: [{
    id: 'lc', label: 'ENV',
    Mu_pos: o.MuPos ?? 0, Mu_neg: o.MuNeg ?? 0, Vu: o.Vu ?? 0, Tu: o.Tu ?? 0, Pu: 0,
  }],
  span: 25,
});

/** Beams that between them exercise every stage and every flag. */
const CASES: [string, Member][] = [
  ['ordinary', beam({ MuPos: 1233, Vu: 225, Tu: 62 })],
  ['heavy shear', beam({ MuPos: 1233, Vu: 430 })],
  ['shear past the section', beam({ MuNeg: 3971, Vu: 1363, Tu: 27 })],
  ['moment past the ladder', beam({ MuPos: 8000, Vu: 300 })],
  ['torsion governed', beam({ MuPos: 1233, Vu: 225, Tu: 400 })],
  ['narrow web', beam({ b: 14, h: 24, MuPos: 400, MuNeg: 350, Vu: 90 })],
];

describe('moment and shear are met TOGETHER, not one after the other', () => {
  it.each(CASES)('%s — sizing the links never degrades the flexural DCR', (_n, m) => {
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    if (isSuggestError(r)) return;
    const steps = r.steps!;
    // The worst of the two moment faces is what the later stages must not push past.
    const atFlexure = Math.max(
      steps.find(s => s.stage === 'flexure+')!.flexDCR,
      steps.find(s => s.stage === 'flexure−')!.flexDCR,
    );
    for (const s of steps) {
      // A tolerance, not equality: the detailing stage can re-read flexure on a DIFFERENT
      // member of the group. What must not happen is the drift that used to push a cage
      // settled at 0.89 over target once shear chose a fatter link.
      expect(s.flexDCR, `${s.stage} moved flexure`).toBeLessThanOrEqual(atFlexure + 0.02);
    }
  });

  it.each(CASES)('%s — the final step agrees with the reported DCRs', (_n, m) => {
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    if (isSuggestError(r)) return;
    const last = r.steps![r.steps!.length - 1];
    expect(last.stage).toBe('detailing');
    expect(last.flexDCR).toBeCloseTo(r.worstDCRFlex, 6);
    expect(last.shearDCR).toBeCloseTo(r.worstDCRShear, 6);
  });
});

describe('the trace records every decision, in order', () => {
  it.each(CASES)('%s — flexure, then shear, then detailing', (_n, m) => {
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    if (isSuggestError(r)) return;
    // The order the user works in: sagging, then hogging around it, then links, then
    // the detailing pass.
    expect(r.steps!.map(s => s.stage)).toEqual(['flexure+', 'flexure−', 'shear', 'detailing']);
  });

  it('says what was CHOSEN at each stage, not just the numbers', () => {
    const r = suggestGroupRebar([beam({ MuPos: 1233, Vu: 225, Tu: 62 })], 'ACI318-19', 0.9);
    if (isSuggestError(r)) throw new Error(r.error);
    const [pos, neg, shear, detail] = r.steps!;
    expect(pos.chose).toMatch(/^bot .*#\d/);                 // sagging cage only
    expect(neg.chose).toMatch(/^top .*#\d/);                 // hogging cage only
    expect(shear.chose).toMatch(/#\d+ \d-leg @ [\d.]+/);      // one spacing
    expect(detail.chose).toMatch(/#\d+ \d-leg @ [\d.]+\/[\d.]+\/[\d.]+/);  // three zones
  });

  it('carries a finite DCR on every row', () => {
    for (const [, m] of CASES) {
      const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
      if (isSuggestError(r)) continue;
      for (const s of r.steps!) {
        for (const k of ['flexDCR', 'shearDCR', 'torsionDCR'] as const) {
          expect(Number.isFinite(s[k]), `${s.stage}.${k}`).toBe(true);
        }
      }
    }
  });
});

describe('warnings say what is still standing on the cage that ships', () => {
  it('is absent entirely when the cage is clean', () => {
    const r = suggestGroupRebar([beam({ MuPos: 1233, Vu: 225, Tu: 62 })], 'ACI318-19', 0.9);
    if (isSuggestError(r)) throw new Error(r.error);
    expect(r.worstDCRFlex).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(r.worstDCRShear).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(r.warnings).toBeUndefined();
  });

  it('names the shear shortfall, with the number', () => {
    const r = suggestGroupRebar([beam({ MuNeg: 3971, Vu: 1363, Tu: 27 })], 'ACI318-19', 0.9);
    if (isSuggestError(r)) throw new Error(r.error);
    expect(r.warnings!.join(' ')).toMatch(/Shear 2\.\d\d is over the 0\.90 target/);
  });

  it('names BOTH the ductility and the strength problem when both apply', () => {
    const r = suggestGroupRebar([beam({ MuPos: 8000, Vu: 300 })], 'ACI318-19', 0.9);
    if (isSuggestError(r)) throw new Error(r.error);
    const all = r.warnings!.join(' | ');
    expect(all).toMatch(/ρmax|over-reinforced/i);
    expect(all).toMatch(/Flexure 1\.\d\d is over/);
  });

  it('every flag it sets is accounted for in the list', () => {
    // The list is what a caller renders; a flag with no sentence is a silent failure.
    for (const [, m] of CASES) {
      const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
      if (isSuggestError(r)) continue;
      const flags = [r.overReinforced, r.belowTarget, r.shearBelowTarget, !!r.sectionLimit, !!r.note]
        .filter(Boolean).length;
      if (flags > 0) expect(r.warnings?.length ?? 0).toBeGreaterThanOrEqual(1);
      else expect(r.warnings).toBeUndefined();
    }
  });
});
