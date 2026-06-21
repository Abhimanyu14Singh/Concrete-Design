/**
 * suggestGroupRebar — picks the lightest *practical* rebar layout for a design
 * group meeting the group's worst demand at the target DCR.
 *
 * Practical defaults (typical office detailing standards):
 *   longitudinal: #5–#9, min 2 bars/layer, max 2 layers, outer layer ≥ inner;
 *   stirrups: #4 or #5, 2 then 4 legs, spacings {4,6,8,10,12} in,
 *   zoned [end, mid, end] with the mid zone one increment more relaxed.
 *
 * Verification-driven: candidate areas come from the engine's own As_req /
 * Av_req demand outputs, and the winning layout is re-verified with runDesign
 * so strain-compatibility effects can bump to the next candidate.
 */
import type { Member, RebarLayout, Project, DesignResults } from '../types';
import { runDesign } from '../engines';
import { getBarArea, getBarDiam } from './concreteDesign';
import { memberSteelWeightLb } from './autoGroup';

const LONG_BAR_SIZES_US  = [5, 6, 7, 8, 9];
const LONG_BAR_SIZES_EC2 = [-10, -12, -16, -20, -25, -32];

// US stirrup candidates
const STIRRUP_SIZES_US       = [4, 5];
const STIRRUP_SPACINGS_US    = [4, 6, 8, 10, 12]; // in

// EC2 stirrup candidates — Ø8, Ø10, Ø12 links; spacings 100/125/150/175/200/250 mm → in
const STIRRUP_SIZES_EC2      = [-8, -10, -12];
const STIRRUP_SPACINGS_EC2   = [100, 125, 150, 175, 200, 250].map(mm => mm / 25.4); // in

const MAX_VERIFY_RETRIES = 5;

export interface SuggestResult {
  rebar: RebarLayout;
  worstDCRFlex: number;
  worstDCRShear: number;
  steelLb: number;           // total longitudinal steel for the group (lb)
  governingMemberId: string;
}

export interface SuggestError { error: string }

export function isSuggestError(r: SuggestResult | SuggestError): r is SuggestError {
  return 'error' in r;
}

interface FaceCandidate {
  layers: { numBars: number; barSize: number }[];
  As: number;
}

/** Max bars per layer that fit the web width with ≥ max(1", db) clear spacing. */
function maxBarsPerLayer(member: Member, barSize: number): number {
  const db = getBarDiam(barSize);
  const bw = member.section.bw ?? member.section.b;
  const dStir = getBarDiam(member.section.stirrupDia);
  const clear = Math.max(1, db);
  const usable = bw - 2 * (member.section.coverClear + dStir);
  // n·db + (n−1)·clear ≤ usable → n ≤ (usable + clear) / (db + clear)
  return Math.max(0, Math.floor((usable + clear) / (db + clear)));
}

/**
 * Practical layouts for one face at a SINGLE bar size with As ≥ required,
 * lightest first. Number of bars / layers may vary, but the size is fixed.
 */
function faceCandidatesAtSize(member: Member, AsRequired: number, size: number): FaceCandidate[] {
  const out: FaceCandidate[] = [];
  const Ab = getBarArea(size);
  const nMax = maxBarsPerLayer(member, size);
  if (nMax < 2) return out;
  // single layer
  for (let n = 2; n <= nMax; n++) {
    const As = n * Ab;
    if (As >= AsRequired) { out.push({ layers: [{ numBars: n, barSize: size }], As }); break; }
  }
  // two layers (outer ≥ inner, inner ≥ 2)
  const maxTotal = 2 * nMax;
  for (let total = Math.max(4, nMax + 1); total <= maxTotal; total++) {
    const As = total * Ab;
    if (As < AsRequired) continue;
    const outer = Math.min(nMax, Math.ceil(total / 2) > nMax ? nMax : Math.ceil(total / 2));
    const inner = total - outer;
    if (inner < 2 || inner > outer) continue;
    out.push({ layers: [{ numBars: outer, barSize: size }, { numBars: inner, barSize: size }], As });
    break;
  }
  return out.sort((a, b) => a.As - b.As);
}

