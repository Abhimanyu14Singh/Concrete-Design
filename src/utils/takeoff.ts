/**
 * Quantity takeoffs — gross concrete volume and reinforcement weight per member
 * and rolled up for the project, with optional per-GFA (gross floor area) ratios.
 *
 * Ported from Column_Design_DW's takeoff display (concrete yd³, rebar tons,
 * per-GFA intensities). Works for every member type now that columns are
 * first-class: beams and columns both contribute.
 *
 * Steel weight reuses the same intensity model as the savings report
 * (steelWeightPerFt: Σ As × 3.4 lb/ft·in² longitudinal + closed-hoop ties), so
 * takeoff and savings never disagree. Concrete volume is the gross section area
 * × member length (no deduction for the displaced rebar — negligible and the
 * convention used by the source tool).
 */
import type { Member, SectionDimensions, MemberType } from '../types';
import { steelWeightPerFt } from './autoGroup';

const FT3_PER_YD3 = 27;
const LB_PER_TON = 2000; // US short ton

export interface MemberTakeoff {
  memberId: string;
  label: string;
  memberType: MemberType;
  lengthFt: number;
  concreteFt3: number;
  longSteelLb: number;
  tieSteelLb: number;
  steelLb: number;
}

export interface TakeoffByType {
  count: number;
  concreteFt3: number;
  steelLb: number;
}

export interface ProjectTakeoff {
  members: MemberTakeoff[];
  concreteFt3: number;
  concreteYd3: number;
  steelLb: number;
  steelTons: number;
  /** Rebar intensity — lb of steel per yd³ of concrete (typical 90–300). */
  steelLbPerYd3: number;
  byType: Record<MemberType, TakeoffByType>;
  // Per-GFA ratios — present only when a positive gfaFt2 is supplied.
  gfaFt2?: number;
  concreteFt3PerGfa?: number; // ft³ concrete per ft² floor (≈ avg member thickness)
  steelLbPerGfa?: number;     // lb steel per ft² floor (psf)
}

/** Gross cross-section area (in²) for any supported section type. */
export function sectionAreaIn2(s: SectionDimensions): number {
  switch (s.type) {
    case 'circular_column': {
      const D = s.diameter ?? s.b;
      return (Math.PI * D * D) / 4;
    }
    case 'T_beam':
    case 'L_beam': {
      const bw = s.bw ?? s.b;
      const hf = s.hf ?? 0;
      return s.b * hf + bw * Math.max(0, s.h - hf);
    }
    default: // rectangular beam / column
      return s.b * (s.h ?? s.b);
  }
}

/**
 * Member length in feet. Prefers the true ETABS frame length (I→J node
 * distance), then the explicit span, then a type default (columns 10 ft,
 * beams 20 ft).
 */
export function memberLengthFt(m: Member): number {
  const e = m.etabs;
  if (e?.pt1 && e?.pt2) {
    return Math.hypot(e.pt2.x - e.pt1.x, e.pt2.y - e.pt1.y, e.pt2.z - e.pt1.z);
  }
  if (m.span && m.span > 0) return m.span;
  return m.memberType === 'column' ? 10 : 20;
}

/** Concrete volume + reinforcement weight for one member. */
export function memberTakeoff(m: Member): MemberTakeoff {
  const lengthFt = memberLengthFt(m);
  const concreteFt3 = (sectionAreaIn2(m.section) / 144) * lengthFt;
  const w = steelWeightPerFt(m);
  const longSteelLb = w.longLbFt * lengthFt;
  const tieSteelLb = w.stirrupLbFt * lengthFt;
  return {
    memberId: m.id,
    label: m.label,
    memberType: m.memberType,
    lengthFt,
    concreteFt3,
    longSteelLb,
    tieSteelLb,
    steelLb: longSteelLb + tieSteelLb,
  };
}

function emptyByType(): Record<MemberType, TakeoffByType> {
  return {
    beam: { count: 0, concreteFt3: 0, steelLb: 0 },
    column: { count: 0, concreteFt3: 0, steelLb: 0 },
  };
}

/**
 * Roll up a project-wide takeoff. Pass `gfaFt2` (gross floor area, ft²) to also
 * get per-GFA intensities; omit it (or pass ≤ 0) to skip those ratios.
 */
export function projectTakeoff(members: Member[], gfaFt2?: number): ProjectTakeoff {
  const rows = members.map(memberTakeoff);
  const byType = emptyByType();
  let concreteFt3 = 0;
  let steelLb = 0;
  for (const r of rows) {
    concreteFt3 += r.concreteFt3;
    steelLb += r.steelLb;
    const bucket = byType[r.memberType];
    bucket.count += 1;
    bucket.concreteFt3 += r.concreteFt3;
    bucket.steelLb += r.steelLb;
  }
  const concreteYd3 = concreteFt3 / FT3_PER_YD3;
  const out: ProjectTakeoff = {
    members: rows,
    concreteFt3,
    concreteYd3,
    steelLb,
    steelTons: steelLb / LB_PER_TON,
    steelLbPerYd3: concreteYd3 > 0 ? steelLb / concreteYd3 : 0,
    byType,
  };
  if (gfaFt2 && gfaFt2 > 0) {
    out.gfaFt2 = gfaFt2;
    out.concreteFt3PerGfa = concreteFt3 / gfaFt2;
    out.steelLbPerGfa = steelLb / gfaFt2;
  }
  return out;
}
