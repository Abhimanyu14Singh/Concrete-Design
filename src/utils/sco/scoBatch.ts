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
 * Writer selection by design code — BOTH are S-Concrete 2026.0, Member Type 2:
 *  • ACI 318 beams → buildAciBeamSco   (templates/aciBeam.sco, imperial, Codes 18)
 *  • EN 1992 beams → buildEc2BeamSco   (templates/ec2Beam.sco, SI, Codes 14)
 * EC2 per-member files handle crack width in-file; the per-group envelope splits it
 * into a ULS set and a separate crack set (see buildGroupEnvelopeScoFiles).
 *
 * Beam force mapping: Nf = Pu, Tf = Tu, **Vfz = Vu**, and Mfy = the factored moment
 * — emitted as a +M row and a −M row so BOTH faces are checked. Vfz pairs with Mfy
 * in the Sectional Loads table; Vfy/Mfz are the minor-axis pair and stay zero.
 *
 * A beam fans out to one file per distinct L/3 REGION section (cage + link spacing),
 * each carrying only the load rows whose station sits in it — see "The three L/3
 * regions" below.
 */
import { designCodeToScoHeader } from './scoWriter';
import {
  buildEc2BeamSco, buildEc2BeamScoExplicit, ec2BeamUlsRows, ec2BeamCrackRows,
} from './scoWriterEC2';
import { buildAciBeamSco, buildAciBeamScoExplicit, aciBeamUlsRows } from './scoWriterACI';
import { parseScrs, type ScrsResult } from './scrsParser';
import type { Member, DesignCode, DesignGroup, Project, LoadCase, RebarLayout, BarGroup } from '../../types';
import { beamMarkEnd } from '../curtailment';

const isEc2 = (code: DesignCode): boolean => code === 'EN1992-1-1';

/** One generated .SCO, still in memory. `memberId` is carried so results parsed back
 *  out of the .SCRS can be matched to the member that produced them. */
export interface ScoFile {
  fileName: string;
  text: string;
  memberId: string;
}

/** Every .SCO generated for one design group, batched so the group verifies together. */
export interface GroupScoBundle {
  groupId: string;
  groupLabel: string;
  files: ScoFile[];
}

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, '_');

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

// ── The three L/3 regions ─────────────────────────────────────────────────────
// A .SCO describes ONE prismatic section: one top cage, one bottom cage, one link
// spacing, for the whole member. A beam in this app is not that. It is three
// regions over equal thirds of the span, and BOTH the cage and the links can differ
// between them:
//
//   region      top cage                          bottom cage                links
//   ─────────── ───────────────────────────────── ────────────────────────── ─────────
//   mark end    rebar.topBars (the heavy cage)    endThirdBotBars ?? botBars tieZones[·]
//   middle ⅓    midThirdTopBars ?? topBars        rebar.botBars              tieZones[1]
//   opposite    oppositeTopBars ?? topBars        endThirdBotBars ?? botBars tieZones[·]
//
// (Mirrors MemberResults' elevation regions and curtailment.steppedMomentCapacity —
// top governs at the supports and is curtailed through mid-span; bottom governs at
// mid-span and is curtailed toward the supports.)
//
// So one file per region, carrying that region's cage, that region's link spacing,
// and only the load rows whose station falls in it. Regions that come out identical
// merge, which is what makes the common cases read properly:
//
//   uniform cage, uniform links      → 1 file  (no suffix)
//   uniform cage, 4"/8"/4" links     → 2 files (_ends, _mid)
//   curtailed top AND opposite end   → 3 files (_mark, _mid, _opp)
//
// This replaces an earlier split that keyed on link SPACING alone: it got the
// stirrups right but carried the mark-end cage into every file, so a top cage
// curtailed to 2-#9 through mid-span was still verified as 6-#9 there.

type RegionLabel = 'mark' | 'mid' | 'opp';
const REGION_ORDER: RegionLabel[] = ['mark', 'mid', 'opp'];

