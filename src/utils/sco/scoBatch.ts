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
 *  • ACI beams → buildBeamScoText (Member Type 1).
 *  • EC2 beams → buildEc2BeamSco (S-Concrete 2026 template; see scoWriterEC2).
 *    Crack width is handled in-file (the EC2 file enables the crack check and
 *    carries the SLS quasi-permanent combo as a load row), so no separate set.
 *  • Beam: Mfy (M3) = governing factored moment, Vfy (V3) = Vu, Tf = Tu, Nf = Pu.
 */
import { buildBeamScoText, designCodeToScoHeader, type ScoLoadCase } from './scoWriter';
import {
  buildEc2BeamSco, buildEc2BeamScoExplicit, ec2BeamUlsRows, ec2BeamCrackRows,
} from './scoWriterEC2';
import { parseScrs, type ScrsResult } from './scrsParser';
import type { Member, DesignCode, DesignGroup, Project, LoadCase } from '../../types';

const isEc2 = (code: DesignCode): boolean => code === 'EN1992-1-1';

/**
 * Elastic constants for an ACI .SCO, in ksi. Only emitted when the project has
 * overridden them in settings — otherwise the writers derive Ec/Gc from f'c
 * exactly as the byte-validated reference files do, so untouched projects
 * produce byte-identical .SCO output.
 */
function elasticOverrides(m: Member): { ecKsi?: number; gcKsi?: number; esKsi?: number } {
  const { Ec, Gc, Es } = m.material;
  return {
    ...(Ec ? { ecKsi: Ec / 1000 } : {}),
    ...(Gc ? { gcKsi: Gc / 1000 } : {}),
    // 29,000 ksi is the writers' built-in default; only override a real change.
    ...(Es && Math.abs(Es - 29_000_000) > 1 ? { esKsi: Es / 1000 } : {}),
  };
}

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

/** Map a beam member's load cases onto S-Concrete Sectional Loads rows. The load
 *  label is also written to the row's Comment column so the governing case stays
 *  traceable — important for the per-group envelope file, where the rows pool
 *  every member's combos. */
/**
 * "Neglect torsion" project setting → drop Tu to 0 on every BEAM load row so no
 * torsion is written into the .SCO (S-Concrete then reports zero torsion demand
 * and skips its shear+torsion interaction). Columns are untouched; the member's
 * stored Tu is preserved — only the SCO input is stripped. Applied at both the
 * per-member and the group-envelope builders so both writer paths are covered.
 */
function stripTorsion(members: Member[], project?: Project): Member[] {
  if (!project?.ignoreTorsion) return members;
  return members.map(m => m.memberType === 'beam'
    ? { ...m, loads: m.loads.map((lc: LoadCase) => (lc.Tu ? { ...lc, Tu: 0 } : lc)) }
    : m);
}

function beamLoadCases(m: Member): ScoLoadCase[] {
  return m.loads.map((lc, i) => ({
    name: lc.label || `LC${i + 1}`,
    comment: lc.label || `LC${i + 1}`,
    P: lc.Pu ?? 0,
    M3: Math.max(Math.abs(lc.Mu_pos ?? 0), Math.abs(lc.Mu_neg ?? 0)),
    V3: lc.Vu ?? 0,
    T: lc.Tu ?? 0,
    M2: 0,
    V2: 0,
  }));
}

