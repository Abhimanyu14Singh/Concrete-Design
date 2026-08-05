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
import { maxBarsPerLayer } from '../suggestRebar';
import { resolveCrack } from '../resolveCrack';
import { signedMomentEnvelope } from '../autoGroup';

// ── Unit conversions (app stores imperial; the EC2 file is SI) ────────────────
const IN_TO_MM = 25.4;
const PSI_TO_MPA = 1 / 145.0377;
const KIP_TO_KN = 4.448222;
const KIPFT_TO_KNM = 1.355818;
/**
 * Concrete strength (psi) → the value S-Concrete's `fcu` field wants (MPa).
 * Despite the BS-era name, S-Concrete's EN 1992 (Codes 14) files store the
 * CYLINDER strength fck in that field — NOT the cube. Confirmed from a real
 * sample: its Ec = 37277.87 MPa is exactly Ecm = 22000·((fck+8)/10)^0.3 for
 * fck = 50. If the 50 were the CUBE (⇒ fck = 40) Ecm would be 35220, which it
 * is not — so the field is the cylinder fck. Push it directly; dividing by 0.8
 * to make a "cube" over-stated the concrete by 25%.
 */
const fckPsiToMpa = (fcPsi: number): number => fcPsi * PSI_TO_MPA;

// S-Concrete renders EN-1992 (metric) .SCO files against its EUROPEAN bar list —
// NOT the "American Alternate Bars" set the sample template happens to embed — and
// it resolves each bar by its INDEX (position) in that list. So a metric bar must
// map to its position in the European table, index → Ø (mm) below.
//
// This is the EXACT "European Reinforcing Bars" table printed in a real
// S-Concrete 2026 .SCRS report — including Ø14 (index 5) and Ø28 (index 9). A
// reduced set that omitted those shifted every bar ≥ Ø16 down one step (Ø16 → Ø14,
// Ø20 → Ø16), which is what the user's section view showed.
const EC2_BAR_DIAM_MM: Record<number, number> = {
  1: 6, 2: 8, 3: 10, 4: 12, 5: 14, 6: 16, 7: 20, 8: 25, 9: 28, 10: 32, 11: 40, 12: 50,
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
  /** Governing cover, and the fallback for the three per-face covers below. */
  coverMm: number;
  /** Per-face cover (mm) — S-Concrete's EN beam file carries Bm Top / Bm Bottom
   *  / Bm Side separately, so the project's three covers go straight through.
   *  Omitted ⇒ coverMm on every face. */
  coverTopMm?: number; coverBottomMm?: number; coverSideMm?: number;
  fyMpa: number; fcuMpa: number; esMpa: number;
  /** Concrete moduli (MPa). Omitted ⇒ the template's Ecm(fck) values stand. */
  ecMpa?: number; gcMpa?: number;
  topLayers: number[]; topBarIdx: number;   // bars per stacked layer, top face
  botLayers: number[]; botBarIdx: number;   // bars per stacked layer, bottom face
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
  t = setParam(t, 'Bm Top', Math.round(p.coverTopMm ?? p.coverMm));
  t = setParam(t, 'Bm Bottom', Math.round(p.coverBottomMm ?? p.coverMm));
  t = setParam(t, 'Bm Side', Math.round(p.coverSideMm ?? p.coverMm));
  // Materials
  t = setParam(t, 'fy', r3(p.fyMpa));
  t = setParam(t, 'fy2', r3(p.fyMpa));
  t = setParam(t, 'fy3', r3(p.fyMpa));
  t = setParam(t, 'fcu', r3(p.fcuMpa));
  t = setParam(t, 'Es', r3(p.esMpa));
  if (p.ecMpa) t = setParam(t, 'Ec', r3(p.ecMpa));
  if (p.gcMpa) t = setParam(t, 'Gc', r3(p.gcMpa));
  // Longitudinal bars — distribute each face across S-Concrete's stacked layers
  // NT/NB(1,j) (j = 1..5), so a face that needs two rows (e.g. 8 bottom bars in a
  // 300 mm web → 4 + 4) is emitted with real layers instead of one crowded row.
  // Curtain 2 (N(2,j)) is unused; every populated layer takes the same bar size
  // (SameDTop/SameDBot = 1 in the template).
  const writeFace = (t0: string, N: 'NT' | 'NB', D: 'DT' | 'DB', layers: number[], barIdx: number): string => {
    let tt = t0;
    for (let j = 1; j <= 5; j++) {
      tt = setParam(tt, `Bm ${N}(1,${j})`, layers[j - 1] ?? 0);
      tt = setParam(tt, `Bm ${N}(2,${j})`, 0);
      tt = setParam(tt, `Bm ${D}(1,${j})`, barIdx);
    }
    return tt;
  };
  t = writeFace(t, 'NT', 'DT', p.topLayers, p.topBarIdx);
  t = writeFace(t, 'NB', 'DB', p.botLayers, p.botBarIdx);
  // Side / skin face bars. ApplyFace drives whether S-Concrete DESIGNS/imposes face
  // (skin) steel; the template ships it ON, so without this every beam — including a
  // shallow 300×700 that is below the EC2 §7.3.3 h ≥ 1000 mm skin threshold and
  // carries no side bars in the app — gets S-Concrete-invented face steel. Honour the
  // app's cage: enable it only when the section actually has side bars.
  t = setParam(t, 'Bm ApplyFace', p.faceCount > 0 ? 1 : 0);
  t = setParam(t, 'Bm NbmFace', p.faceCount);
  t = setParam(t, 'Bm DbmFace', p.faceBarIdx);
  // Stirrups
  t = setParam(t, 'Bm Dstir', p.stirrupBarIdx);
  t = setParam(t, 'Bm Sstir', Math.round(p.stirrupSpacingMm));
  t = setParam(t, 'Bm NlegsZ', p.stirrupLegs);
  t = setParam(t, 'Bm NlegsY', p.stirrupLegs);
  // Crack width — CheckCracks and CheckCracksF are the direct crack-width (SLS)
  // checks: off in the ULS file, on only in the SLS/crack file (both follow
  // p.checkCracks). CheckCracksF is a separate template token from CheckCracks,
  // so setParam targets it independently. (Bm CheckBarS — the §7.3.3 deemed-to-
  // satisfy spacing check — is intentionally left at the template default.)
  t = setParam(t, 'Bm CheckCracks', p.checkCracks ? 1 : 0);
  t = setParam(t, 'Bm CheckCracksF', p.checkCracks ? 1 : 0);
  t = setParam(t, 'Bm CrkWdthLmt', r3(p.crackWidthLimitMm));
  // Forces
  t = replaceSectionalLoads(t, p.rows);
  return t;
}