/** One L/3 region's section: the cage and links that actually run through it. */
interface RegionCage {
  label: RegionLabel;
  topBars: BarGroup[];
  botBars: BarGroup[];
  spacing: number;
}

/** A set of regions that share a section, plus the load rows sitting in them. */
interface RegionBucket extends Omit<RegionCage, 'label'> {
  labels: Set<RegionLabel>;
  loads: LoadCase[];
}

/** Which third of the span a station sits in (0 = start, 1 = middle, 2 = end). */
const zoneOf = (x: number, span: number): number =>
  Math.min(2, Math.max(0, Math.floor((x / span) * 3)));

/** Compact spacing tag: "4", "7.5", "150". */
const spacingTag = (s: number): string => String(Math.round(s * 100) / 100);

const barsSig = (bars: BarGroup[]): string => bars.map((b) => `${b.numBars}x${b.barSize}`).join(',');

/**
 * The three regions of ONE beam, in STATION order (index 0 = the x ≈ 0 end).
 *
 * Which physical end is the "mark" end is a property of the MEMBER, not the group:
 * `beamMarkEnd` picks the support with the greater hogging moment, so a group can
 * hold beams whose heavy end is at x = 0 and beams whose heavy end is at x = L. That
 * is why regions are resolved per member and only then bucketed — pinning "mark" to
 * the start would pair the heavier hogging demand with the LIGHTER opposite-end cage
 * on half the beams, which is unconservative and invisible in the output.
 *
 * With no station forces to judge from, `beamMarkEnd` returns null and both ends take
 * the full mark cage — the heavier one, so the fallback errs safe.
 */
function memberRegions(m: Member, rebar: RebarLayout, g?: DesignGroup): [RegionCage, RegionCage, RegionCage] | null {
  const ties = rebar.ties;
  if (!ties) return null;
  const spacingAt = (i: number): number => rebar.tieZones?.[i]?.spacing || ties.spacing;
  const pick = (bars: BarGroup[] | undefined, fallback: BarGroup[]): BarGroup[] =>
    bars && bars.length ? bars : fallback;

  const endBot = pick(g?.endThirdBotBars, rebar.botBars);
  const midTop = pick(g?.midThirdTopBars, rebar.topBars);
  const oppTop = pick(g?.oppositeTopBars, rebar.topBars);
  const markAtStart = (beamMarkEnd(m) ?? 'start') === 'start';

  const startEnd: RegionCage = markAtStart
    ? { label: 'mark', topBars: rebar.topBars, botBars: endBot, spacing: spacingAt(0) }
    : { label: 'opp', topBars: oppTop, botBars: endBot, spacing: spacingAt(0) };
  const farEnd: RegionCage = markAtStart
    ? { label: 'opp', topBars: oppTop, botBars: endBot, spacing: spacingAt(2) }
    : { label: 'mark', topBars: rebar.topBars, botBars: endBot, spacing: spacingAt(2) };

  return [
    startEnd,
    { label: 'mid', topBars: midTop, botBars: rebar.botBars, spacing: spacingAt(1) },
    farEnd,
  ];
}

/** File-name suffix for the regions a bucket covers: `_mark`, `_mid`, `_ends`, … */
function regionSuffix(labels: Set<RegionLabel>): string {
  const ordered = REGION_ORDER.filter((l) => labels.has(l));
  // Both supports, one section — the overwhelmingly common shape. "ends" says that
  // far better than "mark-opp".
  if (ordered.length === 2 && labels.has('mark') && labels.has('opp')) return '_ends';
  return `_${ordered.join('-')}`;
}

/**
 * Split a set of beams sharing one group cage into one bucket per DISTINCT region
 * section. Returns null — meaning "one file, the whole member" — when the regions
 * all come out identical, or when the beam cannot be divided: no span, no load rows,
 * or any row without a station (`x`). That last case is the hand-entered model, where
 * the app itself falls back to a single section, so the .SCO should too.
 */