/**
 * Build one .SCO per member in the group, through the Member-Type-1 beam writer.
 *
 * EC2 (EN 1992-1-1): beams route to buildEc2BeamSco (which needs the project for
 * the crack-width combo) and crack width is handled in-file (no EC2
 * circular sample yet). Throws for any other code with no confirmed S-Concrete
 * header mapping.
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
  members = stripTorsion(members, project); // neglect-torsion → no Tu in the .SCO
  const files: ScoFile[] = [];
  for (const m of members) {
    if (m.memberType === 'beam') {
      const text = ec2
        ? buildEc2BeamSco(m, project!)
        : buildBeamScoText({
            memberName: m.label,
            bIn: m.section.bw ?? m.section.b,
            hIn: m.section.h,
            fcKsi: m.material.fc / 1000,
            fyKsi: m.material.fy / 1000,
            ...elasticOverrides(m),
            coverIn: m.section.coverClear,
            stirrupBar: m.rebar.ties ? barName(m.rebar.ties.barSize) : barName(m.section.stirrupDia),
            stirrupSpacingIn: m.rebar.ties?.spacing ?? 12,
            topBar: barName(m.rebar.topBars[0]?.barSize ?? m.rebar.botBars[0]?.barSize ?? 8),
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

// ── Per-group ENVELOPE files (one .SCO per design group) ──────────────────────
// The default path (collectGroupScoFiles) emits one .SCO per member. The envelope
// path emits ONE .SCO per group instead: the group's representative section/rebar
// carrying EVERY member's load cases pooled into the Sectional Loads table, so
// S-Concrete checks the single group section against the group's full force
// envelope and the batch summary reports the governing case per group. This is
// the "8 groups → 8 files" extraction workflow.

export interface GroupEnvelopeScoFile extends ScoFile {
  groupId: string;
  groupLabel: string;
  /** Number of members pooled into this single file. */
  memberCount: number;
  /** Number of Sectional Loads rows written (union of the pooled members' combos). */
  loadCaseCount: number;
  /** True when the pooled members did not all share one section — the most common
   *  section was used as the representative; the app should surface this. */
  mixedSections: boolean;
  /** True when the pooled members carry DIFFERENT rebar and the group has no
   *  unified `rebar` template — so the file used one member's bars for the whole
   *  group (per-member design that was never applied group-wide). */
  mixedRebar: boolean;
  /** Members skipped as unsupported by the writers (e.g. circular columns). */
  excludedMemberIds: string[];
  /** What the file checks: 'uls' (strength) / 'crack' (EC2 SLS crack width) /
   *  'single' (combined ULS+in-file, ACI beams & all columns). */
  kind: 'uls' | 'crack' | 'single';
}

/** Stable signature of a member's section + materials, used to find the most
 *  common ("representative") section within a design group. Optional dims are
 *  normalised to what the writers actually emit (bw → b, hf → 0, diameter → 0)
 *  so two members that produce an identical .SCO never get different signatures. */
function sectionSignature(m: Member): string {
  const s = m.section;
  return [s.type, s.b, s.h, s.bw ?? s.b, s.hf ?? 0, s.diameter ?? 0, s.coverClear,
    m.material.fc, m.material.fy].join('|');
}

/** Pick the modal-section member of a list as the group's representative (the
 *  section shared by the most members; ties resolve to first appearance). */
function pickRepresentative(ms: Member[]): Member {
  const buckets = new Map<string, Member[]>();
  for (const m of ms) {
    const k = sectionSignature(m);
    const b = buckets.get(k);
    if (b) b.push(m); else buckets.set(k, [m]);
  }
  let best = ms.slice(0, 1);
  for (const b of buckets.values()) if (b.length > best.length) best = b;
  return best[0];
}

/** Signature of a member's rebar layout — to detect a group whose members were
 *  designed with DIFFERENT bars (so the envelope's single cage doesn't represent
 *  them all). */
function rebarSignature(m: Member): string {
  const bars = (gs?: { numBars: number; barSize: number }[]) =>
    (gs ?? []).map((g) => `${g.numBars}x${g.barSize}`).join(',');
  const r = m.rebar;
  const ties = r.ties ? `${r.ties.barSize}@${r.ties.spacing}x${r.ties.legs}` : '';
  return [bars(r.topBars), bars(r.botBars), bars(r.sideBars), ties, r.tieType ?? ''].join('|');
}

/** Concatenate every member's load cases into one list, qualifying each label
 *  with its source member so the governing row stays traceable in the report. */
function poolLoads(ms: Member[]): LoadCase[] {
  const out: LoadCase[] = [];
  for (const m of ms) {
    for (const lc of m.loads) {
      out.push({ ...lc, label: `${m.label} / ${lc.label || lc.id}` });
    }
  }
  return out;
}

/**
 * Build ONE .SCO per design group: the representative section/rebar with the
 * union of every member's load cases. Groups with no S-Concrete-eligible members
 * are skipped. The synthetic member is run through `buildGroupScoFiles` so the
 * writer selection (ACI/EC2, beam/column) and the force mapping are byte-identical
 * to the per-member path — only the file is named for the group and the load rows
 * are pooled. Pass `project` so EC2 beams resolve their crack-width combo.
 */
