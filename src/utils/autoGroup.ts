/**
 * Auto-grouping logic: clusters beams by demand envelope, computes steel savings,
 * and derives reinforcement-intensity metrics for hotspot map overlays.
 *
 * Pure functions — no React, no side effects.
 */
import type { Member, ComboForces, DesignResults, RebarLayout } from '../types';
import { getBarArea, getBarDiam } from './concreteDesign';

// ── Family key ───────────────────────────────────────────────────────────────

/** Beams only cluster within the same section size + material. */
export function familyKey(m: Member): string {
  const { b, h, bw } = m.section;
  const fc = Math.round(m.material.fc);
  const fy = Math.round(m.material.fy);
  return `${bw ?? b}x${h}|${fc}|${fy}`;
}

// ── Demand extraction ────────────────────────────────────────────────────────

export interface MemberDemand {
  memberId: string;
  label: string;
  story: string;
  /** Maximum positive moment across all load cases (kip-ft) */
  MuPos: number;
  /** Maximum negative moment across all load cases (kip-ft, stored as absolute) */
  MuNeg: number;
  /** Maximum shear across all load cases (kips) */
  Vu: number;
  /** Governing normalized demand 0–1 (used for clustering). */
  governing: number;
  lengthFt: number;
  familyKey: string;
}

/** Signed moment envelope from station forces (avoids the absolute-value loss in stationEnvelope). */
export function signedMomentEnvelope(sf: ComboForces[]): { maxPos: number; maxNeg: number; maxV: number } {
  let maxPos = 0, maxNeg = 0, maxV = 0;
  for (const cf of sf) {
    for (const st of cf.stations) {
      if (st.M > maxPos) maxPos = st.M;
      if (-st.M > maxNeg) maxNeg = -st.M;
      if (Math.abs(st.V) > maxV) maxV = Math.abs(st.V);
    }
  }
  return { maxPos, maxNeg, maxV };
}

export function extractDemands(members: Member[]): MemberDemand[] {
  // Raw demands per member
  const raw = members
    .filter(m => m.memberType === 'beam')
    .map(m => {
      let MuPos = 0, MuNeg = 0, Vu = 0;
      // Primary: loads (envelope load case already produced by import)
      for (const lc of m.loads) {
        if (lc.Mu_pos > MuPos) MuPos = lc.Mu_pos;
        if (lc.Mu_neg > MuNeg) MuNeg = lc.Mu_neg;
        if (lc.Vu > Vu) Vu = lc.Vu;
      }
      // Fallback: stationForces envelope
      if (!MuPos && !MuNeg && !Vu && m.stationForces?.length) {
        const env = signedMomentEnvelope(m.stationForces);
        MuPos = env.maxPos; MuNeg = env.maxNeg; Vu = env.maxV;
      }
      const p1 = m.etabs?.pt1, p2 = m.etabs?.pt2;
      const lengthFt = (p1 && p2)
        ? Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z)
        : (m.span ?? 20);
      return { memberId: m.id, label: m.label, story: m.etabs?.story ?? '', MuPos, MuNeg, Vu, lengthFt, fk: familyKey(m) };
    });

  // Family-normalised governing demand (so heavy-shear beams don't disappear into a light-moment bin)
  const families = new Map<string, { maxMuPos: number; maxMuNeg: number; maxVu: number }>();
  for (const r of raw) {
    const cur = families.get(r.fk) ?? { maxMuPos: 0, maxMuNeg: 0, maxVu: 0 };
    if (r.MuPos > cur.maxMuPos) cur.maxMuPos = r.MuPos;
    if (r.MuNeg > cur.maxMuNeg) cur.maxMuNeg = r.MuNeg;
    if (r.Vu > cur.maxVu) cur.maxVu = r.Vu;
    families.set(r.fk, cur);
  }

  return raw.map(r => {
    const fam = families.get(r.fk)!;
    const govM = Math.max(
      fam.maxMuPos > 0 ? r.MuPos / fam.maxMuPos : 0,
      fam.maxMuNeg > 0 ? r.MuNeg / fam.maxMuNeg : 0,
    );
    const govV = fam.maxVu > 0 ? r.Vu / fam.maxVu : 0;
    return {
      memberId: r.memberId, label: r.label, story: r.story,
      MuPos: r.MuPos, MuNeg: r.MuNeg, Vu: r.Vu,
      governing: Math.max(govM, govV),
      lengthFt: r.lengthFt,
      familyKey: r.fk,
    };
  });
}

