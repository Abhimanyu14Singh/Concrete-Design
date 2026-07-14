/**
 * S-Concrete .SCO file writer — ported 1:1 from Column_Design_DW/sco_writer.py
 * (`write_column_sco` / `build_column_sco_text`), the format S-Concrete's column
 * verification files (prob_cs01–cs05) load correctly (Version 7).
 *
 * Correctness is enforced byte-for-byte against the Python output
 * (src/utils/sco/__tests__/fixtures/scoReference.json). The format is a
 * proprietary tab-delimited @Object@/@Table@ layout with many magic constants
 * and a few quirks (e.g. `Bm DT(2,4)` is emitted with no value, the `Vfy` load
 * field has no leading space) — all reproduced exactly.
 *
 * Rectangular columns only; circular uses a separate S-Concrete template.
 *
 * A beam writer (S-Concrete Member Type 1) is a planned follow-up: it will reuse
 * this same format/machinery but populate the `Bm *` reinforcement tables from a
 * beam's top/bottom bars. It has no Python reference, so it must be validated
 * against a real S-Concrete beam .SCO on Windows before use.
 */

import type { DesignCode } from '../../types';

// Bar name → [tableIndex, diameter_in, area_in2]
export const BAR_INFO: Record<string, [number, number, number]> = {
  '#3': [2, 0.375, 0.11], '#4': [3, 0.5, 0.2],
  '#5': [4, 0.625, 0.31], '#6': [5, 0.75, 0.44],
  '#7': [6, 0.875, 0.6], '#8': [7, 1.0, 0.79],
  '#9': [8, 1.128, 1.0], '#10': [9, 1.27, 1.27],
  '#11': [10, 1.41, 1.56], '#14': [11, 1.693, 2.25],
  '#18': [12, 2.257, 4.0],
};
const DEFAULT_BAR: [number, number, number] = [7, 1.0, 0.79];
const info = (name: string): [number, number, number] => BAR_INFO[String(name).trim()] ?? DEFAULT_BAR;
export const barIdx = (n: string): number => info(n)[0];
export const barDia = (n: string): number => info(n)[1];
export const barArea = (n: string): number => info(n)[2];

const SPLICE_CODES: Record<string, number> = {
  Tangential: 0, Radial: 1, Bearing: 2, Mechanical: 3,
  None: 0, Lap: 1, Compression: 1, 'Tension A': 1, 'Tension B': 1, 'Mech/Weld': 3,
};
const spliceCode = (t: string | undefined): number => SPLICE_CODES[t || 'None'] ?? 0;

export const ecKsi = (fcPsi: number, wcPcf = 150.0): number =>
  33.0 * Math.pow(wcPcf, 1.5) * Math.sqrt(fcPsi) / 1000.0;

const nBarsTotalRect = (nz: number, ny: number): number => 2 * (nz + ny) - 4;

// Python format helpers
export const f0 = (x: number): string => x.toFixed(0);
export const f1 = (x: number): string => x.toFixed(1);
export const f3 = (x: number): string => x.toFixed(3);
const B = (b: boolean): string => (b ? 'True' : 'False');
/** Python str(float): integers render with a trailing .0 (e.g. 60 -> "60.0"). */
const pyFloat = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));

