/**
 * suggestColumnRebar — picks the lightest practical symmetric column cage
 * (longitudinal bars + ties) that meets a design group's worst demand at the
 * target DCR, holding ρg inside ACI §10.6.1's 1–8% band.
 *
 * Ports the auto-design intent of Column_Design_DW (auto_size / auto_design):
 * choose the minimum-steel bar arrangement that satisfies the P-M interaction
 * and axial checks, then size the ties from the shear demand and the ACI
 * §25.7.2 detailing limits.
 *
 * Verification-driven: every candidate is re-run through the (S-Concrete-
 * calibrated) column engine and accepted only when the worst DCR across all
 * members and load cases is at or below target. P-M and axial capacity are
 * independent of the ties (the engine's interaction curve never reads
 * tie size/spacing/legs — only tieType), so we decouple the search:
 *   1. find the lightest longitudinal cage passing DCR_PM and DCR_axial;
 *   2. holding that cage, find the lightest ties passing DCR_shear.
 * This keeps the engine-call count linear rather than combinatorial.
 */
import type { Member, RebarLayout, Project, DesignResults } from '../types';
import { runDesign } from '../engines';
import { getBarArea, getBarDiam } from './concreteDesign';
import { memberSteelWeightLb } from './autoGroup';
import { grossArea } from '../engines/column/sectionModel';
import type { SuggestResult, SuggestError } from './suggestRebar';

// Typical column longitudinal bar sizes (US #; metric Ø in mm as negatives).
const COL_LONG_US  = [6, 7, 8, 9, 10, 11];
const COL_LONG_EC2 = [-16, -20, -25, -32];

// Tie / hoop bar candidates.
const COL_TIE_US  = [3, 4, 5];
const COL_TIE_EC2 = [-8, -10, -12];

// Tie spacing ladder (in). Tightened on shear demand and capped by the
// detailing s_max. EC2 ladder is the metric set converted from mm.
const COL_TIE_SPACINGS_US  = [3, 4, 5, 6, 8, 10, 12];
const COL_TIE_SPACINGS_EC2 = [75, 100, 125, 150, 175, 200, 250].map(mm => mm / 25.4);

const RHO_MIN = 0.01;
const RHO_MAX = 0.08;

export function isColumnMember(m: Member): boolean {
  return m.section.type === 'rectangular_column' || m.section.type === 'circular_column';
}

/**
 * Max bars that fit along one face of clear length `faceLen`, using the
 * column clear-spacing minimum of max(1.5", 1.5·db) (ACI §25.2.3). Mirrors the
 * beam helper's (usable + clear)/(db + clear) convention for consistency.
 */
function maxBarsOnFace(faceLen: number, barSize: number, cover: number, tieD: number): number {
  const db = getBarDiam(barSize);
  const clear = Math.max(1.5, 1.5 * db);
  const usable = faceLen - 2 * (cover + tieD);
  if (usable <= 0) return 0;
  return Math.max(0, Math.floor((usable + clear) / (db + clear)));
}

interface LongCage {
  topBars: RebarLayout['topBars'];
  botBars: RebarLayout['botBars'];
  sideBars?: RebarLayout['sideBars'];
  Ast: number;
  nBars: number;
  rho: number;
}

/**
 * Enumerate symmetric longitudinal cages with ρg inside the 1–8% band, ordered
 * lightest-first. Rectangular: `nf` bars on each of the top/bottom faces plus
 * `rows` intermediate rows of 2 side bars. Circular: N bars pooled on the ring,
 * split nominally across the top/bottom groups (the engine pools them anyway).
 */