// ── Jenks natural-breaks clustering ──────────────────────────────────────────

/**
 * Jenks natural breaks for k groups on a 1-D sorted array.
 * Returns (k−1) interior break values (values above which the next group starts).
 * O(k·n²) — fine for hundreds of beams per section family.
 */
export function jenksBreaks(values: number[], k: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0 || k <= 1) return [];
  if (k >= n) return sorted.slice(0, n - 1); // each value is its own group

  // Lower-class-limits matrix and variance-combination matrix
  const lc = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(0));
  const vc = Array.from({ length: n + 1 }, () => new Array<number>(k + 1).fill(Infinity));
  // Initialize class 1: vc[i][1] = variance of sorted[0..i-1]
  let s1 = 0, s2 = 0;
  for (let i = 1; i <= n; i++) {
    lc[i][1] = 1;
    const v = sorted[i - 1];
    s1 += v; s2 += v * v;
    vc[i][1] = s2 - (s1 * s1) / i;
  }

  for (let l = 2; l <= k; l++) {
    for (let i = l; i <= n; i++) {
      let sum = 0, sumSq = 0, w = 0;
      let best = Infinity;
      for (let m = i; m >= l; m--) {
        w++;
        const v = sorted[m - 1];
        sum += v;
        sumSq += v * v;
        const variance = w > 1 ? sumSq - (sum * sum) / w : 0;
        const candidate = vc[m - 1][l - 1] + variance;
        if (candidate < best) {
          best = candidate;
          lc[i][l] = m;
        }
      }
      vc[i][l] = best;
    }
  }

  // Backtrack to find class boundaries
  const breaks: number[] = [];
  let j = n;
  for (let l = k; l > 1; l--) {
    const start = lc[j][l];
    if (start > 1) breaks.push(sorted[start - 2]); // upper bound of previous group
    j = start - 1;
  }
  return breaks.sort((a, b) => a - b);
}

/** Simple quantile breaks (faster seed / fallback). */
export function quantileBreaks(values: number[], k: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0 || k <= 1) return [];
  const breaks: number[] = [];
  for (let i = 1; i < k; i++) {
    const idx = Math.floor((i * n) / k) - 1;
    breaks.push(sorted[Math.max(0, idx)]);
  }
  return [...new Set(breaks)].sort((a, b) => a - b);
}

/** Assign each value to a bin index 0..k−1 given interior breaks. */
export function assignByBreaks(values: number[], breaks: number[]): number[] {
  return values.map(v => {
    let bin = 0;
    for (const br of breaks) { if (v > br) bin++; else break; }
    return bin;
  });
}

/** Goodness-of-variance-fit 0–1 (1 = perfect classification). */
function computeGVF(values: number[], breaks: number[]): number {
  if (values.length === 0) return 1;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const SDCM = values.reduce((s, v) => {
    const bin = breaks.filter(b => v > b).length;
    return s + (v - mean) ** 2;
  }, 0);
  if (SDCM === 0) return 1;

  // SDAM: sum of squared deviations for array means
  const bins = assignByBreaks(values, breaks);
  const kBins = breaks.length + 1;
  const binMeans = Array(kBins).fill(0);
  const binCounts = Array(kBins).fill(0);
  for (let i = 0; i < values.length; i++) { binMeans[bins[i]] += values[i]; binCounts[bins[i]]++; }
  for (let b = 0; b < kBins; b++) if (binCounts[b]) binMeans[b] /= binCounts[b];
  const SDAM = values.reduce((s, v, i) => s + (v - binMeans[bins[i]]) ** 2, 0);
  return 1 - SDAM / SDCM;
}

// ── Auto-group suggestions ────────────────────────────────────────────────────

export interface AutoGroupBin {
  memberIds: string[];
  demandMin: number;
  demandMax: number;
  /** Representative (worst) governing demand in this bin. */
  worstGoverning: number;
  /** Worst raw MuPos in this bin (kip-ft). */
  worstMuPos: number;
  /** Worst raw MuNeg in this bin (kip-ft). */
  worstMuNeg: number;
  /** Worst raw Vu in this bin (kips). */
  worstVu: number;
}

