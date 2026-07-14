/**
 * Circular-column S-Concrete .SCO writer — ported 1:1 from Column_Design_DW's
 * `_write_circular_sco_v2026` (the self-contained "from-scratch" build kept in
 * sco_writer.py). Circular columns use S-Concrete's **Version 2026.0** format
 * (Member Type 4), which is a different layout from the Version-7 file the
 * rectangular writer (scoWriter.ts) emits — booleans are numeric (1/0), the
 * Identifiers table carries Minor/ID, and the section is described by both the
 * `Bm …` and `Cm …` parameter groups plus fixed Panel/Zone tables.
 *
 * Correctness is enforced byte-for-byte against the Python output
 * (__tests__/fixtures/circularScoReference.json, generated straight from the
 * dead-code build). The Panel + Zone tables and the inactive rows 16–25 are
 * reproduced verbatim: per the Python author's note, "inactive rows 16-25 with
 * ZdbarV=0 are required for D to stay at the specified value" — S-Concrete parses
 * the circular diameter from `Cm D` only when this exact structure is present.
 *
 * Force convention (matches the rectangular writer + the Python `_lc_row`):
 * Nf = P (compression NEGATIVE), Tf = T, Vfz = V2 (strong, with Mfy=M3/Mux),
 * Vfy = V3 (weak, with Mfz=M2/Muy) — biaxial shear preserved, not collapsed.
 *
 * VALIDATION BOUNDARY: this reproduces Column_Design_DW's circular build exactly,
 * but that build was itself superseded in the Python repo by a template-
 * substitution path (against a real S-Concrete circular file we do not have).
 * The output should be confirmed against a real S-Concrete 2026 circular-column
 * run on Windows before it is trusted for design — the same boundary the EC2 and
 * beam writers carry.
 */
import { barIdx, barDia, ecKsi, f0, f1, f3, pyG, BAR_TABLE, type ScoLoadCase } from './scoWriter';

export interface CircularColumnScoParams {
  memberName: string;
  dIn: number;                 // diameter (in)
  fcKsi: number; fyKsi: number;
  /** Total longitudinal bars around the perimeter (Cm Nzcol); clamped to ≥4.
   *  Cm Nycol is derived as max(2, nBars − 1), matching the Python. */
  nBars: number;
  longBar: string; tieBar: string; tieSpacingIn: number;
  coverIn?: number;            // default 1.5
  loadCases?: ScoLoadCase[];
  luYyIn?: number; luZzIn?: number; // default 120
  fyTiesKsi?: number;          // default 60.0
}

