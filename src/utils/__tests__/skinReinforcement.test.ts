import { describe, it, expect } from 'vitest';
import { isSkinWarning, applyMinSkinReinforcement } from '../skinReinforcement';
import type { Member, DesignWarning } from '../../types';

describe('isSkinWarning', () => {
  it('matches by message text (case-insensitive)', () => {
    const w: DesignWarning = { code: 'X', message: 'Add Skin Reinforcement per §7.3.3', severity: 'warning' };
    expect(isSkinWarning(w)).toBe(true);
  });
  it('matches by code', () => {
    const w: DesignWarning = { code: 'EC2 §7.3.3', message: 'side-face bars required', severity: 'warning' };
    expect(isSkinWarning(w)).toBe(true);
  });
  it('returns false for unrelated warnings', () => {
    const w: DesignWarning = { code: 'EC2 §6.2', message: 'shear capacity exceeded', severity: 'error' };
    expect(isSkinWarning(w)).toBe(false);
  });
});

describe('applyMinSkinReinforcement', () => {
  const base: Member = {
    id: 'B1', label: 'B1', memberType: 'beam',
    section: { type: 'rectangular_beam', b: 12, h: 36, coverClear: 1.5, stirrupDia: 4 },
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
    rebar: { topBars: [{ numBars: 2, barSize: 8 }], botBars: [{ numBars: 3, barSize: 8 }] },
    loads: [],
  } as unknown as Member;

  it('sets sideBars only on flagged members', () => {
    const m2 = { ...base, id: 'B2' };
    const out = applyMinSkinReinforcement([base, m2], new Set(['B1']), { numBars: 2, barSize: -16 });
    expect(out[0].rebar.sideBars).toEqual([{ numBars: 2, barSize: -16 }]);
    expect(out[1].rebar.sideBars).toBeUndefined();
    // does not mutate input
    expect(base.rebar.sideBars).toBeUndefined();
  });
});
