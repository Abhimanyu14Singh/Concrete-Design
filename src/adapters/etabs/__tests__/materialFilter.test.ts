/**
 * Filtering the import by frame-property material — "do not bring in the steel beams".
 *
 * Two things make this more than another checkbox list.
 *
 * It is a HARD scope, not a third additive selector. Sections and groups are OR'd, so a
 * material filter joined to that union would be defeated by the very models that need
 * it: a steel beam sitting in a selected ETABS group matches on the group and comes in
 * anyway. Material has to AND with everything else or it does not do its job.
 *
 * And the material is not on the beam. ETABS names a frame's PROPERTY; the material is
 * a field on that property, one table over. The join is supplied by the caller as
 * `sectionMaterials`, which is why an unknown section has to have a defined answer —
 * and that answer is KEEP, because dropping frames the filter cannot identify would
 * silently lose real beams.
 */
import { describe, expect, it } from 'vitest';
import { matchesFilter, type BeamFilter } from '../connection';

const beam = (section: string, over: Partial<{ story: string; groups: string[] }> = {}) => ({
  story: 'L2', section, groups: [], ...over,
});

const MATS: Record<string, string> = {
  B12X24: '4000Psi',
  B14X28: '5000Psi',
  W18X50: 'A992Fy50',
  W21X62: 'A992Fy50',
};

const concreteOnly: BeamFilter = { materials: ['4000Psi', '5000Psi'], sectionMaterials: MATS };

describe('material scope', () => {
  it('keeps concrete sections and drops steel ones', () => {
    expect(matchesFilter(beam('B12X24'), concreteOnly)).toBe(true);
    expect(matchesFilter(beam('B14X28'), concreteOnly)).toBe(true);
    expect(matchesFilter(beam('W18X50'), concreteOnly)).toBe(false);
    expect(matchesFilter(beam('W21X62'), concreteOnly)).toBe(false);
  });

  it('no material selected = every material, which is the default import', () => {
    expect(matchesFilter(beam('W18X50'), { sectionMaterials: MATS })).toBe(true);
    expect(matchesFilter(beam('W18X50'), {})).toBe(true);
  });

  it('a section the map does not know is KEPT, not silently dropped', () => {
    // The section table and the connectivity table can disagree; losing a real beam to
    // that is worse than importing one the user then deletes.
    expect(matchesFilter(beam('MYSTERY-SECTION'), concreteOnly)).toBe(true);
  });

  it('matches case- and whitespace-insensitively — the two ETABS tables disagree on both', () => {
    const f: BeamFilter = { materials: ['  4000psi '], sectionMaterials: { B12X24: '4000Psi' } };
    expect(matchesFilter(beam('B12X24'), f)).toBe(true);
  });

  it('with no sectionMaterials map there is nothing to resolve, so nothing is excluded', () => {
    expect(matchesFilter(beam('W18X50'), { materials: ['4000Psi'] })).toBe(true);
  });
});

describe('material ANDs with the section ∪ group union', () => {
  const inGroup = beam('W18X50', { groups: ['TRANSFER'] });

  it('a steel beam in a SELECTED group is still excluded — the whole point', () => {
    expect(matchesFilter(inGroup, { groups: ['TRANSFER'] })).toBe(true);          // union alone lets it in
    expect(matchesFilter(inGroup, { groups: ['TRANSFER'], ...concreteOnly })).toBe(false);
  });

  it('a steel beam whose SECTION was explicitly picked is still excluded', () => {
    expect(matchesFilter(beam('W18X50'), { sections: ['W18X50'] })).toBe(true);
    expect(matchesFilter(beam('W18X50'), { sections: ['W18X50'], ...concreteOnly })).toBe(false);
  });

  it('a concrete beam must still satisfy the union it was already subject to', () => {
    // Material widens nothing: it can only ever remove beams.
    expect(matchesFilter(beam('B12X24'), { sections: ['B14X28'], ...concreteOnly })).toBe(false);
    expect(matchesFilter(beam('B12X24'), { sections: ['B12X24'], ...concreteOnly })).toBe(true);
  });

  it('and it still ANDs with storey', () => {
    expect(matchesFilter(beam('B12X24', { story: 'L9' }), { stories: ['L2'], ...concreteOnly })).toBe(false);
  });
});

describe('the scope reaches a real connection, not just the predicate', () => {
  it('MockConnection.getBeams honours it — pretend B14X28 is a steel section', async () => {
    const { MockConnection } = await import('../mock');
    const conn = new MockConnection();
    await conn.connect();

    const all = await conn.getBeams({});
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map(b => b.section))).toEqual(new Set(['B14X28', 'B12X24']));

    // The map is the caller's to supply, so the test can say what each section is made
    // of without touching the fixture.
    const kept = await conn.getBeams({
      materials: ['4000Psi'],
      sectionMaterials: { B12X24: '4000Psi', B14X28: 'A992Fy50' },
    });
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(all.length);
    expect(kept.every(b => b.section === 'B12X24')).toBe(true);
  });
});