/** Cheapest practical stirrup layout meeting Av/s demand at target. */
function stirrupCandidate(
  AvReqPerIn: number,
  targetDCR: number,
  isEC2: boolean,
): RebarLayout['ties'] & { tieZones: [{ spacing: number }, { spacing: number }, { spacing: number }] } | null {
  const STIRRUP_SIZES    = isEC2 ? STIRRUP_SIZES_EC2    : STIRRUP_SIZES_US;
  const STIRRUP_SPACINGS = isEC2 ? STIRRUP_SPACINGS_EC2 : STIRRUP_SPACINGS_US;
  const demand = AvReqPerIn / targetDCR;
  for (const legs of [2, 4]) {
    for (const size of STIRRUP_SIZES) {
      const Ab = getBarArea(size);
      // largest spacing that still meets demand
      let chosen: number | null = null;
      for (const s of [...STIRRUP_SPACINGS].reverse()) {
        if ((legs * Ab) / s >= demand) { chosen = s; break; }
      }
      if (chosen !== null) {
        const midIdx = Math.min(STIRRUP_SPACINGS.indexOf(chosen) + 1, STIRRUP_SPACINGS.length - 1);
        const mid = STIRRUP_SPACINGS[midIdx];
        return {
          barSize: size, spacing: chosen, legs,
          tieZones: [{ spacing: chosen }, { spacing: mid }, { spacing: chosen }],
        };
      }
    }
  }
  return null;
}

