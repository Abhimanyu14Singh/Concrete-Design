/**
 * Type surface for the workspace's design runner — only what typed code (its tests)
 * touches. Same rule as `popoutBus.d.ts`: a declaration file that mirrors the whole
 * module is a second copy to keep in step.
 */

import type { DesignCode, CrackControlParams, DesignResults, DesignWarning } from '../types';

/**
 * The PROJECT-level design preferences every check must run under.
 *
 * These exist as an object because `runDesign` takes them positionally — a call that
 * stops short of the ninth argument silently designs under different rules than the
 * project asked for, which is how "neglect torsion" came to be honoured everywhere
 * except the workspace shell.
 */
export interface DesignPrefs {
  /** The project's SLS quasi-permanent combo. Crack params are resolved PER MEMBER from
   *  it, because the quasi-permanent moments come from each member's station forces. */
  slsCombo?: string;
  /** Crack-control params for the EC2 SLS check. Overrides `slsCombo` outright when set. */
  crack?: CrackControlParams;
  /** EC2 §6.2.3 strut angle. Undefined = the engine's 2.5. */
  cotTheta?: number;
  /** Project "neglect torsion": Tu is dropped to 0 and the torsion check is not shown. */
  ignoreTorsion?: boolean;
  /** Bresler contour exponent for the biaxial check. */
  biaxialAlpha?: number;
}

/** The checks a beam has, in chip order. Torsion is omitted when it is being neglected. */
export declare function checksFor(
  code: DesignCode | string, ignoreTorsion?: boolean,
): Array<{ key: string; label: string; of: (r: never) => number }>;

/** Design every load row of a member under `prefs` and summarise. `prefs` travels on the
 *  returned object so anything derived from it later is built under the same rules. */
export declare function designMemberAllRows(
  member: unknown, code: DesignCode | string, prefs?: DesignPrefs,
): DesignAllRows;

/** One designed load row. */
export interface DesignRow { load: unknown; result: DesignResults }

/**
 * Every row of one member, plus the summaries the UI reads.
 *
 * `result` is the engine's own `DesignResults`, not `Record<string, number>`: that
 * shape could not describe `warnings` at all, so typed callers reaching for a row's
 * warning list had nothing to reach for.
 */
export interface DesignAllRows {
  member: unknown; code: string; span: number;
  rows: DesignRow[];
  checks: Array<{ key: string; label: string; dcr: number; row: DesignRow }>;
  governing: { key: string; label: string; dcr: number; row: DesignRow };
  dcr: number;
  /** The DEDUPLICATED UNION of every row's warnings, with how many rows raised each.
   *  This — not the governing row's list — is what the dashboards show. */
  warnings: Array<DesignWarning & { count: number; first: unknown }>;
  prefs: DesignPrefs;
}

/**
 * Per-member maps for the dashboards.
 *
 * `resultById` carries the GOVERNING ROW's capacities and status, but the UNION of
 * every row's warnings spliced over the top — a member has many rows and several
 * checks only run on some of them, so one row's list is not the member's.
 */
export declare function summaryMaps(designs: DesignAllRows[]): {
  resultById: Record<string, DesignResults>;
  dcrById: Record<string, number>;
  modeById: Record<string, {
    flexPos: number; flexNeg: number; shear: number; torsion: number; wk: number;
  }>;
};

/** One design group as the sweep needs it: an id, a label for the note, and members. */
export interface SweepGroup { id: string; label: string; memberIds: string[] }

/**
 * What a sweep returns: the cage per resolved group, why each failure failed, the
 * one-line note the UI prints verbatim, and the same outcome counted.
 *
 * This file is hand-written, and both sweep functions were declared TWICE below with
 * disagreeing shapes — `kind` required in one and optional in the other. TypeScript
 * silently used the first, so the second was documentation that described nothing and
 * could drift indefinitely. Collapsed to one declaration each; neither type was imported
 * anywhere, so nothing depended on the duplicate.
 */