function regionSplit(ms: Member[], rebar: RebarLayout, g: DesignGroup | undefined, qualify: boolean): RegionBucket[] | null {
  const byKey = new Map<string, RegionBucket>();
  for (const m of ms) {
    if (!m.span || m.span <= 0 || !m.loads.length) return null;
    const regions = memberRegions(m, rebar, g);
    if (!regions) return null;
    for (const lc of m.loads) {
      if (lc.x == null || !Number.isFinite(lc.x)) return null;
      const r = regions[zoneOf(lc.x, m.span)];
      if (!r.spacing || r.spacing <= 0) return null;
      const key = `${barsSig(r.topBars)}|${barsSig(r.botBars)}|${spacingTag(r.spacing)}`;
      let b = byKey.get(key);
      if (!b) {
        b = { labels: new Set(), topBars: r.topBars, botBars: r.botBars, spacing: r.spacing, loads: [] };
        byKey.set(key, b);
      }
      b.labels.add(r.label);
      b.loads.push(qualify ? { ...lc, label: `${m.label} / ${lc.label || lc.id}` } : lc);
    }
  }
  if (byKey.size < 2) return null;   // one section across every row → nothing to split
  // Mark end first, then mid, then the opposite end — reading order along the beam.
  const rank = (b: RegionBucket) => Math.min(...[...b.labels].map((l) => REGION_ORDER.indexOf(l)));
  return [...byKey.values()].sort((a, b) => rank(a) - rank(b));
}

/** The cage without its zone list — a single-spacing cage the writers can emit. */
function unzoned(rebar: RebarLayout): RebarLayout {
  const { tieZones: _zones, ...rest } = rebar;
  return rest;
}

