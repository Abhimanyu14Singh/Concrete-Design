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

// S-Concrete 2026 "American Alternate Bars" table — index → bar diameter (mm).
const BAR_IDX_DIAM_MM: Record<number, number> = {
  1: 6.35, 2: 9.525, 3: 12.7, 4: 15.875, 5: 19.05, 6: 22.225,
  7: 25.4, 8: 28.6512, 9: 32.258, 10: 35.814, 11: 43.0022, 12: 57.3278,
};

/** Map an app bar size (US # positive, metric Ø mm negative) to the nearest
 *  S-Concrete 2026 bar-table index by diameter. */
export function barIndex2026(barSize: number): number {
  const dMm = barSize < 0 ? -barSize : getBarDiam(barSize) * IN_TO_MM;
  let best = 7, bestErr = Infinity; // default ≈ #8
  for (const [idx, d] of Object.entries(BAR_IDX_DIAM_MM)) {
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

/** One Sectional Loads row (Table 16). */
function ec2LoadRow(i: number, nf: number, tf: number, vfz: number, mfy: number, sust = 1, comment = '--'): string {
  return ` ${i}\t${sp(nf)}\t${sp(tf)}\t${sp(vfz)}\t${sp(mfy)}\t 1\t 0\t 0\t 1\t 0\t1\t 1\t${comment}\t0\t ${sp(sust).trimStart()}\t 1`;
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
  t = setParam(t, 'Bm CheckCracks', 1);
  t = setParam(t, 'Bm CrkWdthLmt', r3(p.crackWidthLimitMm));
  // Forces
  t = replaceSectionalLoads(t, p.rows);
  return t;
}

const sumBars = (gs: { numBars: number }[]) => gs.reduce((s, g) => s + g.numBars, 0);

/** Build the Sectional Loads rows for a beam: ULS sagging + hogging per load
 *  case, then the SLS quasi-permanent crack-width row when one resolves. */
export function ec2BeamLoadRows(member: Member, project: Project): string[] {
  const rows: string[] = [];
  let i = 1;
  for (const lc of member.loads) {
    const nf = -(lc.Pu ?? 0) * KIP_TO_KN;
    const tf = (lc.Tu ?? 0) * KIPFT_TO_KNM;
    const vfz = (lc.Vu ?? 0) * KIP_TO_KN;
    const mPos = (lc.Mu_pos ?? 0) * KIPFT_TO_KNM;
    const mNeg = (lc.Mu_neg ?? 0) * KIPFT_TO_KNM;
    rows.push(ec2LoadRow(i++, nf, tf, vfz, mPos, 1, lc.label || `LC${i}`));
    if (Math.abs(mNeg) > 1e-9) rows.push(ec2LoadRow(i++, nf, tf, vfz, mNeg, 1, `${lc.label || 'LC'} (hog)`));
  }
  // SLS quasi-permanent (crack width) — the combo the user selected.
  const cp = resolveCrack(member, project.code, project.slsCombo);
  if (cp && (cp.Mqp_pos != null || cp.Mqp_neg != null)) {
    const mqp = Math.max(Math.abs(cp.Mqp_pos ?? 0), Math.abs(cp.Mqp_neg ?? 0)) * KIPFT_TO_KNM;
    let vqp = 0;
    if (project.slsCombo && member.stationForces?.length) {
      const sf = member.stationForces.filter((c) => c.combo === project.slsCombo);
      if (sf.length) vqp = signedMomentEnvelope(sf).maxV * KIP_TO_KN;
    }
    rows.push(ec2LoadRow(i, 0, 0, vqp, mqp, cp.qpFactor ?? 0.6, 'SLS quasi-perm (crack)'));
  }
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
    topBarIdx: barIndex2026(top[0]?.barSize ?? 8),
    botCount: sumBars(bot),
    botBarIdx: barIndex2026(bot[0]?.barSize ?? 8),
    faceCount: sumBars(side),
    faceBarIdx: barIndex2026(side[0]?.barSize ?? 5),
    stirrupBarIdx: barIndex2026(member.rebar.ties?.barSize ?? s.stirrupDia),
    stirrupSpacingMm: (member.rebar.ties?.spacing ?? 8) * IN_TO_MM,
    stirrupLegs: member.rebar.ties?.legs ?? 2,
    crackWidthLimitMm: member.crackParams?.wLimitBot ?? 0.3,
    rows: ec2BeamLoadRows(member, project),
  };
}

/** Full EC2 beam .SCO text for an app member. */
export function buildEc2BeamSco(member: Member, project: Project): string {
  return buildBeamScoTextEC2(memberToEc2BeamParams(member, project));
}
