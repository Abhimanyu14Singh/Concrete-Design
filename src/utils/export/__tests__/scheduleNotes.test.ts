import { describe, it, expect } from 'vitest';
import { buildCurtailmentNotes } from '../schedulePdfExport';
import type { Member, DesignGroup, ComboForces } from '../../../types';

const K = 1200; // fixed-end: Mend = 100 kip-ft, mid-span = 50 kip-ft
const stations: ComboForces[] = [{
  combo: 'C1',
  stations: Array.from({ length: 9 }, (_, i) => {
    const f = i / 8;
    return { x: +(f * 20).toFixed(2), V: 0, M: +(K * (-1 / 12 + f / 2 - (f * f) / 2)).toFixed(2) };
  }),
}];

function beam(id: string): Member {
  return {
    id, label: id, memberType: 'beam',
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 },
    section: { type: 'rectangular_beam', b: 14, h: 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: { topBars: [{ numBars: 4, barSize: 8 }], botBars: [{ numBars: 4, barSize: 8 }], ties: { barSize: 4, spacing: 6, legs: 2 } },
    loads: [{ id: 'env', label: 'Env', Mu_pos: 50, Mu_neg: 100, Vu: 40, Tu: 0, Pu: 0 }],
    span: 20, stationForces: stations,
  };
}

describe('buildCurtailmentNotes — pinned L/3 notes for the schedule', () => {
  const memberById = new Map<string, Member>([['b1', beam('b1')]]);
  const cage = beam('b1').rebar;

  it('emits a note only for the faces the user pinned', () => {
    const g: DesignGroup = { id: 'g1', label: 'L2 · B14X28', memberIds: ['b1'], rebar: cage, curtailmentNotes: { bot: true } };
    const notes = buildCurtailmentNotes([g], memberById, 'ACI318-19');
    expect(notes).toHaveLength(1);
    expect(notes[0].group).toBe('L2 · B14X28');
    expect(notes[0].note.toLowerCase()).toContain('bottom');
    expect(notes[0].note).toMatch(/%/);
  });

  it('emits notes for both faces when both are pinned', () => {
    const g: DesignGroup = { id: 'g1', label: 'G', memberIds: ['b1'], rebar: cage, curtailmentNotes: { top: true, bot: true } };
    const notes = buildCurtailmentNotes([g], memberById, 'ACI318-19');
    expect(notes).toHaveLength(2);
    expect(notes.some(n => n.note.toLowerCase().includes('top'))).toBe(true);
    expect(notes.some(n => n.note.toLowerCase().includes('bottom'))).toBe(true);
  });

  it('emits nothing when no face is pinned', () => {
    const g: DesignGroup = { id: 'g1', label: 'G', memberIds: ['b1'], rebar: cage };
    expect(buildCurtailmentNotes([g], memberById, 'ACI318-19')).toHaveLength(0);
  });

  it('skips a pinned group whose members carry no station data', () => {
    const noStations = { ...beam('b2'), stationForces: undefined };
    const g: DesignGroup = { id: 'g2', label: 'G2', memberIds: ['b2'], rebar: cage, curtailmentNotes: { top: true, bot: true } };
    const notes = buildCurtailmentNotes([g], new Map([['b2', noStations]]), 'ACI318-19');
    expect(notes).toHaveLength(0);
  });
});
