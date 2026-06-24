import { describe, it, expect } from 'vitest';
import {
  jenksBreaks, quantileBreaks, assignByBreaks,
  familyKey, extractDemands, suggestGroups, allocateGroupBudget,
  memberSteelWeightLb, computeSavings,
  flexSteelRatioPct, stirrupAvPerFt, steelWeightPerFt,
  governingFace, ALL_BEAMS_FAMILY_KEY,
} from '../autoGroup';
import type { MemberDemand } from '../autoGroup';
import { toDisplay } from '../units';
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

  it('total-groups budget caps the committed group count', () => {
    // Two families (h=24 and h=36), 4 members each, spread demands
    const members = [
      ...Array.from({ length: 4 }, (_, i) => makeMember({ id: `s${i}`, h: 24, loads: [{ id: 'l', label: 'E', Mu_pos: (i + 1) * 50, Mu_neg: 10, Vu: 10, Tu: 0, Pu: 0 }] })),
      ...Array.from({ length: 4 }, (_, i) => makeMember({ id: `d${i}`, h: 36, loads: [{ id: 'l', label: 'E', Mu_pos: (i + 1) * 90, Mu_neg: 10, Vu: 10, Tu: 0, Pu: 0 }] })),
    ];
    const sug = suggestGroups(members, 'auto', 'jenks', 'Mu_pos', 4);
    const totalBins = sug.reduce((s, x) => s + x.bins.length, 0);
    expect(totalBins).toBeLessThanOrEqual(4);
    expect(totalBins).toBeGreaterThanOrEqual(2); // ≥1 per family
  });
});