// Panel Information (Table 17) + Zone Information (Table 42) — fixed layout copied
// verbatim from the working S-Concrete circular example (via the Python dead code).
// The inactive rows 16–25 (ZdbarV=0) are load-bearing: they keep S-Concrete from
// re-deriving the diameter, so `Cm D` is honoured. Do not "clean up" this block.
const CIRC_PANEL_ZONE =
  '@Object@S-CONCRETE Panel Information@0@\n' +
  '@Table@17@\n' +
  'Index\tActive\tPlabel\tL\tT\tX0\tY0\tAngle\tZoneNoA\tZoneNoB\tVertD\tHorzD\tCurt\tVertS\tHorzS\tHookA\tHookB\n' +
  ' 1\t1\t1\t 240\t 10\t 0\t 0\t 0\t 0\t 0\t 3\t 3\t 1\t 16\t 16\t 0\t 0\n' +
  ' 2\t1\t2\t 120\t 16\t 0\t 0\t 0\t 0\t 0\t 4\t 4\t 2\t 16\t 16\t 0\t 0\n' +
  ' 3\t0\t3\t 120\t 16\t 0\t 0\t 0\t 0\t 0\t 4\t 4\t 2\t 16\t 16\t 0\t 0\n' +
  ' 4\t0\t4\t 120\t 16\t 0\t 0\t 0\t 0\t 0\t 4\t 4\t 2\t 16\t 16\t 0\t 0\n' +
  ' 5\t0\t5\t 120\t 16\t 0\t 0\t 0\t 0\t 0\t 4\t 4\t 2\t 16\t 16\t 0\t 0\n' +
  ' 6\t0\t6\t 120\t 16\t 0\t 0\t 0\t 0\t 0\t 4\t 4\t 2\t 16\t 16\t 0\t 0\n' +
  ' 7\t0\t7\t 120\t 16\t 0\t 0\t 0\t 0\t 0\t 4\t 4\t 2\t 16\t 16\t 0\t 0\n' +
  ' 8\t0\t8\t 120\t 16\t 0\t 0\t 0\t 0\t 0\t 4\t 4\t 2\t 16\t 16\t 0\t 0\n' +
  ' 9\t0\t9\t 120\t 16\t 0\t 0\t 0\t 0\t 0\t 4\t 4\t 2\t 16\t 16\t 0\t 0\n' +
  ' 10\t0\t10\t 120\t 16\t 0\t 0\t 0\t 0\t 0\t 4\t 4\t 2\t 16\t 16\t 0\t 0\n' +
  '@EndTable@\n' +
  '@Object@S-CONCRETE Zone Information@0@\n' +
  '@Table@42@\n' +
  'Index\tActive\tZlabel\tZnbars\tZtype\tZangle\tZfill\tZsymmetric\tZdbarV\tZdbarH\tZSplice\tPanel1\tPanel2\tAnchorX\tAnchorY\tZtieS\tZSclLimit\tZCodeScl\tNbar1\tNbar2\tNbar3\tNbar4\tNbar5\tNbar6\tSbar1\tSbar2\tSbar3\tSbar4\tSbar5\tSbar6\tZdim1\tZdim2\tZdim3\tZdim4\tZdim5\tZdim6\tUseZdim1\tUseZdim2\tUseZdim3\tUseZdim4\tUseZdim5\tUseZdim6\n' +
  ' 1\t1\tA\t 0\t 1\t 0\t0\t0\t 7\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 2\t1\tB\t 0\t 1\t 180\t0\t0\t 7\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 3\t1\tA\t 0\t 1\t 0\t0\t0\t 7\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 4\t1\tA\t 0\t 1\t 0\t0\t0\t 7\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 5\t1\tB\t 0\t 1\t 270\t0\t0\t 5\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 6\t1\tB\t 0\t 1\t 90\t0\t0\t 5\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 7\t1\tC\t 0\t 1\t 180\t0\t0\t 7\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 8\t1\tC\t 0\t 1\t 180\t0\t0\t 7\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 9\t1\tA\t 0\t 1\t 0\t0\t0\t 5\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 10\t1\tB\t 0\t 3\t 180\t1\t1\t 5\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 3\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 11\t1\tC\t 0\t 1\t 270\t0\t0\t 7\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 12\t1\tC\t 0\t 1\t 90\t0\t0\t 7\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 13\t1\tA\t 0\t 1\t 0\t0\t0\t 5\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 14\t1\tB\t 0\t 2\t 0\t1\t0\t 5\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 3\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 15\t1\tC\t 0\t 1\t 270\t0\t0\t 7\t 2\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 16\t0\t\t 0\t 1\t 0\t0\t0\t 0\t 0\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 17\t0\t\t 0\t 1\t 0\t0\t0\t 0\t 0\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 18\t0\t\t 0\t 1\t 0\t0\t0\t 0\t 0\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 19\t0\t\t 0\t 1\t 0\t0\t0\t 0\t 0\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 20\t0\t\t 0\t 1\t 0\t0\t0\t 0\t 0\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 21\t0\t\t 0\t 1\t 0\t0\t0\t 0\t 0\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 22\t0\t\t 0\t 1\t 0\t0\t0\t 0\t 0\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 23\t0\t\t 0\t 1\t 0\t0\t0\t 0\t 0\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 24\t0\t\t 0\t 1\t 0\t0\t0\t 0\t 0\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  ' 25\t0\t\t 0\t 1\t 0\t0\t0\t 0\t 0\t 0\t 0\t 0\t 0\t 0\t 8\t 6\t1\t 3\t 4\t 2\t 2\t 2\t 2\t 6\t 6\t 6\t 6\t 6\t 6\t 0\t 0\t 0\t 0\t 0\t 0\t0\t0\t0\t0\t0\t0\n' +
  '@EndTable@\n';

