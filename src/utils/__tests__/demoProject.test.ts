/**
 * The built-in demo model.
 *
 * "Explore the demo model" on the welcome screen promised a two-storey frame and
 * delivered `defaultProject` — two hand-written beams, no model map, no design
 * groups. The Model panel opened on "0 frames" and Groups on "2 ungrouped", so the
 * two panels the button exists to demonstrate had nothing in them.
 *
 * These tests hold the demo to what the button claims, and to being a model worth
 * opening: geometry the map can draw, groups the dashboard can summarise, and a
 * DCR spread that is neither all-green nor all-red.
 */
import { describe, expect, it } from 'vitest';
import { buildDemoProject } from '../demoProject';
import { runDesign } from '../../engines';
import type { Project } from '../../types';

const built = await buildDemoProject();

/** Worst DCR over every load row of a member — never row [0]; see CLAUDE.md. */
function worstDcr(p: Project, m: Project['members'][number]) {
  let flex = 0, shear = 0, tors = 0;
  for (const lc of m.loads) {
    const r = runDesign(m.section, m.material, m.rebar, lc, m.span, p.code);
    flex = Math.max(flex, r.DCR_flex_pos ?? 0, r.DCR_flex_neg ?? 0);
    shear = Math.max(shear, r.DCR_shear ?? 0);
    tors = Math.max(tors, r.DCR_torsion ?? 0);
  }
  return { flex, shear, tors, worst: Math.max(flex, shear, tors) };
}

describe('it is a frame, not two beams', () => {
  it('is two storeys of beams', () => {
    expect(built.modelMap?.stories).toEqual(['Level 2', 'Level 3']);
    expect(built.members.length).toBeGreaterThan(20);
    expect(new Set(built.members.map(m => m.etabs?.story)).size).toBe(2);
  });

  it('carries the geometry the model map draws — the whole point of the fix', () => {
    const map = built.modelMap;
    expect(map).toBeDefined();
    expect(map!.source).toBe('mock');
    expect(map!.frames).toHaveLength(built.members.length);
    expect(map!.columns?.length).toBeGreaterThan(0);
    expect(map!.walls?.length).toBeGreaterThan(0);
    expect(map!.grids?.length).toBeGreaterThan(0);
    expect(map!.openings?.length).toBeGreaterThan(0);
  });

  it('every frame on the map links to a member that exists', () => {
    const ids = new Set(built.members.map(m => m.id));
    for (const f of built.modelMap!.frames) {
      expect(f.memberId, f.frameName).toBeDefined();
      expect(ids.has(f.memberId!), f.frameName).toBe(true);
    }
  });

  it('is grouped, and every member is in exactly one group', () => {
    const groups = built.designGroups ?? [];
    expect(groups.length).toBeGreaterThan(1);
    const membered = groups.flatMap(g => g.memberIds);
    expect(new Set(membered).size).toBe(membered.length);      // no member twice
    expect(new Set(membered)).toEqual(new Set(built.members.map(m => m.id)));
    // and the back-link the dashboard reads agrees with the forward one
    for (const m of built.members) {
      const g = groups.find(x => x.memberIds.includes(m.id));
      expect(m.etabs?.designGroupId, m.id).toBe(g!.id);
    }
  });

  it('every member has real station forces, not one envelope row', () => {
    for (const m of built.members) {
      expect(m.loads.length, m.id).toBeGreaterThan(5);
      expect(m.stationForces?.length, m.id).toBe(3);           // three combos
    }
  });

  it('keeps the per-section concrete grade, so the frame is mixed-grade like a real import', () => {
    const grades = new Map(built.members.map(m => [m.etabs?.sectionName, m.material.fc]));
    expect(grades.get('B14X28')).toBe(5000);
    expect(grades.get('B12X24')).toBe(4000);
  });
});

describe('it is a model worth opening', () => {
  const spread = built.members.map(m => ({ id: m.id, ...worstDcr(built, m) }));

  it('is mostly passing, with a few members left to fix', () => {
    const over = spread.filter(s => s.worst > 1).length;
    // Neither extreme is a demo: all-green has nothing to do, all-red looks broken.
    expect(over).toBeGreaterThan(0);
    expect(over).toBeLessThan(spread.length / 3);
    expect(Math.max(...spread.map(s => s.worst))).toBeLessThan(1.5);
    expect(Math.min(...spread.map(s => s.worst))).toBeGreaterThan(0.25);
  });

  it('exercises torsion, not just flexure and shear', () => {
    // Perimeter beams take the slab edge as a torque (mock.ts `isSpandrel`). Without
    // it the torsion check reads 0.00 across the one model every new user opens.
    expect(spread.filter(s => s.tors > 0).length).toBeGreaterThan(5);
    expect(spread.every(s => s.flex > 0 && s.shear > 0)).toBe(true);
  });
});

describe('deterministic', () => {
  it('two builds give the same model — only the timestamps move', async () => {
    const again = await buildDemoProject();
    expect(again.members).toEqual(built.members);
    expect(again.designGroups).toEqual(built.designGroups);
    expect(again.modelMap!.frames).toEqual(built.modelMap!.frames);
  });
});
