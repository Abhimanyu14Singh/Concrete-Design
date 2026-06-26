/**
 * S-Concrete batch orchestration: turn a design group's members into .SCO files
 * (with their factored forces) and parse the .SCRS batch report back into
 * per-member results. Ties scoWriter + scrsParser into the generate → run → pull
 * workflow merged from Column_Design_DW.
 *
 * The actual batch RUN (spawning S-Concrete's BatchReporter and reading the
 * .SCRS) happens in the Electron main process — see electron/sconcreteBridge.cjs.
 * This module is the pure, testable orchestration logic.
 *
 * Columns use the byte-validated rectangular-column writer (buildColumnScoText,
 * 1:1 with Column_Design_DW). Beams use the Member-Type-1 writer, which has no
 * Python reference and must be confirmed against a real S-Concrete beam file.
 *
 * Force conventions (matching the column repo's sco_writer.py `_lc_row`):
 *  • Column: P is compression-NEGATIVE (app Pu is +compression, so negated);
 *    ETABS↔S-Concrete axis pairing is M3↔Mux (V2/Z-direction) and M2↔Muy
 *    (V3/Y-direction). The app carries a single Vu, placed on V2; V3 is left 0
 *    and should be confirmed on Windows for true biaxial shear.
 *  • Beam: Mfy (M3) = governing factored moment, Vfy (V3) = Vu, Tf = Tu, Nf = Pu.
 */
import { buildBeamScoText, buildColumnScoText, designCodeToScoHeader, type ScoLoadCase } from './scoWriter';
import { parseScrs, type ScrsResult } from './scrsParser';
import type { Member, DesignCode } from '../../types';

export interface ScoFile {
  fileName: string;
  text: string;
  memberId: string;
}

const barName = (n: number): string => `#${n}`;
const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, '_');

const isColumnSection = (m: Member): boolean =>
  m.section.type === 'rectangular_column' || m.section.type === 'circular_column';

/** Map a beam member's load cases onto S-Concrete Sectional Loads rows. */
function beamLoadCases(m: Member): ScoLoadCase[] {
  return m.loads.map((lc, i) => ({
    name: lc.label || `LC${i + 1}`,
    P: lc.Pu ?? 0,
    M3: Math.max(Math.abs(lc.Mu_pos ?? 0), Math.abs(lc.Mu_neg ?? 0)),
    V3: lc.Vu ?? 0,
    T: lc.Tu ?? 0,
    M2: 0,
    V2: 0,
  }));
}

/**
 * Map a column member's load cases onto S-Concrete Sectional Loads rows.
 * P compression-negative; M3↔Mux paired with V2, M2↔Muy paired with V3.
 */
function columnLoadCases(m: Member): ScoLoadCase[] {
  return m.loads.map((lc, i) => ({
    name: lc.label || `LC${i + 1}`,
    P: -(lc.Pu ?? 0),
    M3: lc.Mux ?? lc.Mu_pos ?? 0,
    M2: lc.Muy ?? 0,
    V2: lc.Vu ?? 0,
    V3: 0,
    T: lc.Tu ?? 0,
  }));
}

/**
 * S-Concrete per-face bar counts from the app's column rebar layout — the same
 * inverse mapping the biaxial engine uses (ny = top-face bars, nz = side/2 + 2),
 * so the exported geometry matches what was analysed.
 */
function colFaceCounts(m: Member): { nz: number; ny: number } {
  const ny = m.rebar.topBars.reduce((s, g) => s + g.numBars, 0);
  const side = (m.rebar.sideBars ?? []).reduce((s, g) => s + g.numBars, 0);
  const nz = Math.floor(side / 2) + 2;
  return { nz: Math.max(2, nz), ny: Math.max(2, ny) };
}

/**
 * Build one .SCO per member in the group. Columns route through the validated
 * rectangular-column writer; beams through the Member-Type-1 writer. Circular
 * columns are skipped (S-Concrete uses a separate circular template the writer
 * does not yet emit).
 *
 * Throws when the selected design code has no confirmed S-Concrete header
 * mapping (e.g. EC2) so a wrong-code file is never emitted — surface this to the
 * user as "configure the code first".
 */
export function buildGroupScoFiles(members: Member[], code: DesignCode): ScoFile[] {
  const hdr = designCodeToScoHeader(code);
  if (!hdr) {
    throw new Error(
      `No confirmed S-Concrete .SCO mapping for design code "${code}". ` +
      `Configure the S-Concrete code header (Codes/Units/Bar Type) for this code before exporting.`,
    );
  }
  const files: ScoFile[] = [];
  for (const m of members) {
    if (isColumnSection(m)) {
      if (m.section.type === 'circular_column') continue; // rectangular template only
      const { nz, ny } = colFaceCounts(m);
      const longBar = barName(m.rebar.topBars[0] ? m.rebar.topBars[0].barSize : 8);
      const tieBar = barName(m.rebar.ties ? m.rebar.ties.barSize : m.section.stirrupDia);
      const text = buildColumnScoText({
        memberName: m.label,
        bIn: m.section.b,
        hIn: m.section.h,
        fcKsi: m.material.fc / 1000,
        fyKsi: m.material.fy / 1000,
        nzBars: nz,
        nyBars: ny,
        longBar,
        tieBar,
        tieSpacingIn: m.rebar.ties?.spacing ?? 12,
        coverIn: m.section.coverClear,
        loadCases: columnLoadCases(m),
        codeNumber: hdr.codeNumber,
        units: hdr.units,
        barType: hdr.barType,
      });
      files.push({ fileName: `${sanitize(m.label)}.SCO`, text, memberId: m.id });
      continue;
    }
    if (m.memberType === 'beam') {
      const topBar = m.rebar.topBars[0] ? barName(m.rebar.topBars[0].barSize) : '#8';
      const stirrupBar = m.rebar.ties ? barName(m.rebar.ties.barSize) : barName(m.section.stirrupDia);
      const text = buildBeamScoText({
        memberName: m.label,
        bIn: m.section.bw ?? m.section.b,
        hIn: m.section.h,
        fcKsi: m.material.fc / 1000,
        fyKsi: m.material.fy / 1000,
        coverIn: m.section.coverClear,
        stirrupBar,
        stirrupSpacingIn: m.rebar.ties?.spacing ?? 12,
        topBar,
        loadCases: beamLoadCases(m),
        codeNumber: hdr.codeNumber,
        units: hdr.units,
        barType: hdr.barType,
      });
      files.push({ fileName: `${sanitize(m.label)}.SCO`, text, memberId: m.id });
    }
    // other member types (walls) are not S-Concrete sections — skipped
  }
  return files;
}

/** Parse an S-Concrete .SCRS batch report and key the results by member name. */
export function parseBatchResults(scrsText: string): Record<string, ScrsResult> {
  const out: Record<string, ScrsResult> = {};
  for (const r of parseScrs(scrsText)) out[r.name] = r;
  return out;
}