export interface SweepResult {
  rebarByGroup: Map<string, unknown>;
  /** Keyed by group id. `kind` is `SuggestError['kind']`, absent on an unclassified
   *  refusal. Carries the user's LABELS — for the UI, never for the usage log. */
  errorByGroup: Map<string, { label: string; kind?: string; at?: string; error: string }>;
  note: string;
  /** The sweep as numbers — see `createSweep.finish` in design.js on why this exists
   *  beside `note`. Counts and reason codes only; no labels. */
  stats: SuggestSweepStats;
}

/** A Suggest sweep counted by outcome. Safe to record: counts and codes, no labels. */
export interface SuggestSweepStats {
  /** Groups the sweep actually tried — empty groups are skipped and counted in neither. */
  attempted: number;
  resolved: number;
  /**
   * Of the RESOLVED, how many came back flagged rather than clean. Mutually exclusive
   * with each other, so they sum to at most `resolved` — a group that is section-limited
   * is short too, and counting it in both would report one problem as two.
   *
   * `belowTarget` — the cage is the section's ceiling and still over target on flexure,
   * shear or torsion. `sectionLimited` — a cross-section limit (shear+torsion crushing,
   * or a hard spacing) that no reinforcement can answer.
   */
  belowTarget?: number;
  sectionLimited?: number;
  failed: number;
  /** Keyed by `SuggestError['kind']`, plus `unclassified` for a refusal carrying none. */
  reasons: Record<string, number>;
  /** Worst torsion DCR left behind by the cages that WERE applied. */
  worstTorsionAfter: number;
  /** Applied cages still governed by torsion above target — expected to be 0. */
  torsionGoverned: number;
}

/** Auto-size every group's cage, synchronously. */
export declare function suggestAllGroups(
  groups: SweepGroup[], members: unknown[], code: DesignCode | string, barFamily: string,
  floors?: unknown, targetDCR?: number, prefs?: DesignPrefs,
): SweepResult;

/**
 * The same sweep, one group per turn of the event loop — what the status bar narrates.
 *
 * `gate` is awaited BETWEEN groups (see utils/activity.ts), which is where a pause
 * lands; `onProgress` is called before each group and once more at completion, with
 * `label` null on that last call.
 */
export declare function suggestAllGroupsChunked(
  groups: SweepGroup[], members: unknown[], code: DesignCode | string, barFamily: string,
  floors?: unknown, targetDCR?: number, prefs?: DesignPrefs,
  hooks?: {
    gate?: () => Promise<void>;
    onProgress?: (done: number, total: number, label: string | null) => void;
  },
): Promise<SweepResult>;

/** Station forces for one load combination, as imported from ETABS. */
export interface ComboForcesLike {
  combo: string;
  stations: { x: number; M: number; V: number; P?: number; T?: number }[];
}

/**
 * The M or V curve the plan overlay draws, as `[{x, v}]` sorted by station.
 *
 * With `combo`, that combination's OWN stations — a real diagram, signed, with its
 * inflection points where they actually are. Empty when the member does not carry that
 * combo (callers fall back to the envelope).
 *
 * Without it, the envelope: at each station the value of largest MAGNITUDE across every
 * combo, carrying its sign. Right for "the worst this member sees anywhere", but the
 * points come from different load cases, so the curve through them is not a diagram of
 * anything — which is why the combo is selectable.
 */
export declare function stationEnvelope(
  stationForces: ComboForcesLike[] | undefined | null,
  type: 'M' | 'V',
  combo?: string,
): { x: number; v: number }[];

/** Every combo name in the model, in import order — a UNION across members, since they
 *  do not all carry the same combinations. */
export declare function comboNames(
  members: { stationForces?: ComboForcesLike[] }[] | undefined | null,
): string[];

/**
 * Structural fingerprint of a model — sections, cages and demand. Equal fingerprints
 * mean the working model has not diverged from a frozen one, which is how the model
 * picker decides whether to offer "Working model" as a separate entry.
 */
export declare function modelSignatureOf(members: unknown[] | null | undefined): string;
