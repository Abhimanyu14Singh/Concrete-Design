/**
 * ACI 318 beam .SCO writer — S-Concrete **2026.0**, imperial (Units 0).
 *
 * Built from a real S-Concrete 2026 ACI/imperial beam file
 * (templates/aciBeam.sco, saved by S-Concrete itself), the same way the EC2 writer
 * was built from a real EN 1992 file. Header from that sample:
 *
 *     Version 2026.0 · Codes 18 (ACI 318) · Units 0 (imperial) ·
 *     Bar Type 2 (US #-bars) · Member Type 2 (beam)
 *
 * WHY THIS EXISTS. The app used to emit ACI beams through `scoWriter.buildBeamScoText`,
 * which produces the legacy **Version 7** format with **Member Type 1**. The sample
 * shows S-Concrete 2026 writes ACI beams in the SAME 2026 format as EN beams, with
 * **Member Type 2** — so the old output was a different format generation AND
 * declared the wrong member type. `scoWriter.ts` keeps the V7 writer for the
 * byte-validated column file; beams now come through here.
 *
 * UNITS. The app already stores imperial internally (in, psi, kips, kip-ft), and
 * Units 0 is imperial, so this writer converts almost nothing. Confirmed from the
 * sample, which is the metric reference beam re-saved in imperial:
 *   • lengths in INCHES   — `Bm b 19.68504` (500 mm), `LuYY 118.1102` (3000 mm)
 *   • fy / Ec / Es in KSI — `fy 60`, `Ec 4286.826`, `Es 29000`
 *   • f'c in PSI          — `fcu 5000`
 *   • crack limit in IN   — `Bm CrkWdthLmt 1.181102E-02` (0.3 mm)
 *
 * VALIDATION BOUNDARY: the sample's Sectional Loads table is EMPTY, so it cannot
 * confirm the moment unit. Rows are written in kip-ft, which is what the
 * S-Concrete-calibrated column reference (Column_Design_DW) used and what the app
 * has always emitted — but kip-ft vs kip-in is the one field a real ACI batch run
 * should still be used to confirm.
 */
import aciBeamTemplate from './templates/aciBeam.sco?raw';
import type { Member } from '../../types';
import { barIdx } from './scoWriter';
import { maxBarsPerLayer } from '../suggestRebar';
import {
  buildBeamSco2026, loadRow2026, splitLayers, trimNum, type Beam2026Params,
} from './scoWriter2026';

const MM_TO_IN = 1 / 25.4;

/** Header trio for an ACI 318 / imperial / US-bar file, from the sample. */
export const ACI_2026_HEADER = { codes: 18, units: 0, barType: 2 } as const;

// Imperial values are not round numbers — a 300 mm web is 11.811" — so both
// formatters keep decimals and trim trailing zeros, matching how S-Concrete itself
// writes them (`Bm b 19.68504`).
const dimIn = (x: number): string => trimNum(x, 6);
const valIn = (x: number): string => trimNum(x, 6);

/**
 * Map an app bar size to its index in the file's US bar table. The template embeds
 * that table (index 3 = No 4, index 7 = No 8, …) and S-Concrete resolves by index,
 * which is exactly what `scoWriter.barIdx` already returns. Metric sizes (stored
 * negative) have no US index; an ACI project uses US bars, so fall back to #8.
 */
export function barIndexACI(barSize: number): number {
  return barSize < 0 ? barIdx('#8') : barIdx(`#${barSize}`);
}

const sumBars = (gs: { numBars: number }[]): number => gs.reduce((s, g) => s + g.numBars, 0);

/**
 * ULS Sectional Loads rows for a beam, numbered from `start`.
 *
 * Nf = −Pu (kips), Tf = Tu (kip-ft), Vfz = Vu (kips), Mfy = moment (kip-ft). Each
 * load case emits a sagging row and, when there is hogging, a second row with −Mfy
 * — giving the two faces OPPOSITE signs so S-Concrete checks the correct cage for
 * each. Collapsing them to one positive number only ever checks one face.
 *
 * AXIAL IS NEGATED, and it was not. S-Concrete reports axial COMPRESSION-NEGATIVE
 * — `Examples/ACI/Example 1` runs 1000 kips of compression and its report reads
 * "N = −1000.0 kips" under "Max. Axial Comp. Util." — while `LoadCase.Pu` is
 * compression-POSITIVE throughout this app (see `computeTorsion`'s Nu, and
 * `DCR_axial` vs `DCR_axial_tens`). Writing Pu straight into Nf therefore sent every
 * axially-loaded ACI beam to S-Concrete with its axial force REVERSED: a column-like
 * beam designed for compression was verified in tension, which changes M_n, V_c and
 * T_cr all at once and in the unconservative direction for compression members.
 *
 * The EC2 writer beside this one has negated from the start (`scoWriterEC2.ts`,
 * "Nf = axial (compression NEGATIVE)"); only the ACI path was missing it.
 */
