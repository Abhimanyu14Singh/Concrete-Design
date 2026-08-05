/**
 * Per-face cover: top / bottom / side covers must reach the numbers that matter
 * — effective depths, the closed-stirrup torsion geometry, and the bar-fit
 * checks — while sections that carry only the legacy `coverClear` behave exactly
 * as they did before.
 */
import { describe, it, expect } from 'vitest';
import type { MaterialProps, RebarLayout, SectionDimensions } from '../../types';
import {
  computeFlexure, computeTorsion, coverFor, effectiveDepth, effectiveDepthMulti,
  designMember, getBarDiam,
} from '../concreteDesign';
import { designMemberEC2 } from '../../engines/ec2/ec2Beam';

const mat: MaterialProps = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 };

/** 16×24 rectangular beam, #4 stirrups. */
const sec = (over: Partial<SectionDimensions> = {}): SectionDimensions =>
  ({ type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4, ...over });

const rebar: RebarLayout = {
  topBars: [{ numBars: 3, barSize: 8 }],
  botBars: [{ numBars: 3, barSize: 8 }],
  ties: { barSize: 4, spacing: 6, legs: 2 },
};

const load = { id: 'lc', label: '1.2D+1.6L', Mu_pos: 150, Mu_neg: 150, Vu: 50, Tu: 10, Pu: 0 };

describe('coverFor', () => {
  it('falls back to coverClear on every face when nothing is split', () => {
    const s = sec();
    expect(coverFor(s, 'top')).toBe(1.5);
    expect(coverFor(s, 'bot')).toBe(1.5);
    expect(coverFor(s, 'side')).toBe(1.5);
  });

  it('returns the per-face value when set, face by face', () => {
    const s = sec({ coverTop: 2.5, coverBottom: 1.5, coverSide: 2 });
    expect(coverFor(s, 'top')).toBe(2.5);
    expect(coverFor(s, 'bot')).toBe(1.5);
    expect(coverFor(s, 'side')).toBe(2);
  });

  it('falls back per face — a section with only a top cover keeps coverClear elsewhere', () => {
    const s = sec({ coverTop: 3 });
    expect(coverFor(s, 'top')).toBe(3);
    expect(coverFor(s, 'bot')).toBe(1.5);
  });
});

describe('effective depth follows the face it is measured from', () => {
  // d = h − cover − stirrupØ − barØ/2 = 24 − cc − 0.5 − 0.5
  it('single-layer: bottom uses coverBottom, top uses coverTop', () => {
    const s = sec({ coverTop: 2.5, coverBottom: 1.5, coverSide: 1.5 });
    expect(effectiveDepth(s, 8, 'bot')).toBeCloseTo(24 - 1.5 - 0.5 - 0.5, 9);
    expect(effectiveDepth(s, 8, 'top')).toBeCloseTo(24 - 2.5 - 0.5 - 0.5, 9);
  });

  it('multi-layer centroid picks up the face cover too', () => {
    const s = sec({ coverTop: 2.5, coverBottom: 1.5 });
    const bars = [{ numBars: 3, barSize: 8 }, { numBars: 2, barSize: 8 }];
    const dBot = effectiveDepthMulti(s, bars, 1.0, 'bot');
    const dTop = effectiveDepthMulti(s, bars, 1.0, 'top');
    expect(dBot - dTop).toBeCloseTo(1.0, 9);   // exactly the 1" cover difference
  });

  it('defaults to the bottom face, so existing call sites are unchanged', () => {
    const s = sec({ coverTop: 2.5, coverBottom: 1.5 });
    expect(effectiveDepth(s, 8)).toBe(effectiveDepth(s, 8, 'bot'));
    expect(effectiveDepthMulti(s, rebar.botBars)).toBe(effectiveDepthMulti(s, rebar.botBars, 1.0, 'bot'));
  });
});