/** The member as it is inside one region: that region's cage, links and rows. */
function memberInRegion(m: Member, rebar: RebarLayout, b: RegionBucket): Member {
  return {
    ...m,
    rebar: {
      ...unzoned(rebar),
      topBars: b.topBars,
      botBars: b.botBars,
      ties: { ...rebar.ties!, spacing: b.spacing },
    },
    loads: b.loads,
  };
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
    if (m.memberType !== 'beam') continue; // other member types are not S-Concrete sections
    // Zoned stirrups → one file per distinct spacing, each with its own rows.
    const zones = regionSplit([m], m.rebar, undefined, false);
    const variants = zones
      ? zones.map((z) => ({ member: memberInRegion(m, m.rebar, z), suffix: regionSuffix(z.labels) }))
      : [{ member: m, suffix: '' }];
    for (const v of variants) {
      const name = `${m.label}${v.suffix}`;
      const named = { ...v.member, label: name };
      const text = ec2 ? buildEc2BeamSco(named, project!) : buildAciBeamSco(named);
      files.push({ fileName: `${sanitize(name)}.SCO`, text, memberId: m.id });
    }
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
      // Key on member AND file name: one member can now legitimately produce
      // several files (one per stirrup zone), so deduping on memberId alone would
      // keep only the first zone and silently drop the rest.
      const key = `${f.memberId}|${f.fileName}`;
      if (seen.has(key)) continue;
      seen.add(key);
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
  /** Link spacing (in) this file checks, when the group was split by region.
   *  Undefined when one file covers the whole span. */
  zoneSpacing?: number;
  /** Which L/3 regions this file covers ('mark' | 'mid' | 'opp'), when split. */
  regions?: string[];
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

  type Meta = { memberCount: number; loadCaseCount: number; mixedSections: boolean; mixedRebar: boolean; excludedMemberIds: string[]; kind: 'uls' | 'crack' | 'single'; zoneSpacing?: number; regions?: string[] };
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
      // The region belongs in the id too — a group split by region emits several ULS
      // files, and they must not collide on one key.
      fileName: name, text, memberId: `group:${g.id}:${meta.kind}${meta.regions ? `:${meta.regions.join('-')}` : ''}`,
      groupId: g.id, groupLabel: g.label,
      memberCount: meta.memberCount, loadCaseCount: meta.loadCaseCount,
      mixedSections: meta.mixedSections, mixedRebar: meta.mixedRebar, excludedMemberIds: meta.excludedMemberIds, kind: meta.kind,
      ...(meta.zoneSpacing != null ? { zoneSpacing: meta.zoneSpacing } : {}),
      ...(meta.regions ? { regions: meta.regions } : {}),
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
      const effRebar = g.rebar ?? rep.rebar;

      // One STRENGTH file per distinct L/3 region section, each pooling only the rows
      // whose station sits in it. The split has to happen HERE, not inside
      // buildGroupScoFiles, for two reasons: the region of a row depends on its OWN
      // member's span, and which end is the mark end depends on its OWN hogging —
      // both associations are gone once the envelope has pooled the rows.
      const buckets = regionSplit(sub, effRebar, g, true);
      const variants = buckets
        ? buckets.map((z) => ({
            rebar: memberInRegion(rep, effRebar, z).rebar, loads: z.loads,
            suffix: regionSuffix(z.labels), spacing: z.spacing as number | undefined,
            regions: REGION_ORDER.filter((l) => z.labels.has(l)) as string[] | undefined,
          }))
        // No split (unzoned, or a member without a span / rows without a station).
        // Drop tieZones from the synthetic member so the generic path cannot then
        // re-split on the REPRESENTATIVE's span — the pooled rows come from members
        // whose spans differ, and that association is gone by this point.
        : [{ rebar: unzoned(effRebar), loads: poolLoads(sub), suffix: '', spacing: undefined as number | undefined, regions: undefined as string[] | undefined }];

      for (const v of variants) {
        const label = `${baseLabel}${v.suffix}`;
        const synth: Member = { ...rep, label, rebar: v.rebar, loads: v.loads };
        const meta = {
          memberCount: sub.length, mixedSections, mixedRebar, excludedMemberIds,
          ...(v.spacing != null ? { zoneSpacing: v.spacing } : {}),
          ...(v.regions ? { regions: v.regions } : {}),
        };
        if (ec2 && type === 'beam') {
          // ULS file, crack check OFF — crack width is a separate file below.
          const ulsRows = ec2BeamUlsRows(synth, 1);
          const ulsText = buildEc2BeamScoExplicit(synth, project!, { rows: ulsRows, checkCracks: false, memberName: label });
          pushFile(label, ulsText, g, { ...meta, loadCaseCount: ulsRows.length || 1, kind: 'uls' });
        } else {
          // Single envelope file (ACI beams, EC2 columns) via the generic path.
          const built = buildGroupScoFiles([synth], code, project);
          if (built.length) {
            pushFile(label, built[0].text, g, { ...meta, loadCaseCount: synth.loads.length || 1, kind: 'single' });
          }
        }
      }

      if (ec2 && type === 'beam') {
        // ONE crack-width file for the group (crack check ON), pooling EVERY
        // member's SLS quasi-permanent row. It is not split by stirrup zone —
        // crack width is a flexural SLS check and does not see the links.
        let ci = 1;
        const crackRows: string[] = [];
        for (const m of sub) { const r = ec2BeamCrackRows(m, project!, ci); crackRows.push(...r); ci += r.length; }
        if (crackRows.length) {
          const crackSynth: Member = { ...rep, label: baseLabel, rebar: effRebar, loads: poolLoads(sub) };
          const crackText = buildEc2BeamScoExplicit(crackSynth, project!, { rows: crackRows, checkCracks: true, memberName: `${baseLabel} (crack)` });
          pushFile(`${baseLabel}_crack`, crackText, g, { memberCount: sub.length, loadCaseCount: crackRows.length, mixedSections, mixedRebar, excludedMemberIds, kind: 'crack' });
        }
      }
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
