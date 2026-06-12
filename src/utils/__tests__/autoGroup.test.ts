import { describe, it, expect } from 'vitest';
import {
  jenksBreaks, quantileBreaks, assignByBreaks,
  familyKey, extractDemands, suggestGroups,
  memberSteelWeightLb, computeSavings,
  flexSteelRatioPct, stirrupAvPerFt, steelWeightPerFt,
} from '../autoGroup';
import type { Member, DesignResults } from '../../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMember(overrides: Partial<Member> & { id: string; b?: number; h?: number; fc?: number; fy?: number }): Member {
  const { id, b, h, fc, fy, ...rest } = overrides;
  return {
    id,
    label: rest.label ?? id,
    memberType: 'beam',
    material: { fc: fc ?? 4000, fy: fy ?? 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
    section: {
      type: 'rectangular_beam',
      b: b ?? 14,
      h: h ?? 24,
      coverClear: 1.5,
      stirrupDia: 4,
    },
    rebar: {
      topBars: [{ numBars: 3, barSize: 8 }],
      botBars: [{ numBars: 3, barSize: 8 }],
      ties: { barSize: 4, spacing: 6, legs: 2 },
    },
    loads: rest.loads ?? [{ id: 'lc1', label: 'Env', Mu_pos: 100, Mu_neg: 80, Vu: 30, Tu: 0, Pu: 0 }],
    span: rest.span ?? 20,
    ...rest,
  } as Member;
}

// ── jenksBreaks ───────────────────────────────────────────────────────────────

describe('jenksBreaks', () => {
  it('finds natural breaks in a 3-cluster dataset', () => {
    // Three obvious clusters: [1,2,3], [10,11,12], [20,21,22]
    const vals = [1, 2, 3, 10, 11, 12, 20, 21, 22];
    const breaks = jenksBreaks(vals, 3);
    expect(breaks).toHaveLength(2);
    expect(breaks[0]).toBeGreaterThanOrEqual(3);
    expect(breaks[0]).toBeLessThan(10);
    expect(breaks[1]).toBeGreaterThanOrEqual(12);
    expect(breaks[1]).toBeLessThan(20);
  });

  it('returns empty array for k=1', () => {
    expect(jenksBreaks([1, 2, 3], 1)).toEqual([]);
  });

  it('handles degenerate: all equal values', () => {
    const breaks = jenksBreaks([5, 5, 5, 5], 2);
    expect(breaks.length).toBeLessThanOrEqual(1);
  });

  it('handles n < k: returns n-1 breaks', () => {
    const breaks = jenksBreaks([1, 2], 5);
    expect(breaks).toHaveLength(1);
  });
});

// ── quantileBreaks ────────────────────────────────────────────────────────────

describe('quantileBreaks', () => {
  it('splits 10 values into 2 equal groups', () => {
    const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const breaks = quantileBreaks(vals, 2);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toBeLessThan(6);
  });
});

// ── assignByBreaks ────────────────────────────────────────────────────────────

describe('assignByBreaks', () => {
  it('assigns values correctly with two breaks', () => {
    const bins = assignByBreaks([1, 5, 10, 15, 20], [6, 12]);
    expect(bins).toEqual([0, 0, 1, 2, 2]);
  });

  it('value exactly at break goes to lower bin', () => {
    const bins = assignByBreaks([5, 6, 7], [6]);
    // 5 ≤ 6 → bin 0; 6 ≤ 6 → bin 0 (not strictly above); 7 > 6 → bin 1
    expect(bins[0]).toBe(0);
    expect(bins[1]).toBe(0);
    expect(bins[2]).toBe(1);
  });
});

// ── familyKey ─────────────────────────────────────────────────────────────────

describe('familyKey', () => {
  it('produces consistent key for same dims/material', () => {
    const m = makeMember({ id: 'a' });
    expect(familyKey(m)).toBe('14x24|4000|60000');
  });

  it('separates beams by depth', () => {
    const m1 = makeMember({ id: 'a', h: 24 });
    const m2 = makeMember({ id: 'b', h: 30 });
    expect(familyKey(m1)).not.toBe(familyKey(m2));
  });

  it('uses bw for T-beams', () => {
    const m = makeMember({ id: 'a' });
    (m.section as { bw?: number }).bw = 12;
    expect(familyKey(m)).toContain('12x');
  });
});

// ── extractDemands ────────────────────────────────────────────────────────────

describe('extractDemands', () => {
  it('reads governing demand from loads', () => {
    const m = makeMember({ id: 'a', loads: [{ id: 'lc1', label: 'E', Mu_pos: 200, Mu_neg: 150, Vu: 50, Tu: 0, Pu: 0 }] });
    const [d] = extractDemands([m]);
    expect(d.MuPos).toBe(200);
    expect(d.MuNeg).toBe(150);
    expect(d.Vu).toBe(50);
    expect(d.governing).toBeCloseTo(1, 4); // only one member → normalized = 1
  });

  it('filters out non-beam members', () => {
    const m = makeMember({ id: 'c' });
    (m as unknown as { memberType: string }).memberType = 'column';
    expect(extractDemands([m])).toHaveLength(0);
  });
});

// ── suggestGroups ──────────────────────────────────────────────────────────────

