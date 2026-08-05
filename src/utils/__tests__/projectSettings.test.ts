import { describe, it, expect } from 'vitest';
import type { Member, Project, ProjectSettings } from '../../types';
import {
  applyProjectSettings, autoEc, autoEs, autoGc, coversFromSettings,
  defaultSettings, derivedModuli, settingsFromProject, withDerivedModuli,
} from '../projectSettings';
import { serializeProject, deserializeProject } from '../saveLoad';
import { buildProjectWorkbook } from '../export/excelExport';
import * as XLSX from 'xlsx';

const PSI_PER_MPA = 145.0377;

function beam(over: Partial<Member> = {}): Member {
  return {
    id: 'B1', label: 'Beam', memberType: 'beam', span: 20,
    material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 },
    section: { type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: { topBars: [{ numBars: 2, barSize: 8 }], botBars: [{ numBars: 3, barSize: 8 }], ties: { barSize: 4, spacing: 6, legs: 2 } },
    loads: [{ id: 'lc', label: '1.2D+1.6L', Mu_pos: 100, Mu_neg: 80, Vu: 40, Tu: 0, Pu: 0 }],
    ...over,
  };
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p', name: 'P', code: 'ACI318-19', description: '', engineer: '', date: '2026-01-01',
    members: [beam()],
    ...over,
  };
}

describe('code-derived elastic constants', () => {
  it('ACI Ec = 57000·√f\'c (§19.2.2.1)', () => {
    expect(autoEc(4000, 'ACI318-19')).toBeCloseTo(57000 * Math.sqrt(4000), 3);
    expect(autoEc(5000, 'ACI318-14')).toBeCloseTo(57000 * Math.sqrt(5000), 3);
  });

  it('EC2 Ecm = 22000·((fck+8)/10)^0.3 — C30 ≈ 32.8 GPa', () => {
    const ecPsi = autoEc(30 * PSI_PER_MPA, 'EN1992-1-1');
    expect(ecPsi / PSI_PER_MPA).toBeCloseTo(32837, 0);
  });

  it('Es follows the code: 29,000 ksi (ACI) vs 200 GPa (EC2)', () => {
    expect(autoEs('ACI318-19')).toBe(29_000_000);
    expect(autoEs('EN1992-1-1') / PSI_PER_MPA).toBeCloseTo(200_000, 3);
  });

  it('Gc = Ec / 2.4 (ν = 0.2)', () => {
    expect(autoGc(3_600_000)).toBeCloseTo(1_500_000, 6);
    const { Ec, Gc } = derivedModuli(4000, 'ACI318-19');
    expect(Gc).toBeCloseTo(Ec / 2.4, 6);
  });

  it('f\'c = 0 does not produce NaN moduli', () => {
    const m = derivedModuli(0, 'ACI318-19');
    expect(m.Ec).toBe(0);
    expect(m.Gc).toBe(0);
  });
});

describe('withDerivedModuli', () => {
  const base = defaultSettings('ACI318-19');

  it('re-derives when auto is on', () => {
    const next = withDerivedModuli({ ...base, fc: 8000 }, 'ACI318-19');
    expect(next.Ec).toBeCloseTo(57000 * Math.sqrt(8000), 3);
  });

  it('leaves custom values alone when auto is off', () => {
    const custom: ProjectSettings = { ...base, autoModuli: false, Ec: 1234, Gc: 567, Es: 890 };
    const next = withDerivedModuli({ ...custom, fc: 8000 }, 'ACI318-19');
    expect(next.Ec).toBe(1234);
    expect(next.Gc).toBe(567);
    expect(next.Es).toBe(890);
  });
});

describe('defaultSettings', () => {
  it('ACI starts imperial at 4 ksi / Grade 60 / 1.5" cover', () => {
    const s = defaultSettings('ACI318-19');
    expect(s.units).toBe('imperial');
    expect(s.fc).toBe(4000);
    expect(s.fy).toBe(60000);
    expect(s.coverTop).toBe(1.5);
  });

  it('EC2 starts SI at C30/37, B500, 30 mm cover and a 0.3 mm crack limit', () => {
    const s = defaultSettings('EN1992-1-1');
    expect(s.units).toBe('si');
    expect(s.fc / PSI_PER_MPA).toBeCloseTo(30, 6);
    expect(s.fy / PSI_PER_MPA).toBeCloseTo(500, 6);
    expect(s.coverTop * 25.4).toBeCloseTo(30, 6);
    expect(s.crackWidthLimit).toBe(0.3);
  });
});

