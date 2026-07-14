import { describe, it, expect } from 'vitest';
import { buildColumnStacks, stackCapacityCurve, phiPnMaxAtRho } from '../columnStack';
import type { Member, Point3D } from '../../types';

let seq = 0;
function col(opts: {
  label: string; x: number; y: number; zBase: number; story: string;
  b?: number; h?: number; Pu?: number;
}): Member {
  const pt1: Point3D = { x: opts.x, y: opts.y, z: opts.zBase };
  const pt2: Point3D = { x: opts.x, y: opts.y, z: opts.zBase + 12 };
  seq += 1;
  return {
    id: `m${seq}`, label: opts.label, memberType: 'column',
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 },
    section: { type: 'rectangular_column', b: opts.b ?? 20, h: opts.h ?? 20, coverClear: 1.5, stirrupDia: 4 },
    rebar: {
      topBars: [{ numBars: 3, barSize: 9 }], botBars: [{ numBars: 3, barSize: 9 }],
      sideBars: [{ numBars: 2, barSize: 9 }], ties: { barSize: 4, spacing: 12, legs: 2 },
      tieType: 'tied',
    },
    loads: [{ id: 'LC1', label: 'env', Mu_pos: 0, Mu_neg: 0, Vu: 20, Tu: 0, Pu: opts.Pu ?? 400, Mux: 60, Muy: 40 }],
    span: 12,
    etabs: {
      frameName: `F${seq}`, story: opts.story, groups: [], sectionName: 'C20',
      pt1, pt2,
    },
  };
}

describe('phiPnMaxAtRho', () => {
  it('matches the ACI §22.4.2 tied axial capacity at ρ = 2%', () => {
    const s = { type: 'rectangular_column' as const, b: 20, h: 24, coverClear: 1.5, stirrupDia: 4 };
    const mat = { fc: 4000, fy: 60000, fyt: 60000, Es: 29e6, lambdaConcrete: 1 };
    // Ag = 480, Ast = 9.6; 0.65·0.80·(0.85·4000·470.4 + 60000·9.6)/1000
    const expected = 0.52 * (0.85 * 4000 * (480 - 9.6) + 60000 * 9.6) / 1000;
    expect(phiPnMaxAtRho(s, mat, 0.02, false)).toBeCloseTo(expected, 6);
  });
  it('spiral gives a higher capacity than tied', () => {
    const s = { type: 'circular_column' as const, b: 24, h: 24, diameter: 24, coverClear: 1.5, stirrupDia: 4 };
    const mat = { fc: 4000, fy: 60000, fyt: 60000, Es: 29e6, lambdaConcrete: 1 };
    expect(phiPnMaxAtRho(s, mat, 0.02, true)).toBeGreaterThan(phiPnMaxAtRho(s, mat, 0.02, false));
  });
});

describe('buildColumnStacks', () => {
  it('groups columns at one plan location into a stack, ordered bottom → top', () => {
    const members = [
      col({ label: 'C1-L3', x: 0, y: 0, zBase: 24, story: 'L3', Pu: 200 }),
      col({ label: 'C1-L1', x: 0, y: 0, zBase: 0, story: 'L1', Pu: 600 }),
      col({ label: 'C1-L2', x: 0, y: 0, zBase: 12, story: 'L2', Pu: 400 }),
    ];
    const stacks = buildColumnStacks(members, 'ACI318-19');
    expect(stacks).toHaveLength(1);
    expect(stacks[0].stories.map(s => s.story)).toEqual(['L1', 'L2', 'L3']);  // bottom → top
    expect(stacks[0].stories.map(s => s.elevation)).toEqual([0, 12, 24]);
    // Axial demand decreases up the stack; capacity (same section) is constant.
    expect(stacks[0].stories[0].PuGov).toBe(600);
    expect(stacks[0].stories[2].PuGov).toBe(200);
    expect(stacks[0].stories[0].dcrAxial).toBeGreaterThan(stacks[0].stories[2].dcrAxial);
  });

  it('separates columns at different plan locations into different stacks', () => {
    const members = [
      col({ label: 'A', x: 0, y: 0, zBase: 0, story: 'L1' }),
      col({ label: 'A', x: 0, y: 0, zBase: 12, story: 'L2' }),
      col({ label: 'B', x: 30, y: 0, zBase: 0, story: 'L1' }),
    ];
    const stacks = buildColumnStacks(members, 'ACI318-19');
    expect(stacks).toHaveLength(2);
    expect(stacks[0].stories).toHaveLength(2); // sorted by descending story count first
    expect(stacks[1].stories).toHaveLength(1);
  });

  it('ignores beams and loadless columns', () => {
    const beam: Member = { ...col({ label: 'bm', x: 0, y: 0, zBase: 0, story: 'L1' }), memberType: 'beam', section: { type: 'rectangular_beam', b: 14, h: 24, coverClear: 1.5, stirrupDia: 4 } };
    const loadless: Member = { ...col({ label: 'C', x: 9, y: 9, zBase: 0, story: 'L1' }), loads: [] };
    const stacks = buildColumnStacks([beam, loadless], 'ACI318-19');
    expect(stacks).toHaveLength(0);
  });
});

describe('stackCapacityCurve', () => {
  it('returns per-story demand and capacity at reference ratios', () => {
    const members = [
      col({ label: 'C1-L1', x: 0, y: 0, zBase: 0, story: 'L1', Pu: 600 }),
      col({ label: 'C1-L2', x: 0, y: 0, zBase: 12, story: 'L2', Pu: 300 }),
    ];
    const stacks = buildColumnStacks(members, 'ACI318-19');
    const curve = stackCapacityCurve(stacks[0], members, 'ACI318-19');
    expect(curve.map(p => p.story)).toEqual(['L1', 'L2']);
    expect(curve[0].Pu).toBe(600);
    expect(Object.keys(curve[0].phiPnAtRho)).toEqual(['1.0%', '2.0%', '3.0%']);
    // capacity grows with ρ
    expect(curve[0].phiPnAtRho['3.0%']).toBeGreaterThan(curve[0].phiPnAtRho['1.0%']);
    // same section both stories → identical reference capacities
    expect(curve[0].phiPnAtRho['2.0%']).toBeCloseTo(curve[1].phiPnAtRho['2.0%'], 6);
  });
});