export function suggestGroupRebar(
  members: Member[],
  code: Project['code'],
  targetDCR = 0.9,
): SuggestResult | SuggestError {
  const beams = members.filter(m => m.memberType === 'beam' && m.loads.length > 0);
  if (!beams.length) return { error: 'No designed beam members with loads in this group.' };

  // 1. Demand pass: worst As_req / Av_req across the group (engine demand-side
  //    outputs are independent of the currently provided steel).
  let worstAsTop = 0, worstAsBot = 0, worstAsMin = 0, worstAv = 0;
  let governing: Member = beams[0];
  let governingScore = -1;
  for (const m of beams) {
    for (const lc of m.loads) {
      let r: DesignResults;
      try {
        r = runDesign(m.section, m.material, m.rebar, lc, m.span, code, m.crackParams);
      } catch (e) {
        return { error: `Design failed for ${m.label}: ${(e as Error).message}` };
      }
      worstAsTop = Math.max(worstAsTop, r.As_req_neg);
      worstAsBot = Math.max(worstAsBot, r.As_req_pos);
      worstAsMin = Math.max(worstAsMin, r.As_min);
      worstAv = Math.max(worstAv, r.Av_req, r.Av_min_per_s);
      const score = Math.max(r.As_req_pos, r.As_req_neg);
      if (score > governingScore) { governingScore = score; governing = m; }
    }
  }

  const AsTopReq = Math.max(worstAsTop / targetDCR, worstAsMin);
  const AsBotReq = Math.max(worstAsBot / targetDCR, worstAsMin);

  // Pick the smallest COMMON bar size where both faces have a feasible layout.
  // Top and bottom must share one bar size (bar count / layers may still differ).
  const isEC2 = code === 'EN1992-1-1';
  const LONG_BAR_SIZES    = isEC2 ? LONG_BAR_SIZES_EC2    : LONG_BAR_SIZES_US;
  const STIRRUP_SPACINGS  = isEC2 ? STIRRUP_SPACINGS_EC2  : STIRRUP_SPACINGS_US;
  let sizeIdx = -1;
  let topCands: FaceCandidate[] = [];
  let botCands: FaceCandidate[] = [];
  for (let i = 0; i < LONG_BAR_SIZES.length; i++) {
    const t = faceCandidatesAtSize(governing, AsTopReq, LONG_BAR_SIZES[i]);
    const b = faceCandidatesAtSize(governing, AsBotReq, LONG_BAR_SIZES[i]);
    if (t.length && b.length) { sizeIdx = i; topCands = t; botCands = b; break; }
  }
  if (sizeIdx < 0) {
    return { error: 'No practical bar layout fits this section — consider a larger section.' };
  }
  const stirrups = stirrupCandidate(worstAv, targetDCR, isEC2);
  if (!stirrups) {
    return { error: 'No practical stirrup layout meets the shear demand — consider a wider section.' };
  }

  // 2. Verify the layout on every member; bump candidates if DCR exceeds target.
  //    Bumping a face stays at the current common size (more bars / a layer);
  //    only when a face is exhausted at this size do we step up to the next
  //    common size and recompute both faces.
  let ti = 0, bi = 0;
  for (let retry = 0; retry <= MAX_VERIFY_RETRIES; retry++) {
    const candidate: RebarLayout = {
      topBars: topCands[ti].layers,
      botBars: botCands[bi].layers,
      ties: { barSize: stirrups.barSize, spacing: stirrups.spacing, legs: stirrups.legs },
      tieZones: stirrups.tieZones,
    };

    let worstFlex = 0, worstShear = 0;
    let worstFlexFace: 'top' | 'bot' = 'bot';
    let failed = false;
    for (const m of beams) {
      for (const lc of m.loads) {
        let r: DesignResults;
        try {
          r = runDesign(m.section, m.material, candidate, lc, m.span, code, m.crackParams);
        } catch { failed = true; break; }
        if (r.DCR_flex_neg > worstFlex) { worstFlex = r.DCR_flex_neg; worstFlexFace = 'top'; }
        if (r.DCR_flex_pos > worstFlex) { worstFlex = r.DCR_flex_pos; worstFlexFace = 'bot'; }
        worstShear = Math.max(worstShear, r.DCR_shear);
      }
      if (failed) break;
    }

    const flexOk = !failed && worstFlex <= targetDCR + 1e-6;
    const shearOk = !failed && worstShear <= targetDCR + 1e-6;
    if (flexOk && shearOk) {
      const lengthFt = governing.span ?? 20;
      const steelLb = beams.reduce((s, m) => {
        const len = m.etabs?.pt1 && m.etabs?.pt2
          ? Math.hypot(m.etabs.pt2.x - m.etabs.pt1.x, m.etabs.pt2.y - m.etabs.pt1.y, m.etabs.pt2.z - m.etabs.pt1.z)
          : (m.span ?? lengthFt);
        const As = topCands[ti].As + botCands[bi].As;
        return s + memberSteelWeightLb(As, len);
      }, 0);
      return {
        rebar: candidate,
        worstDCRFlex: worstFlex,
        worstDCRShear: worstShear,
        steelLb,
        governingMemberId: governing.id,
      };
    }

    // Bump the failing face's candidate. Prefer bumping within the current
    // common bar size (more bars / a layer). If both faces are exhausted at
    // this size, step up to the next common size and recompute both faces so
    // top and bottom keep a shared bar size.
    if (!flexOk) {
      if (worstFlexFace === 'top' && ti < topCands.length - 1) ti++;
      else if (worstFlexFace === 'bot' && bi < botCands.length - 1) bi++;
      else if (ti < topCands.length - 1) ti++;
      else if (bi < botCands.length - 1) bi++;
      else {
        // Exhausted at this size — step up to the next common size.
        let stepped = false;
        for (let i = sizeIdx + 1; i < LONG_BAR_SIZES.length; i++) {
          const t = faceCandidatesAtSize(governing, AsTopReq, LONG_BAR_SIZES[i]);
          const b = faceCandidatesAtSize(governing, AsBotReq, LONG_BAR_SIZES[i]);
          if (t.length && b.length) {
            sizeIdx = i; topCands = t; botCands = b; ti = 0; bi = 0; stepped = true; break;
          }
        }
        if (!stepped) return { error: 'Even the largest practical layout exceeds the target DCR — consider a larger section.' };
      }
    } else if (!shearOk) {
      // tighten end-zone spacing one increment, or add legs via next stirrupCandidate demand bump
      const idx = STIRRUP_SPACINGS.indexOf(stirrups.spacing);
      if (idx > 0) {
        stirrups.spacing = STIRRUP_SPACINGS[idx - 1];
        stirrups.tieZones = [{ spacing: stirrups.spacing }, { spacing: STIRRUP_SPACINGS[idx] }, { spacing: stirrups.spacing }];
      } else if (stirrups.legs === 2) {
        stirrups.legs = 4;
        stirrups.spacing = STIRRUP_SPACINGS[STIRRUP_SPACINGS.length - 1];
        stirrups.tieZones = [
          { spacing: stirrups.spacing }, { spacing: stirrups.spacing }, { spacing: stirrups.spacing },
        ];
      } else {
        return { error: 'Shear demand exceeds practical stirrup layouts — consider a wider section.' };
      }
    }
  }
  return { error: 'Could not converge on a layout within the retry budget.' };
}