describe('coversFromSettings', () => {
  it('keeps coverClear at the LARGEST face — the conservative fallback', () => {
    const s = { ...defaultSettings('ACI318-19'), coverTop: 2.5, coverBottom: 1.5, coverSide: 2.0 };
    expect(coversFromSettings(s)).toEqual({
      coverTop: 2.5, coverBottom: 1.5, coverSide: 2.0, coverClear: 2.5,
    });
  });
});

describe('applyProjectSettings', () => {
  const s: ProjectSettings = {
    ...defaultSettings('ACI318-19'),
    fc: 6000, fy: 75000, fyt: 60000, lambdaConcrete: 0.75,
    coverTop: 2, coverBottom: 1.5, coverSide: 2.5,
    crackWidthLimit: 0.2, cotTheta: 1.25, ignoreTorsion: true, displayScale: 1.25,
  };

  it('writes the standards onto EVERY member', () => {
    const p = applyProjectSettings(
      project({ members: [beam({ id: 'A' }), beam({ id: 'B', material: { fc: 3000, fy: 40000, fyt: 40000, Es: 1, lambdaConcrete: 1 } })] }),
      s,
    );
    for (const m of p.members) {
      expect(m.material.fc).toBe(6000);
      expect(m.material.fy).toBe(75000);
      expect(m.material.lambdaConcrete).toBe(0.75);
      expect(m.section.coverTop).toBe(2);
      expect(m.section.coverBottom).toBe(1.5);
      expect(m.section.coverSide).toBe(2.5);
      expect(m.section.coverClear).toBe(2.5);   // largest of the three
      expect(m.crackParams?.wLimitBot).toBe(0.2);
      expect(m.crackParams?.wLimitTop).toBe(0.2);
      expect(m.crackParams?.wLimitFace).toBe(0.2);
    }
  });

  it('re-derives the moduli from the new f\'c and stamps them on members', () => {
    const p = applyProjectSettings(project(), s);
    const expected = 57000 * Math.sqrt(6000);
    expect(p.settings!.Ec).toBeCloseTo(expected, 3);
    expect(p.members[0].material.Ec).toBeCloseTo(expected, 3);
    expect(p.members[0].material.Gc).toBeCloseTo(expected / 2.4, 3);
  });

  it('mirrors cotTheta and ignoreTorsion onto the project fields the engines read', () => {
    const p = applyProjectSettings(project(), s);
    expect(p.cotTheta).toBe(1.25);
    expect(p.ignoreTorsion).toBe(true);
  });

  it('leaves member geometry, rebar and loads untouched', () => {
    const src = project();
    const p = applyProjectSettings(src, s);
    expect(p.members[0].section.b).toBe(16);
    expect(p.members[0].section.h).toBe(24);
    expect(p.members[0].rebar).toEqual(src.members[0].rebar);
    expect(p.members[0].loads).toEqual(src.members[0].loads);
  });

  it('preserves other crack parameters the engineer tuned', () => {
    const src = project({
      members: [beam({ crackParams: { wLimitTop: 0.4, wLimitBot: 0.4, wLimitFace: 0.4, qpFactor: 0.8, kt: 0.6 } })],
    });
    const cp = applyProjectSettings(src, s).members[0].crackParams!;
    expect(cp.qpFactor).toBe(0.8);
    expect(cp.kt).toBe(0.6);
    expect(cp.wLimitBot).toBe(0.2);   // the limit itself IS overwritten
  });
});

