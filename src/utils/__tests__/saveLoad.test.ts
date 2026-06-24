import { describe, it, expect } from 'vitest';
import { serializeProject, deserializeProject } from '../saveLoad';
import { defaultProject } from '../sampleData';
import type { Project, ModelMap } from '../../types';

describe('project save/load round-trip', () => {
  it('round-trips the default project', () => {
    const json = serializeProject(defaultProject);
    const back = deserializeProject(json);
    expect(back).toEqual(defaultProject);
  });

  it('round-trips a project with modelMap and design groups', () => {
    const modelMap: ModelMap = {
      source: 'com',
      modelName: 'tower.edb',
      importedAt: new Date().toISOString(),
      stories: ['L1', 'L2'],
      frames: [{
        frameName: '101', story: 'L2', sectionName: 'B36X24',
        pt1: { x: 0, y: 0, z: 12 }, pt2: { x: 24, y: 0, z: 12 },
        memberId: defaultProject.members[0].id,
      }],
    };
    const project: Project = {
      ...defaultProject,
      modelMap,
      designGroups: [{ id: 'g1', label: 'Gravity beams', memberIds: [defaultProject.members[0].id], color: '#2563eb' }],
    };
    const back = deserializeProject(serializeProject(project));
    expect(back.modelMap).toEqual(modelMap);
    expect(back.designGroups).toHaveLength(1);
    expect(back.designGroups![0].label).toBe('Gravity beams');
  });

  it('round-trips the project-level targetDCR', () => {
    const project: Project = { ...defaultProject, targetDCR: 0.85 };
    const back = deserializeProject(serializeProject(project));
    expect(back.targetDCR).toBe(0.85);
  });

  it('rejects files that are not S-Concrete projects', () => {
    expect(() => deserializeProject('{"foo": 1}')).toThrow(/valid S-Concrete/i);
    expect(() => deserializeProject('not json at all')).toThrow();
  });

  it('migrates a legacy v1.0 file missing fields added later', () => {
    // A minimal old file: material without fyt/Es/lambdaConcrete, member without
    // memberType, rebar without sideBars, and no project-level group arrays.
    const legacy = JSON.stringify({
      _version: '1.0',
      id: 'p1', name: 'Legacy', code: 'ACI318-19', description: '', engineer: 'JS', date: '2020-01-01',
      members: [{
        id: 'm1', label: 'B1',
        material: { fc: 4000, fy: 60000 },
        section: { type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 },
        rebar: { topBars: [{ numBars: 2, barSize: 5 }], botBars: [{ numBars: 3, barSize: 6 }] },
        loads: [],
      }],
    });
    const back = deserializeProject(legacy);
    const m = back.members[0];
    expect(m.memberType).toBe('beam');          // backfilled
    expect(m.material.fyt).toBe(60000);          // falls back to fy
    expect(m.material.Es).toBe(29000000);        // backfilled
    expect(m.material.lambdaConcrete).toBe(1.0); // backfilled
    expect(m.rebar.topBars).toHaveLength(1);     // preserved
    expect(m.rebar.botBars).toHaveLength(1);     // preserved
  });

  it('preserves a custom fyt rather than overwriting with fy', () => {
    const json = JSON.stringify({
      _version: '1.0',
      id: 'p1', name: 'X', code: 'ACI318-19', description: '', engineer: '', date: '2020-01-01',
      members: [{
        id: 'm1', label: 'B1', memberType: 'beam',
        material: { fc: 4000, fy: 60000, fyt: 40000 },
        section: { type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 },
        rebar: { topBars: [], botBars: [] }, loads: [],
      }],
    });
    expect(deserializeProject(json).members[0].material.fyt).toBe(40000);
  });
});