export function buildGroupEnvelopeScoFiles(
  groups: DesignGroup[], members: Member[], code: DesignCode, project?: Project,
): GroupEnvelopeScoFile[] {
  const ec2 = isEc2(code);
  if (ec2 && !project) {
    throw new Error('EC2 .SCO export needs the project (for the crack-width combo). Pass the project.');
  }
  members = stripTorsion(members, project); // neglect-torsion → no Tu in the .SCO
  const byId = new Map(members.map((m) => [m.id, m]));
  const usedNames = new Set<string>();
  const out: GroupEnvelopeScoFile[] = [];

  type Meta = { memberCount: number; loadCaseCount: number; mixedSections: boolean; mixedRebar: boolean; excludedMemberIds: string[]; kind: 'uls' | 'crack' | 'single' };
  const pushFile = (fileBase: string, text: string, g: DesignGroup, meta: Meta) => {
    let name = `${sanitize(fileBase)}.SCO`;
    if (usedNames.has(name)) {
      const base = name.replace(/\.SCO$/i, '');
      let n = 2;
      while (usedNames.has(`${base}_${n}.SCO`)) n += 1;
      name = `${base}_${n}.SCO`;
    }
    usedNames.add(name);
    out.push({
      fileName: name, text, memberId: `group:${g.id}:${meta.kind}`,
      groupId: g.id, groupLabel: g.label,
      memberCount: meta.memberCount, loadCaseCount: meta.loadCaseCount,
      mixedSections: meta.mixedSections, mixedRebar: meta.mixedRebar, excludedMemberIds: meta.excludedMemberIds, kind: meta.kind,
    });
  };

  for (const g of groups) {
    const groupMembers = g.memberIds.map((id) => byId.get(id)).filter((m): m is Member => m != null);
    const eligible = groupMembers;
    if (!eligible.length) continue; // empty group → no file
    // Every member is a beam, so nothing is ever excluded.
    const excludedMemberIds: string[] = [];

    const types = [...new Set(eligible.map((m) => m.memberType))];
    const multiType = types.length > 1;
    for (const type of types) {
      const sub = eligible.filter((m) => m.memberType === type);
      const rep = pickRepresentative(sub);
      const mixedSections = new Set(sub.map(sectionSignature)).size > 1;
      // Members carry different bars AND the group has no unified template → the
      // file used one member's cage for all of them.
      const mixedRebar = !g.rebar && new Set(sub.map(rebarSignature)).size > 1;
      const baseLabel = `${g.label}${multiType ? (type === 'beam' ? '_beam' : '_col') : ''}`;
      const synth: Member = { ...rep, label: baseLabel, rebar: g.rebar ?? rep.rebar, loads: poolLoads(sub) };

      if (ec2 && type === 'beam') {
        // TWO SETS: a ULS file (crack check OFF) and a separate crack-width file
        // (crack check ON) that pools EVERY member's SLS quasi-permanent row — so
        // the group's crack control envelopes all members, not just the representative.
        const ulsRows = ec2BeamUlsRows(synth, 1);
        const ulsText = buildEc2BeamScoExplicit(synth, project!, { rows: ulsRows, checkCracks: false, memberName: baseLabel });
        pushFile(baseLabel, ulsText, g, { memberCount: sub.length, loadCaseCount: ulsRows.length || 1, mixedSections, mixedRebar, excludedMemberIds, kind: 'uls' });

        let ci = 1;
        const crackRows: string[] = [];
        for (const m of sub) { const r = ec2BeamCrackRows(m, project!, ci); crackRows.push(...r); ci += r.length; }
        if (crackRows.length) {
          const crackText = buildEc2BeamScoExplicit(synth, project!, { rows: crackRows, checkCracks: true, memberName: `${baseLabel} (crack)` });
          pushFile(`${baseLabel}_crack`, crackText, g, { memberCount: sub.length, loadCaseCount: crackRows.length, mixedSections, mixedRebar, excludedMemberIds, kind: 'crack' });
        }
        continue;
      }

      // Single envelope file (ACI beams/columns, EC2 columns) via the generic path.
      const built = buildGroupScoFiles([synth], code, project);
      if (!built.length) continue;
      pushFile(baseLabel, built[0].text, g, { memberCount: sub.length, loadCaseCount: synth.loads.length || 1, mixedSections, mixedRebar, excludedMemberIds, kind: 'single' });
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
