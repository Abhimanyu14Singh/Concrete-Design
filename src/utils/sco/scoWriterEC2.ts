/**
 * EC2 (EN 1992-1-1) beam .SCO writer — S-Concrete 2026.0 format.
 *
 * The EC2 file is a much richer format than the Version-7 ACI file emitted by
 * scoWriter.ts (full Parameters/Bar/Panel/Zone tables, SI units), and we have a
 * single real sample to work from. Rather than reproduce the whole format
 * programmatically, this writer uses that sample verbatim as a template
 * (templates/ec2Beam.sco) and injects the inputs the app actually controls —
 * section, materials, cover, stirrups, longitudinal bars, crack-width limit and
 * the load forces — leaving the remaining S-Concrete defaults untouched.
 *
 * Header (from the sample): Codes 14 (EN 1992-1-1), Units 1 (SI mm/MPa/kN),
 * Bar Type 8, Member Type 2 (beam).
 *
 * Force convention (sample Sectional Loads): Nf = axial (compression NEGATIVE),
 * Tf = torsion, Vfz = shear, Mfy = major-axis moment (sagging +, hogging −),
 * each in kN / kN·m. A beam load case is emitted as a sagging row and (when the
 * hogging moment is non-zero) a hogging row, matching the sample's two rows.
 *
 * VALIDATION BOUNDARY: the field mapping is by inspection of one sample; it must
 * be confirmed against a real S-Concrete 2026 EC2 run on Windows before the
 * output is trusted for design (the same boundary as the column repo's writers).
 */
import ec2BeamTemplate from './templates/ec2Beam.sco?raw';
import ec2ColumnTemplate from './templates/ec2Column.sco?raw';
import type { Member, Project } from '../../types';
import { getBarDiam } from '../concreteDesign';
import { resolveCrack } from '../resolveCrack';
import { signedMomentEnvelope } from '../autoGroup';

// ── Unit conversions (app stores imperial; the EC2 file is SI) ────────────────
const IN_TO_MM = 25.4;
const PSI_TO_MPA = 1 / 145.0377;
const KIP_TO_KN = 4.448222;
const KIPFT_TO_KNM = 1.355818;
/** Cylinder strength (psi) → characteristic cube strength fcu (MPa). */
const fcPsiToFcuMpa = (fcPsi: number): number => (fcPsi * PSI_TO_MPA) / 0.8;

// S-Concrete renders EN-1992 (metric) .SCO files against its EUROPEAN bar list —
// NOT the "American Alternate Bars" set the sample template happens to embed — and
// it resolves each bar by its INDEX (position) in that list. So a metric bar must
// map to its position in the European table, index → Ø (mm) below. Mapping to the
// American table instead undersized every bar by one European step (Ø10 showed as
// Ø8, Ø12 as Ø10).
//
// VALIDATION: calibrated from a real S-Concrete 2026 EN run (user screenshots) —
// Ø8 → index 2 (renders Ø8) and Ø12 → index 4 (index 3 was rendering Ø10). The
// small/common bars are confirmed; Ø16+ follow the standard reduced European set
// and should be re-checked against a Windows run before relying on them.
const EC2_BAR_DIAM_MM: Record<number, number> = {
  1: 6, 2: 8, 3: 10, 4: 12, 5: 16, 6: 20, 7: 25, 8: 32, 9: 40,
};

/** Map an app bar size (US # positive, metric Ø mm negative) to the nearest
 *  S-Concrete 2026 EUROPEAN bar-table index by diameter (EN 1992-1-1 files). */
