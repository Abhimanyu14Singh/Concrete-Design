/**
 * Public type surface for the concrete design application.
 *
 * All imports from '../types' or '../../types' still resolve here.
 * Actual definitions live in the focused sub-files:
 *
 *   common.ts  — shared primitives (material, bar tables, warnings)
 *   beam.ts    — beam section / rebar / load / results types
 *   column.ts  — column stubs (implement when ready)
 *   wall.ts    — wall stubs    (implement when ready)
 *   member.ts  — discriminated-union Member + MemberType
 */

// ── Shared ───────────────────────────────────────────────────────────────────
export type { DesignCode, ExposureClass } from './common';
export type { MaterialProps, BarGroup, TieLayout } from './common';
export type { DesignWarning, BaseDesignResults, BaseLoadCase, BaseMember } from './common';

// ── Beam ─────────────────────────────────────────────────────────────────────
export type { BeamSectionType, BeamSection, BeamRebar, BeamLoadCase, BeamResults, BeamMember } from './beam';

// ── Column stubs ─────────────────────────────────────────────────────────────
export type { ColumnSectionType, ColumnSection, ColumnRebar, ColumnLoadCase, ColumnResults, ColumnMember } from './column';

// ── Wall stubs ───────────────────────────────────────────────────────────────
export type { WallSectionType, WallSection, WallRebar, WallLoadCase, WallResults, WallMember } from './wall';

// ── Member union ─────────────────────────────────────────────────────────────
export type { Member, MemberType } from './member';

// ── Backwards-compatible aliases (existing code uses these names) ─────────────
// SectionType, SectionDimensions, RebarLayout, LoadCase, DesignResults are the
// beam-specific types exposed under their original names so existing imports
// (concreteDesign.ts, calcBreakdown.ts, tests, components) need no changes.
export type { BeamSectionType as SectionType }     from './beam';
export type { BeamSection     as SectionDimensions } from './beam';
export type { BeamRebar       as RebarLayout }       from './beam';
export type { BeamLoadCase    as LoadCase }           from './beam';
export type { BeamResults     as DesignResults }      from './beam';

// ── Project ───────────────────────────────────────────────────────────────────
import type { Member } from './member';
import type { DesignCode } from './common';

export interface Project {
  id: string;
  name: string;
  code: DesignCode;
  description: string;
  engineer: string;
  date: string;
  members: Member[];
}
