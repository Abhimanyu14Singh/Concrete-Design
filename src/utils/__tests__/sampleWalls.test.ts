/**
 * Regression tests for the sample wall members W1 and W2.
 * These guard the demo experience: W1 must design cleanly without an SBZ,
 * W2 must require an SBZ and still pass all confinement checks.
 */
import { describe, it, expect } from 'vitest';
import { designWallACI } from '../wallDesign';
import { defaultProject } from '../sampleData';
import type { Member } from '../../types';

function wallMember(id: string): Member {
  const m = defaultProject.members.find(x => x.id === id);
  if (!m) throw new Error(`Sample member ${id} not found`);
  return m;
}

describe('Sample wall W1 (Stair Core)', () => {
  const m = wallMember('W1');
  const r = designWallACI(m.section, m.material, m.wallRebar!, m.loads[0]);

  it('does not require a special boundary zone', () => {
    expect(r.sbzRequired).toBe(false);
  });

  it('passes all DCR checks', () => {
    expect(r.status).toBe('OK');
    expect(r.DCR_shear_wall).toBeLessThan(1);
    expect(r.DCR_flex_wall).toBeLessThan(1);
  });

  it('has no error-severity warnings', () => {
    expect(r.warnings.filter(w => w.severity === 'error')).toHaveLength(0);
  });
});

describe('Sample wall W2 (Elevator Core, SBZ)', () => {
  const m = wallMember('W2');
  const r = designWallACI(m.section, m.material, m.wallRebar!, m.loads[0]);

  it('requires a special boundary zone', () => {
    expect(r.sbzRequired).toBe(true);
    expect(r.sbzLength).toBeGreaterThan(0);
  });

  it('provided SBZ confinement satisfies Ash requirement (§18.10.6.4f)', () => {
    expect(r.sbzAshProvided).toBeGreaterThanOrEqual(r.sbzAshRequired!);
    expect(r.DCR_sbzAsh).toBeLessThanOrEqual(1);
  });

  it('passes shear and P-M checks', () => {
    expect(r.status).toBe('OK');
    expect(r.DCR_shear_wall).toBeLessThan(1);
    expect(r.DCR_flex_wall).toBeLessThan(1);
  });

  it('has no error-severity warnings', () => {
    expect(r.warnings.filter(w => w.severity === 'error')).toHaveLength(0);
  });

  it('finite DCRs across a moment sweep (interaction ray robustness)', () => {
    for (const Mu of [100, 1000, 5000, 9000, 12000, 20000]) {
      const res = designWallACI(m.section, m.material, m.wallRebar!, { ...m.loads[0], Mu_pos: Mu });
      expect(Number.isFinite(res.DCR_flex_wall!)).toBe(true);
    }
  });
});