export interface AutoGroupSuggestion {
  familyKey: string;
  /** e.g. "14×24" for readability */
  familyLabel: string;
  breaks: number[];          // interior break values on governing demand scale
  bins: AutoGroupBin[];
  algorithm: 'jenks' | 'quantile';
  gvf: number;               // goodness-of-variance fit
}

export function familyLabel(fk: string): string {
  const dim = fk.split('|')[0]; // e.g. "14x24"
  return dim.replace('x', '×');
}

export function suggestGroups(
  members: Member[],
  kPerFamily: number | 'auto' = 'auto',
  algorithm: 'jenks' | 'quantile' = 'jenks',
): AutoGroupSuggestion[] {
  const demands = extractDemands(members);
  const byFamily = new Map<string, MemberDemand[]>();
  for (const d of demands) {
    const list = byFamily.get(d.familyKey) ?? [];
    list.push(d);
    byFamily.set(d.familyKey, list);
  }

  const suggestions: AutoGroupSuggestion[] = [];

  for (const [fk, fdemands] of byFamily) {
    const vals = fdemands.map(d => d.governing);

    let breaks: number[];
    let kUsed: number;
    const breakFn = algorithm === 'jenks' ? jenksBreaks : quantileBreaks;

    if (kPerFamily === 'auto') {
      let best = { k: 1, breaks: [] as number[], gvf: 0 };
      for (let k = 2; k <= Math.min(5, fdemands.length); k++) {
        const br = breakFn(vals, k);
        const gvf = computeGVF(vals, br);
        if (gvf > best.gvf) best = { k, breaks: br, gvf };
        if (gvf >= 0.85) break;
      }
      breaks = best.breaks;
      kUsed = best.k;
    } else {
      kUsed = Math.min(kPerFamily, fdemands.length);
      breaks = breakFn(vals, kUsed);
    }

    const binAssign = assignByBreaks(vals, breaks);
    const numBins = breaks.length + 1;
    const bins: AutoGroupBin[] = Array.from({ length: numBins }, () => ({
      memberIds: [], demandMin: Infinity, demandMax: -Infinity,
      worstGoverning: 0, worstMuPos: 0, worstMuNeg: 0, worstVu: 0,
    }));
    for (let i = 0; i < fdemands.length; i++) {
      const d = fdemands[i];
      const b = bins[binAssign[i]];
      b.memberIds.push(d.memberId);
      if (d.governing < b.demandMin) b.demandMin = d.governing;
      if (d.governing > b.demandMax) b.demandMax = d.governing;
      if (d.governing > b.worstGoverning) { b.worstGoverning = d.governing; b.worstMuPos = d.MuPos; b.worstMuNeg = d.MuNeg; b.worstVu = d.Vu; }
    }
    for (const b of bins) { if (b.demandMin === Infinity) b.demandMin = 0; if (b.demandMax === -Infinity) b.demandMax = 0; }

    suggestions.push({
      familyKey: fk,
      familyLabel: familyLabel(fk),
      breaks,
      bins: bins.filter(b => b.memberIds.length > 0),
      algorithm,
      gvf: computeGVF(vals, breaks),
    });
  }

  return suggestions.sort((a, b) => a.familyKey.localeCompare(b.familyKey));
}

// ── Savings computation ───────────────────────────────────────────────────────

const STEEL_LB_PER_FT_IN2 = 3.4; // 1 in² × 1 ft length ≈ 3.4 lb (490 lb/ft³ × 1/144)

export function memberSteelWeightLb(As_in2: number, lengthFt: number): number {
  return As_in2 * lengthFt * STEEL_LB_PER_FT_IN2;
}

export interface MemberSavings {
  memberId: string;
  label: string;
  story: string;
  familyKey: string;
  lengthFt: number;
  dcrGov: number;          // governing DCR (max of flex/shear)
  AsProvTop: number;       // in²
  AsProvBot: number;
  AsReqTop: number;        // at targetDCR
  AsReqBot: number;
  flexSlackLb: number;     // longitudinal steel savings (lb)
  shearSlackLb: number;    // stirrup savings (lb) — approximate
  totalSlackLb: number;    // lb
}

export interface SavingsSummary {
  perMember: MemberSavings[];
  perGroup: Record<string, number>;  // groupId → lb saved
  totalLb: number;
  totalTons: number;
}

function rebarAs(bars: RebarLayout['topBars']): number {
  return bars.reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
}

