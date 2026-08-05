import { describe, it, expect } from 'vitest';
import { sectionAreaIn2, memberLengthFt, memberTakeoff, projectTakeoff } from '../takeoff';
import type { Member, SectionDimensions } from '../../types';

function beam(opts: { id: string; b?: number; h?: number; span?: number; etabs?: Member['etabs'] }): Member {
  return {
    id: opts.id, label: opts.id, memberType: 'beam',
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
    section: { type: 'rectangular_beam', b: opts.b ?? 12, h: opts.h ?? 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 2, barSize: 8 }], botBars: [{ numBars: 3, barSize: 8 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    },
    loads: [], span: opts.span ?? 20, etabs: opts.etabs,
  };
}

describe('sectionAreaIn2', () => {
  it('rectangular = b·h', () => {
    expect(sectionAreaIn2({ type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 })).toBe(288);
  });
  it('T-beam = flange + web below flange', () => {
    const s: SectionDimensions = { type: 'T_beam', b: 36, h: 24, bw: 12, hf: 6, coverClear: 1.5, stirrupDia: 4 };
    // 36×6 flange + 12×18 web = 216 + 216 = 432
    expect(sectionAreaIn2(s)).toBe(432);
  });
});

describe('memberLengthFt', () => {
  it('prefers the ETABS frame length over span', () => {
    const m = beam({ id: 'b', span: 20, etabs: {
      frameName: 'F1', story: 'L1', groups: [], sectionName: 'B1',
      pt1: { x: 0, y: 0, z: 0 }, pt2: { x: 30, y: 0, z: 0 },
    } });
    expect(memberLengthFt(m)).toBeCloseTo(30, 6);
  });
  it('falls back to span', () => {
    expect(memberLengthFt(beam({ id: 'b', span: 18 }))).toBe(18);
  });
});

describe('memberTakeoff', () => {
  it('computes gross concrete volume for a 12×24 beam over 20 ft', () => {
    const t = memberTakeoff(beam({ id: 'b', b: 12, h: 24, span: 20 }));
    // 288 in² / 144 × 20 ft = 40 ft³
    expect(t.concreteFt3).toBeCloseTo(40, 6);
    expect(t.steelLb).toBeGreaterThan(0);
    expect(t.steelLb).toBeCloseTo(t.longSteelLb + t.tieSteelLb, 9);
  });
});

describe('projectTakeoff', () => {
  it('rolls up volume + steel and buckets by member type', () => {
    const members = [
      beam({ id: 'b1', b: 12, h: 24, span: 20 }),
      beam({ id: 'b2', b: 16, h: 28, span: 24 }),
    ];
    const t = projectTakeoff(members);
    expect(t.byType.beam.count).toBe(2);
    expect(t.concreteFt3).toBeCloseTo(t.byType.beam.concreteFt3, 9);
    expect(t.concreteYd3).toBeCloseTo(t.concreteFt3 / 27, 9);
    expect(t.steelTons).toBeCloseTo(t.steelLb / 2000, 9);
    expect(t.steelLbPerYd3).toBeGreaterThan(0);
    expect(t.gfaFt2).toBeUndefined();
  });
  it('adds per-GFA intensities when GFA is supplied', () => {
    const members = [beam({ id: 'b1', span: 20 })];
    const t = projectTakeoff(members, 5000);
    expect(t.gfaFt2).toBe(5000);
    expect(t.concreteFt3PerGfa).toBeCloseTo(t.concreteFt3 / 5000, 9);
    expect(t.steelLbPerGfa).toBeCloseTo(t.steelLb / 5000, 9);
  });
  it('ignores a non-positive GFA', () => {
    const t = projectTakeoff([beam({ id: 'b1' })], 0);
    expect(t.gfaFt2).toBeUndefined();
    expect(t.steelLbPerGfa).toBeUndefined();
  });
  it('handles an empty project without dividing by zero', () => {
    const t = projectTakeoff([]);
    expect(t.concreteFt3).toBe(0);
    expect(t.steelLbPerYd3).toBe(0);
  });
});