describe('flexure', () => {
  it('a deeper TOP cover cuts hogging capacity; sagging barely moves', () => {
    const even = computeFlexure(sec(), mat, 2.37, 2.37, 20, 8, 8, rebar.topBars, rebar.botBars);
    const split = computeFlexure(
      sec({ coverTop: 2.5, coverBottom: 1.5, coverSide: 1.5 }),
      mat, 2.37, 2.37, 20, 8, 8, rebar.topBars, rebar.botBars,
    );
    // Hogging is measured to the top steel — 1" more cover costs ~1" of d.
    expect(split.phi_Mn_neg).toBeLessThan(even.phi_Mn_neg * 0.97);
    // Sagging is governed by the unchanged BOTTOM cover. The top cover still
    // reaches it through d' of the compression steel, but only as a fraction of
    // a percent — it must not move with the tension-side sensitivity.
    expect(split.phi_Mn_pos).toBeGreaterThan(even.phi_Mn_pos * 0.995);
    expect(split.phi_Mn_pos).toBeLessThan(even.phi_Mn_pos * 1.005);
  });

  it('equal per-face covers reproduce the legacy single-cover result exactly', () => {
    const legacy = computeFlexure(sec(), mat, 2.37, 2.37, 20, 8, 8, rebar.topBars, rebar.botBars);
    const explicit = computeFlexure(
      sec({ coverTop: 1.5, coverBottom: 1.5, coverSide: 1.5 }),
      mat, 2.37, 2.37, 20, 8, 8, rebar.topBars, rebar.botBars,
    );
    expect(explicit).toEqual(legacy);
  });
});

describe('torsion — closed stirrup centreline geometry', () => {
  it('x0 shrinks with the SIDE cover, y0 with the top and bottom covers', () => {
    const s = sec({ coverTop: 2.5, coverBottom: 2, coverSide: 1.5 });
    const dStir2 = getBarDiam(4) / 2;
    const x0 = 16 - 2 * (1.5 + dStir2);
    const y0 = 24 - (2.5 + dStir2) - (2 + dStir2);
    expect(computeTorsion(s, mat, rebar).Ph).toBeCloseTo(2 * (x0 + y0), 9);
  });

  it('uniform cover matches the legacy 2·cc inset', () => {
    const legacy = computeTorsion(sec(), mat, rebar);
    const explicit = computeTorsion(sec({ coverTop: 1.5, coverBottom: 1.5, coverSide: 1.5 }), mat, rebar);
    expect(explicit).toEqual(legacy);
  });
});

describe('full member design', () => {
  it('ACI: per-face covers change the result; uniform covers do not', () => {
    const legacy = designMember(sec(), mat, rebar, load, 20);
    const same = designMember(sec({ coverTop: 1.5, coverBottom: 1.5, coverSide: 1.5 }), mat, rebar, load, 20);
    const split = designMember(sec({ coverTop: 3, coverBottom: 1.5, coverSide: 1.5 }), mat, rebar, load, 20);
    expect(same.DCR_flex_neg).toBeCloseTo(legacy.DCR_flex_neg, 9);
    expect(split.DCR_flex_neg).toBeGreaterThan(legacy.DCR_flex_neg);
  });

  it('EC2: a deeper top cover reduces M_Rd for hogging, barely touches sagging', () => {
    const ec2Sec = sec({ b: 500 / 25.4, h: 600 / 25.4, coverClear: 35 / 25.4, stirrupDia: -10 });
    const legacy = designMemberEC2(ec2Sec, mat, rebar, load, 20);
    const split = designMemberEC2({ ...ec2Sec, coverTop: 60 / 25.4 }, mat, rebar, load, 20);
    expect(split.phi_Mn_neg).toBeLessThan(legacy.phi_Mn_neg * 0.97);
    // Sagging moves only via the compression steel's depth — well under 1%.
    expect(split.phi_Mn_pos).toBeGreaterThan(legacy.phi_Mn_pos * 0.99);
    expect(split.phi_Mn_pos).toBeLessThan(legacy.phi_Mn_pos * 1.01);
  });
});

describe('Ec override', () => {
  it('EC2 crack width uses the project Ec instead of Ecm(fck)', () => {
    const ec2Sec = sec({ b: 300 / 25.4, h: 500 / 25.4, coverClear: 35 / 25.4, stirrupDia: -10 });
    const crack = { wLimitTop: 0.3, wLimitBot: 0.3, wLimitFace: 0.3, qpFactor: 0.6, kt: 0.4 };
    const base = designMemberEC2(ec2Sec, mat, rebar, load, 20, crack);
    // A much stiffer concrete lowers αe, so the computed crack width moves.
    const stiff = designMemberEC2(ec2Sec, { ...mat, Ec: 8_000_000 }, rebar, load, 20, crack);
    expect(base.wk_bot).toBeGreaterThan(0);
    expect(stiff.wk_bot).not.toBeCloseTo(base.wk_bot!, 4);
  });
});