const sumBars = (gs: { numBars: number }[]) => gs.reduce((s, g) => s + g.numBars, 0);

/**
 * Distribute `total` bars of one face across S-Concrete's up-to-5 stacked layers
 * (NT/NB(1,j)), filling `perLayer` bars per row — so a face wider than one layer
 * holds (e.g. 8 bars in a 300 mm web → 4 + 4) is emitted as real layers instead
 * of one impossibly-crowded row. Any remainder beyond 5 layers folds into the
 * last row (a degenerate case S-Concrete will flag).
 */
export function splitLayers(total: number, perLayer: number, maxLayers = 5): number[] {
  if (total <= 0) return [0];
  const n = Math.max(1, perLayer);
  const layers: number[] = [];
  let rem = total;
  while (rem > 0 && layers.length < maxLayers) {
    const c = Math.min(rem, n);
    layers.push(c);
    rem -= c;
  }
  if (rem > 0) layers[layers.length - 1] += rem;
  return layers;
}

/** ULS sagging + hogging Sectional Loads rows for a beam, numbered from `start`. */
export function ec2BeamUlsRows(member: Member, start = 1): string[] {
  const rows: string[] = [];
  let i = start;
  for (const lc of member.loads) {
    const nf = -(lc.Pu ?? 0) * KIP_TO_KN;
    const tf = (lc.Tu ?? 0) * KIPFT_TO_KNM;
    const vfz = (lc.Vu ?? 0) * KIP_TO_KN;
    // S-Concrete My sign, matching how ETABS/the app report the two moment
    // envelopes: the Mu_pos envelope is emitted as +My and the Mu_neg envelope as
    // −My. Giving them OPPOSITE signs makes S-Concrete check the correct face for
    // each — essential once top and bottom bars differ (a same-sign pair only ever
    // checks one face).
    const mPos = Math.abs((lc.Mu_pos ?? 0) * KIPFT_TO_KNM);
    const mNeg = Math.abs((lc.Mu_neg ?? 0) * KIPFT_TO_KNM);
    rows.push(ec2LoadRow(i++, nf, tf, vfz, mPos, { comment: lc.label || `LC${i}` }));
    if (mNeg > 1e-9) rows.push(ec2LoadRow(i++, nf, tf, vfz, -mNeg, { comment: `${lc.label || 'LC'} (−My)` }));
  }
  return rows;
}

/** The SLS quasi-permanent crack-width row for a beam (the combo the user
 *  selected), numbered from `start` — empty when no crack combo resolves. Each
 *  row is tagged with the member so a pooled crack set stays traceable. */
export function ec2BeamCrackRows(member: Member, project: Project, start = 1): string[] {
  const cp = resolveCrack(member, project.code, project.slsCombo);
  if (!cp || (cp.Mqp_pos == null && cp.Mqp_neg == null)) return [];
  // Same My sign convention as the ULS rows: the Mqp_pos envelope → +My, the
  // Mqp_neg envelope → −My, so the crack check runs on the correct face.
  const mqpPos = Math.abs(cp.Mqp_pos ?? 0) * KIPFT_TO_KNM;
  const mqpNeg = Math.abs(cp.Mqp_neg ?? 0) * KIPFT_TO_KNM;
  const mqp = mqpPos >= mqpNeg ? mqpPos : -mqpNeg;
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
  // Split each face into stacked layers using the SAME per-layer capacity the
  // auto-designer uses, so the .SCO layout matches what the app drew.
  const topLayers = splitLayers(sumBars(top), maxBarsPerLayer(member, topSize));
  const botLayers = splitLayers(sumBars(bot), maxBarsPerLayer(member, botSize));
  return {
    memberName: member.label,
    webMm: (s.bw ?? s.b) * IN_TO_MM,
    depthMm: s.h * IN_TO_MM,
    flangeWidthMm: s.b * IN_TO_MM,
    flangeThkMm: (s.hf ?? 0) * IN_TO_MM,
    ignoreFlange: !isFlanged,
    coverMm: s.coverClear * IN_TO_MM,
    coverTopMm: (s.coverTop ?? s.coverClear) * IN_TO_MM,
    coverBottomMm: (s.coverBottom ?? s.coverClear) * IN_TO_MM,
    coverSideMm: (s.coverSide ?? s.coverClear) * IN_TO_MM,
    fyMpa: member.material.fy * PSI_TO_MPA,
    fcuMpa: fckPsiToMpa(member.material.fc),
    esMpa: member.material.Es * PSI_TO_MPA,
    ...(member.material.Ec ? { ecMpa: member.material.Ec * PSI_TO_MPA } : {}),
    ...(member.material.Gc ? { gcMpa: member.material.Gc * PSI_TO_MPA } : {}),
    topLayers,
    topBarIdx: barIndexEC2(topSize),
    botLayers,
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