export function barIndexEC2(barSize: number): number {
  const dMm = barSize < 0 ? -barSize : getBarDiam(barSize) * IN_TO_MM;
  let best = 4, bestErr = Infinity; // default ≈ Ø12
  for (const [idx, d] of Object.entries(EC2_BAR_DIAM_MM)) {
    const err = Math.abs(d - dMm);
    if (err < bestErr) { bestErr = err; best = +idx; }
  }
  return best;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
/** Number formatting matching the sample: ≤3 decimals, positives get a leading
 *  space, the minus sign of a negative takes that slot. */
const sp = (x: number): string => (x < 0 ? '' : ' ') + String(r3(x));

// The sample is Windows-authored (CRLF). Preserve those line endings so the file
// still loads in S-Concrete — value matches must stop at \r as well as \t/\n.
const EOL = '\r\n';

/** Replace every `Key\t value` occurrence in the template with a new value. */
function setParam(text: string, key: string, value: string | number): string {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${esc}\\t) ?[^\\t\\r\\n]*`, 'g');
  if (!re.test(text)) throw new Error(`EC2 template missing field: ${key}`);
  return text.replace(re, `$1 ${value}`);
}

const SO_HEADER =
  'LC\tNf\tTf\tVfz\tMfy\tCmy\tVfy\tMfz\tCmz\tPdistr\tCheckLC\tLoad Type\tComment\tAutoGen\tSustFactor\tServLdFactor';

interface RowOpts { vfy?: number; mfz?: number; sust?: number; comment?: string }
/** One Sectional Loads row (Table 16). Columns are biaxial, so Vfy/Mfz are
 *  populated; beams leave them 0. */
function ec2LoadRow(i: number, nf: number, tf: number, vfz: number, mfy: number, opts: RowOpts = {}): string {
  const { vfy = 0, mfz = 0, sust = 1, comment = '--' } = opts;
  return ` ${i}\t${sp(nf)}\t${sp(tf)}\t${sp(vfz)}\t${sp(mfy)}\t 1\t${sp(vfy)}\t${sp(mfz)}\t 1\t 0\t1\t 1\t${comment}\t0\t ${sp(sust).trimStart()}\t 1`;
}

function replaceSectionalLoads(text: string, rows: string[]): string {
  const tag = `@Object@S-CONCRETE Sectional Loads@${EOL}@Table@16@${EOL}`;
  const start = text.indexOf(tag);
  if (start < 0) throw new Error('EC2 template missing Sectional Loads table');
  const bodyStart = start + tag.length;
  const end = text.indexOf('@EndTable@', bodyStart);
  return text.slice(0, bodyStart) + SO_HEADER + EOL + rows.join(EOL) + EOL + text.slice(end);
}

export interface Ec2BeamScoParams {
  memberName: string;
  webMm: number; depthMm: number; flangeWidthMm: number; flangeThkMm: number; ignoreFlange: boolean;
  coverMm: number;
  fyMpa: number; fcuMpa: number; esMpa: number;
  topCount: number; topBarIdx: number;
  botCount: number; botBarIdx: number;
  faceCount: number; faceBarIdx: number;
  stirrupBarIdx: number; stirrupSpacingMm: number; stirrupLegs: number;
  crackWidthLimitMm: number;
  checkCracks: boolean; // emit the crack-width check (Bm CheckCracks 1/0)
  rows: string[]; // pre-built Sectional Loads rows
}

/** Inject EC2 beam parameters into the sample template. */
export function buildBeamScoTextEC2(p: Ec2BeamScoParams): string {
  let t = ec2BeamTemplate;
  // Header (Identifiers + Parameters tables)
  t = setParam(t, 'Codes', 14);
  t = setParam(t, 'Units', 1);
  t = setParam(t, 'Bar Type', 8);
  t = setParam(t, 'Member Type', 2);
  t = setParam(t, 'Member Name', p.memberName);
  // Section
  t = setParam(t, 'Bm b', Math.round(p.webMm));
  t = setParam(t, 'Bm h', Math.round(p.depthMm));
  t = setParam(t, 'Bm bf', Math.round(p.flangeWidthMm));
  t = setParam(t, 'Bm hf', Math.round(p.flangeThkMm));
  t = setParam(t, 'Bm IgnoreFlange', p.ignoreFlange ? 1 : 0);
  t = setParam(t, 'Bm Top', Math.round(p.coverMm));
  t = setParam(t, 'Bm Bottom', Math.round(p.coverMm));
  t = setParam(t, 'Bm Side', Math.round(p.coverMm));
  // Materials
  t = setParam(t, 'fy', r3(p.fyMpa));
  t = setParam(t, 'fy2', r3(p.fyMpa));
  t = setParam(t, 'fy3', r3(p.fyMpa));
  t = setParam(t, 'fcu', r3(p.fcuMpa));
  t = setParam(t, 'Es', r3(p.esMpa));
  // Longitudinal bars — collapse to a single position per face; zero the rest.
  t = setParam(t, 'Bm NT(1,1)', p.topCount);
  for (const c of [2, 3, 4, 5]) t = setParam(t, `Bm NT(1,${c})`, 0);
  for (const c of [1, 2, 3, 4, 5]) t = setParam(t, `Bm NT(2,${c})`, 0);
  t = setParam(t, 'Bm NB(1,1)', p.botCount);
  for (const c of [2, 3, 4, 5]) t = setParam(t, `Bm NB(1,${c})`, 0);
  for (const c of [1, 2, 3, 4, 5]) t = setParam(t, `Bm NB(2,${c})`, 0);
  t = setParam(t, 'Bm DT(1,1)', p.topBarIdx);
  t = setParam(t, 'Bm DB(1,1)', p.botBarIdx);
  // Side / skin face bars
  t = setParam(t, 'Bm NbmFace', p.faceCount);
  t = setParam(t, 'Bm DbmFace', p.faceBarIdx);
  // Stirrups
  t = setParam(t, 'Bm Dstir', p.stirrupBarIdx);
  t = setParam(t, 'Bm Sstir', Math.round(p.stirrupSpacingMm));
  t = setParam(t, 'Bm NlegsZ', p.stirrupLegs);
  t = setParam(t, 'Bm NlegsY', p.stirrupLegs);
  // Crack width
  t = setParam(t, 'Bm CheckCracks', p.checkCracks ? 1 : 0);
  t = setParam(t, 'Bm CrkWdthLmt', r3(p.crackWidthLimitMm));
  // Forces
  t = replaceSectionalLoads(t, p.rows);
  return t;
}

const sumBars = (gs: { numBars: number }[]) => gs.reduce((s, g) => s + g.numBars, 0);

/** ULS sagging + hogging Sectional Loads rows for a beam, numbered from `start`. */
export function ec2BeamUlsRows(member: Member, start = 1): string[] {
  const rows: string[] = [];
  let i = start;
  for (const lc of member.loads) {
    const nf = -(lc.Pu ?? 0) * KIP_TO_KN;
    const tf = (lc.Tu ?? 0) * KIPFT_TO_KNM;
    const vfz = (lc.Vu ?? 0) * KIP_TO_KN;
    const mPos = (lc.Mu_pos ?? 0) * KIPFT_TO_KNM;
    const mNeg = (lc.Mu_neg ?? 0) * KIPFT_TO_KNM;
    rows.push(ec2LoadRow(i++, nf, tf, vfz, mPos, { comment: lc.label || `LC${i}` }));
    if (Math.abs(mNeg) > 1e-9) rows.push(ec2LoadRow(i++, nf, tf, vfz, mNeg, { comment: `${lc.label || 'LC'} (hog)` }));
  }
  return rows;
}

/** The SLS quasi-permanent crack-width row for a beam (the combo the user
 *  selected), numbered from `start` — empty when no crack combo resolves. Each
 *  row is tagged with the member so a pooled crack set stays traceable. */
export function ec2BeamCrackRows(member: Member, project: Project, start = 1): string[] {
  const cp = resolveCrack(member, project.code, project.slsCombo);
  if (!cp || (cp.Mqp_pos == null && cp.Mqp_neg == null)) return [];
  const mqp = Math.max(Math.abs(cp.Mqp_pos ?? 0), Math.abs(cp.Mqp_neg ?? 0)) * KIPFT_TO_KNM;
  let vqp = 0;
  if (project.slsCombo && member.stationForces?.length) {
    const sf = member.stationForces.filter((c) => c.combo === project.slsCombo);
    if (sf.length) vqp = signedMomentEnvelope(sf).maxV * KIP_TO_KN;
  }
  return [ec2LoadRow(start, 0, 0, vqp, mqp, { sust: cp.qpFactor ?? 0.6, comment: `${member.label}: SLS quasi-perm (crack)` })];
}

/** Build the Sectional Loads rows for a single-file beam: ULS sagging + hogging
 *  per load case, then the SLS quasi-permanent crack-width row when one resolves. */
export function ec2BeamLoadRows(member: Member, project: Project): string[] {
  const uls = ec2BeamUlsRows(member, 1);
  const crack = ec2BeamCrackRows(member, project, uls.length + 1);
  const rows = [...uls, ...crack];
  if (!rows.length) rows.push(ec2LoadRow(1, 0, 0, 0, 0));
  return rows;
}

/** Convert an app beam Member into EC2 .SCO parameters (imperial → SI). */
export function memberToEc2BeamParams(member: Member, project: Project): Ec2BeamScoParams {
  const s = member.section;
  const isFlanged = s.type === 'T_beam' || s.type === 'L_beam';
  const top = member.rebar.topBars;
  const bot = member.rebar.botBars;
  const side = member.rebar.sideBars ?? [];
  // Longitudinal bar size per face, borrowing the OPPOSITE face before falling
  // back to a metric default — so a one-sided cage never silently degrades to a
  // bar the user never chose (the "I picked Ø12 but the .SCO shows Ø10" surprise).
  const topSize = top[0]?.barSize ?? bot[0]?.barSize ?? -16;
  const botSize = bot[0]?.barSize ?? top[0]?.barSize ?? -16;
  return {
    memberName: member.label,
    webMm: (s.bw ?? s.b) * IN_TO_MM,
    depthMm: s.h * IN_TO_MM,
    flangeWidthMm: s.b * IN_TO_MM,
    flangeThkMm: (s.hf ?? 0) * IN_TO_MM,
    ignoreFlange: !isFlanged,
    coverMm: s.coverClear * IN_TO_MM,
    fyMpa: member.material.fy * PSI_TO_MPA,
    fcuMpa: fcPsiToFcuMpa(member.material.fc),
    esMpa: member.material.Es * PSI_TO_MPA,
    topCount: sumBars(top),
    topBarIdx: barIndexEC2(topSize),
    botCount: sumBars(bot),
    botBarIdx: barIndexEC2(botSize),
    faceCount: sumBars(side),
    faceBarIdx: barIndexEC2(side[0]?.barSize ?? -12),
    stirrupBarIdx: barIndexEC2(member.rebar.ties?.barSize ?? s.stirrupDia),
    stirrupSpacingMm: (member.rebar.ties?.spacing ?? 8) * IN_TO_MM,
    stirrupLegs: member.rebar.ties?.legs ?? 2,
    crackWidthLimitMm: member.crackParams?.wLimitBot ?? 0.3,
    checkCracks: true,
    rows: ec2BeamLoadRows(member, project),
  };
}

/** Full EC2 beam .SCO text for an app member (single file: ULS + in-file crack). */
export function buildEc2BeamSco(member: Member, project: Project): string {
  return buildBeamScoTextEC2(memberToEc2BeamParams(member, project));
}

/**
 * EC2 beam .SCO with explicit Sectional Loads rows and crack-check flag — used by
 * the per-group envelope to emit a ULS set (checkCracks off) and a separate
 * crack-width set (checkCracks on) from pooled rows, instead of one combined file.
 * The section/material/rebar come from `member`; only the load rows and the
 * member name are overridden.
 */
export function buildEc2BeamScoExplicit(
  member: Member, project: Project, opts: { rows: string[]; checkCracks: boolean; memberName?: string },
): string {
  const params = memberToEc2BeamParams(member, project);
  const rows = opts.rows.length ? opts.rows : [ec2LoadRow(1, 0, 0, 0, 0)];
  return buildBeamScoTextEC2({
    ...params, rows, checkCracks: opts.checkCracks,
    ...(opts.memberName ? { memberName: opts.memberName } : {}),
  });
}

// ── EC2 columns (S-Concrete 2026, Member Type 3) ──────────────────────────────
// Same template machinery as the beam writer, but the active section is the
// `Cm …` (column) parameter group and the loads carry biaxial moments. From the
// EC2 column sample: Nzcol/Nycol are the per-face bar counts, DVert/DHorz the
// longitudinal/tie bar-table indices, NClegsZ/Y the tie legs, Stie the tie
// spacing (mm). Slender is forced OFF — the app's column engine is a short-column
// (cross-section) check on already-amplified forces, so leaving S-Concrete's
// slenderness on would double-count the moment magnification.

export interface Ec2ColumnScoParams {
  memberName: string;
  bcolMm: number; hcolMm: number; diameterMm: number;
  coverMm: number;
  fyMpa: number; fcuMpa: number; esMpa: number;
  nzcol: number; nycol: number;
  vertBarIdx: number; tieBarIdx: number;
  tieLegs: number; tieSpacingMm: number;
  rows: string[];
}

/** Inject EC2 column parameters into the column sample template. */
export function buildColumnScoTextEC2(p: Ec2ColumnScoParams): string {
  let t = ec2ColumnTemplate;
  // Header — Member Type 3 (column)
  t = setParam(t, 'Codes', 14);
  t = setParam(t, 'Units', 1);
  t = setParam(t, 'Bar Type', 8);
  t = setParam(t, 'Member Type', 3);
  t = setParam(t, 'Member Name', p.memberName);
  // Section (Cm …)
  t = setParam(t, 'Cm bcol', Math.round(p.bcolMm));
  t = setParam(t, 'Cm hcol', Math.round(p.hcolMm));
  t = setParam(t, 'Cm D', Math.round(p.diameterMm));
  t = setParam(t, 'Cm Cover', Math.round(p.coverMm));
  t = setParam(t, 'Cm CoverInside', Math.round(p.coverMm));
  // Materials
  t = setParam(t, 'fy', r3(p.fyMpa));
  t = setParam(t, 'fy2', r3(p.fyMpa));
  t = setParam(t, 'fy3', r3(p.fyMpa));
  t = setParam(t, 'fcu', r3(p.fcuMpa));
  t = setParam(t, 'Es', r3(p.esMpa));
  // Longitudinal cage + ties
  t = setParam(t, 'Cm Nzcol', p.nzcol);
  t = setParam(t, 'Cm Nycol', p.nycol);
  t = setParam(t, 'Cm Nface1', 0);   // perimeter cage only — no extra face bars
  t = setParam(t, 'Cm Nface2', 0);
  t = setParam(t, 'Cm DVert', p.vertBarIdx);
  t = setParam(t, 'Cm DVert2', p.vertBarIdx);
  t = setParam(t, 'Cm DHorz', p.tieBarIdx);
  t = setParam(t, 'Cm DHorz2', p.tieBarIdx);
  t = setParam(t, 'Cm NClegsZ', p.tieLegs);
  t = setParam(t, 'Cm NClegsY', p.tieLegs);
  t = setParam(t, 'Cm Stie', Math.round(p.tieSpacingMm));
  t = setParam(t, 'Cm Stie2', Math.round(p.tieSpacingMm));
  // Short-column check (app supplies amplified forces)
  t = setParam(t, 'Slender', 0);
  // Forces
  t = replaceSectionalLoads(t, p.rows);
  return t;
}

/** Sectional Loads rows for a column: one per load case, biaxial.
 *  Nf=-Pu, Tf=Tu, Vfz=Vu, Mfy=Mux (major), Mfz=Muy (minor); SustFactor 0.6
 *  (the sustained-load ratio S-Concrete uses for creep, per the sample). */
export function ec2ColumnLoadRows(member: Member): string[] {
  const rows: string[] = [];
  let i = 1;
  for (const lc of member.loads) {
    const nf = -(lc.Pu ?? 0) * KIP_TO_KN;
    const tf = (lc.Tu ?? 0) * KIPFT_TO_KNM;
    const vfz = (lc.Vu ?? 0) * KIP_TO_KN;
    const mfy = (lc.Mux ?? lc.Mu_pos ?? 0) * KIPFT_TO_KNM;
    const mfz = (lc.Muy ?? 0) * KIPFT_TO_KNM;
    rows.push(ec2LoadRow(i++, nf, tf, vfz, mfy, { mfz, sust: 0.6, comment: lc.label || `LC${i}` }));
  }
  if (!rows.length) rows.push(ec2LoadRow(1, 0, 0, 0, 0, { sust: 0.6 }));
  return rows;
}

/** Convert an app rectangular column Member into EC2 .SCO parameters. */
export function memberToEc2ColumnParams(member: Member): Ec2ColumnScoParams {
  const s = member.section;
  const D = s.diameter ?? s.b;
  // Per-face counts — the same inverse mapping the biaxial engine uses.
  const ny = member.rebar.topBars.reduce((sum, g) => sum + g.numBars, 0);
  const side = (member.rebar.sideBars ?? []).reduce((sum, g) => sum + g.numBars, 0);
  const nz = Math.floor(side / 2) + 2;
  return {
    memberName: member.label,
    bcolMm: s.b * IN_TO_MM,
    hcolMm: (s.h ?? s.b) * IN_TO_MM,
    diameterMm: D * IN_TO_MM,
    coverMm: s.coverClear * IN_TO_MM,
    fyMpa: member.material.fy * PSI_TO_MPA,
    fcuMpa: fcPsiToFcuMpa(member.material.fc),
    esMpa: member.material.Es * PSI_TO_MPA,
    nzcol: Math.max(2, nz),
    nycol: Math.max(2, ny),
    vertBarIdx: barIndexEC2(member.rebar.topBars[0]?.barSize ?? -16),
    tieBarIdx: barIndexEC2(member.rebar.ties?.barSize ?? s.stirrupDia),
    tieLegs: member.rebar.ties?.legs ?? 2,
    tieSpacingMm: (member.rebar.ties?.spacing ?? 12) * IN_TO_MM,
    rows: ec2ColumnLoadRows(member),
  };
}

/** Full EC2 column .SCO text for an app member (rectangular columns). */
export function buildEc2ColumnSco(member: Member): string {
  return buildColumnScoTextEC2(memberToEc2ColumnParams(member));
}
