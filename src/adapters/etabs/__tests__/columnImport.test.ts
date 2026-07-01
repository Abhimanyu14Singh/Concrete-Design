/**
 * Column import: the ETABS adapter can enumerate columns (getColumns) and map
 * them into first-class app Members (buildColumnMembers) — geometry + section +
 * a starter cage — so they appear on the model map and can be grouped/exported.
 * Design forces start at zero (entered after import / future live-ETABS read).
 */
import { describe, it, expect } from 'vitest';
import { MockConnection } from '../mock';
import { buildColumnMembers } from '../index';
import type { SeedOptions } from '../rebarSeed';

const SEED: SeedOptions = {
  rhoTopPct: 0.4, rhoBotPct: 0.6, stirrupSpacings: [4, 8, 4],
  stirrupBarSize: 4, stirrupLegs: 2, imposeSkinReinf: true, skinBarSize: 5, coverClear: 1.5,
};

describe('MockConnection.getColumns', () => {
  it('returns vertical columns at plan grid points, rising through the stories', async () => {
    const conn = new MockConnection();
    const cols = await conn.getColumns({});
    expect(cols.length).toBeGreaterThan(0);
    for (const c of cols) {
      expect(c.pt1.x).toBe(c.pt2.x);                          // same plan X
      expect(c.pt1.y).toBe(c.pt2.y);                          // same plan Y
      expect(Math.abs(c.pt2.z - c.pt1.z)).toBeGreaterThan(0); // vertical extent
      expect(c.heightFt).toBeGreaterThan(0);
    }
  });

  it('filters columns by story and by group', async () => {
    const conn = new MockConnection();
    const l2 = await conn.getColumns({ stories: ['Level 2'] });
    expect(l2.length).toBeGreaterThan(0);
    expect(l2.every(c => c.story === 'Level 2')).toBe(true);

    const byGroup = await conn.getColumns({ groups: ['L3-Cols'] });
    expect(byGroup.length).toBeGreaterThan(0);
    expect(byGroup.every(c => c.groups.includes('L3-Cols'))).toBe(true);
  });

  it('exposes the column section + groups so the map can render them', async () => {
    const conn = new MockConnection();
    expect((await conn.getFrameSections()).some(s => s.name === 'C18X18')).toBe(true);
    expect(await conn.getGroups()).toContain('Columns');
  });
});

describe('buildColumnMembers', () => {
  it('maps columns to rectangular_column members with geometry, a cage, and a placeholder load', async () => {
    const conn = new MockConnection();
    const cols = await conn.getColumns({ stories: ['Level 2'] });
    const members = buildColumnMembers(cols, await conn.getFrameSections(), await conn.getMaterials(), SEED);

    expect(members).toHaveLength(cols.length);
    const m = members[0];
    expect(m.memberType).toBe('column');
    expect(m.section.type).toBe('rectangular_column');
    expect(m.section.b).toBe(18);                 // C18X18 width
    expect(m.section.h).toBe(18);                 // C18X18 depth
    expect(m.etabs?.pt1).toBeDefined();           // carries plan/elevation geometry
    expect(m.etabs?.story).toBe('Level 2');
    expect(m.rebar.ties).toBeDefined();           // has a tie set
    expect(m.rebar.sideBars?.length).toBeGreaterThan(0);
    expect(m.loads).toHaveLength(1);
    expect(m.loads[0].Pu).toBe(0);                // forces entered after import
    expect(m.loads[0].label).toMatch(/enter column forces/i);
  });

  it('resolves the column concrete strength from the section material', async () => {
    const conn = new MockConnection();
    const cols = await conn.getColumns({ stories: ['Level 2'] });
    const members = buildColumnMembers(cols, await conn.getFrameSections(), await conn.getMaterials(), SEED);
    expect(members[0].material.fc).toBe(5000);    // C18X18 → 5000Psi
  });
});