function stirrupAvProvPerIn(rebar: RebarLayout): number {
  // Governing zone = end zone (zone 0) which usually governs; fallback to ties.
  const barSize = rebar.ties?.barSize ?? 4;
  const legs = rebar.ties?.legs ?? 2;
  const Ab = getBarArea(barSize);
  if (rebar.tieZones) {
    const s = rebar.tieZones[0].spacing; // end zone
    return legs * Ab / s;
  }
  const s = rebar.ties?.spacing ?? 12;
  return legs * Ab / s;
}

export function computeSavings(
  members: Member[],
  resultsById: Record<string, DesignResults>,
  designGroupsById: Record<string, string>, // memberId → groupId
  targetDCR = 0.9,
): SavingsSummary {
  const perMember: MemberSavings[] = [];
  const perGroup: Record<string, number> = {};

  for (const m of members) {
    if (m.memberType !== 'beam') continue;
    const res = resultsById[m.id];
    if (!res) continue;

    const p1 = m.etabs?.pt1, p2 = m.etabs?.pt2;
    const lengthFt = (p1 && p2)
      ? Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z)
      : (m.span ?? 20);

    const AsProvTop = rebarAs(m.rebar.topBars);
    const AsProvBot = rebarAs(m.rebar.botBars);

    // Minimum area we still need at targetDCR (can't go below As_min)
    const AsReqTop = Math.max(res.As_req_neg / targetDCR, res.As_min);
    const AsReqBot = Math.max(res.As_req_pos / targetDCR, res.As_min);

    const flexSlackTop = Math.max(0, AsProvTop - AsReqTop);
    const flexSlackBot = Math.max(0, AsProvBot - AsReqBot);
    const flexSlackLb = memberSteelWeightLb(flexSlackTop + flexSlackBot, lengthFt);

    // Stirrup slack: governing Av/s required vs provided
    const AvProvPerIn = stirrupAvProvPerIn(m.rebar);
    const AvReqPerIn = Math.max(res.Av_req, res.Av_min_per_s);
    const AvSlackPerIn = Math.max(0, AvProvPerIn - AvReqPerIn / targetDCR);
    // Convert Av/s slack (in²/in) to lb: × span length
    const shearSlackLb = memberSteelWeightLb(AvSlackPerIn * 12, lengthFt); // in²/ft × ft × 3.4

    const dcrGov = Math.max(res.DCR_flex_pos, res.DCR_flex_neg, res.DCR_shear);
    const totalSlackLb = flexSlackLb + shearSlackLb;

    const story = m.etabs?.story ?? '';
    perMember.push({
      memberId: m.id, label: m.label, story, familyKey: familyKey(m), lengthFt,
      dcrGov, AsProvTop, AsProvBot, AsReqTop, AsReqBot,
      flexSlackLb, shearSlackLb, totalSlackLb,
    });

    const gId = designGroupsById[m.id];
    if (gId) perGroup[gId] = (perGroup[gId] ?? 0) + totalSlackLb;
  }

  perMember.sort((a, b) => b.totalSlackLb - a.totalSlackLb);
  const totalLb = perMember.reduce((s, r) => s + r.totalSlackLb, 0);
  return { perMember, perGroup, totalLb, totalTons: totalLb / 2000 };
}

// ── Hotspot metrics ───────────────────────────────────────────────────────────

function effectiveDepth(m: Member, face: 'top' | 'bot'): number {
  const bars = face === 'top' ? m.rebar.topBars : m.rebar.botBars;
  const dStir = getBarDiam(m.section.stirrupDia);
  const cc = m.section.coverClear;
  // Conservative: use first (outermost) layer bar diameter
  const db = bars.length > 0 ? getBarDiam(bars[0].barSize) : getBarDiam(8);
  return m.section.h - cc - dStir - db / 2;
}

/** Longitudinal reinforcement ratio ρ = As/(b·d) × 100 (%) for top or bot face. */
export function flexSteelRatioPct(m: Member, face: 'top' | 'bot'): number {
  const bars = face === 'top' ? m.rebar.topBars : m.rebar.botBars;
  const As = rebarAs(bars);
  const bw = m.section.bw ?? m.section.b;
  const d = effectiveDepth(m, face);
  if (!bw || !d) return 0;
  return (As / (bw * d)) * 100;
}

/** Av/s in in²/ft (governing zone). */
export function stirrupAvPerFt(m: Member): number {
  return stirrupAvProvPerIn(m.rebar) * 12;
}
