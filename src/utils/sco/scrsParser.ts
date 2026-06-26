/**
 * Parser for S-Concrete batch result files (.SCRS) — ported from
 * Column_Design_DW/compare_all.py (`parse_scrs`). Pulls per-member status and
 * utilizations back into the app after an S-Concrete batch run.
 *
 * The .SCRS format is S-Concrete's proprietary text report; this reproduces the
 * column repo's line/regex extraction. There is no sample .SCRS in the repo and
 * S-Concrete is Windows-only, so the parse LOGIC is unit-tested against a
 * synthetic sample — the exact real-world layout should be confirmed against an
 * actual S-Concrete .SCRS before relying on it in production.
 */

export interface ScrsResult {
  name: string;
  status: string | null;       // 'OK' | 'OVERSTRESSED' | 'WARNING' | ...
  nmUtil: number | null;       // N vs M (axial+moment) utilization
  vtUtil: number | null;       // shear + torsion utilization
  axialUtil: number | null;    // governing load case axial utilization
  momentUtil: number | null;   // governing load case moment utilization
  maxMomentUtil: number | null;
  maxAxialUtil: number | null;
  phiMn: number | null;        // φMn (kip-ft)
  phiVnz: number | null;
  phiVny: number | null;
  phiTcr: number | null;
  msgs: string[];
}

const TRAIL = /([\d.]+)\s*$/;       // trailing number
const EQNUM = /=\s*([\d.]+)/;        // "= 12.3"
const EQSCI = /=\s*([\d.E+]+)/;      // "= 1.2E+02"

function newSection(name: string): ScrsResult {
  return {
    name, status: null, nmUtil: null, vtUtil: null, axialUtil: null, momentUtil: null,
    maxMomentUtil: null, maxAxialUtil: null, phiMn: null, phiVnz: null, phiVny: null,
    phiTcr: null, msgs: [],
  };
}

/** Parse an S-Concrete .SCRS file's text into one result per member ("File:"). */
export function parseScrs(text: string): ScrsResult[] {
  const sections: ScrsResult[] = [];
  let cur: ScrsResult | null = null;
  let inGovLc = false, inMaxMoment = false, inShear = false;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();

    if (stripped.startsWith('File:') && stripped.includes('File:')) {
      if (cur) sections.push(cur);
      let name = (stripped.split('File:').pop() ?? '').trim();
      if (!name) name = i + 1 < lines.length ? lines[i + 1].trim() : '';
      cur = newSection(name.replace('.SCO', ''));
      inGovLc = false; inMaxMoment = false; inShear = false;
      continue;
    }
    if (!cur) continue;

    if (stripped.includes('V & T Util')) {
      const m = stripped.match(TRAIL); if (m) cur.vtUtil = parseFloat(m[1]);
    } else if (stripped.includes('N vs M Util')) {
      const m = stripped.match(TRAIL); if (m && cur.nmUtil === null) cur.nmUtil = parseFloat(m[1]);
    } else if (/^(OK|OVERSTRESSED|WARNING)/.test(stripped)) {
      if (cur.status === null) cur.status = stripped;
    } else if (stripped.includes('Governing Load Case Utilizations:')) {
      inGovLc = true; inMaxMoment = false; inShear = false;
    } else if (stripped.includes('Maximum Axial Compression Utilization:')) {
      inGovLc = false; inMaxMoment = false; inShear = false;
      for (let k = i + 1; k < Math.min(i + 6, lines.length); k++) {
        const sl = lines[k].trim();
        if (sl.includes('Utilization')) {
          const mm = sl.match(TRAIL); if (mm) cur.maxAxialUtil = parseFloat(mm[1]);
          break;
        }
      }
    } else if (stripped.includes('Maximum Resultant Moment Utilization:')) {
      inMaxMoment = true; inGovLc = false; inShear = false;
    } else if (stripped.includes('Shear and Torsion Utilization:') || stripped.includes('Shear Z-Direction:')) {
      inShear = true; inGovLc = false; inMaxMoment = false;
    } else if (inGovLc) {
      if (stripped.includes('Axial Util.')) {
        const m = stripped.match(TRAIL); if (m) cur.axialUtil = parseFloat(m[1]);
      } else if (stripped.includes('Moment Util.')) {
        const m = stripped.match(TRAIL); if (m) cur.momentUtil = parseFloat(m[1]);
      } else if (/^[OØ]Mn\b/.test(stripped) || stripped.includes('OMn')) {
        const m = stripped.match(EQSCI); if (m && cur.phiMn === null) cur.phiMn = parseFloat(m[1]);
      }
    } else if (inMaxMoment) {
      if (stripped.startsWith('Utilization')) {
        const m = stripped.match(TRAIL); if (m) cur.maxMomentUtil = parseFloat(m[1]);
      }
    } else if (inShear) {
      if (stripped.includes('phi_Vnz') || stripped.includes('OVnz') || stripped.includes('phi*Vnz')) {
        const m = stripped.match(EQNUM); if (m && cur.phiVnz === null) cur.phiVnz = parseFloat(m[1]);
      } else if (stripped.includes('phi_Vny') || stripped.includes('OVny') || stripped.includes('phi*Vny')) {
        const m = stripped.match(EQNUM); if (m && cur.phiVny === null) cur.phiVny = parseFloat(m[1]);
      } else if (stripped.includes('phi_Tcr') || stripped.includes('OTcr') || stripped.includes('phi*Tcr')) {
        const m = stripped.match(EQNUM); if (m && cur.phiTcr === null) cur.phiTcr = parseFloat(m[1]);
      }
    } else if (/^Msg\s+\d+/.test(stripped)) {
      cur.msgs.push(stripped);
    }
  }
  if (cur) sections.push(cur);
  return sections;
}