describe('allocateGroupBudget', () => {
  function fam(prefix: string, h: number, n: number): Member[] {
    return Array.from({ length: n }, (_, i) =>
      makeMember({ id: `${prefix}${i}`, h, loads: [{ id: 'l', label: 'E', Mu_pos: (i + 1) * 50, Mu_neg: 10, Vu: 10, Tu: 0, Pu: 0 }] }));
  }
  const members = [...fam('a', 24, 5), ...fam('b', 36, 3)]; // 2 families, 8 members

  it('sums to clamped K and gives each family ≥1 and ≤ its count', () => {
    const alloc = allocateGroupBudget(members, 5, 'Mu_pos');
    const vals = Object.values(alloc);
    expect(vals.reduce((s, v) => s + v, 0)).toBe(5);
    for (const v of vals) expect(v).toBeGreaterThanOrEqual(1);
    expect(Object.keys(alloc)).toHaveLength(2);
  });

  it('clamps below #families up to #families', () => {
    const alloc = allocateGroupBudget(members, 1, 'Mu_pos');
    expect(Object.values(alloc).reduce((s, v) => s + v, 0)).toBe(2); // 2 families
  });

  it('clamps above #members down to #members', () => {
    const alloc = allocateGroupBudget(members, 99, 'Mu_pos');
    expect(Object.values(alloc).reduce((s, v) => s + v, 0)).toBe(8); // 8 members
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

// ── SI-unit display of savings ──────────────────────────────────────────────
// The engine computes everything in imperial (in², ft, lb). SI is a pure
// display conversion. These tests verify the numbers the SI user actually
// sees (kg, kg/m, metric tons) are converted correctly from the imperial core.
describe('computeSavings — SI display conversion', () => {
  const LB_TO_KG = 0.453592;
  const LBFT_TO_KGM = 1.48816;

  const m = makeMember({ id: 'm1', span: 20 });
  const res: Partial<DesignResults> = {
    DCR_flex_pos: 0.63, DCR_flex_neg: 0.5, DCR_shear: 0.6,
    As_req_pos: 1.5, As_req_neg: 1.2, As_min: 0.5, As_max: 10,
    Av_req: 0.01, Av_min_per_s: 0.005,
    phi_Mn_pos: 200, phi_Mn_neg: 180, phi_Vn: 80,
    Mn_pos: 200, Mn_neg: 180, warnings: [], status: 'OK', loadCaseId: 'lc1',
  };

  it('total savings convert lb → kg with the correct factor', () => {
    const { totalLb } = computeSavings([m], { m1: res as DesignResults }, {}, 0.9);
    expect(totalLb).toBeGreaterThan(0);
    const kg = toDisplay(totalLb, 'steelWeight', 'si');
    expect(kg).toBeCloseTo(totalLb * LB_TO_KG, 6);
  });

  it('metric tons = kg / 1000 matches imperial tons × 0.907', () => {
    const { totalLb } = computeSavings([m], { m1: res as DesignResults }, {}, 0.9);
    const metricTons = toDisplay(totalLb, 'steelWeight', 'si') / 1000;
    const usTons = totalLb / 2000;
    // 1 US ton (2000 lb) = 0.90718 metric tons
    expect(metricTons).toBeCloseTo(usTons * 0.90718, 4);
  });

  it('per-foot steel weight converts lb/ft → kg/m correctly', () => {
    const w = steelWeightPerFt(m);
    const kgm = toDisplay(w.longLbFt, 'steelWeightPerLength', 'si');
    expect(kgm).toBeCloseTo(w.longLbFt * LBFT_TO_KGM, 6);
  });

  it('SI imperial round-trip leaves the imperial core unchanged', () => {
    // Changing the display system must NOT change the computed slack — the
    // engine is always imperial; only the displayed number differs.
    const a = computeSavings([m], { m1: res as DesignResults }, {}, 0.9);
    const b = computeSavings([m], { m1: res as DesignResults }, {}, 0.9);
    expect(a.totalLb).toBe(b.totalLb);
    // SI value divided back by the factor recovers the imperial value
    const kg = toDisplay(a.totalLb, 'steelWeight', 'si');
    expect(kg / LB_TO_KG).toBeCloseTo(a.totalLb, 6);
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

// ── suggestGroups — splitByFace ───────────────────────────────────────────────

describe('governingFace', () => {
  it('returns bot when MuPos >= MuNeg (sagging)', () => {
    const d = { MuPos: 100, MuNeg: 80 } as MemberDemand;
    expect(governingFace(d)).toBe('bot');
  });

  it('returns bot on tie (MuPos === MuNeg)', () => {
    const d = { MuPos: 50, MuNeg: 50 } as MemberDemand;
    expect(governingFace(d)).toBe('bot');
  });

  it('returns top when MuNeg > MuPos (hogging)', () => {
    const d = { MuPos: 30, MuNeg: 120 } as MemberDemand;
    expect(governingFace(d)).toBe('top');
  });

  it('returns bot when both are zero', () => {
    const d = { MuPos: 0, MuNeg: 0 } as MemberDemand;
    expect(governingFace(d)).toBe('bot');
  });
});

describe('suggestGroups — splitByFace', () => {
  // Build a mixed family: 4 sagging beams + 2 hogging beams, same section.
  function makeFamily() {
    const sagMembers = [100, 120, 130, 150].map((mu, i) =>
      makeMember({
        id: `s${i}`,
        b: 14, h: 24,
        loads: [{ id: 'lc', label: 'Env', Mu_pos: mu, Mu_neg: mu * 0.3, Vu: 30, Tu: 0, Pu: 0 }],
      })
    );
    const hogMembers = [20, 30].map((mu, i) =>
      makeMember({
        id: `h${i}`,
        b: 14, h: 24,
        loads: [{ id: 'lc', label: 'Env', Mu_pos: mu, Mu_neg: mu * 5, Vu: 30, Tu: 0, Pu: 0 }],
      })
    );
    return [...sagMembers, ...hogMembers];
  }

  it('mixed family → two sub-pools with face bot and top', () => {
    const members = makeFamily();
    const result = suggestGroups(members, 4, 'jenks', 'governing', undefined, false, true);
    expect(result.length).toBe(2);
    expect(result.some(s => s.face === 'bot')).toBe(true);
    expect(result.some(s => s.face === 'top')).toBe(true);
  });

  it('no cross-face contamination — bot bins only sagging members', () => {
    const members = makeFamily();
    const result = suggestGroups(members, 4, 'jenks', 'governing', undefined, false, true);

    const botSug = result.find(s => s.face === 'bot')!;
    const topSug = result.find(s => s.face === 'top')!;

    const botIds = new Set(botSug.bins.flatMap(b => b.memberIds));
    const topIds = new Set(topSug.bins.flatMap(b => b.memberIds));

    // No overlap
    expect([...botIds].some(id => topIds.has(id))).toBe(false);

    // Sagging members in bot pool
    const sagIds = new Set(['s0', 's1', 's2', 's3']);
    expect([...botIds].every(id => sagIds.has(id))).toBe(true);

    // Hogging members in top pool
    const hogIds = new Set(['h0', 'h1']);
    expect([...topIds].every(id => hogIds.has(id))).toBe(true);
  });

  it('purely sagging family → only one bot sub-pool', () => {
    const members = [100, 120, 130].map((mu, i) =>
      makeMember({
        id: `s${i}`,
        b: 14, h: 24,
        loads: [{ id: 'lc', label: 'Env', Mu_pos: mu, Mu_neg: mu * 0.2, Vu: 30, Tu: 0, Pu: 0 }],
      })
    );
    const result = suggestGroups(members, 4, 'jenks', 'governing', undefined, false, true);
    expect(result.length).toBe(1);
    expect(result[0].face).toBe('bot');
    expect(result.some(s => s.face === 'top')).toBe(false);
  });

  it('splitByFace = false → single suggestion with no face field', () => {
    const members = makeFamily();
    const result = suggestGroups(members, 4, 'jenks', 'governing', undefined, false, false);
    expect(result.length).toBe(1);
    expect(result[0].face).toBeUndefined();
    expect(result[0].bins.flatMap(b => b.memberIds)).toHaveLength(6);
  });

  it('auto metric: governing → bot uses Mu_pos, top uses Mu_neg', () => {
    const members = makeFamily();
    const result = suggestGroups(members, 4, 'jenks', 'governing', undefined, false, true);
    const botSug = result.find(s => s.face === 'bot')!;
    const topSug = result.find(s => s.face === 'top')!;
    expect(botSug.metric).toBe('Mu_pos');
    expect(topSug.metric).toBe('Mu_neg');
  });

  it('explicit non-governing metric preserved in both sub-pools', () => {
    const members = makeFamily();
    const result = suggestGroups(members, 4, 'jenks', 'Vu', undefined, false, true);
    expect(result.every(s => s.metric === 'Vu')).toBe(true);
  });

  it('groupAllBeams = true ignores splitByFace', () => {
    const members = makeFamily();
    const result = suggestGroups(members, 4, 'jenks', 'governing', undefined, true, true);
    expect(result.length).toBe(1);
    expect(result[0].face).toBeUndefined();
    expect(result[0].familyKey).toBe(ALL_BEAMS_FAMILY_KEY);
  });

  it('rawFamilyKey equals plain familyKey of member', () => {
    const members = makeFamily();
    const result = suggestGroups(members, 4, 'jenks', 'governing', undefined, false, true);
    const plainKey = familyKey(members[0]);
    result.forEach(s => {
      expect(s.rawFamilyKey).toBe(plainKey);
    });
  });
});