export function aciBeamUlsRows(member: Member, start = 1): string[] {
  const rows: string[] = [];
  let i = start;
  for (const lc of member.loads) {
    const nf = -(lc.Pu ?? 0);
    const tf = lc.Tu ?? 0;
    const vfz = lc.Vu ?? 0;
    const mPos = Math.abs(lc.Mu_pos ?? 0);
    const mNeg = Math.abs(lc.Mu_neg ?? 0);
    const label = lc.label || `LC${i}`;
    // The sagging row goes out even at M = 0 so a shear-only station is still checked.
    rows.push(loadRow2026(i++, nf, tf, vfz, mPos, { comment: label }));
    if (mNeg > 1e-9) rows.push(loadRow2026(i++, nf, tf, vfz, -mNeg, { comment: `${label} (-M)` }));
  }
  return rows;
}

/** Convert an app beam Member into ACI 2026 .SCO parameters (imperial throughout). */
export function memberToAciBeamParams(member: Member): Beam2026Params {
  const s = member.section;
  const isFlanged = s.type === 'T_beam' || s.type === 'L_beam';
  const top = member.rebar.topBars;
  const bot = member.rebar.botBars;
  const side = member.rebar.sideBars ?? [];
  // Borrow the OPPOSITE face's bar before any default, so a one-sided cage never
  // silently degrades to a bar the user never chose.
  const topSize = top[0]?.barSize ?? bot[0]?.barSize ?? 8;
  const botSize = bot[0]?.barSize ?? top[0]?.barSize ?? 8;
  // Split each face into stacked layers using the SAME per-layer capacity the
  // auto-designer uses, so the .SCO layout matches what the app drew.
  const topLayers = splitLayers(sumBars(top), maxBarsPerLayer(member, topSize));
  const botLayers = splitLayers(sumBars(bot), maxBarsPerLayer(member, botSize));
  return {
    memberName: member.label,
    ...ACI_2026_HEADER,
    fmtDim: dimIn,
    fmtVal: valIn,

    web: s.bw ?? s.b,
    depth: s.h,
    // A T/L beam's flange is real compression area; a rectangular beam declares the
    // flange equal to the web and sets IgnoreFlange.
    flangeWidth: isFlanged ? s.b : (s.bw ?? s.b),
    flangeThk: isFlanged ? (s.hf ?? 0) : 0,
    ignoreFlange: !isFlanged,
    cover: s.coverClear,
    coverTop: s.coverTop ?? s.coverClear,
    coverBottom: s.coverBottom ?? s.coverClear,
    coverSide: s.coverSide ?? s.coverClear,

    fy: member.material.fy / 1000,            // psi → ksi
    fcu: member.material.fc,                  // psi, as the sample writes it
    es: member.material.Es / 1000,            // psi → ksi
    ...(member.material.Ec ? { ec: member.material.Ec / 1000 } : {}),
    ...(member.material.Gc ? { gc: member.material.Gc / 1000 } : {}),

    topLayers,
    topBarIdx: barIndexACI(topSize),
    botLayers,
    botBarIdx: barIndexACI(botSize),
    faceCount: sumBars(side),
    faceBarIdx: barIndexACI(side[0]?.barSize ?? botSize),

    stirrupBarIdx: barIndexACI(member.rebar.ties?.barSize ?? s.stirrupDia),
    stirrupSpacing: member.rebar.ties?.spacing ?? 12,
    stirrupLegs: member.rebar.ties?.legs ?? 2,

    // crackParams limits are stored in mm (the check is SI-native); the file wants
    // inches. The sample's own value is 0.3 mm expressed as 1.181102E-02 in, so
    // S-Concrete does run this check on an ACI file — keep it on rather than
    // guessing that ACI has no crack check.
    crackWidthLimit: (member.crackParams?.wLimitBot ?? 0.3) * MM_TO_IN,
    checkCracks: true,

    rows: [],
  };
}

/** Full ACI 2026 beam .SCO text for an app member. */
export function buildAciBeamSco(member: Member): string {
  const rows = aciBeamUlsRows(member, 1);
  return buildBeamSco2026(aciBeamTemplate, {
    ...memberToAciBeamParams(member),
    rows: rows.length ? rows : [loadRow2026(1, 0, 0, 0, 0)],
  });
}

/**
 * ACI 2026 beam .SCO with explicit Sectional Loads rows and crack-check flag — used
 * by the per-group envelope to emit a ULS set and a separate crack-width set from
 * pooled rows. Section/material/rebar come from `member`; only the rows, the crack
 * flag and the member name are overridden.
 */
export function buildAciBeamScoExplicit(
  member: Member, opts: { rows: string[]; checkCracks: boolean; memberName?: string },
): string {
  const params = memberToAciBeamParams(member);
  return buildBeamSco2026(aciBeamTemplate, {
    ...params,
    rows: opts.rows.length ? opts.rows : [loadRow2026(1, 0, 0, 0, 0)],
    checkCracks: opts.checkCracks,
    ...(opts.memberName ? { memberName: opts.memberName } : {}),
  });
}
