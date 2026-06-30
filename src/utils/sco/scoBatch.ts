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
 * Writer selection by design code:
 *  • ACI columns → buildColumnScoText (byte-validated, 1:1 with Column_Design_DW).
 *  • ACI beams   → buildBeamScoText (Member-Type-1; confirm against a real file).
 *  • EC2 beams   → buildEc2BeamSco (S-Concrete 2026 template; see scoWriterEC2).
 *    Crack width is handled in-file (the EC2 file enables the crack check and
 *    carries the SLS quasi-permanent combo as a load row), so no separate set.
 *  • EC2 columns → not supported yet (no EC2 column sample to template from).
 *
 * ACI force conventions (matching the column repo's sco_writer.py `_lc_row`):
 *  • Column: P is compression-NEGATIVE (app Pu is +compression, so negated);
 *    ETABS↔S-Concrete axis pairing is M3↔Mux (V2/Z-direction) and M2↔Muy
 *    (V3/Y-direction). The app carries a single Vu, placed on V2; V3 is left 0
 *    and should be confirmed on Windows for true biaxial shear.
 *  • Beam: Mfy (M3) = governing factored moment, Vfy (V3) = Vu, Tf = Tu, Nf = Pu.
 */
import { buildBeamScoText, buildColumnScoText, designCodeToScoHeader, type ScoLoadCase } from './scoWriter';
import { buildEc2BeamSco } from './scoWriterEC2';
import { parseScrs, type ScrsResult } from './scrsParser';
import type { Member, DesignCode, DesignGroup, Project } from '../../types';

const isEc2 = (code: DesignCode): boolean => code === 'EN1992-1-1';

export interface ScoFile {
  fileName: string;
  text: string;
  memberId: string;
}

export interface GroupScoBundle {
  groupId: string;
  groupLabel: string;
  files: ScoFile[];
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
 * EC2 (EN 1992-1-1): beams route to buildEc2BeamSco (which needs the project for
 * the crack-width combo) and crack width is handled in-file; EC2 columns are
 * skipped (no EC2 column sample yet). Throws for any other code that has no
 * confirmed S-Concrete header mapping.
 */
export function buildGroupScoFiles(members: Member[], code: DesignCode, project?: Project): ScoFile[] {
  const ec2 = isEc2(code);
  const hdr = designCodeToScoHeader(code);
  if (!hdr && !ec2) {
    throw new Error(
      `No confirmed S-Concrete .SCO mapping for design code "${code}". ` +
      `Configure the S-Concrete code header (Codes/Units/Bar Type) for this code before exporting.`,
    );
  }
  if (ec2 && !project) {
    throw new Error('EC2 .SCO export needs the project (for the crack-width combo). Pass the project.');
  }
  const files: ScoFile[] = [];
  for (const m of members) {
    if (isColumnSection(m)) {
      if (ec2) continue;                                  // EC2 column .SCO not supported yet
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
        codeNumber: hdr!.codeNumber,
        units: hdr!.units,
        barType: hdr!.barType,
      });
      files.push({ fileName: `${sanitize(m.label)}.SCO`, text, memberId: m.id });
      continue;
    }
    if (m.memberType === 'beam') {
      const text = ec2
        ? buildEc2BeamSco(m, project!)
        : buildBeamScoText({
            memberName: m.label,
            bIn: m.section.bw ?? m.section.b,
            hIn: m.section.h,
            fcKsi: m.material.fc / 1000,
            fyKsi: m.material.fy / 1000,
            coverIn: m.section.coverClear,
            stirrupBar: m.rebar.ties ? barName(m.rebar.ties.barSize) : barName(m.section.stirrupDia),
            stirrupSpacingIn: m.rebar.ties?.spacing ?? 12,
            topBar: m.rebar.topBars[0] ? barName(m.rebar.topBars[0].barSize) : '#8',
            loadCases: beamLoadCases(m),
            codeNumber: hdr!.codeNumber,
            units: hdr!.units,
            barType: hdr!.barType,
          });
      files.push({ fileName: `${sanitize(m.label)}.SCO`, text, memberId: m.id });
    }
    // other member types are not S-Concrete sections — skipped
  }
  return files;
}

/**
 * Build .SCO files for each design group the user created, resolving the group's
 * memberIds against the project members. Unknown ids are skipped; each group's
 * members route through buildGroupScoFiles (beams + rectangular columns), so
 * every member's section AND its full set of load cases/forces are emitted.
 * Pass `project` so EC2 beams can resolve their crack-width combo.
 */
export function buildScoFilesByGroup(
  groups: DesignGroup[], members: Member[], code: DesignCode, project?: Project,
): GroupScoBundle[] {
  const byId = new Map(members.map((m) => [m.id, m]));
  return groups.map((g) => {
    const groupMembers = g.memberIds
      .map((id) => byId.get(id))
      .filter((m): m is Member => m != null);
    return { groupId: g.id, groupLabel: g.label, files: buildGroupScoFiles(groupMembers, code, project) };
  });
}

/**
 * Flat, de-duplicated .SCO file list for a batch RUN scoped to the user's design
 * groups: the union of every group's S-Concrete-eligible members, with each
 * physical member exported once even if it belongs to several groups. Falls back
 * to all eligible members when no groups have been defined, so the batch still
 * works before any grouping. Pass `project` so EC2 beams resolve their crack-
 * width combo.
 */
export function collectGroupScoFiles(
  groups: DesignGroup[], members: Member[], code: DesignCode, project?: Project,
): ScoFile[] {
  if (groups.length === 0) return buildGroupScoFiles(members, code, project);
  const seen = new Set<string>();
  const out: ScoFile[] = [];
  for (const bundle of buildScoFilesByGroup(groups, members, code, project)) {
    for (const f of bundle.files) {
      if (seen.has(f.memberId)) continue;
      seen.add(f.memberId);
      out.push(f);
    }
  }
  return out;
}

/** Parse an S-Concrete .SCRS batch report and key the results by member name. */
export function parseBatchResults(scrsText: string): Record<string, ScrsResult> {
  const out: Record<string, ScrsResult> = {};
  for (const r of parseScrs(scrsText)) out[r.name] = r;
  return out;
}
