import { describe, it, expect } from 'vitest';
import { resolveCrack } from '../resolveCrack';
import { DEFAULT_CRACK_PARAMS } from '../../types';
import type { Member, ComboForces } from '../../types';

const EC2 = 'EN1992-1-1';

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: 'm1',
    label: 'B1',
    memberType: 'beam',
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
    section: { type: 'rectangular_beam', b: 14, h: 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: { topBars: [{ numBars: 3, barSize: 8 }], botBars: [{ numBars: 3, barSize: 8 }], ties: { barSize: 4, spacing: 6, legs: 2 } },
    loads: [{ id: 'lc1', label: 'Env', Mu_pos: 100, Mu_neg: 80, Vu: 30, Tu: 0, Pu: 0 }],
    span: 20,
    crackParams: { ...DEFAULT_CRACK_PARAMS },
    ...overrides,
  } as Member;
}

const slsForces: ComboForces[] = [{
  combo: 'SLS-QP',
  stations: [
    { x: 0, V: -20, M: -55 },   // negative moment 55 kip-ft
    { x: 10, V: 0, M: 70 },     // positive moment 70 kip-ft
    { x: 20, V: 20, M: -40 },
  ],
}];

describe('resolveCrack', () => {
  it('EC2 + slsCombo present in stationForces → Mqp_pos/Mqp_neg from envelope', () => {
    const m = makeMember({ stationForces: slsForces });
    const cp = resolveCrack(m, EC2, 'SLS-QP');
    expect(cp?.Mqp_pos).toBe(70);
    expect(cp?.Mqp_neg).toBe(55);
    // base params preserved
    expect(cp?.qpFactor).toBe(DEFAULT_CRACK_PARAMS.qpFactor);
  });

  it('non-EC2 code → returns crackParams unchanged (no overrides)', () => {
    const m = makeMember({ stationForces: slsForces });
    const cp = resolveCrack(m, 'ACI318-19', 'SLS-QP');
    expect(cp).toBe(m.crackParams);
    expect(cp?.Mqp_pos).toBeUndefined();
  });

  it('slsCombo set but absent from stationForces → falls back to legacy/cp', () => {
    const m = makeMember({ stationForces: slsForces });
    const cp = resolveCrack(m, EC2, 'OTHER-COMBO');
    expect(cp?.Mqp_pos).toBeUndefined();
    expect(cp).toBe(m.crackParams);
  });

  it('legacy slsLoadCaseId resolves Mqp from member loads when no project combo', () => {
    const m = makeMember({
      crackParams: { ...DEFAULT_CRACK_PARAMS, slsLoadCaseId: 'lc1' },
    });
    const cp = resolveCrack(m, EC2, undefined);
    expect(cp?.Mqp_pos).toBe(100);
    expect(cp?.Mqp_neg).toBe(80);
  });

  it('uses DEFAULT_CRACK_PARAMS when member has no crackParams', () => {
    const m = makeMember({ crackParams: undefined, stationForces: slsForces });
    const cp = resolveCrack(m, EC2, 'SLS-QP');
    expect(cp?.kt).toBe(DEFAULT_CRACK_PARAMS.kt);
    expect(cp?.Mqp_pos).toBe(70);
  });
});
