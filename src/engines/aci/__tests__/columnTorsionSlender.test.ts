import { describe, it, expect } from 'vitest';
import { aciColumnTorsion, aciColumnSlenderness, designColumnACI } from '../aciColumn';
import type { SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../../types';

const mat: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 };
const sec = (over: Partial<SectionDimensions> = {}): SectionDimensions =>
  ({ type: 'rectangular_column', b: 20, h: 24, coverClear: 1.5, stirrupDia: 4, ...over });
const rebar: RebarLayout = {
  topBars: [{ numBars: 3, barSize: 9 }], botBars: [{ numBars: 3, barSize: 9 }],
  sideBars: [{ numBars: 2, barSize: 9 }], ties: { barSize: 4, spacing: 12, legs: 2 }, tieType: 'tied',
};

describe('aciColumnTorsion (ACI §22.7, S-Concrete-calibrated)', () => {
  it('φTcr rises with axial compression', () => {
    const t0 = aciColumnTorsion(sec(), mat, rebar, 0, 0);
    const tP = aciColumnTorsion(sec(), mat, rebar, 0, 600);
    expect(tP.phi_Tcr).toBeGreaterThan(t0.phi_Tcr);
    expect(tP.Tu_threshold).toBeCloseTo(0.25 * tP.phi_Tcr, 6);
  });

  it('torsion is inactive below the 0.25·φTcr threshold (DCR_T = 0)', () => {
    const t = aciColumnTorsion(sec(), mat, rebar, 0, 400);
    const tiny = aciColumnTorsion(sec(), mat, rebar, t.Tu_threshold * 0.5, 400);
    expect(tiny.torsionActive).toBe(false);
    expect(tiny.DCR_T).toBe(0);
  });

  it('computes a DCR once torsion is active', () => {
    const t = aciColumnTorsion(sec(), mat, rebar, 0, 400);
    const big = aciColumnTorsion(sec(), mat, rebar, t.Tu_threshold * 4, 400);
    expect(big.torsionActive).toBe(true);
    expect(big.phi_Tn).toBeGreaterThan(0);
    expect(big.DCR_T).toBeCloseTo((t.Tu_threshold * 4) / big.phi_Tn, 5);
  });
});

describe('aciColumnSlenderness (ACI §6.6.4.4.2)', () => {
  it('a stocky short column is not slender; Pu below 0.75·Ncr', () => {
    const s = aciColumnSlenderness(sec({ b: 24, h: 24 }), mat, rebar, 300, 10 * 12); // 10 ft
    expect(s.slender).toBe(false);
    expect(Math.abs(300)).toBeLessThan(0.75 * s.Ncr);
  });

  it('a tall slender column under high axial trips the warning', () => {
    const s = aciColumnSlenderness(sec({ b: 12, h: 12 }), mat, rebar, 700, 30 * 12); // 30 ft, small section
    expect(s.slender).toBe(true);
    expect(Math.abs(700)).toBeGreaterThan(0.75 * s.Ncr);
  });

  it('returns not-slender when no length is supplied', () => {
    expect(aciColumnSlenderness(sec(), mat, rebar, 600, 0).slender).toBe(false);
  });
});

describe('designColumnACI wires torsion + slenderness into the result', () => {
  const load = (over: Partial<LoadCase> = {}): LoadCase =>
    ({ id: 'LC1', label: 'env', Mu_pos: 0, Mu_neg: 0, Vu: 30, Tu: 0, Pu: 400, Mux: 80, Muy: 50, ...over });

  it('populates φTcr / φTn / DCR_torsion / VT_util (no longer hard-zero)', () => {
    const r = designColumnACI(sec(), mat, rebar, load({ Tu: 40, Vu: 30 }), 12);
    expect(r.phi_Tcr!).toBeGreaterThan(0);
    expect(r.phi_Tn!).toBeGreaterThan(0);
    expect(r.VT_util!).toBeCloseTo(r.DCR_shear + r.DCR_torsion, 6);
  });

  it('flags a slender column via the design path', () => {
    const r = designColumnACI(sec({ b: 12, h: 12 }), mat, rebar, load({ Pu: 700, Mux: 30, Muy: 20 }), 30);
    expect(r.warnings.some(w => w.code === 'ACI §6.6.4.4.2')).toBe(true);
  });

  it('warns on tight clear spacing (too many bars on a face)', () => {
    const crammed: RebarLayout = { ...rebar, topBars: [{ numBars: 8, barSize: 11 }], botBars: [{ numBars: 8, barSize: 11 }] };
    const r = designColumnACI(sec({ b: 14 }), mat, crammed, load(), 12);
    expect(r.warnings.some(w => w.code === 'ACI §25.2.3')).toBe(true);
  });
});
