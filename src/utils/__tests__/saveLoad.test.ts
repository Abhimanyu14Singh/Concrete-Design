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
});
