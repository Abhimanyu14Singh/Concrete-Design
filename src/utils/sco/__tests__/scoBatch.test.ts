import { describe, it, expect } from 'vitest';
import { buildGroupScoFiles, parseBatchResults } from '../scoBatch';
import { buildBeamScoText } from '../scoWriter';
import type { BeamMember } from '../../../types/beam';

const beam = (id: string, label: string): BeamMember => ({
  id,
  label,
  memberType: 'beam',
  material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 },
  section: { type: 'rectangular_beam', b: 14, h: 24, coverClear: 1.5, stirrupDia: 4 },
  rebar: {
    topBars: [{ numBars: 2, barSize: 8 }],
    botBars: [{ numBars: 3, barSize: 9 }],
    ties: { barSize: 4, spacing: 6, legs: 2 },
  },
  loads: [{ id: 'LC1', label: '1.2D+1.6L', Mu_pos: 180, Mu_neg: -90, Vu: 45, Tu: 8, Pu: 0 }],
});

describe('buildBeamScoText', () => {
  it('emits Member Type 1 (beam), not 3 (column)', () => {
    const t = buildBeamScoText({
      memberName: 'B1', bIn: 14, hIn: 24, fcKsi: 4, fyKsi: 60,
      stirrupBar: '#4', stirrupSpacingIn: 6, topBar: '#8',
      forces: { M3: 180, V3: 45, T: 8 },
    });
    expect(t.includes('Member Type\t 1')).toBe(true);
    expect(t.includes('Member Type\t 3')).toBe(false);
    expect(t.includes('Member Status\t 3')).toBe(true); // unrelated token preserved
  });
});

describe('buildGroupScoFiles', () => {
  it('builds one .SCO per member with section, code, and forces embedded', () => {
    const files = buildGroupScoFiles([beam('b1', 'B1')], 'ACI318-19');
    expect(files).toHaveLength(1);
    expect(files[0].fileName).toBe('B1.SCO');
    expect(files[0].memberId).toBe('b1');
    const t = files[0].text;
    expect(t.includes('Member Type\t 1')).toBe(true);
    expect(t.includes('Codes\t 18')).toBe(true);     // ACI 318-19
    expect(t.includes('Bm b\t 14')).toBe(true);       // web width
    expect(t.includes('Bm h\t 24')).toBe(true);
    expect(t.includes(' 180.0')).toBe(true);          // governing moment max(|+180|,|-90|)
    expect(t.includes('45.0')).toBe(true);            // shear
  });

  it('sanitizes member labels into file names', () => {
    const files = buildGroupScoFiles([beam('b2', 'B 2/A')], 'ACI318-19');
    expect(files[0].fileName).toBe('B_2_A.SCO');
  });

  it('throws for a design code without a confirmed S-Concrete mapping (EC2)', () => {
    expect(() => buildGroupScoFiles([beam('b1', 'B1')], 'EN1992-1-1')).toThrow(/No confirmed S-Concrete/);
  });
});

describe('parseBatchResults', () => {
  it('keys parsed .SCRS results by member name', () => {
    const scrs = [
      'File: B1.SCO',
      '  OK',
      '  N vs M Util ...... 0.62',
      'File: B2.SCO',
      '  OVERSTRESSED',
      '  N vs M Util ...... 1.08',
    ].join('\n');
    const byName = parseBatchResults(scrs);
    expect(Object.keys(byName).sort()).toEqual(['B1', 'B2']);
    expect(byName.B1.status).toBe('OK');
    expect(byName.B2.nmUtil).toBeCloseTo(1.08, 6);
  });
});
