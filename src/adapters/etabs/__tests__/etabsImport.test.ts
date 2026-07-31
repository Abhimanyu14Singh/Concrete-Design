/**
 * ETABS import pipeline tests — mock connection, force envelopes, zone
 * demands, rebar seeding, member building, auto-grouping, zoned shear check.
 */
import { describe, it, expect } from 'vitest';
import { MockConnection } from '../mock';
import { envelopeLoadCase, stationLoadCases, zoneShearDemands, buildMembers, autoGroup } from '../index';
import { seedRebar, pickBars, minSkinReinforcement } from '../rebarSeed';
import { zonedShearCheck, getBarArea, effectiveDepth } from '../../../utils/concreteDesign';
import { zonedShearCheckEC2 } from '../../../engines/ec2/ec2Beam';
import { runDesign } from '../../../engines';
import type { ComboForces, SectionDimensions } from '../../../types';

const SECTION: SectionDimensions = {
  type: 'rectangular_beam', b: 14, h: 28, coverClear: 1.5, stirrupDia: 4,
};

describe('MockConnection', () => {
  const conn = new MockConnection();

  it('connects and exposes model lists', async () => {
    const info = await conn.connect();
    expect(info.modelName).toContain('Sample');
    expect(await conn.getStories()).toEqual(['Level 2', 'Level 3']);
    expect((await conn.getGroups()).length).toBeGreaterThan(0);
    expect((await conn.getCombos()).length).toBe(3);
  });

  it('filters beams by story', async () => {
    const all = await conn.getBeams({});
    const l2 = await conn.getBeams({ stories: ['Level 2'] });
    expect(l2.length).toBeGreaterThan(0);
    expect(l2.length).toBeLessThan(all.length);
    expect(l2.every(b => b.story === 'Level 2')).toBe(true);
  });

  it('filters beams by section and group', async () => {
    const girders = await conn.getBeams({ sections: ['B14X28'] });
    expect(girders.every(b => b.section === 'B14X28')).toBe(true);
    const grp = await conn.getBeams({ groups: ['Girders'] });
    expect(grp.every(b => b.groups.includes('Girders'))).toBe(true);
  });

  it('returns sorted station forces per combo', async () => {
    const beams = await conn.getBeams({ stories: ['Level 2'] });
    const forces = await conn.getStationForces([beams[0].name], ['1.2D+1.6L', '0.9D+1.0E']);
    const cf = forces[beams[0].name];
    expect(cf).toHaveLength(2);
    const xs = cf[0].stations.map(s => s.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(cf[0].stations[0].x).toBe(0);
  });
});

describe('envelopeLoadCase', () => {
  const forces: ComboForces[] = [
    { combo: 'C1', stations: [{ x: 0, V: 40, M: -120 }, { x: 10, V: 0, M: 80 }, { x: 20, V: -40, M: -120 }] },
    { combo: 'C2', stations: [{ x: 0, V: 55, M: -90 }, { x: 10, V: 5, M: 140 }, { x: 20, V: -30, M: -60 }] },
  ];

  it('takes max sagging, max hogging magnitude, and max |V| across combos', () => {
    const lc = envelopeLoadCase(forces);
    expect(lc.Mu_pos).toBe(140);
    expect(lc.Mu_neg).toBe(120);
    expect(lc.Vu).toBe(55);
  });

  it('returns zeros for empty forces', () => {
    const lc = envelopeLoadCase([]);
    expect(lc.Mu_pos).toBe(0);
    expect(lc.Vu).toBe(0);
  });
});

describe('stationLoadCases', () => {
  const forces: ComboForces[] = [
    { combo: 'C1', stations: [{ x: 0, V: 40, M: -120 }, { x: 10, V: 0, M: 80 }, { x: 20, V: -40, M: -120 }] },
    { combo: 'C2', stations: [{ x: 0, V: 55, M: -90 }, { x: 10, V: 5, M: 140 }, { x: 20, V: -30, M: -60 }] },
  ];

  it('expands to one row per DISTINCT station force state (not one envelope)', () => {
    const rows = stationLoadCases(forces);
    // C1 has two identical support states (|V|=40, M=−120) → collapsed to 1; C1 keeps
    // {support, midspan} = 2, C2 keeps all 3 distinct → 5 rows total.
    expect(rows.length).toBe(5);
    expect(new Set(rows.map(r => r.id)).size).toBe(rows.length); // ids unique
  });

  it('sets Mu_pos OR Mu_neg from the signed station moment, keeping each station simultaneous', () => {
    const rows = stationLoadCases(forces);
    const sag = rows.find(r => r.Mu_pos === 140)!;      // C2 midspan: sagging + its own small shear
    expect(sag).toBeTruthy();
    expect(sag.Mu_neg).toBe(0);
    expect(sag.Vu).toBe(5);                              // NOT the max |V| of 55 — the station's own V
    const hog = rows.find(r => r.Mu_neg === 120)!;      // C1 support: hogging + its own shear
    expect(hog.Mu_pos).toBe(0);
    expect(hog.Vu).toBe(40);
  });

  it('carries per-station torsion and signed axial', () => {
    const rows = stationLoadCases([{ combo: 'D', stations: [{ x: 5, V: 30, M: 100, T: 20, P: -15 }] }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Mu_pos: 100, Vu: 30, Tu: 20, Pu: -15 });
  });

  it('falls back to a single envelope row when there is no station data', () => {
    const rows = stationLoadCases([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].Mu_pos).toBe(0);
  });
});

describe('zoneShearDemands', () => {
  it('buckets max |V| into span thirds', () => {
    const forces: ComboForces[] = [{
      combo: 'C1',
      stations: [
        { x: 0, V: 60, M: 0 },   // zone 0
        { x: 9, V: 20, M: 0 },   // zone 1 (9/30*3 = 0.9 → still zone 0)
        { x: 12, V: 15, M: 0 },  // zone 1
        { x: 29, V: -58, M: 0 }, // zone 2
      ],
    }];
    const z = zoneShearDemands(forces, 30);
    expect(z[0]).toBe(60);
    expect(z[1]).toBe(15);
    expect(z[2]).toBe(58);
  });

  it('station at exactly L lands in the last zone', () => {
    const forces: ComboForces[] = [{ combo: 'C', stations: [{ x: 30, V: -44, M: 0 }] }];
    expect(zoneShearDemands(forces, 30)[2]).toBe(44);
  });
});

describe('pickBars / seedRebar', () => {
  it('meets the target steel area', () => {
    const target = 3.0; // in²
    const pick = pickBars(target, SECTION);
    expect(pick.numBars * getBarArea(pick.barSize)).toBeGreaterThanOrEqual(target);
  });

  it('respects the 2-bar minimum for small targets', () => {
    const pick = pickBars(0.1, SECTION);
    expect(pick.numBars).toBeGreaterThanOrEqual(2);
  });

  it('seeded layout hits the requested percentages', () => {
    const rebar = seedRebar(SECTION, {
      rhoTopPct: 0.4, rhoBotPct: 0.6, stirrupSpacings: [4, 8, 4],
    });
    const d = effectiveDepth(SECTION, 8);
    const AsBot = rebar.botBars[0].numBars * getBarArea(rebar.botBars[0].barSize);
    expect(AsBot).toBeGreaterThanOrEqual(0.006 * SECTION.b * d);
    expect(rebar.tieZones).toHaveLength(3);
    expect(rebar.tieZones![1].spacing).toBe(8);
    // engine single-spacing check uses the tightest spacing
    expect(rebar.ties!.spacing).toBe(4);
  });

  it('imposes no skin steel on a shallow section, even when requested', () => {
    const rebar = seedRebar(SECTION, { // h = 28 in < 36 in ACI threshold
      rhoTopPct: 0.4, rhoBotPct: 0.6, stirrupSpacings: [4, 8, 4],
      imposeSkinReinf: true, skinBarSize: 5,
    }, 'ACI318-19');
    expect(rebar.sideBars).toBeUndefined();
  });

  it('imposes ACI skin steel when h > 36 in', () => {
    const deep: SectionDimensions = { ...SECTION, h: 48 };
    const rebar = seedRebar(deep, {
      rhoTopPct: 0.4, rhoBotPct: 0.6, stirrupSpacings: [4, 8, 4],
      imposeSkinReinf: true, skinBarSize: 5,
    }, 'ACI318-19');
    expect(rebar.sideBars?.[0].barSize).toBe(5);
    // Per face now (beam convention): region = h/2 − cover = 22.5" at ≤ 12" → 2.
    expect(rebar.sideBars![0].numBars).toBe(2);
  });

  it('EC2 threshold (h > 1000 mm ≈ 39.4 in) differs from ACI', () => {
    const h42: SectionDimensions = { ...SECTION, h: 42 }; // > both thresholds
    const aci = minSkinReinforcement(h42, 'ACI318-19', 5);
    const ec2 = minSkinReinforcement(h42, 'EN1992-1-1', 5);
    expect(aci).toBeDefined();
    expect(ec2).toBeDefined();
    // A section between 36 in and 39.4 in triggers ACI but not EC2
    const h38: SectionDimensions = { ...SECTION, h: 38 };
    expect(minSkinReinforcement(h38, 'ACI318-19', 5)).toBeDefined();
    expect(minSkinReinforcement(h38, 'EN1992-1-1', 5)).toBeUndefined();
  });
});

describe('buildMembers + autoGroup', () => {
  it('builds members with per-station loads, station forces, and ETABS links', async () => {
    const conn = new MockConnection();
    await conn.connect();
    const beams = await conn.getBeams({ stories: ['Level 2'] });
    const forces = await conn.getStationForces(beams.map(b => b.name), ['1.2D+1.6L']);
    const members = buildMembers(beams, await conn.getFrameSections(), await conn.getMaterials(), forces, {
      rhoTopPct: 0.4, rhoBotPct: 0.6, stirrupSpacings: [4, 8, 4],
    });

    expect(members).toHaveLength(beams.length);
    const m = members[0];
    expect(m.memberType).toBe('beam');
    expect(m.etabs?.story).toBe('Level 2');
    expect(m.stationForces!.length).toBe(1);
    // One row per distinct station force state (not a single envelope): the
    // parabolic mock beam yields hogging supports + a sagging midspan.
    expect(m.loads.length).toBeGreaterThan(1);
    expect(m.loads.some(l => l.Vu > 0)).toBe(true);
    expect(m.loads.some(l => l.Mu_pos > 0)).toBe(true);   // sagging midspan
    expect(m.loads.some(l => l.Mu_neg > 0)).toBe(true);   // hogging supports
    // section size came from the frame property
    const girder = members.find(x => x.etabs!.sectionName === 'B14X28')!;
    expect(girder.section.b).toBe(14);
    expect(girder.section.h).toBe(28);
    // material came from the section's concrete
    expect(girder.material.fc).toBe(5000);
    // members are designable by the standard engine without errors
    const r = runDesign(m.section, m.material, m.rebar, m.loads[0], m.span, 'ACI318-19');
    expect(Number.isFinite(r.DCR_shear)).toBe(true);
  });

  it('auto-groups by story × section by default and tags members', async () => {
    const conn = new MockConnection();
    await conn.connect();
    const beams = await conn.getBeams({});
    const members = buildMembers(beams, await conn.getFrameSections(), await conn.getMaterials(), {}, {
      rhoTopPct: 0.4, rhoBotPct: 0.6, stirrupSpacings: [4, 8, 4],
    });
    const groups = autoGroup(members);
    // 2 stories × 2 sections
    expect(groups).toHaveLength(4);
    expect(groups.reduce((s, g) => s + g.memberIds.length, 0)).toBe(members.length);
    for (const m of members) {
      const g = groups.find(g => g.id === m.etabs!.designGroupId)!;
      expect(g.memberIds).toContain(m.id);
    }
  });

  it('mirrors only opted-in ETABS group names; others fall back to story × section', async () => {
    const conn = new MockConnection();
    await conn.connect();
    const beams = await conn.getBeams({});
    const members = buildMembers(beams, await conn.getFrameSections(), await conn.getMaterials(), {}, {
      rhoTopPct: 0.4, rhoBotPct: 0.6, stirrupSpacings: [4, 8, 4],
    });
    const groups = autoGroup(members, new Set(['Girders']));
    const girders = groups.find(g => g.label === 'Girders');
    expect(girders).toBeDefined();
    // Girders members all carry the ETABS 'Girders' group
    for (const mid of girders!.memberIds) {
      const m = members.find(mm => mm.id === mid)!;
      expect(m.etabs!.groups).toContain('Girders');
    }
    // Non-girder beams still bucket by story · section
    const fallback = groups.filter(g => g.label.includes(' · '));
    expect(fallback.length).toBeGreaterThan(0);
    expect(groups.reduce((s, g) => s + g.memberIds.length, 0)).toBe(members.length);
  });
});

describe('zonedShearCheck', () => {
  const material = { fc: 5000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 };
  const rebar = {
    topBars: [{ numBars: 3, barSize: 8 }],
    botBars: [{ numBars: 4, barSize: 8 }],
    ties: { barSize: 4, spacing: 4, legs: 2 },
    tieZones: [{ spacing: 4 }, { spacing: 10 }, { spacing: 4 }] as [{ spacing: number }, { spacing: number }, { spacing: number }],
  };

  it('tighter zones have higher capacity', () => {
    const z = zonedShearCheck(SECTION, material, rebar, [60, 20, 55]);
    expect(z).toHaveLength(3);
    expect(z[0].phi_Vn).toBeGreaterThan(z[1].phi_Vn);
    expect(z[0].phi_Vn).toBeCloseTo(z[2].phi_Vn, 6);
  });

  it('DCR = zone demand / zone capacity', () => {
    const z = zonedShearCheck(SECTION, material, rebar, [60, 20, 55]);
    expect(z[0].DCR).toBeCloseTo(60 / z[0].phi_Vn, 6);
    expect(z[1].DCR).toBeCloseTo(20 / z[1].phi_Vn, 6);
  });

  it('returns empty without tieZones', () => {
    const plain = { topBars: rebar.topBars, botBars: rebar.botBars, ties: rebar.ties };
    expect(zonedShearCheck(SECTION, material, plain, [60, 20, 55])).toEqual([]);
  });

  it('a wide middle zone can govern even with lower demand', () => {
    const wideMid = { ...rebar, tieZones: [{ spacing: 3 }, { spacing: 18 }, { spacing: 3 }] as typeof rebar.tieZones };
    const z = zonedShearCheck(SECTION, material, wideMid, [50, 45, 50]);
    expect(z[1].DCR).toBeGreaterThan(z[0].DCR);
  });
});

describe('zonedShearCheckEC2', () => {
  const material = { fc: 5000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 };
  const rebar = {
    topBars: [{ numBars: 3, barSize: 8 }],
    botBars: [{ numBars: 4, barSize: 8 }],
    ties: { barSize: 4, spacing: 4, legs: 2 },
    tieZones: [{ spacing: 4 }, { spacing: 10 }, { spacing: 4 }] as [{ spacing: number }, { spacing: number }, { spacing: number }],
  };

  it('checks all three zones with EC2 variable-strut capacity', () => {
    const z = zonedShearCheckEC2(SECTION, material, rebar, [60, 20, 55]);
    expect(z).toHaveLength(3);
    // Tighter end zones carry more (V_Rd,s ∝ Asw/s) until capped by V_Rd,max.
    expect(z[0].phi_Vn).toBeGreaterThanOrEqual(z[1].phi_Vn);
    expect(z[0].phi_Vn).toBeCloseTo(z[2].phi_Vn, 6);
  });

  it('DCR = zone demand / zone capacity (governing worst case per third)', () => {
    const z = zonedShearCheckEC2(SECTION, material, rebar, [60, 20, 55]);
    expect(z[0].DCR).toBeCloseTo(60 / z[0].phi_Vn, 6);
    expect(z[1].DCR).toBeCloseTo(20 / z[1].phi_Vn, 6);
    expect(z[2].DCR).toBeCloseTo(55 / z[2].phi_Vn, 6);
  });

  it('a wide middle zone can govern even with lower demand', () => {
    const wideMid = { ...rebar, tieZones: [{ spacing: 3 }, { spacing: 18 }, { spacing: 3 }] as typeof rebar.tieZones };
    const z = zonedShearCheckEC2(SECTION, material, wideMid, [50, 45, 50]);
    expect(z[1].DCR).toBeGreaterThan(z[0].DCR);
  });

  it('returns empty without tieZones', () => {
    const plain = { topBars: rebar.topBars, botBars: rebar.botBars, ties: rebar.ties };
    expect(zonedShearCheckEC2(SECTION, material, plain, [60, 20, 55])).toEqual([]);
  });

  it('headline EC2 DCR_shear reflects the worst (widest) zone, not the tightest', () => {
    // ties.spacing stores the tight end value (4"); the middle zone is wider (16").
    const wideMid = { ...rebar, ties: { ...rebar.ties, spacing: 4 }, tieZones: [{ spacing: 4 }, { spacing: 16 }, { spacing: 4 }] as typeof rebar.tieZones };
    const tight   = { ...rebar, ties: { ...rebar.ties, spacing: 4 }, tieZones: [{ spacing: 4 }, { spacing: 4 }, { spacing: 4 }] as typeof rebar.tieZones };
    const load = { id: 'lc', label: 'LC1', Mu_pos: 100, Mu_neg: 80, Vu: 60, Tu: 0, Pu: 0 };
    const rWide  = runDesign(SECTION, material, wideMid, load, 20, 'EN1992-1-1');
    const rTight = runDesign(SECTION, material, tight, load, 20, 'EN1992-1-1');
    // A loose middle zone must NOT show a lower headline DCR than uniform-tight links.
    expect(rWide.DCR_shear).toBeGreaterThan(rTight.DCR_shear);
  });
});