function longCages(section: Member['section'], sizes: number[], minBars: number): LongCage[] {
  const isCirc = section.type === 'circular_column';
  const D = section.diameter ?? section.b;
  const b = section.b;
  const h = section.h ?? section.b;
  const cover = section.coverClear;
  const tieD = getBarDiam(section.stirrupDia);
  const Ag = grossArea(isCirc, b, h, D);
  if (Ag <= 0) return [];

  const cages: LongCage[] = [];

  for (const size of sizes) {
    const Ab = getBarArea(size);
    if (Ab <= 0) continue;

    if (isCirc) {
      // Bars distributed on the cage ring; cap by the ring circumference.
      const dbar = getBarDiam(size);
      const ringR = D / 2 - cover - tieD - dbar / 2;
      const clear = Math.max(1.5, 1.5 * dbar);
      const maxRing = ringR > 0 ? Math.max(0, Math.floor((2 * Math.PI * ringR) / (dbar + clear))) : 0;
      for (let N = Math.max(minBars, 4); N <= Math.min(maxRing, 24); N++) {
        const Ast = N * Ab;
        const rho = Ast / Ag;
        if (rho < RHO_MIN) continue;
        if (rho > RHO_MAX) break;
        const top = Math.ceil(N / 2), bot = N - top;
        cages.push({
          topBars: [{ numBars: top, barSize: size }],
          botBars: [{ numBars: bot, barSize: size }],
          Ast, nBars: N, rho,
        });
      }
    } else {
      const maxFace = maxBarsOnFace(b, size, cover, tieD);            // top/bottom face (width b)
      const maxSideRows = Math.max(0, maxBarsOnFace(h, size, cover, tieD) - 2); // intermediate rows over height h
      for (let nf = 2; nf <= Math.min(maxFace, 8); nf++) {
        for (let rows = 0; rows <= Math.min(maxSideRows, 6); rows++) {
          const ns = 2 * rows;
          const N = 2 * nf + ns;
          if (N < minBars) continue;
          const Ast = N * Ab;
          const rho = Ast / Ag;
          if (rho < RHO_MIN) continue;
          if (rho > RHO_MAX) continue;
          const cage: LongCage = {
            topBars: [{ numBars: nf, barSize: size }],
            botBars: [{ numBars: nf, barSize: size }],
            Ast, nBars: N, rho,
          };
          if (ns > 0) cage.sideBars = [{ numBars: ns, barSize: size }];
          cages.push(cage);
        }
      }
    }
  }

  // Lightest first; tie-break on fewer bars (simpler cage).
  return cages.sort((a, b2) => a.Ast - b2.Ast || a.nBars - b2.nBars);
}

/** Largest longitudinal bar diameter / US-size in a cage (for tie detailing). */
function maxLongBar(cage: LongCage): { db: number; usSize: number } {
  const groups = [...cage.topBars, ...cage.botBars, ...(cage.sideBars ?? [])];
  let db = 0, usSize = 0;
  for (const g of groups) {
    db = Math.max(db, getBarDiam(g.barSize));
    usSize = Math.max(usSize, Math.abs(g.barSize) >= 25.4 ? 11 : g.barSize);
  }
  return { db, usSize };
}

/** ACI §25.7.2.1 tie spacing ceiling s_max = min(16·db_long, 48·db_tie, least dim). */
function tieSpacingMax(section: Member['section'], dbLong: number, tieD: number): number {
  const isCirc = section.type === 'circular_column';
  const D = section.diameter ?? section.b;
  const leastDim = isCirc ? D : Math.min(section.b, section.h ?? section.b);
  return Math.min(16 * dbLong, 48 * tieD, leastDim);
}

/**
 * Lightest ties (size/legs/spacing) meeting the worst shear DCR at target while
 * respecting the detailing s_max, or null if none do. Ordered smallest size →
 * fewest legs → largest spacing (least steel first).
 */
function chooseTies(
  members: Member[],
  cage: LongCage,
  section: Member['section'],
  code: Project['code'],
  targetDCR: number,
  tieType: RebarLayout['tieType'],
): RebarLayout['ties'] | null {
  const isEC2 = code === 'EN1992-1-1';
  const tieSizes = isEC2 ? COL_TIE_EC2 : COL_TIE_US;
  const spacings = isEC2 ? COL_TIE_SPACINGS_EC2 : COL_TIE_SPACINGS_US;
  const { db: dbLong, usSize } = maxLongBar(cage);
  const minUsTie = usSize <= 10 ? 3 : 4;                     // §25.7.2.2
  const minLinkMm = Math.max(6, 0.25 * dbLong * 25.4);      // EC2 §9.5.3

  for (const size of tieSizes) {
    if (!isEC2 && size < minUsTie) continue;
    if (isEC2 && -size < minLinkMm - 1e-9) continue;
    const tieD = getBarDiam(size);
    const sMax = tieSpacingMax(section, dbLong, tieD);
    const ladder = spacings.filter(s => s <= sMax + 1e-9).sort((a, b) => b - a); // largest first
    for (const legs of [2, 4]) {
      for (const spacing of ladder) {
        const ties = { barSize: size, spacing, legs };
        const rebar: RebarLayout = {
          topBars: cage.topBars, botBars: cage.botBars, sideBars: cage.sideBars,
          ties, tieType,
        };
        let worstShear = 0, failed = false;
        for (const m of members) {
          for (const lc of m.loads) {
            let r: DesignResults;
            try { r = runDesign(m.section, m.material, rebar, lc, m.span, code, m.crackParams); }
            catch { failed = true; break; }
            worstShear = Math.max(worstShear, r.DCR_shear);
          }
          if (failed) break;
        }
        if (!failed && worstShear <= targetDCR + 1e-6) return ties;
      }
    }
  }
  return null;
}

/**
 * Suggest the lightest column cage for a group of column members. Returns the
 * same SuggestResult shape as the beam path, with `kind: 'column'` and the
 * column-specific DCRs filled in (worstDCRFlex carries the governing P-M DCR).
 */
