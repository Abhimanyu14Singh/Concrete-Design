import { describe, it, expect } from 'vitest';
import { suggestColumnRebar } from '../suggestColumnRebar';
import { suggestGroupRebar, isSuggestError } from '../suggestRebar';
import { runDesign } from '../../engines';
import { getBarArea } from '../concreteDesign';
import type { Member } from '../../types';

function makeColumn(opts: {
  id: string; type?: 'rectangular_column' | 'circular_column';
  b?: number; h?: number; diameter?: number; tieType?: 'tied' | 'spiral';
  Pu?: number; Mux?: number; Muy?: number; Vu?: number;
  loads?: Member['loads'];
}): Member {
  const type = opts.type ?? 'rectangular_column';
  const isCirc = type === 'circular_column';
  return {
    id: opts.id,
    label: opts.id,
    memberType: 'column',
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
    section: {
      type,
      b: opts.b ?? (isCirc ? (opts.diameter ?? 20) : 20),
      h: opts.h ?? (isCirc ? (opts.diameter ?? 20) : 20),
      diameter: isCirc ? (opts.diameter ?? 20) : undefined,
      coverClear: 1.5, stirrupDia: 4,
    },
    rebar: {
      topBars: [{ numBars: 3, barSize: 8 }],
      botBars: [{ numBars: 3, barSize: 8 }],
      sideBars: [{ numBars: 2, barSize: 8 }],
      ties: { barSize: 4, spacing: 12, legs: 2 },
      tieType: opts.tieType ?? 'tied',
    },
    loads: opts.loads ?? [{
      id: 'lc1', label: 'Env',
      Mu_pos: 0, Mu_neg: 0, Vu: opts.Vu ?? 25, Tu: 0,
      Pu: opts.Pu ?? 400, Mux: opts.Mux ?? 80, Muy: opts.Muy ?? 60,
    }],
    span: 12,
  };
}

function rhoPct(m: Member, rebar: Member['rebar']): number {
  const isCirc = m.section.type === 'circular_column';
  const D = m.section.diameter ?? m.section.b;
  const Ag = isCirc ? Math.PI * D * D / 4 : m.section.b * (m.section.h ?? m.section.b);
  const As = [...rebar.topBars, ...rebar.botBars, ...(rebar.sideBars ?? [])]
    .reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
  return (As / Ag) * 100;
}

describe('suggestColumnRebar', () => {
  it('suggests a cage meeting the target DCR for a typical biaxial column', () => {
    const m = makeColumn({ id: 'c1' });
    const r = suggestColumnRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.kind).toBe('column');
    expect(r.worstDCRFlex).toBeLessThanOrEqual(0.9 + 1e-6);     // P-M
    expect(r.worstDCRAxial!).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(r.worstDCRShear).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(r.rhoPct!).toBeGreaterThanOrEqual(1 - 1e-6);
    expect(r.rhoPct!).toBeLessThanOrEqual(8 + 1e-6);
    expect(r.steelLb).toBeGreaterThan(0);
    expect(r.governingMemberId).toBe('c1');

    // Independent verification with the engine.
    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(check.DCR_PM!).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(check.DCR_axial!).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(check.DCR_shear).toBeLessThanOrEqual(0.9 + 1e-6);
    expect(check.warnings.some(w => w.severity === 'error')).toBe(false);
  });

  it('keeps ρ in the 1–8% band and uses ≥ 4 bars (tied)', () => {
    const m = makeColumn({ id: 'c1', Pu: 250, Mux: 40, Muy: 30 });
    const r = suggestColumnRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    const nBars = [...r.rebar.topBars, ...r.rebar.botBars, ...(r.rebar.sideBars ?? [])]
      .reduce((s, g) => s + g.numBars, 0);
    expect(nBars).toBeGreaterThanOrEqual(4);
    expect(rhoPct(m, r.rebar)).toBeGreaterThanOrEqual(1 - 1e-6);
    // ties from the practical column set
    expect([3, 4, 5]).toContain(r.rebar.ties!.barSize);
    expect(r.rebar.tieType).toBe('tied');
  });

  it('heavier demand needs at least as much steel', () => {
    const light = makeColumn({ id: 'L', Pu: 250, Mux: 30, Muy: 20 });
    const heavy = makeColumn({ id: 'H', Pu: 700, Mux: 160, Muy: 120 });
    const rl = suggestColumnRebar([light], 'ACI318-19', 0.9);
    const rh = suggestColumnRebar([heavy], 'ACI318-19', 0.9);
    expect(isSuggestError(rl)).toBe(false);
    expect(isSuggestError(rh)).toBe(false);
    if (isSuggestError(rl) || isSuggestError(rh)) return;
    expect(rh.rhoPct!).toBeGreaterThanOrEqual(rl.rhoPct! - 1e-6);
  });

  it('uses worst demand across a group and reports the governing member', () => {
    const light = makeColumn({ id: 'light', Pu: 200, Mux: 20, Muy: 15 });
    const heavy = makeColumn({ id: 'heavy', Pu: 650, Mux: 150, Muy: 110 });
    const r = suggestColumnRebar([light, heavy], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.governingMemberId).toBe('heavy');
    const check = runDesign(heavy.section, heavy.material, r.rebar, heavy.loads[0], heavy.span, 'ACI318-19');
    expect(Math.max(check.DCR_PM!, check.DCR_axial!, check.DCR_shear)).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it('handles a circular column (≥ 6 bars on a spiral)', () => {
    const m = makeColumn({ id: 'circ', type: 'circular_column', diameter: 24, tieType: 'spiral', Pu: 500, Mux: 70, Muy: 50 });
    const r = suggestColumnRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.rebar.tieType).toBe('spiral');
    const nBars = [...r.rebar.topBars, ...r.rebar.botBars, ...(r.rebar.sideBars ?? [])]
      .reduce((s, g) => s + g.numBars, 0);
    expect(nBars).toBeGreaterThanOrEqual(6);
    const check = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(check.DCR_PM!).toBeLessThanOrEqual(0.9 + 1e-6);
  });

  it('errors for column members without loads', () => {
    const m = makeColumn({ id: 'c1', loads: [] });
    const r = suggestColumnRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(true);
  });

  it('errors when even 8% steel cannot meet a huge demand', () => {
    const m = makeColumn({ id: 'tiny', b: 12, h: 12, Pu: 1400, Mux: 300, Muy: 250 });
    const r = suggestColumnRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(true);
  });

  it('is reachable through suggestGroupRebar dispatch for column groups', () => {
    const m = makeColumn({ id: 'c1' });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.kind).toBe('column');
  });
});
