/**
 * ACI §22.5.1.2 — the Vs ceiling is REPORTED, not warned about.
 *
 * `computeShear` caps the stirrup contribution at Vs,max = 8√f'c·bw·d. That used to
 * raise an amber warning on the member: "Stirrup contribution capped … enlarge section
 * instead of adding stirrups". It is not a defect. It says the links have stopped
 * buying capacity — which is a property of the section, not of the design — and if
 * φVn still covers Vu the beam is perfectly good. Flagging it put a warning chip on
 * passing members whose only sin was that their shear DCR had stopped moving.
 *
 * So the condition moved to the Calc Sheet, where it reads as information rather than
 * as a fault, and where it can show both numbers: the raw Vs the formula produces and
 * the ceiling the capacity was actually taken from.
 *
 * The genuine failure keeps its error. Vu > φVn,max means the ceiling is not merely
 * reached but breached, no arrangement of links will do it, and Suggest reads that same
 * clause to answer "bigger section" instead of grinding through its stirrup ladder.
 */
import { describe, expect, it } from 'vitest';
import { computeShear, designMember } from '../concreteDesign';
import { generateBreakdown, type CalcStep } from '../calcBreakdown';
import type { LoadCase, MaterialProps, RebarLayout, SectionDimensions } from '../../types';

const sec: SectionDimensions = { type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4 };
const mat: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };
/** 6-leg #6 at 2" — far past what the section can use, so the ceiling binds hard. */
const capped: RebarLayout = {
  topBars: [{ numBars: 2, barSize: 8 }], botBars: [{ numBars: 4, barSize: 8 }],
  ties: { barSize: 6, spacing: 2, legs: 6 },
};
/** An ordinary cage, nowhere near the ceiling. */
const ordinary: RebarLayout = {
  topBars: [{ numBars: 2, barSize: 8 }], botBars: [{ numBars: 4, barSize: 8 }],
  ties: { barSize: 4, spacing: 10, legs: 2 },
};
const at = (Vu: number): LoadCase =>
  ({ id: 'l', label: 'ULS', Mu_pos: 100, Mu_neg: 0, Vu, Tu: 0, Pu: 0 } as LoadCase);

const steps = (cage: RebarLayout, Vu: number): CalcStep[] =>
  generateBreakdown(sec, mat, cage, at(Vu), 20).flatMap(s => s.steps ?? []);
const ceilingStep = (cage: RebarLayout, Vu: number) =>
  steps(cage, Vu).find(s => String(s.label).startsWith('Upper limit on the stirrup'));
const num = (text: string, after: string) =>
  Number(new RegExp(`${after}[^0-9-]*(-?[\\d.]+)`).exec(text)?.[1]);

describe('reaching the ceiling raises nothing', () => {
  it('a capped but passing beam carries no warning at all', () => {
    const sh = computeShear(sec, mat, capped);
    expect(sh.VsCapped).toBe(true);            // the cage really is past the limit
    const r = designMember(sec, mat, capped, at(80), 20);
    expect(r.DCR_shear).toBeLessThan(1);
    expect(r.warnings).toEqual([]);
  });

  it('no §22.5.1.2 warning at any demand the section can carry', () => {
    for (const Vu of [20, 80, 120, 160]) {
      const r = designMember(sec, mat, capped, at(Vu), 20);
      if (r.DCR_shear > 1) continue;
      expect(r.warnings.filter(w => w.code === 'ACI §22.5.1.2'), `Vu = ${Vu}`).toEqual([]);
    }
  });
});

describe('breaching it is still an error', () => {
  it('Vu past φVn,max keeps the clause, at error severity', () => {
    const r = designMember(sec, mat, capped, at(400), 20);
    const w = r.warnings.filter(x => x.code === 'ACI §22.5.1.2');
    expect(w).toHaveLength(1);
    expect(w[0].severity).toBe('error');
    expect(w[0].message).toMatch(/enlarge section/);
    expect(r.DCR_shear).toBeGreaterThan(1);
  });

  it('and the two conditions are distinguishable — one fires without the other', () => {
    // Capped, not breached → silent. Breached → exactly one error.
    expect(designMember(sec, mat, capped, at(80), 20)
      .warnings.some(w => w.code === 'ACI §22.5.1.2')).toBe(false);
    expect(designMember(sec, mat, capped, at(400), 20)
      .warnings.some(w => w.code === 'ACI §22.5.1.2')).toBe(true);
  });
});

describe('the Calc Sheet is where the ceiling is said', () => {
  it('names the limit and states that the capacity was taken from it', () => {
    const st = ceilingStep(capped, 80);
    expect(st).toBeDefined();
    expect(st!.ref).toBe('ACI 318-19 §22.5.1.2');
    expect(st!.result).toMatch(/CAPPED/);
    expect(st!.note).toMatch(/Not a failure/);
  });

  it('reproduces the engine: the printed ceiling IS the Vs the capacity used', () => {
    const sh = computeShear(sec, mat, capped);
    const printed = num(ceilingStep(capped, 80)!.result, 'Vs,max =');
    expect(printed).toBeCloseTo(sh.Vs, 1);                       // capped Vs == the ceiling
    expect(printed).toBeCloseTo(8 * Math.sqrt(4000) * 16 * sh.d_shear / 1000, 1);
  });

  it('the Vs step above it prints the RAW value, so its own substitution adds up', () => {
    // `shear.Vs` is already capped. Printing it against the Av·fyt·d/s substitution
    // showed a derivation that did not produce its own result whenever the cap bound.
    const vsStep = steps(capped, 80).find(s => s.label === 'Steel shear strength')!;
    const raw = num(vsStep.result, 'Vs =');
    const sh = computeShear(sec, mat, capped);
    expect(raw).toBeGreaterThan(sh.Vs);            // uncapped, so far above the ceiling
    const Av = 6 * 0.44;                            // 6 legs of #6
    expect(raw).toBeCloseTo(Av * 60000 * sh.d_shear / (2 * 1000), 1);
  });

  it('says so plainly when the ceiling is NOT governing', () => {
    const st = ceilingStep(ordinary, 40)!;
    expect(computeShear(sec, mat, ordinary).VsCapped).toBe(false);
    expect(st.result).toMatch(/not governing/);
    expect(st.result).not.toMatch(/CAPPED/);
  });

  it('the crushing-limit step is still there and still judges Vu', () => {
    const crush = steps(capped, 400).find(s => s.label === 'Cross-section crushing limit')!;
    expect(crush.result).toMatch(/NG/);
    expect(steps(capped, 80).find(s => s.label === 'Cross-section crushing limit')!.result)
      .toMatch(/OK/);
  });
});
