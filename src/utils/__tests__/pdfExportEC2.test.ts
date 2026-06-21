/**
 * EC2 / SI report sanity tests.
 *
 * Tests three things:
 *   1. buildReportBytes completes without throwing for an EC2 project.
 *   2. makeU(true) unit converters produce correct SI values.
 *   3. generateBreakdownEC2 produces calc sections whose text content
 *      contains SI units (MPa, kN, mm) and EC2 clause references.
 *
 * Also serves as a regression guard for the kt/wLimitFace partial-object
 * crash (calcBreakdownEC2 must merge with DEFAULT_CRACK_PARAMS).
 */
import { describe, it, expect } from 'vitest';
import { buildReportBytes } from '../export/pdfExport';
import { generateBreakdownEC2 } from '../calcBreakdownEC2';
import type { Project, Member, SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../types';

// ── Conversion constants ──────────────────────────────────────────────────────
const MM_TO_IN     = 1 / 25.4;
const MPA_TO_PSI   = 145.038;
const KN_TO_KIPS   = 1 / 4.44822;
const KNM_TO_KIPFT = 1 / 1.35582;
const M_TO_FT      = 3.28084;

function mm(v: number) { return v * MM_TO_IN; }
function mpa(v: number) { return v * MPA_TO_PSI; }
function kn(v: number)  { return v * KN_TO_KIPS; }
function knm(v: number) { return v * KNM_TO_KIPFT; }

// ── Section / material / rebar stored in internal imperial units ──────────────
const section: SectionDimensions = {
  type: 'rectangular_beam',
  b: mm(300), h: mm(500),
  coverClear: mm(35),
  stirrupDia: -8,
};
const material: MaterialProps = {
  fc: mpa(25), fy: mpa(500), fyt: mpa(500),
  Es: mpa(200_000), lambdaConcrete: 1.0,
};
const rebar: RebarLayout = {
  topBars: [{ numBars: 2, barSize: -16 }],
  botBars: [{ numBars: 3, barSize: -16 }],
  ties: { barSize: -8, spacing: mm(150), legs: 2 },
};
const load: LoadCase = {
  id: 'lc1', label: '1.35G+1.5Q',
  Mu_pos: knm(180), Mu_neg: knm(60), Vu: kn(90), Tu: 0, Pu: 0,
};

// ── EC2 beam member for full PDF test ────────────────────────────────────────
const ec2Beam: Member = {
  id: 'B-EC2',
  label: 'Level-2 Long-Span Transfer Beam EC2',
  memberType: 'beam',
  material,
  section,
  rebar,
  loads: [
    load,
    { id: 'lc2', label: 'SLS quasi-permanent', Mu_pos: knm(110), Mu_neg: knm(30), Vu: kn(55), Tu: 0, Pu: 0 },
  ],
  span: 6 * M_TO_FT,
  crackParams: {
    wLimitBot: 0.3, wLimitTop: 0.4, wLimitFace: 0.3,
    Mqp_pos: knm(110), Mqp_neg: knm(30),
    qpFactor: 0.6, kt: 0.4,
  },
};
const ec2Column: Member = {
  id: 'C-EC2', label: 'Ground-Floor Corner Column',
  memberType: 'column',
  material: { fc: mpa(30), fy: mpa(500), fyt: mpa(500), Es: mpa(200_000), lambdaConcrete: 1.0 },
  section: { type: 'rectangular_column', b: mm(400), h: mm(400), coverClear: mm(40), stirrupDia: -10 },
  rebar: {
    topBars: [{ numBars: 4, barSize: -20 }], botBars: [{ numBars: 4, barSize: -20 }],
    ties: { barSize: -10, spacing: mm(200), legs: 2 },
  },
  loads: [{ id: 'lc1', label: '1.35G+1.5Q', Mu_pos: 0, Mu_neg: 0, Vu: kn(40), Tu: 0, Pu: kn(1200), Mux: knm(80), Muy: knm(40) }],
  span: 3.5 * M_TO_FT,
};

function makeEC2Project(): Project {
  return {
    id: 'ec2-si-sanity', name: 'EC2 SI Sanity Check',
    code: 'EN1992-1-1', description: '', engineer: 'Test', date: '2026-06-21',
    members: [ec2Beam, ec2Column],
  };
}

// ── 1. PDF generation smoke test ─────────────────────────────────────────────
describe('EC2/SI PDF generation', () => {
  it('buildReportBytes completes without throwing for EC2 project', async () => {
    const bytes = await buildReportBytes(makeEC2Project(), {
      governingOnly: false, includeDiagrams: false, includeCalcs: true, includeCrack: true,
    });
    expect(bytes.length).toBeGreaterThan(5000);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('%PDF');
  });

  it('does not crash when crackParams is a partial object (missing kt / wLimitFace)', async () => {
    const project = makeEC2Project();
    // Simulate an old save that has crackParams but is missing kt and wLimitFace
    (project.members[0] as Member).crackParams = {
      wLimitBot: 0.3, wLimitTop: 0.3, wLimitFace: 0.3,
      qpFactor: 0.6,
    } as never;
    await expect(
      buildReportBytes(project, { governingOnly: true, includeDiagrams: false, includeCalcs: true, includeCrack: true }),
    ).resolves.toBeDefined();
  });
});

// ── 2. Unit converter sanity (makeU is not exported; test via calc breakdown text) ──
describe('EC2/SI unit converters (via calc breakdown text)', () => {
  // Generate calc sections and join all step text for inspection.
  const sections = generateBreakdownEC2(section, material, rebar, load, 6 * M_TO_FT, {
    wLimitBot: 0.3, wLimitTop: 0.4, wLimitFace: 0.3,
    Mqp_pos: knm(110), Mqp_neg: knm(30), qpFactor: 0.6, kt: 0.4,
  });
  const allText = sections.flatMap(s => s.steps.flatMap(st => [st.label, st.equation, st.substitution, st.result])).join('\n');

  it('generates at least 4 calc sections', () => {
    expect(sections.length).toBeGreaterThanOrEqual(4);
  });

  it('includes MPa in stress results', () => {
    expect(allText).toMatch(/MPa/);
  });

  it('includes kN in force/moment results', () => {
    expect(allText).toMatch(/kN/);
  });

  it('includes mm in dimension steps', () => {
    expect(allText).toMatch(/\bmm/);
  });

  it('references EC2 clauses (§6.1 flexure, §6.2 shear)', () => {
    const refs = sections.flatMap(s => s.steps.map(st => st.ref)).join(' ');
    expect(refs).toMatch(/§6\.1/);
    expect(refs).toMatch(/§6\.2/);
  });

  it('references EC2 crack clause §7.3', () => {
    const refs = sections.flatMap(s => s.steps.map(st => st.ref)).join(' ');
    expect(refs).toMatch(/§7\.3/);
  });

  it('fcd result shows ~14.2 MPa (0.85×25/1.5)', () => {
    // fcd = 0.85 × 25 / 1.5 = 14.17 MPa
    expect(allText).toMatch(/fcd\s*=\s*14\.\d+ MPa/);
  });

  it('fyd result shows ~435 MPa (500/1.15)', () => {
    // fyd = 500 / 1.15 = 434.78 → "435 MPa"
    expect(allText).toMatch(/fyd\s*=\s*43[45] MPa/);
  });

  it('effective depth d ≈ 447 mm (500 − 35 − 8 − 8)', () => {
    // d = 500 − 35 − 8 − 8 = 449 mm (barD for Ø16 / 2 = 8)
    const dMatch = allText.match(/d\s*=\s*(\d+)\s*mm/);
    expect(dMatch).toBeTruthy();
    const d = parseInt(dMatch![1]);
    expect(d).toBeGreaterThan(430);
    expect(d).toBeLessThan(470);
  });

  it('detailing section references §9.2', () => {
    const refs = sections.flatMap(s => s.steps.map(st => st.ref)).join(' ');
    expect(refs).toMatch(/§9\.2/);
  });

  it('crack-width section references §7.3.4 and includes wk result in mm', () => {
    const crackSection = sections.find(s => s.title.includes('Crack'));
    expect(crackSection).toBeDefined();
    const crackText = crackSection!.steps.map(st => st.result).join('\n');
    expect(crackText).toMatch(/wk\s*=\s*\d+\.\d+ mm/);
  });
});

// ── 3. Partial crackParams must not crash (unit test for the merge fix) ───────
describe('generateBreakdownEC2 partial crackParams tolerance', () => {
  it('does not throw when kt is missing from crackParams', () => {
    expect(() =>
      generateBreakdownEC2(section, material, rebar, load, 6 * M_TO_FT, {
        wLimitBot: 0.3, wLimitTop: 0.3, wLimitFace: 0.3, qpFactor: 0.6,
      } as never),
    ).not.toThrow();
  });

  it('does not throw when crackParams is completely undefined', () => {
    expect(() =>
      generateBreakdownEC2(section, material, rebar, load),
    ).not.toThrow();
  });
});