describe('suggestGroups', () => {
  it('never mixes families', () => {
    const m1 = makeMember({ id: 'a', h: 24 });
    const m2 = makeMember({ id: 'b', h: 36 });
    const suggestions = suggestGroups([m1, m2], 2);
    expect(suggestions).toHaveLength(2);
    for (const s of suggestions) {
      for (const bin of s.bins) expect(bin.memberIds).toHaveLength(1);
    }
  });

  it('auto mode produces at least 1 group per family', () => {
    const members = Array.from({ length: 6 }, (_, i) =>
      makeMember({ id: String(i), loads: [{ id: 'lc1', label: 'E', Mu_pos: (i + 1) * 50, Mu_neg: (i + 1) * 40, Vu: (i + 1) * 15, Tu: 0, Pu: 0 }] })
    );
    const sug = suggestGroups(members, 'auto');
    expect(sug).toHaveLength(1);
    expect(sug[0].bins.length).toBeGreaterThanOrEqual(1);
  });
});

// ── memberSteelWeightLb ───────────────────────────────────────────────────────

describe('memberSteelWeightLb', () => {
  it('1 in² × 10 ft = 34 lb', () => {
    expect(memberSteelWeightLb(1, 10)).toBeCloseTo(34, 1);
  });
});

// ── computeSavings ────────────────────────────────────────────────────────────

describe('computeSavings', () => {
  const m = makeMember({ id: 'm1', span: 20 });
  // 3 #8 bars = 3 × 0.79 = 2.37 in²
  // Target = 0.9 → effective AsReq/0.9
  // Suppose As_req_pos = 1.5 in², As_min = 0.5 — floor = max(1.5/0.9, 0.5) = 1.667
  const res: Partial<DesignResults> = {
    DCR_flex_pos: 0.63, DCR_flex_neg: 0.5, DCR_shear: 0.6,
    As_req_pos: 1.5, As_req_neg: 1.2, As_min: 0.5, As_max: 10,
    Av_req: 0.01, Av_min_per_s: 0.005,
    phi_Mn_pos: 200, phi_Mn_neg: 180, phi_Vn: 80,
    Mn_pos: 200, Mn_neg: 180,
    warnings: [], status: 'OK',
    loadCaseId: 'lc1',
  };

  it('computes flex slack and total > 0 when over-designed', () => {
    const result = computeSavings([m], { m1: res as DesignResults }, {}, 0.9);
    expect(result.perMember).toHaveLength(1);
    const s = result.perMember[0];
    expect(s.totalSlackLb).toBeGreaterThan(0);
    expect(s.flexSlackLb).toBeGreaterThan(0);
  });

  it('slack is 0 when member is at or over target DCR', () => {
    const overloaded = { ...res, As_req_pos: 2.5, As_req_neg: 2.3 } as DesignResults;
    const result = computeSavings([m], { m1: overloaded }, {}, 0.9);
    // AsReqBot = max(2.5/0.9, 0.5) = 2.78 > AsProvBot(2.37) → clamp to 0
    expect(result.perMember[0].flexSlackLb).toBe(0);
  });

  it('totalLb and totalTons are consistent', () => {
    const result = computeSavings([m], { m1: res as DesignResults }, {}, 0.9);
    expect(result.totalTons).toBeCloseTo(result.totalLb / 2000, 6);
  });
});

// ── hotspot metrics ───────────────────────────────────────────────────────────

describe('flexSteelRatioPct', () => {
  it('returns nonzero positive value for a valid member', () => {
    const m = makeMember({ id: 'a' });
    const pct = flexSteelRatioPct(m, 'bot');
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(10); // sanity: ρ < 10%
  });
});

describe('stirrupAvPerFt', () => {
  it('returns Av/s × 12 for uniform ties', () => {
    const m = makeMember({ id: 'a' });
    // ties: #4 @ 6", 2 legs → Ab=0.20, AvPerIn = 2×0.20/6 = 0.0667 in²/in
    // AvPerFt = 0.0667 × 12 = 0.80 in²/ft
    expect(stirrupAvPerFt(m)).toBeCloseTo(0.80, 2);
  });
});

describe('steelWeightPerFt', () => {
  it('computes longitudinal weight from total As × 3.4', () => {
    const m = makeMember({ id: 'a' });
    // 3-#8 top + 3-#8 bot = 6 × 0.79 = 4.74 in² → 4.74 × 3.4 = 16.12 lb/ft
    const w = steelWeightPerFt(m);
    expect(w.longLbFt).toBeCloseTo(4.74 * 3.4, 2);
  });

  it('computes stirrup weight from hoop length and spacing', () => {
    const m = makeMember({ id: 'a' });
    // 14×24, cc=1.5 → hoop = 2×((14−3)+(24−3)) = 64 in; #4 @ 6", 2 legs
    // lb/ft = 0.20 × 64 × 3.4 / 6 = 7.253
    const w = steelWeightPerFt(m);
    expect(w.stirrupLbFt).toBeCloseTo(0.20 * 64 * 3.4 / 6, 2);
    expect(w.totalLbFt).toBeCloseTo(w.longLbFt + w.stirrupLbFt, 6);
  });

  it('averages zoned stirrup spacing over the three zones', () => {
    const m = makeMember({ id: 'a' });
    m.rebar.tieZones = [{ spacing: 4 }, { spacing: 12 }, { spacing: 4 }];
    const w = steelWeightPerFt(m);
    const perFt = (s: number) => 0.20 * 64 * 3.4 / s;
    expect(w.stirrupLbFt).toBeCloseTo((perFt(4) + perFt(12) + perFt(4)) / 3, 2);
  });

  it('adds interior legs for 4-leg stirrups', () => {
    const m2 = makeMember({ id: 'b' });
    const m4 = makeMember({ id: 'c' });
    m4.rebar.ties = { barSize: 4, spacing: 6, legs: 4 };
    expect(steelWeightPerFt(m4).stirrupLbFt).toBeGreaterThan(steelWeightPerFt(m2).stirrupLbFt);
  });
});