/** Build a circular-column S-Concrete .SCO (Version 2026.0, Member Type 4). */
export function buildCircularColumnScoText(p: CircularColumnScoParams): string {
  const cover = p.coverIn ?? 1.5;
  const luYy = p.luYyIn ?? 120.0;
  const luZz = p.luZzIn ?? 120.0;
  const fyTies = p.fyTiesKsi ?? 60.0;
  const nBars = Math.max(4, p.nBars);                 // n_bars_total(circular)
  const nyVal = Math.max(2, nBars - 1);
  const dIdx = barIdx(p.longBar);
  const fcPsi = Math.trunc(p.fcKsi * 1000);
  const Ec = ecKsi(fcPsi);
  const Gc = Ec / 2.4;
  const stie2 = Math.max(4.0, Math.floor(p.tieSpacingIn * 0.6 / 2.0) * 2.0);
  const dlayer = Math.max(1.5 * barDia(p.longBar), 1.5);
  const sbm = Math.max(0.0, p.dIn - 4 * cover);

  // Python renders app-supplied dimensions with str(); JS String() matches for the
  // integer diameters / decimal covers the app produces (S-Concrete parses the
  // number regardless of a trailing ".0").
  const D = String(p.dIn);
  const CV = String(cover);
  const tieSp = f0(p.tieSpacingIn);

  // --- Identifiers (Table 2) + Parameters (Table 60) ---
  let sco =
    '@\t\n' +
    '@Object@S-CONCRETE Identifiers@\n' +
    '@Table@2@\n' +
    'Version\t2026.0\n' +
    'Minor\t.0\n' +
    'Codes\t 18\n' +
    'Bar Type\t 2\n' +
    'Member Type\t 4\n' +
    'Units\t 0\n' +
    'Orientation\t 0\n' +
    'ID\t\n' +
    '@EndTable@\n' +
    '@Object@S-CONCRETE Parameters@ 0@\n' +
    '@Table@60@\n' +
    `Codes\t 18\tUnits\t 0\tBar Type\t 2\tMaximum\t 1\tSimple\t1\tThetaIn\t 0\t` +
    `UtilNoReinf\t .05\tApplyImprfct\t0\tReducedSHorzMax\t0\t` +
    `Text10\tValue10\tText11\tValue11\t` +
    `Member Name\t${p.memberName}\tJob Number\t305SC\t` +
    `Member Type\t 4\tMember Status\t 3\tInitialize Reinf\t1\t` +
    `Report Check 1\t1\tReport Check 2\t1\tReport Check 3\t1\t` +
    `Report Check 4\t1\tReport Check 5\t1\tReport Check 6\t1\t` +
    `Report Check 7\t1\tReport Check 8\t1\tReport Check 9\t1\t` +
    `Ignore Nf\t0\tOrientation\t 0\tClosedBeams\t0\tClosed\t1\t` +
    `Bm b\t ${D}\n` +
    `Bm h\t ${D}\tBm bf\t ${D}\tBm hf\t 7\tBm IgnoreFlange\t0\t` +
    `Bm Top\t ${CV}\tBm Bottom\t ${CV}\tBm Side\t ${CV}\t` +
    `Bm CheckCracks\t1\tBm CheckBarS\t1\t` +
    `Bm Dstir\t 2\tBm Sstir\t ${tieSp}\t` +
    `Bm StirHook\t 135\tBm StirHook1\t 135\t` +
    `Bm ApplyStir\t1\tBm ShowStir\t1\t` +
    `Bm NlegsZ\t 2\tBm NlegsY\t 0\tBm NlegsZreqd\t 0\tBm DoubleStir\t0\t` +
    `Bm NbmFace\t 0\tBm DbmFace\t ${dIdx}\t` +
    `Bm SbmFace\t ${f0(sbm)}\tBm ZbmFace\t 0\t` +
    `Bm ApplyFace\t1\tBm ApplyFaceNvsM\t1\tBm NfaceCurtains\t 2\t` +
    `Bm Exposure\t 0\tBm CoatTop\t 0\tBm CoatBot\t 0\t` +
    `Bm Show2ndT\t1\n` +
    `Bm Show2ndB\t1\tBm SameDTop\t1\tBm SameDBot\t1\t` +
    `Bm dzT\t 1\tBm dzB\t 1\tBm ComputedzT\t1\tBm ComputedzB\t1\t` +
    `Bm NT(1,1)\t 2\tBm NT(1,2)\t 0\tBm NT(1,3)\t 0\tBm NT(1,4)\t 0\tBm NT(1,5)\t 0\t` +
    `Bm NT(2,1)\t 3\tBm NT(2,2)\t 0\tBm NT(2,3)\t 0\tBm NT(2,4)\t 0\tBm NT(2,5)\t 0\t` +
    `Bm NB(1,1)\t 2\tBm NB(1,2)\t 0\tBm NB(1,3)\t 0\tBm NB(1,4)\t 0\tBm NB(1,5)\t 0\t` +
    `Bm NB(2,1)\t 2\tBm NB(2,2)\t 0\tBm NB(2,3)\t 0\tBm NB(2,4)\t 0\tBm NB(2,5)\t 0\t` +
    `Bm DT(1,1)\t ${dIdx}\tBm DT(1,2)\t ${dIdx}\tBm DT(1,3)\t ${dIdx}\t` +
    `Bm DT(1,4)\t ${dIdx}\tBm DT(1,5)\t ${dIdx}\t` +
    `Bm DT(2,1)\t ${dIdx}\tBm DT(2,2)\t ${dIdx}\tBm DT(2,3)\t ${dIdx}\t` +
    `Bm DT(2,4)\t ${dIdx}\n` +
    `Bm DT(2,5)\t ${dIdx}\t` +
    `Bm DB(1,1)\t ${dIdx}\tBm DB(1,2)\t ${dIdx}\tBm DB(1,3)\t ${dIdx}\t` +
    `Bm DB(1,4)\t ${dIdx}\tBm DB(1,5)\t ${dIdx}\t` +
    `Bm DB(2,1)\t ${dIdx}\tBm DB(2,2)\t ${dIdx}\tBm DB(2,3)\t ${dIdx}\t` +
    `Bm DB(2,4)\t ${dIdx}\tBm DB(2,5)\t ${dIdx}\t` +
    `Cm bcol\t ${D}\tCm hcol\t ${D}\tCm D\t ${D}\t` +
    `Cm Cover\t ${CV}\tCm CoverInside\t ${CV}\t` +
    `Cm ApplyMinM\t1\tCm Do1Pcnt\t0\tCm NrClause\t 4\tCm HoleType\t 0\t` +
    `Cm bcolHole\t 2\tCm hcolHole\t 2\tCm DcolHole\t 2\tCm ApplySteelSect\t0\n` +
    `Cm Nzcol\t ${nBars}\tCm Nycol\t ${nyVal}\t` +
    `Cm Nface1\t ${nBars}\tCm Nface2\t ${nyVal}\t` +
    `Cm Nface1draw\t ${nBars}\tCm Nface2draw\t 0\t` +
    `Cm DVert\t ${dIdx}\tCm DVert2\t ${dIdx}\tCm DHorz\t 2\tCm DHorz2\t 2\t` +
    `Cm NClegsZ\t 2\tCm NClegsY\t 2\t` +
    `Cm TieHook\t 135\tCm CrossHook\t 135\t` +
    `Cm NLayers\t 1\tCm Apply2ndLayer\t0\tCm ApplyDiamond\t1\t` +
    `Cm TieReinf\t 1\tCm Splice\t 0\t` +
    `Cm dlayer\t ${f3(dlayer)}\tCm ComputeDlayer\t0\t` +
    `Cm Stie\t ${tieSp}\tCm Stie2\t ${f0(stie2)}\t` +
    `Cm Pitch\t ${tieSp}\tCm Pitch2\t ${f0(stie2)}\t` +
    `Cm SteelSectTable\t 2\tCm SteelSectNo\t 5\tCm SteelSectName\tW40X593       J\t` +
    `Cm WWFd\t 42.99\tCm WWFb\t 16.69\n` +
    `Cm WWFt\t 3.23\tCm WWFw\t 1.79\t` +
    `Wa CoverW\t 1.5\tWa CoverZ\t 1.5\tWa Npanels\t 0\tWa Offset\t 24\t` +
    `Wa Symmetric\t0\tWa Rectangular\t0\tWa AddWall\t1\tWa VertOut\t0\t` +
    `Wa DoNomProb\t1\tWa L2\t 24\tWa T2\t 16\tWa L3\t 30\tWa T3\t 20\t` +
    `Slender\t1\tNomStfnsSlndr\t1\tCoMomDFyy\t 8\tCoMomDFzz\t 8\t` +
    `CcvtrDFyy\t 8\tCcvtrDFzz\t 8\t` +
    `LuYY\t ${f0(luYy)}\tLuZZ\t ${f0(luZz)}\tky\t 1\tkz\t 1\tkEcIg\t .25\t` +
    `Bm hIncr\t 2\tBm bIncr\t 1\tCm hcolIncr\t 2\tCm bcolIncr\t 2\n` +
    `Cm Dincr\t 2\tCm HoleIncr\t .5\tBm bfIncr\t 4\tBm hfIncr\t .5\t` +
    `Wa Lincr\t 2\tWa Tincr\t 1\tfyIncr\t 10\tfcuIncr\t 1000\t` +
    `Bm StirIncr\t 1\tBm FaceIncr\t .5\tCm TieIncr\t 1\tCm PitchIncr\t .25\t` +
    `Wa ZoneVertSIncr\t 1\tWa ZoneTieSIncr\t 1\tWa PanelSincr\t 2\tScaleBarWidth\t1\t` +
    `fy\t ${Math.trunc(p.fyKsi)}\tfy2\t ${Math.trunc(fyTies)}\tfy3\t 65\t` +
    `Wc\t 150\tWs\t 500\tPoisson\t .2\thagg\t .75\t` +
    `Gc\t ${f3(Gc)}\tEc\t ${f3(Ec)}\tEs\t 29000\t` +
    `kIe\t .5\tkAe\t .5\tkAse\t .5\tkJe\t .5\n` +
    `MaxIter\t 25\t` +
    `fyDesMin\t 15\tfyDesMax\t 150\tfy2DesMin\t 15\tfy2DesMax\t 150\t` +
    `fy3DesMin\t 15\tfy3DesMax\t 150\tfcuDesMin\t 700\tfcuDesMax\t 15000\t` +
    `Freezefy\t1\tFreezefy2\t1\tFreezefy3\t1\tFreezefcu\t1\t` +
    `Bm Bmbovrh\t .7\tBm bmin\t 5\tBm bmax\t 400\tBm hmin\t 6\tBm hmax\t 400\t` +
    `Bm Freezeb\t0\tBm Freezeh\t0\t` +
    `Bm dbTopMin\t .5\tBm dbTopMax\t 1.375\tBm dbBotMin\t .5\tBm dbBotMax\t 1.375\t` +
    `Bm dbStirMin\t .5\tBm dbStirMax\t .75\tBm dbFaceMin\t .625\tBm dbFaceMax\t 1\t` +
    `Bm FreezeTop\t0\tBm FreezeBot\t0\tBm FreezeStir\t0\tBm FreezeFace\t0\t` +
    `Bm RhogMinT\t .004\tBm RhogMaxT\t .025\tBm RhogMinB\t .004\tBm RhogMaxB\t .025\t` +
    `Bm SclMaxTens\t 8\tBm SclMaxComp\t 8\t` +
    `Cm Colbovrh\t 1\tCm bcolmin\t 6\tCm bcolmax\t 400\n` +
    `Cm hcolmin\t 6\tCm hcolmax\t 400\tCm Dcolmin\t 6\tCm Dcolmax\t 400\t` +
    `Cm FreezeDcol\t0\tCm Freezebcol\t0\tCm Freezehcol\t0\tCm FreezeSplice\t0\t` +
    `Cm dbVertMin\t .625\tCm dbVertMax\t 2.257\tCm dbHorzMin\t .375\tCm dbHorzMax\t 1\t` +
    `Cm FreezeVert\t0\tCm FreezeHorz\t0\t` +
    `Cm RhoVmin\t 1\tCm RhoVmax\t 8\t` +
    `fcu\t ${fcPsi}\tQuick Calc\t1\tWa EDM\t0\t` +
    `Wa Duct\t 0\tWa MagVf\t0\tWa Plastic\t1\tWa EstimateG\t 0\t` +
    `Wa MfoverMr\t 25\tWa R\t 1.5\tWa GammaWy\t 1.3\tWa GammaWz\t 1.5\t` +
    `Wa GammaWpy\t 1.6\tWa GammaWpz\t 1.7\tWa hw\t 1200\n` +
    `Wa Zone\t 1\tWa Strain\t0\tWa BZDL\t .05\tWa PhiV\t .6\tWa PhiVmode\t 0\t` +
    `Cm AddSteelShear\t0\tCm WWFIconfig\t1\tCm ApplyWWFbeam\t0\t` +
    `Cm WWFbeamb\t 10\tCm WWFbeamh\t 10\tCm WWFbdincr\t .5\tCm WWFtwincr\t .125\t` +
    `Cm UseSteelTables\t1\tCm bshapemin\t 4\tCm bshapemax\t 100\t` +
    `Cm dshapemin\t 4\tCm dshapemax\t 100\tCm FreezeShape\t0\t` +
    `Wa dbPanelVertMin\t .375\tWa dbPanelVertMax\t 1.375\t` +
    `Wa dbPanelHorzMin\t .375\tWa dbPanelHorzMax\t 1.375\t` +
    `Wa FreezePanelVert\t0\tWa FreezePanelHorz\t0\t` +
    `Wa dbZoneVertMin\t .375\tWa dbZoneVertMax\t 1.375\t` +
    `Wa dbZoneHorzMin\t .375\tWa dbZoneHorzMax\t 1.375\t` +
    `Wa FreezeZoneVert\t0\tWa FreezeZoneHorz\t0\n` +
    `Wa FreezeZoneSplice\t0\t` +
    `Wa tmin1\t 4\tWa tmin2\t 4\tWa tmin3\t 4\tWa tmin4\t 4\t` +
    `Wa tmax1\t 400\tWa tmax2\t 400\tWa tmax3\t 400\tWa tmax4\t 400\t` +
    `Wa Lmin1\t 30\tWa Lmin2\t 30\tWa Lmin3\t 30\tWa Lmin4\t 30\t` +
    `Wa Lmax1\t 400\tWa Lmax2\t 400\tWa Lmax3\t 400\tWa Lmax4\t 400\t` +
    `Wa FreezeWallDim\t0\t` +
    `Wa L2minDes\t 12\tWa L2maxDes\t 400\tWa T2minDes\t 10\tWa T2maxDes\t 400\t` +
    `Wa L3minDes\t 12\tWa L3maxDes\t 400\tWa T3minDes\t 10\tWa T3maxDes\t 400\t` +
    `Wa R0\t 1.3\tWa DeltaFyy\t 3\tWa DeltaFzz\t 3\tWa Coupled\t 0\n` +
    `Wa DispMethod\t1\tWa MuoverMr\t 25\tWa duhwYY\t .007\tWa duhwZZ\t .007\t` +
    `Cohesion\t 75\tMew\t 1\tEp\t 28500\tfyzVert\t 60\tfyzHorz\t 60\tfpu\t 270\t` +
    `Bm End\t 2\tCm ApplySteelSectH\t0\tCm SteelSectNoH\t 5\t` +
    `Cm SteelSectNameH\tW40X593       J\tCm WWFd_H\t 42.99\tCm WWFb_H\t 16.69\t` +
    `Cm WWFt_H\t 3.23\tCm WWFw_H\t 1.79\tCm OrientI\t 0\n` +
    `Cm OrientH\t 90\tCm OffsetdyI\t 0\tCm OffsetdzI\t 0\t` +
    `Cm OffsetdyH\t 0\tCm OffsetdzH\t 0\tCm WWFOffsetIncr\t 1\t` +
    `Bm CheckCracksF\t1\tkIez\t .5\tCm BetaD\t .6\tPhiEffY\t 2\tPhiEffZ\t 2\t` +
    `Bm Applydlimit\t1\tBm FibreReinf\t0\t` +
    `Concrete Qty\t 323.0826\tSteel Qty\t 15.47469\t` +
    `Primary Qty\t 13.88889\tSecondary Qty\t 1.585801\tShape Qty\t 0\t` +
    `Bm SeisOption\t 0\tBm SeisLocType\t 0\tCm SeisOption\t 0\tCm SeisLocType\t 0\t` +
    `Cm SeisLwYY\t 240\tCm SeisLwZZ\t 240\t` +
    `Cm SeisThetaIDyy\t .004\tCm SeisThetaIDzz\t .004\t` +
    `Bm BondTop\t 1\tBm BondBot\t 1\tBm BondSkn\t 1\tBm CrkWdthLmt\t .012\n` +
    `LoadDuration\t 2\tCohesionC\t .2\tWa EstimateHM\t 0\t` +
    `Wa HiModFctrYY\t 1.25\tWa HiModFctrZZ\t 1.25\t` +
    `Wa PeriodTaYY\t 1\tWa PeriodTaZZ\t 1\tWa PeriodTL\t .5\tWa PeriodTU\t 1\t` +
    `MinFlexuralBhvr\t 3\tWa NumStories\t 6\t` +
    `Report Check 10\t1\tReport Check 11\t1\tReport Check 12\t1\tReport Check 13\t0\t` +
    `FRPfum\t 145\tFRPEm\t 8700\tFRPWf\t 120\tFRPkb\t 1.2\t` +
    `FRPfus\t 145\tFRPEs\t 7250\tFRPbs\t 100\t` +
    `Bm SclMinBot\t 2\tBm SclMaxBot\t 5\tBm SclMinTop\t 2\t` +
    `Bm StirSMin\t 3\tBm StirSMax\t 24\tBm SclMaxTop\t 5\t` +
    `Cm Applybovrh\t0\tBm Applybovrh\t0\n` +
    `Wa FreezeWallL1\t0\tWa FreezeWallT1\t0\tWa FreezeWallL2\t0\tWa FreezeWallT2\t0\t` +
    `Wa FreezeWallL3\t0\tWa FreezeWallT3\t0\t` +
    `Text7\tValue7\tText8\tValue8\tText9\tValue9\tText10\tValue10\tText11\tValue11\t` +
    `Text12\tValue12\tText13\tValue13\tText14\tValue14\tText15\tValue15\tText16\tValue16\t` +
    `Text17\tValue17\tText18\tValue18\tText19\tValue19\tText20\tValue20\tText21\tValue21\t` +
    `Text22\tValue22\tText23\tValue23\tText24\tValue24\tText25\tValue25\tText26\tValue26\t` +
    `Text27\tValue27\tText28\tValue28\tText29\tValue29\tText30\tValue30\n` +
    `@EndTable@\n`;

  sco += BAR_TABLE;
  sco += CIRC_PANEL_ZONE;

  // --- Sectional Loads (Table 16) — biaxial, V2=Vfz / V3=Vfy ---
  const lcRow = (i: number, P: number, T: number, V2: number, M3: number, V3: number, M2: number, comment: string): string =>
    ` ${i}\t ${f1(P)}\t ${pyG(T, 2)}\t ${f1(V2)}\t ${f1(M3)}\t 1\t ${f1(V3)}\t ${f1(M2)}\t 1\t 0\t1\t 1\t ${comment}\t0\t 1\t 1`;

  const lcs = (p.loadCases && p.loadCases.length) ? p.loadCases : [{ P: 0 } as ScoLoadCase];
  const rows = lcs.map((lc, i) =>
    lcRow(i + 1, lc.P ?? 0, lc.T ?? 0, lc.V2 ?? 0, lc.M3 ?? 0, lc.V3 ?? 0, lc.M2 ?? 0, lc.comment ?? '--'));

  sco +=
    '@Object@S-CONCRETE Sectional Loads@\n' +
    '@Table@16@\n' +
    'LC\tNf\tTf\tVfz\tMfy\tCmy\tVfy\tMfz\tCmz\tPdistr\tCheckLC\tLoad Type\tComment\tAutoGen\tSustFactor\tServLdFactor\n' +
    rows.join('\n') + '\n' +
    '@EndTable@\n' +
    '@Object@S-CONCRETE Panel Loads@\n' +
    '@Table@35@\n' +
    'LC\tCheckLC\tLoad Type\tSustFactor\tComment\tN1\tV1\tM1\tN2\tV2\tM2\tN3\tV3\tM3\tN4\tV4\tM4\tN5\tV5\tM5\tN6\tV6\tM6\tN7\tV7\tM7\tN8\tV8\tM8\tN9\tV9\tM9\tN10\tV10\tM10\n' +
    '@EndTable@\n';

  return sco;
}