describe('settingsFromProject — projects saved before the setup dialog', () => {
  it('reads the standards back off the first member', () => {
    const p = project({
      members: [beam({
        material: { fc: 5000, fy: 75000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 0.85 },
        section: { type: 'rectangular_beam', b: 16, h: 24, coverClear: 2, stirrupDia: 4 },
      })],
    });
    const s = settingsFromProject(p);
    expect(s.fc).toBe(5000);
    expect(s.fy).toBe(75000);
    expect(s.lambdaConcrete).toBe(0.85);
    // No per-face cover on file ⇒ all three fall back to coverClear.
    expect([s.coverTop, s.coverBottom, s.coverSide]).toEqual([2, 2, 2]);
    expect(s.autoModuli).toBe(true);
    expect(s.Ec).toBeCloseTo(57000 * Math.sqrt(5000), 3);
  });

  it('treats an explicit member Ec as an engineer override', () => {
    const p = project({
      members: [beam({ material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1, Ec: 4_000_000 } })],
    });
    const s = settingsFromProject(p);
    expect(s.autoModuli).toBe(false);
    expect(s.Ec).toBe(4_000_000);
    expect(s.Gc).toBeCloseTo(4_000_000 / 2.4, 6);
  });

  it('picks up project-level cotTheta / ignoreTorsion', () => {
    const s = settingsFromProject(project({ code: 'EN1992-1-1', cotTheta: 1.5, ignoreTorsion: true }));
    expect(s.cotTheta).toBe(1.5);
    expect(s.ignoreTorsion).toBe(true);
  });
});

describe('standards reach the outputs', () => {
  /** Flatten the Summary sheet to plain rows so we can look for the block. */
  const summaryRows = (p: Project) =>
    XLSX.utils.sheet_to_json<(string | number)[]>(
      buildProjectWorkbook(p).Sheets['Summary'], { header: 1, blankrows: false },
    );

  it('the Excel summary carries the project standards', () => {
    const p = applyProjectSettings(project(), {
      ...defaultSettings('ACI318-19'), fc: 6000, fy: 75000,
      coverTop: 2, coverBottom: 1.5, coverSide: 2.5,
    });
    const rows = summaryRows(p);
    const flat = rows.map(r => r.join('|'));
    expect(flat.some(r => r.startsWith('Design standards'))).toBe(true);
    expect(flat.some(r => r.startsWith("f'c (psi)|6000"))).toBe(true);
    expect(flat.some(r => r.startsWith('Cover top / bottom / side (in)|2|1.5|2.5'))).toBe(true);
    expect(flat.some(r => r.includes('code formula'))).toBe(true);
  });

  it('flags custom moduli and adds the EC2 rows under Eurocode', () => {
    const p = applyProjectSettings(project({ code: 'EN1992-1-1' }), {
      ...defaultSettings('EN1992-1-1'), autoModuli: false, Ec: 4_000_000, Gc: 1_600_000,
      crackWidthLimit: 0.2, cotTheta: 1.25, ignoreTorsion: true,
    });
    const flat = summaryRows(p).map(r => r.join('|'));
    expect(flat.some(r => r.includes('custom'))).toBe(true);
    expect(flat.some(r => r.startsWith('Crack limit w_max (mm)|0.2'))).toBe(true);
    expect(flat.some(r => r.startsWith('Torsion|Neglected'))).toBe(true);
  });
});

describe('save/load migration', () => {
  it('backfills settings for a file written without them, without rewriting members', () => {
    const legacy = project({
      members: [beam({
        material: { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1 },
        section: { type: 'rectangular_beam', b: 16, h: 24, coverClear: 2, stirrupDia: 4 },
      })],
    });
    const back = deserializeProject(serializeProject(legacy));
    expect(back.settings).toBeDefined();
    expect(back.settings!.fc).toBe(5000);
    expect(back.settings!.coverBottom).toBe(2);
    // Migration must not silently change anyone's design.
    expect(back.members[0].material.fc).toBe(5000);
    expect(back.members[0].section.coverClear).toBe(2);
    expect(back.members[0].section.coverTop).toBeUndefined();
  });

  it('round-trips per-face cover and Ec/Gc overrides', () => {
    const p = applyProjectSettings(
      project(),
      { ...defaultSettings('ACI318-19'), autoModuli: false, Ec: 4_100_000, Gc: 1_700_000, coverTop: 2.5, coverBottom: 1.5, coverSide: 2 },
    );
    const back = deserializeProject(serializeProject(p));
    expect(back.settings!.autoModuli).toBe(false);
    expect(back.members[0].material.Ec).toBe(4_100_000);
    expect(back.members[0].material.Gc).toBe(1_700_000);
    expect(back.members[0].section.coverTop).toBe(2.5);
    expect(back.members[0].section.coverBottom).toBe(1.5);
    expect(back.members[0].section.coverSide).toBe(2);
  });
});