/** Python "%.4g" formatting (4 significant figures, trailing zeros stripped). */
export function pyG(x: number, prec = 4): string {
  if (x === 0) return '0';
  const exp = Math.floor(Math.log10(Math.abs(x)));
  let s: string;
  if (exp < -4 || exp >= prec) {
    const m0 = x.toExponential(prec - 1);
    const [mRaw, eRaw] = m0.split('e');
    let m = mRaw;
    if (m.includes('.')) m = m.replace(/0+$/, '').replace(/\.$/, '');
    const en = parseInt(eRaw, 10);
    const esign = en < 0 ? '-' : '+';
    const ea = Math.abs(en).toString().padStart(2, '0');
    s = `${m}e${esign}${ea}`;
  } else {
    const dec = Math.max(0, prec - 1 - exp);
    s = x.toFixed(dec);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}

export interface ScoForce {
  P?: number; V2?: number; V3?: number; M2?: number; M3?: number; T?: number;
}
export interface ScoLoadCase extends ScoForce {
  name?: string; comment?: string;
}

export interface ColumnScoParams {
  memberName: string;
  bIn: number; hIn: number;
  fcKsi: number; fyKsi: number;
  nzBars: number; nyBars: number;
  longBar: string; tieBar: string; tieSpacingIn: number;
  coverIn?: number;          // default 1.5
  shape?: 'rectangular' | 'circular';
  forces?: ScoForce;
  loadCases?: ScoLoadCase[];
  luYyIn?: number; luZzIn?: number; // default 120
  fyTiesKsi?: number;        // default 60.0
  nLayers?: number;          // default 1
  spliceType?: string;       // default 'None'
  tieHook?: number;          // default 135
  crossHook?: number;        // default 135
  // Design-code selection. These map the app's selected code onto S-Concrete's
  // .SCO header. Defaults reproduce the ACI 318-19 / US-customary file the
  // column repo emits (Codes 18, Units 0 = kip-in, Bar Type 2 = US #-bars).
  codeNumber?: number;       // S-Concrete "Codes" enum (default 18 = ACI 318-19)
  units?: number;            // S-Concrete "Units" enum (default 0)
  barType?: number;          // S-Concrete "Bar Type" enum (default 2 = US)
  applyDiamond?: boolean;    // default true
  tieReinf?: number;
  slender?: boolean;         // default true
  applyMinM?: boolean;       // default true
}

/** Tie-leg count — faithful port of write_column_sco's inline _n_legs. */
function nLegs(
  nFace: number, barDiaIn: number, tieDiaIn: number, faceDim: number, cov: number,
  applyDiamond: boolean, nLayers: number,
  c2cOtherFace: number | null, wideFace: boolean, nFaceOther: number | null,
): number {
  const nInt = nFace - 2;
  if (nInt <= 0) return 2;
  const ctc = cov + tieDiaIn + barDiaIn / 2.0;
  const c2c = (faceDim - 2.0 * ctc) / Math.max(1, nFace - 1);
  const clear = c2c - barDiaIn;

  if (nInt === 1) {
    if (nLayers >= 2) return 3;
    if (!applyDiamond) return 2;
    if (nFaceOther !== null && nFaceOther === nFace) return 2;
    return 3;
  }
  if (nInt === 2) return 4;
  if (nInt === 3) {
    if (nLayers >= 2) return clear > 6.0 ? 5 : 4;
    if (applyDiamond) {
      if (clear >= 3.0 && clear <= 6.0) {
        if (c2cOtherFace !== null) {
          const oc = c2cOtherFace - barDiaIn;
          if (oc < 3.0) return 4;
          else if (oc > 6.0) return nFace;
        }
        return 2;
      } else if (clear > 6.0) {
        if (wideFace) return 4;
        if (c2cOtherFace !== null && c2cOtherFace - barDiaIn < 3.0) return 4;
        return nFace;
      } else {
        if (c2cOtherFace !== null && c2cOtherFace - barDiaIn < 3.0) return 2;
        return nFace;
      }
    }
    if (clear > 6.0) {
      if (c2cOtherFace !== null && c2cOtherFace - barDiaIn < 3.0) return 4;
      return nFace;
    }
    return 4;
  }
  if (nInt === 4) {
    if (nLayers >= 2) return 4;
    if (wideFace) return 4;
    return clear <= 7.0 ? 4 : 6;
  }
  if (nInt === 5) {
    if (nLayers >= 2) {
      if (barDiaIn < 1.25 && clear >= 2.0) return nFace;
      return 4;
    }
    const otherTight = c2cOtherFace !== null && c2cOtherFace < 3.0;
    if ((c2c >= 7.0 && !otherTight) ||
        (tieDiaIn >= 0.5 && barDiaIn < 1.25 && c2c >= 3.0 && c2c < 3.2 &&
         (c2cOtherFace === null || c2cOtherFace > 9.0))) {
      return 7;
    }
    return 4;
  }
  if (nInt === 6) {
    if (nLayers >= 2) {
      if (applyDiamond || nFace >= 8) return 4;
      return clear < 3.0 ? 4 : 6;
    }
    return 6;
  }
  if (nInt === 7) {
    if (nLayers >= 2) return 3;
    return 6;
  }
  return 2 * Math.ceil(nFace / 4);
}

export const BAR_TABLE =
  '@Object@S-CONCRETE Customized Bar Parameters@0@\n' +
  '@Table@2@\n' +
  'Units\t 0\n' +
  'Nbars\t 12\n' +
  'NCustbars\t 12\n' +
  'Custom Bar Space\t0\n' +
  'Custom Bar Name\tAmerican Alternate Bars\n' +
  'Custom Bar Delimiter\t-\n' +
  '@EndTable@\n' +
  '@Object@S-CONCRETE Customized Bar Information@0@\n' +
  '@Table@4@\n' +
  'Index\tDesignation\tDiameter\tArea\n' +
  ' 0\tNone\t 0\t 0\t\n' +
  ' 1\tNo 2\t .25\t .05\t\n' +
  ' 2\tNo 3\t .375\t .11\t\n' +
  ' 3\tNo 4\t .5\t .2\t\n' +
  ' 4\tNo 5\t .625\t .31\t\n' +
  ' 5\tNo 6\t .75\t .44\t\n' +
  ' 6\tNo 7\t .875\t .6\t\n' +
  ' 7\tNo 8\t 1\t .79\t\n' +
  ' 8\tNo 9\t 1.128\t 1\t\n' +
  ' 9\tNo 10\t 1.27\t 1.27\t\n' +
  '10\tNo 11\t 1.41\t 1.56\t\n' +
  '11\tNo 14\t 1.693\t 2.25\t\n' +
  '12\tNo 18\t 2.257\t 4\t\n' +
  '@EndTable@\n';

/** Build an S-Concrete column .SCO file as a string (rectangular only). */
export function buildColumnScoText(p: ColumnScoParams): string {
  const coverIn = p.coverIn ?? 1.5;
  const shape = p.shape ?? 'rectangular';
  // Circular columns use a different S-Concrete format (Version 2026.0, Member
  // Type 4) — see buildCircularColumnScoText in scoWriterCircular.ts.
  if (shape === 'circular') throw new Error('Use buildCircularColumnScoText for circular columns (Member Type 4).');
  const luYyIn = p.luYyIn ?? 120.0;
  const luZzIn = p.luZzIn ?? 120.0;
  const fyTiesKsi = p.fyTiesKsi ?? 60.0;
  const nLayers = p.nLayers ?? 1;
  const spliceType = p.spliceType ?? 'None';
  const tieHook = p.tieHook ?? 135;
  const crossHook = p.crossHook ?? 135;
  const applyDiamond = p.applyDiamond ?? true;
  const slender = p.slender ?? true;
  const applyMinM = p.applyMinM ?? true;
  const codeNumber = p.codeNumber ?? 18;
  const units = p.units ?? 0;
  const barType = p.barType ?? 2;

  const { bIn, hIn, fcKsi, fyKsi, nzBars, nyBars, longBar, tieBar, tieSpacingIn } = p;
  const dIdx = barIdx(longBar);
  const hIdx = barIdx(tieBar);
  const fcPsi = Math.trunc(fcKsi * 1000);
  const DVal = bIn;
  const hUse = hIn;
  const Ec = ecKsi(fcPsi);
  const Gc = Ec / 2.4;
  const stie2 = Math.max(4.0, Math.floor(tieSpacingIn * 0.6 / 2.0) * 2.0);

  const nzSco = nzBars; // n_layers < 2
  const nySco = nyBars;

  const dbVal = barDia(longBar);
  const dsVal = barDia(tieBar);
  const ctcLegs = coverIn + dsVal + dbVal / 2.0;
  const c2cZ = (DVal - 2.0 * ctcLegs) / Math.max(1, nzSco - 1);
  const c2cY = (hUse - 2.0 * ctcLegs) / Math.max(1, nySco - 1);
  let nLegsZ = nLegs(nySco, dbVal, dsVal, hUse, coverIn, applyDiamond, nLayers, c2cZ, false, nzSco);
  if (nySco === 2 && nzSco > 2 && nLayers < 2) nLegsZ += Math.ceil((nzSco - 2) / 2);
  const nLegsY = nLegs(nzSco, dbVal, dsVal, DVal, coverIn, applyDiamond, nLayers, c2cY, DVal > hUse && nLayers < 2, nySco);

  const tieReinf = p.tieReinf !== undefined ? String(p.tieReinf) : '0';
  const dlayer = Math.max(1.5 * barDia(longBar), 1.5);

  // --- Identifiers block ---
  let sco =
    '@\t\n' +
    '@Object@S-CONCRETE Identifiers@\n' +
    '@Table@2@\n' +
    'Version\t 7\n' +
    `Codes\t ${codeNumber}\n` +
    `Bar Type\t ${barType}\n` +
    'Member Type\t 3\n' +
    `Units\t ${units}\n` +
    'Orientation\t 0\n' +
    '@EndTable@\n';

  // --- Parameters block (Table 60) ---
  sco +=
    '@Object@S-CONCRETE Parameters@ 0@\n' +
    '@Table@60@\n' +
    `Codes\t ${codeNumber}\tUnits\t ${units}\tBar Type\t ${barType}\tMaximum\t 1\tSimple\t True\t` +
    `Member Name\t${p.memberName}\tJob Number\t305SC\t` +
    `Member Type\t 3\tMember Status\t 3\tInitialize Reinf\t True\t` +
    `Report Check 1\t True\tReport Check 2\t True\tReport Check 3\t True\t` +
    `Report Check 4\t True\tReport Check 5\t True\tReport Check 6\t True\t` +
    `Report Check 7\t True\tReport Check 8\t True\tReport Check 9\t True\t` +
    `Ignore Nf\t False\tOrientation\t 0\tClosedBeams\t False\tClosed\t True\t` +
    `Bm b\t ${f0(bIn)}\tBm h\t ${f0(hUse)}\tBm bf\t ${f0(bIn)}\tBm hf\t 7\t` +
    `Bm IgnoreFlange\t False\tBm Top\t ${pyFloat(coverIn)}\tBm Bottom\t ${pyFloat(coverIn)}\n` +

    `Bm Side\t ${pyFloat(coverIn)}\tBm CheckCracks\t True\tBm CheckBarS\t True\t` +
    `Bm Dstir\t ${hIdx}\tBm Sstir\t ${f1(tieSpacingIn)}\t` +
    `Bm StirHook\t 135\tBm StirHook1\t 135\t` +
    `Bm ApplyStir\t True\tBm ShowStir\t True\t` +
    `Bm NlegsZ\t 2\tBm NlegsY\t 0\tBm NlegsZreqd\t 0\tBm DoubleStir\t False\t` +
    `Bm NbmFace\t 0\tBm DbmFace\t ${dIdx}\t` +
    `Bm SbmFace\t ${f1(Math.max(0.0, hUse - 4 * coverIn))}\tBm ZbmFace\t 0\t` +
    `Bm ApplyFace\t True\tBm ApplyFaceNvsM\t True\tBm NfaceCurtains\t 2\t` +
    `Bm Exposure\t 0\tBm CoatTop\t 0\tBm CoatBot\t 0\t` +
    `Bm Show2ndT\t True\tBm Show2ndB\t True\tBm SameDTop\t True\tBm SameDBot\t True\t` +
    `Bm dzT\t 1\tBm dzB\t 1\tBm ComputedzT\t True\n` +
    `Bm ComputedzB\t True\t` +
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
    `Cm bcol\t ${f0(bIn)}\tCm hcol\t ${f0(hUse)}\tCm D\t ${f0(DVal)}\t` +
    `Cm Cover\t ${pyFloat(coverIn)}\tCm CoverInside\t ${pyFloat(coverIn)}\t` +
    `Cm ApplyMinM\t ${B(applyMinM)}\tCm Do1Pcnt\t False\tCm NrClause\t 4\tCm HoleType\t 0\t` +
    `Cm bcolHole\t 2\tCm hcolHole\t 2\tCm DcolHole\t 2\tCm ApplySteelSect\t False\t` +
    `Cm Nzcol\t ${nzSco}\tCm Nycol\t ${nySco}\t` +
    `Cm Nface1\t ${nzSco}\tCm Nface2\t ${nySco}\t` +
    `Cm Nface1draw\t 0\tCm Nface2draw\t 0\n` +
    `Cm DVert\t ${dIdx}\tCm DVert2\t ${dIdx}\tCm DHorz\t ${hIdx}\tCm DHorz2\t ${hIdx}\t` +
    `Cm NClegsZ\t ${nLegsZ}\tCm NClegsY\t ${nLegsY}\t` +
    `Cm TieHook\t ${tieHook}\tCm CrossHook\t ${crossHook}\t` +
    `Cm NLayers\t ${nLayers}\tCm Apply2ndLayer\t ${B(nLayers > 1)}\t` +
    `Cm ApplyDiamond\t ${B(applyDiamond)}\t` +
    `Cm TieReinf\t ${tieReinf}\t` +
    `Cm Splice\t ${spliceCode(spliceType)}\t` +
    `Cm dlayer\t ${f3(dlayer)}\tCm ComputeDlayer\t False\t` +
    `Cm Stie\t ${f1(tieSpacingIn)}\tCm Stie2\t ${f1(stie2)}\t` +
    `Cm Pitch\t ${f1(tieSpacingIn)}\tCm Pitch2\t ${f1(stie2)}\t` +
    `Cm SteelSectTable\t 2\tCm SteelSectNo\t 5\tCm SteelSectName\tW40X593       J\t` +
    `Cm WWFd\t 42.99\tCm WWFb\t 16.69\t` +
    `Cm WWFt\t 3.23\tCm WWFw\t 1.79\t` +
    `Wa CoverW\t 1.5\tWa CoverZ\t 1.5\tWa Npanels\t 0\tWa Offset\t 24\n` +
    `Wa Symmetric\t False\tWa Rectangular\t False\tWa AddWall\t True\tWa VertOut\t False\t` +
    `Wa DoNomProb\t True\tWa L2\t 24\tWa T2\t 16\tWa L3\t 30\tWa T3\t 20\t` +
    `Slender\t ${B(slender)}\t` +
    `LuYY\t ${f0(luYyIn)}\tLuZZ\t ${f0(luZzIn)}\tky\t 1\tkz\t 1\t` +
    `kEcIg\t .25\t` +
    `Bm hIncr\t 2\tBm bIncr\t 1\tCm hcolIncr\t 2\tCm bcolIncr\t 2\t` +
    `Cm Dincr\t 2\tCm HoleIncr\t .5\tBm bfIncr\t 4\tBm hfIncr\t .5\t` +
    `Wa Lincr\t 2\tWa Tincr\t 1\tfyIncr\t 10\tfcuIncr\t 1000\t` +
    `Bm StirIncr\t 1\tBm FaceIncr\t .5\tCm TieIncr\t 1\n` +
    `Cm PitchIncr\t .25\tWa ZoneVertSIncr\t 1\tWa ZoneTieSIncr\t 1\tWa PanelSincr\t 2\t` +
    `ScaleBarWidth\t True\t` +
    `fy\t ${fyKsi}\tfy2\t ${pyFloat(fyTiesKsi)}\tfy3\t 65.0\t` +
    `Wc\t 150\tWs\t 500\tPoisson\t .2\thagg\t .75\t` +
    `Gc\t ${f3(Gc)}\tEc\t ${f3(Ec)}\tEs\t 29000\t` +
    `kIe\t .5\tkAe\t .5\tkAse\t .5\tkJe\t .5\t` +
    `MaxIter\t 25\t` +
    `fyDesMin\t 15\tfyDesMax\t 150\tfy2DesMin\t 15\tfy2DesMax\t 150\t` +
    `fy3DesMin\t 15\tfy3DesMax\t 150\tfcuDesMin\t 700\tfcuDesMax\t 15000\t` +
    `Freezefy\t True\tFreezefy2\t True\n` +
    `Freezefy3\t True\tFreezefcu\t True\t` +
    `Bm Bmbovrh\t .7\tBm bmin\t 5\tBm bmax\t 400\tBm hmin\t 6\tBm hmax\t 400\t` +
    `Bm Freezeb\t False\tBm Freezeh\t False\t` +
    `Bm dbTopMin\t .5\tBm dbTopMax\t 1.375\tBm dbBotMin\t .5\tBm dbBotMax\t 1.375\t` +
    `Bm dbStirMin\t .5\tBm dbStirMax\t .75\tBm dbFaceMin\t .625\tBm dbFaceMax\t 1\t` +
    `Bm FreezeTop\t False\tBm FreezeBot\t False\tBm FreezeStir\t False\tBm FreezeFace\t False\t` +
    `Bm RhogMinT\t .004\tBm RhogMaxT\t .025\tBm RhogMinB\t .004\tBm RhogMaxB\t .025\t` +
    `Bm SclMaxTens\t 8\tBm SclMaxComp\t 8\t` +
    `Cm Colbovrh\t 1\tCm bcolmin\t 6\tCm bcolmax\t 400\n` +
    `Cm hcolmin\t 6\tCm hcolmax\t 400\tCm Dcolmin\t 6\tCm Dcolmax\t 400\t` +
    `Cm FreezeDcol\t False\tCm Freezebcol\t False\tCm Freezehcol\t False\tCm FreezeSplice\t False\t` +
    `Cm dbVertMin\t .625\tCm dbVertMax\t 2.257\tCm dbHorzMin\t .375\tCm dbHorzMax\t 1\t` +
    `Cm FreezeVert\t False\tCm FreezeHorz\t False\t` +
    `Cm RhoVmin\t 1\tCm RhoVmax\t 8\t` +
    `fcu\t ${fcPsi}\tQuick Calc\t True\tWa EDM\t False\t` +
    `Wa Duct\t 0\tWa MagVf\t False\tWa Plastic\t True\tWa EstimateG\t 0\t` +
    `Wa MfoverMr\t 25\tWa R\t 1.5\tWa GammaWy\t 1.3\tWa GammaWz\t 1.5\t` +
    `Wa GammaWpy\t 1.6\tWa GammaWpz\t 1.7\tWa hw\t 1200\n` +
    `Wa Zone\t 1\tWa Strain\t False\tWa BZDL\t .05\tWa PhiV\t .6\tWa PhiVmode\t 0\t` +
    `Cm AddSteelShear\t False\t` +
    `Cm WWFIconfig\t True\tCm ApplyWWFbeam\t False\tCm WWFbeamb\t 10\tCm WWFbeamh\t 10\t` +
    `Cm WWFbdincr\t .5\tCm WWFtwincr\t .125\tCm UseSteelTables\t True\t` +
    `Cm bshapemin\t 4\tCm bshapemax\t 100\tCm dshapemin\t 4\tCm dshapemax\t 100\t` +
    `Cm FreezeShape\t False\t` +
    `Wa dbPanelVertMin\t .375\tWa dbPanelVertMax\t 1.375\t` +
    `Wa dbPanelHorzMin\t .375\tWa dbPanelHorzMax\t 1.375\t` +
    `Wa FreezePanelVert\t False\tWa FreezePanelHorz\t False\t` +
    `Wa dbZoneVertMin\t .375\tWa dbZoneVertMax\t 1.375\t` +
    `Wa dbZoneHorzMin\t .375\tWa dbZoneHorzMax\t 1.375\t` +
    `Wa FreezeZoneVert\t False\tWa FreezeZoneHorz\t False\n` +
    `Wa FreezeZoneSplice\t False\t` +
    `Wa tmin1\t 4\tWa tmin2\t 4\tWa tmin3\t 4\tWa tmin4\t 4\t` +
    `Wa tmax1\t 400\tWa tmax2\t 400\tWa tmax3\t 400\tWa tmax4\t 400\t` +
    `Wa Lmin1\t 30\tWa Lmin2\t 30\tWa Lmin3\t 30\tWa Lmin4\t 30\t` +
    `Wa Lmax1\t 400\tWa Lmax2\t 400\tWa Lmax3\t 400\tWa Lmax4\t 400\t` +
    `Wa FreezeWallDim\t False\t` +
    `Wa L2minDes\t 12\tWa L2maxDes\t 400\tWa T2minDes\t 10\tWa T2maxDes\t 400\t` +
    `Wa L3minDes\t 12\tWa L3maxDes\t 400\tWa T3minDes\t 10\tWa T3maxDes\t 400\t` +
    `Wa R0\t 1.3\tWa DeltaFyy\t 3\tWa DeltaFzz\t 3\t` +
    `Wa Coupled\t 0\n` +
    '@EndTable@\n';

  sco += BAR_TABLE;

  // --- Sectional Loads (Table 16) ---
  const hdr = 'LC\tNf\tTf\tVfz\tMfy\tCmy\tVfy\tMfz\tCmz\t' +
    'Pdistr\tCheckLC\tLoad Type\tComment\tAutoGen\tSustFactor\tServLdFactor';

  const lcRow = (i: number, P: number, T: number, V2: number, M3: number, V3: number, M2: number, comment: string): string =>
    ` ${i}\t ${f1(P)}\t ${pyG(T)}\t ${f1(V2)}\t ${f1(M3)}\t 1\t` +
    `${f1(V3)}\t ${f1(M2)}\t 1\t 0\t True\t 1\t ${comment}\t 0\t 1\t 1`;

  let rows: string[];
  if (p.loadCases && p.loadCases.length) {
    rows = p.loadCases.map((lc, i) =>
      lcRow(i + 1, lc.P ?? 0, lc.T ?? 0, lc.V2 ?? 0, lc.M3 ?? 0, lc.V3 ?? 0, lc.M2 ?? 0, lc.comment ?? ''));
  } else if (p.forces) {
    const fc = p.forces;
    rows = [lcRow(1, fc.P ?? 0, fc.T ?? 0, fc.V2 ?? 0, fc.M3 ?? 0, fc.V3 ?? 0, fc.M2 ?? 0, '')];
  } else {
    rows = [' 1\t 0\t 0\t 0\t 0\t 1\t 0\t 0\t 1\t 0\t True\t 1\t\t 0\t 1\t 1'];
  }

  sco +=
    '@Object@S-CONCRETE Sectional Loads@\n' +
    '@Table@16@\n' +
    hdr + '\n' +
    rows.join('\n') + '\n' +
    '@EndTable@\n';

  return sco;
}

/**
 * Map the app's selected design code onto the S-Concrete .SCO header fields
 * (Codes / Units / Bar Type) so the file actually runs under the chosen code.
 *
 * IMPORTANT: only ACI 318-19 is CONFIRMED — `Codes 18` is the value the
 * S-Concrete-calibrated column repo emits. The column repo is ACI-318-19-only,
 * so the S-Concrete enum values for EN 1992-1-1 (EC2 / UK National Annex) and
 * the other ACI editions are NOT known here. For those this returns `null` and
 * the caller MUST refuse to emit a .SCO (or prompt for the values) rather than
 * silently produce an ACI file for an EC2 selection. EC2 additionally needs SI
 * units and metric bars, not just a different Codes number.
 */
export function designCodeToScoHeader(
  code: DesignCode,
): { codeNumber: number; units: number; barType: number } | null {
  switch (code) {
    case 'ACI318-19':
      return { codeNumber: 18, units: 0, barType: 2 };
    default:
      // ACI318-14: unknown S-Concrete enum — confirm before emitting. (EC2 has
      // its own writer, scoWriterEC2, and does not use this header.)
      return null;
  }
}

export interface BeamScoParams {
  memberName: string;
  bIn: number;             // web / overall width (in)
  hIn: number;             // overall depth (in)
  fcKsi: number;
  fyKsi: number;
  coverIn?: number;        // default 1.5
  stirrupBar: string;      // e.g. '#4'
  stirrupSpacingIn: number;
  topBar?: string;         // representative longitudinal bar (seed only)
  forces?: ScoForce;
  loadCases?: ScoLoadCase[];
  codeNumber?: number;
  units?: number;
  barType?: number;
}

/**
 * Build an S-Concrete BEAM .SCO (Member Type 1).
 *
 * BEST-EFFORT / UNVALIDATED: this reuses the byte-validated column .SCO machinery
 * and switches the member type to beam. The section, cover, stirrups, and — most
 * importantly — the load forces (carried into the Sectional Loads table) are
 * correct; the seed longitudinal reinforcement is approximate (S-Concrete designs
 * a beam from the loads when "Initialize Reinf" is set). The exact `Bm *`
 * reinforcement-table mapping and the load-component convention MUST be confirmed
 * against a real S-Concrete beam .SCO on Windows before production use.
 */
export function buildBeamScoText(p: BeamScoParams): string {
  const col = buildColumnScoText({
    memberName: p.memberName,
    bIn: p.bIn,
    hIn: p.hIn,
    fcKsi: p.fcKsi,
    fyKsi: p.fyKsi,
    nzBars: 2,
    nyBars: 2,
    longBar: p.topBar ?? '#8',
    tieBar: p.stirrupBar,
    tieSpacingIn: p.stirrupSpacingIn,
    coverIn: p.coverIn,
    forces: p.forces,
    loadCases: p.loadCases,
    codeNumber: p.codeNumber,
    units: p.units,
    barType: p.barType,
  });
  // Switch Member Type 3 (column) -> 1 (beam) in the Identifiers + Parameters
  // blocks. "Member Status 3" is a different token and is left untouched.
  return col.split('Member Type\t 3').join('Member Type\t 1');
}
