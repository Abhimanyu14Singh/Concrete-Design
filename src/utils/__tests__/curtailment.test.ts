import { describe, it, expect } from 'vitest';
import { analyzeGroupCurtailment, curtailmentNote, CURTAIL_THRESHOLD_PCT } from '../curtailment';
import type { Member, ComboForces, RebarLayout } from '../../types';

/** Build a beam with a moment profile M(f), f = fraction along the span. */
function makeBeam(opts: {
  id: string;
  moment: (f: number) => number;   // kip-ft; +ve sagging, −ve hogging
  L?: number; n?: number;
  rebar?: RebarLayout;
  withStations?: boolean;
}): Member {
  const L = opts.L ?? 20, n = opts.n ?? 9;
  const stations: ComboForces[] = [{
    combo: 'C1',
    stations: Array.from({ length: n }, (_, i) => {
      const f = i / (n - 1);
      return { x: +(f * L).toFixed(3), V: 0, M: +opts.moment(f).toFixed(3) };
    }),
  }];
  return {
    id: opts.id, label: opts.id, memberType: 'beam',
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
    section: { type: 'rectangular_beam', b: 14, h: 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: opts.rebar ?? {
      topBars: [{ numBars: 4, barSize: 8 }],
      botBars: [{ numBars: 4, barSize: 8 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    },
    loads: [{ id: 'env', label: 'Env', Mu_pos: 60, Mu_neg: 100, Vu: 40, Tu: 0, Pu: 0 }],
    span: L,
    ...(opts.withStations === false ? {} : { stationForces: stations }),
  };
}

// Fixed-end profile: hogging at the supports, sagging at mid-span. In the MIDDLE
// third the moment is entirely sagging (no hogging) → top governed by code minimum.
const K = 1200; // → Mend = 100 kip-ft, mid-span = 50 kip-ft
const fixedEnd = (f: number) => K * (-1 / 12 + f / 2 - (f * f) / 2);

describe('analyzeGroupCurtailment', () => {
  it('reports no flags when the group has no station data', () => {
    const m = makeBeam({ id: 'nofx', moment: fixedEnd, withStations: false });
    const r = analyzeGroupCurtailment([m], m.rebar, 'ACI318-19');
    expect(r.hasStationData).toBe(false);
    expect(r.top).toBeNull();
    expect(r.bot).toBeNull();
  });

  it('fixed-end beam: middle third has no hogging → top governed by code minimum', () => {
    const m = makeBeam({ id: 'fe', moment: fixedEnd });
    const r = analyzeGroupCurtailment([m], m.rebar, 'ACI318-19');
    expect(r.hasStationData).toBe(true);
    expect(r.top).not.toBeNull();
    expect(r.bot).not.toBeNull();
    // No hogging in the middle third of a fixed-end beam.
    expect(r.top!.demandMoment).toBeCloseTo(0, 3);
    expect(r.top!.governedBy).toBe('code-min');
    // Bottom sees the sagging that reaches into the end thirds (peaks at x = L/3).
    expect(r.bot!.demandMoment).toBeGreaterThan(0);
    expect(r.bot!.region).toBe('end-thirds');
  });

  it('all-hogging beam: top region sees real moment demand, bottom sees none', () => {
    const m = makeBeam({ id: 'hog', moment: () => -200, rebar: {
      topBars: [{ numBars: 2, barSize: 6 }],   // deliberately light top → high % needed
      botBars: [{ numBars: 4, barSize: 8 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    } });
    const r = analyzeGroupCurtailment([m], m.rebar, 'ACI318-19');
    expect(r.top!.demandMoment).toBeCloseTo(200, 3);
    expect(r.top!.governedBy).toBe('moment');
    expect(r.bot!.demandMoment).toBeCloseTo(0, 3);
    expect(r.bot!.governedBy).toBe('code-min');
    // A light top face carrying 90 kip-ft through the middle third needs > 50 %.
    expect(r.top!.pctNeeded).toBeGreaterThan(CURTAIL_THRESHOLD_PCT);
    expect(r.top!.flag).toBe('red');
  });

  it('flag is red iff more than 50 % of the face is needed', () => {
    const m = makeBeam({ id: 'mix', moment: fixedEnd });
    const r = analyzeGroupCurtailment([m], m.rebar, 'ACI318-19');
    for (const fc of [r.top!, r.bot!]) {
      expect(fc.flag === 'red').toBe(fc.pctNeeded > CURTAIL_THRESHOLD_PCT);
      expect(fc.fiftyEnvelopes).toBe(fc.pctNeeded <= CURTAIL_THRESHOLD_PCT);
    }
  });

  it('takes the worst member across the group', () => {
    const light = makeBeam({ id: 'light', moment: () => -20 });
    const heavy = makeBeam({ id: 'heavy', moment: () => -120, rebar: {
      topBars: [{ numBars: 2, barSize: 6 }], botBars: [{ numBars: 4, barSize: 8 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    } });
    // Same cage for the group check (heavy's light top governs the top face).
    const r = analyzeGroupCurtailment([light, heavy], heavy.rebar, 'ACI318-19');
    expect(r.top!.governingMemberId).toBe('heavy');
  });

  it('produces a schedule note mentioning the percentage', () => {
    const m = makeBeam({ id: 'note', moment: fixedEnd });
    const r = analyzeGroupCurtailment([m], m.rebar, 'ACI318-19');
    const note = curtailmentNote(r.bot!);
    expect(note).toMatch(/%/);
    expect(note.toLowerCase()).toContain('bottom');
  });

  it('works under EC2 as well', () => {
    const MPA = 1 / 0.00689476;
    const m: Member = {
      id: 'ec2', label: 'ec2', memberType: 'beam',
      material: { fc: 40 * MPA, fy: 500 * MPA, fyt: 500 * MPA, Es: 200000 * MPA, lambdaConcrete: 1 },
      section: { type: 'rectangular_beam', b: 300 / 25.4, h: 600 / 25.4, coverClear: 40 / 25.4, stirrupDia: -10 },
      rebar: { topBars: [{ numBars: 4, barSize: -16 }], botBars: [{ numBars: 4, barSize: -16 }], ties: { barSize: -10, spacing: 150 / 25.4, legs: 2 } },
      loads: [{ id: 'ULS', label: 'ULS', Mu_pos: 50, Mu_neg: 90, Vu: 40, Tu: 0, Pu: 0 }],
      span: 8,
      stationForces: [{ combo: 'ULS', stations: Array.from({ length: 9 }, (_, i) => { const f = i / 8; return { x: +(f * 8).toFixed(3), V: 0, M: +(K * (-1 / 12 + f / 2 - f * f / 2)).toFixed(3) }; }) }],
    };
    const r = analyzeGroupCurtailment([m], m.rebar, 'EN1992-1-1');
    expect(r.hasStationData).toBe(true);
    expect(r.top).not.toBeNull();
    expect(r.bot).not.toBeNull();
  });
});