export function suggestColumnRebar(
  members: Member[],
  code: Project['code'],
  targetDCR = 0.9,
): SuggestResult | SuggestError {
  const cols = members.filter(m => isColumnMember(m) && m.loads.length > 0);
  if (!cols.length) return { error: 'No designed column members with loads in this group.' };

  // One section family / tie type per group; use the governing member's section
  // for cage geometry and the most common tie type (default tied).
  const tieType: RebarLayout['tieType'] = cols.some(m => m.rebar.tieType === 'spiral') ? 'spiral' : 'tied';
  const minBars = tieType === 'spiral' ? 6 : 4;
  const isEC2 = code === 'EN1992-1-1';
  const sizes = isEC2 ? COL_LONG_EC2 : COL_LONG_US;

  // Geometry comes from the section with the largest gross area in the group so
  // the cage fits every member (members in a group share a section family, but
  // be defensive). Demand is always checked against ALL members below.
  const refSection = cols.reduce((a, m) =>
    grossArea(
      m.section.type === 'circular_column',
      m.section.b, m.section.h ?? m.section.b, m.section.diameter ?? m.section.b,
    ) > grossArea(
      a.type === 'circular_column', a.b, a.h ?? a.b, a.diameter ?? a.b,
    ) ? m.section : a, cols[0].section);

  const cages = longCages(refSection, sizes, minBars);
  if (!cages.length) {
    return { error: 'No practical bar layout fits this column section within ρ = 1–8%.' };
  }

  // 1. Lightest cage passing P-M and axial across every member/load. Ties do not
  //    affect these checks, so use a nominal tie just to run the engine.
  const nominalTie = { barSize: isEC2 ? -8 : 3, spacing: isEC2 ? 150 / 25.4 : 6, legs: 2 };
  let chosen: LongCage | null = null;
  let governingId = cols[0].id;
  let bestPM = 0, bestAxial = 0;
  let leastInfeasiblePM = Infinity;

  for (const cage of cages) {
    const rebar: RebarLayout = {
      topBars: cage.topBars, botBars: cage.botBars, sideBars: cage.sideBars,
      ties: nominalTie, tieType,
    };
    let worstPM = 0, worstAxial = 0, gov = cols[0].id, failed = false;
    for (const m of cols) {
      for (const lc of m.loads) {
        let r: DesignResults;
        try { r = runDesign(m.section, m.material, rebar, lc, m.span, code, m.crackParams); }
        catch { failed = true; break; }
        if (r.DCR_PM != null && r.DCR_PM > worstPM) { worstPM = r.DCR_PM; gov = m.id; }
        worstAxial = Math.max(worstAxial, r.DCR_axial ?? 0);
      }
      if (failed) break;
    }
    if (failed) continue;
    leastInfeasiblePM = Math.min(leastInfeasiblePM, Math.max(worstPM, worstAxial));
    if (worstPM <= targetDCR + 1e-6 && worstAxial <= targetDCR + 1e-6) {
      chosen = cage; governingId = gov; bestPM = worstPM; bestAxial = worstAxial;
      break;
    }
  }

  if (!chosen) {
    const detail = Number.isFinite(leastInfeasiblePM)
      ? ` Best achievable DCR ≈ ${leastInfeasiblePM.toFixed(2)} at ρ = 8%.`
      : '';
    return { error: `Even ρ = 8% longitudinal steel exceeds the target DCR — enlarge the section.${detail}` };
  }

  // 2. Size the ties for shear + detailing on the chosen cage.
  const ties = chooseTies(cols, chosen, refSection, code, targetDCR, tieType);
  if (!ties) {
    return { error: 'No practical tie layout meets the shear demand — consider a larger section.' };
  }

  // Re-verify shear with the chosen ties for the reported number.
  const finalRebar: RebarLayout = {
    topBars: chosen.topBars, botBars: chosen.botBars, sideBars: chosen.sideBars,
    ties, tieType,
  };
  let worstShear = 0;
  for (const m of cols) {
    for (const lc of m.loads) {
      const r = runDesign(m.section, m.material, finalRebar, lc, m.span, code, m.crackParams);
      worstShear = Math.max(worstShear, r.DCR_shear);
    }
  }

  // Steel quantity: Ast × clear height (span) × unit weight, per member.
  const steelLb = cols.reduce((s, m) => {
    const len = m.span ?? 10;
    return s + memberSteelWeightLb(chosen!.Ast, len);
  }, 0);

  return {
    rebar: finalRebar,
    worstDCRFlex: bestPM,          // governing P-M interaction DCR
    worstDCRShear: worstShear,
    steelLb,
    governingMemberId: governingId,
    kind: 'column',
    worstDCRAxial: bestAxial,
    rhoPct: chosen.rho * 100,
  };
}
