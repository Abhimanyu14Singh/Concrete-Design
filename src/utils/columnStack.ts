/**
 * Multi-story column stacks — group a model's column members into vertical
 * stacks (one plan location, many floors) and analyse them story-by-story, the
 * way Column_Design_DW does. Plus the capacity-vs-elevation data its capacity
 * curves chart consumes: per-story axial demand against φPn,max at a set of
 * reference steel ratios.
 *
 * Stacks are derived ON THE FLY from the members (their ETABS plan location, or
 * label when there is no ETABS link) — no persistent stack model is added, so a
 * project saved before this feature is unaffected.
 *
 * Units: kips / inches.
 */
import type { Member, MaterialProps, SectionDimensions } from '../types';
import { runDesign } from '../engines';
import { grossArea } from '../engines/column/sectionModel';
import { getBarArea } from './concreteDesign';

export interface StoryColumn {
  memberId: string;
  label: string;
  story: string;
  elevation: number;      // ft (base node z; 0 when no ETABS link)
  b: number; h: number; diameter?: number; circular: boolean;
  PuGov: number;          // governing |Pu| over the member's load cases (kips)
  rho: number;            // provided longitudinal steel ratio
  phiPnMax: number;       // axial capacity φPn,max (kips)
  dcrAxial: number;
  dcrGov: number;         // worst DCR (P-M / axial / shear) over the load cases
}

export interface ColumnStack {
  key: string;            // grouping key (plan location or label)
  label: string;          // representative member label
  stories: StoryColumn[]; // ordered bottom → top
}

export interface CapacityPoint {
  story: string;
  elevation: number;      // ft
  Pu: number;             // governing axial demand at this story (kips)
  phiPnDesign: number;    // capacity at the provided ρ (kips)
  phiPnAtRho: Record<string, number>; // capacity at each reference ρ, keyed "1.0%" etc.
}

export const isColumn = (m: Member): boolean =>
  m.section.type === 'rectangular_column' || m.section.type === 'circular_column';

/** φPn,max (kips) for a column section at an arbitrary steel ratio ρ. */
export function phiPnMaxAtRho(section: SectionDimensions, material: MaterialProps, rho: number, spiral: boolean): number {
  const isCirc = section.type === 'circular_column';
  const D = section.diameter ?? section.b;
  const Ag = grossArea(isCirc, section.b, section.h ?? section.b, D);
  const Ast = rho * Ag;
  const phi = spiral ? 0.75 : 0.65;
  const alpha = spiral ? 0.85 : 0.80;
  return (phi * alpha * (0.85 * material.fc * (Ag - Ast) + material.fy * Ast)) / 1000;
}

/** Provided longitudinal steel ratio ρg = Ast / Ag for the member's bar set. */
function providedRho(m: Member): number {
  const isCirc = m.section.type === 'circular_column';
  const D = m.section.diameter ?? m.section.b;
  const Ag = grossArea(isCirc, m.section.b, m.section.h ?? m.section.b, D);
  const Ast = [...m.rebar.topBars, ...m.rebar.botBars, ...(m.rebar.sideBars ?? [])]
    .reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
  return Ag > 0 ? Ast / Ag : 0;
}

/** Plan-location key for stacking; falls back to the member label. */
function planKey(m: Member): string {
  const p = m.etabs?.pt1;
  if (p) return `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`;
  return m.label;
}

function baseElevation(m: Member): number {
  const a = m.etabs?.pt1, b = m.etabs?.pt2;
  if (a && b) return Math.min(a.z, b.z);
  if (a) return a.z;
  return 0;
}

function analyseStory(m: Member, code: string): StoryColumn {
  const isCirc = m.section.type === 'circular_column';
  const spiral = m.rebar.tieType === 'spiral';
  let PuGov = 0, dcrAxial = 0, dcrGov = 0;
  for (const lc of m.loads) {
    PuGov = Math.max(PuGov, Math.abs(lc.Pu ?? 0));
    const r = runDesign(m.section, m.material, m.rebar, lc, m.span ?? 10, code, m.crackParams);
    dcrAxial = Math.max(dcrAxial, r.DCR_axial ?? 0);
    dcrGov = Math.max(dcrGov, r.DCR_PM ?? 0, r.DCR_axial ?? 0, r.DCR_shear);
  }
  return {
    memberId: m.id, label: m.label, story: m.etabs?.story ?? '—',
    elevation: baseElevation(m),
    b: m.section.b, h: m.section.h ?? m.section.b,
    diameter: isCirc ? (m.section.diameter ?? m.section.b) : undefined, circular: isCirc,
    PuGov, rho: providedRho(m),
    phiPnMax: phiPnMaxAtRho(m.section, m.material, providedRho(m), spiral),
    dcrAxial, dcrGov,
  };
}

/**
 * Group all column members into vertical stacks and analyse each story.
 * Stacks (and the stories inside them) are returned in a stable order: stacks
 * by descending story count then key, stories bottom → top by elevation.
 */
export function buildColumnStacks(members: Member[], code: string): ColumnStack[] {
  const byKey = new Map<string, Member[]>();
  for (const m of members) {
    if (!isColumn(m) || m.loads.length === 0) continue;
    const k = planKey(m);
    const arr = byKey.get(k);
    if (arr) arr.push(m); else byKey.set(k, [m]);
  }
  const stacks: ColumnStack[] = [];
  for (const [key, ms] of byKey) {
    const stories = ms.map(m => analyseStory(m, code)).sort((a, b) => a.elevation - b.elevation);
    stacks.push({ key, label: stories[0]?.label ?? key, stories });
  }
  return stacks.sort((a, b) => b.stories.length - a.stories.length || a.key.localeCompare(b.key));
}

const DEFAULT_REF_RHOS = [0.01, 0.02, 0.03];

/**
 * Capacity-vs-elevation data for one stack: per-story axial demand against
 * φPn,max at the provided ρ and at each reference ρ (default 1/2/3%). Mirrors
 * Column_Design_DW.design_engine.capacity_curve.
 */
export function stackCapacityCurve(
  stack: ColumnStack, members: Member[], code: string, refRhos: number[] = DEFAULT_REF_RHOS,
): CapacityPoint[] {
  const byId = new Map(members.map(m => [m.id, m]));
  return stack.stories.map(sc => {
    const m = byId.get(sc.memberId)!;
    const spiral = m.rebar.tieType === 'spiral';
    const phiPnAtRho: Record<string, number> = {};
    for (const rho of refRhos) {
      phiPnAtRho[`${(rho * 100).toFixed(1)}%`] = phiPnMaxAtRho(m.section, m.material, rho, spiral);
    }
    return {
      story: sc.story, elevation: sc.elevation, Pu: sc.PuGov,
      phiPnDesign: sc.phiPnMax, phiPnAtRho,
    };
  });
}
