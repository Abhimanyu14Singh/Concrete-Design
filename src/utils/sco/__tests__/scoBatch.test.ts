import { describe, it, expect } from 'vitest';
import { buildGroupScoFiles, parseBatchResults } from '../scoBatch';
import { buildBeamScoText } from '../scoWriter';
import type { BeamMember } from '../../../types/beam';
import type { Member } from '../../../types';

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

  it('EC2 needs the project (for the crack-width combo)', () => {
    expect(() => buildGroupScoFiles([beam('b1', 'B1')], 'EN1992-1-1')).toThrow(/needs the project/);
  });

  it('EC2 beams route to the EC2 writer when the project is supplied', () => {
    const proj = { id: 'p', name: 'P', code: 'EN1992-1-1' as const, description: '', engineer: 'E', date: 'd', members: [] };
    const files = buildGroupScoFiles([beam('b1', 'B1')], 'EN1992-1-1', proj);
    expect(files).toHaveLength(1);
    expect(files[0].text).toContain('Codes\t 14');   // EN 1992-1-1 header
  });
});

const col = (id: string, label: string, over: Partial<Member['section']> = {}): Member => ({
  id,
  label,
  memberType: 'column',
  material: { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 },
  section: { type: 'rectangular_column', b: 20, h: 24, coverClear: 1.5, stirrupDia: 4, ...over },
  rebar: {
    topBars: [{ numBars: 3, barSize: 9 }],
    botBars: [{ numBars: 3, barSize: 9 }],
    sideBars: [{ numBars: 4, barSize: 9 }],  // nz = 4/2 + 2 = 4 ; ny = 3
    ties: { barSize: 4, spacing: 12, legs: 2 },
    tieType: 'tied',
  },
  loads: [{ id: 'LC1', label: '1.2D+1.6L', Mu_pos: 0, Mu_neg: 0, Vu: 30, Tu: 5, Pu: 600, Mux: 120, Muy: 80 }],
});

describe('buildGroupScoFiles — columns', () => {
  it('routes a rectangular column through the validated Type-3 writer', () => {
    const files = buildGroupScoFiles([col('c1', 'C1')], 'ACI318-19');
    expect(files).toHaveLength(1);
    expect(files[0].fileName).toBe('C1.SCO');
    const t = files[0].text;
    expect(t.includes('Member Type\t 3')).toBe(true);   // column, not beam
    expect(t.includes('Member Type\t 1')).toBe(false);
    expect(t.includes('Codes\t 18')).toBe(true);
  });

  it('embeds forces with P compression-negative and M3↔Mux, M2↔Muy', () => {
    const t = buildGroupScoFiles([col('c1', 'C1')], 'ACI318-19')[0].text;
    expect(t.includes('-600.0')).toBe(true);  // P = -Pu (compression negative)
    expect(t.includes('120.0')).toBe(true);   // M3 = Mux
    expect(t.includes('80.0')).toBe(true);    // M2 = Muy
  });

  it('skips circular columns (no rectangular template)', () => {
    const files = buildGroupScoFiles(
      [col('c2', 'C2', { type: 'circular_column', diameter: 24, b: 24, h: 24 })],
      'ACI318-19',
    );
    expect(files).toHaveLength(0);
  });

  it('handles a mixed beam + column group, one .SCO each', () => {
    const files = buildGroupScoFiles([beam('b1', 'B1'), col('c1', 'C1')], 'ACI318-19');
    expect(files.map((f) => f.fileName).sort()).toEqual(['B1.SCO', 'C1.SCO']);
    const byId = Object.fromEntries(files.map((f) => [f.memberId, f.text]));
    expect(byId.b1.includes('Member Type\t 1')).toBe(true);
    expect(byId.c1.includes('Member Type\t 3')).toBe(true);
  });

  it('skips EC2 columns (no EC2 column sample to template from yet)', () => {
    const proj = { id: 'p', name: 'P', code: 'EN1992-1-1' as const, description: '', engineer: 'E', date: 'd', members: [] };
    expect(buildGroupScoFiles([col('c1', 'C1')], 'EN1992-1-1', proj)).toEqual([]);
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
