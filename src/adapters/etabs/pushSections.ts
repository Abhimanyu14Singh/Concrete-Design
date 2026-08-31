/**
 * Pushing resized design groups back into the ETABS model — define the frame-section
 * properties, put each group's frames on its property, save the model under a new name
 * and re-run the analysis.
 *
 * This is the write half of the round trip the app exists to serve. The read half
 * (`TableConnection`) has been there since the import wizard; until now the only thing
 * that went the other way was `pushGroups`, which labels frames with an ETABS *group*
 * and changes nothing about them.
 *
 * ── Why a plan, and not four calls in a row ──────────────────────────────────────
 * The transport is the untestable part — it needs a running ETABS. So everything that
 * can be decided WITHOUT one is decided here, in `buildSectionPushPlan`: which
 * properties to define, what to call them, which material each carries, what the
 * dimensions are in the model's own units, which frames move, where the file goes. The
 * plan is plain data, so a test can assert the exact calls the app is about to make
 * against a mock connection — the arguments, the order, the unit conversion, and the
 * refusal to run before saving.
 *
 * ── Order matters, and each step has a reason ────────────────────────────────────
 *   1. saveAs    FIRST, and this is the important one. Defining or assigning a section
 *                requires an UNLOCKED model, and unlocking discards the analysis
 *                results. Doing that before the save would unlock the model the
 *                engineer has open — the analysed one they are working from — and throw
 *                away its results to build a copy. `File.Save(path)` is a Save As: ETABS
 *                continues with the NEW file as the current model, so everything after
 *                this point happens to the copy and the original is left on disk,
 *                analysed and untouched.
 *   2. define    a frame cannot be assigned to a property that does not exist yet.
 *                Unlocks the COPY, which is the one place unlocking is free.
 *   3. rebar     optional; the cage the app designed, so ETABS' own beam design sees
 *                the steel this app chose rather than re-sizing it
 *   4. assign    frames move onto the new properties
 *   5. run       the analysis, on the copy
 *   6. reimport  read the NEW forces back onto the members. Resizing changes stiffness,
 *                which redistributes force in an indeterminate frame — a beam made
 *                deeper attracts MORE moment — so without this the app goes on checking
 *                the new sections against the demand from before they were new, which
 *                flatters exactly the members that were just enlarged.
 *
 * This used to run define→assign→save, which edited the open model in memory and saved
 * afterwards. That does keep the original FILE byte-identical, but only by unlocking the
 * live model first — so the engineer's analysed session was cleared as a side effect of
 * making a copy. Saving first costs nothing and avoids it entirely.
 */
import type { EtabsConnection } from './connection';
import type { ComboForces } from '../../types';

/** Section geometry as ETABS holds it. Depth is T3, width is T2 — see `toModelUnits`. */
export interface SectionPushProperty {
  /** ETABS frame-property name, e.g. `B16X32-C5000`. */
  name: string;
  /** Material property name. The grade the model already defines, where there is one. */
  matProp: string;
  /** Concrete strength, app units (psi). Only used when `matProp` has to be created. */
  fc?: number;
  /** Depth h and width b, app units (in). Converted at plan time, never at call time. */
  depth: number;
  width: number;
  /** Frames that move onto this property (ETABS frame names, not member ids). */
  frameNames: string[];
  /** Designed cage, when it should travel with the section. Areas in in². */
  rebar?: {
    matLong: string;
    matConfine: string;
    coverTop: number;
    coverBot: number;
    topArea: number;
    botArea: number;
  };
}

/**
 * The complete, already-converted plan for a section push — every call that will be
 * made, in order, with no decisions left to take at execution time.
 *
 * Building the plan is separated from running it precisely so the whole thing can be
 * tested and shown to the user for confirmation before anything touches their model.
 */
export interface SectionPushPlan {
  /** In call order, exactly as `runSectionPush` will issue them. */
  define: Array<{ name: string; matProp: string; fc?: number; depth: number; width: number }>;
  rebar: Array<{
    name: string; matLong: string; matConfine: string;
    coverTop: number; coverBot: number;
    topLeftArea: number; topRightArea: number; botLeftArea: number; botRightArea: number;
  }>;
  assign: Array<{ name: string; frameNames: string[] }>;
  savePath: string;
  runAnalysis: boolean;
  /**
   * The combinations to re-read after the analysis — THE SAME SET the model was
   * imported under.
   *
   * Not "all combos in the model": a design compared against a different load case than
   * the one it was sized on is not a comparison. The list comes from the members' own
   * `stationForces`, so it is literally what was imported, not a guess at it.
   */
  combos: string[];
  /** Totals for the confirmation screen — no call reads these. */
  propertyCount: number;
  frameCount: number;
  /** The length factor applied, so a reviewer can see the conversion that happened. */
  lengthFactor: number;
}

/**
 * ETABS length units per app inch, keyed by the `eUnits` enum the sidecar reports.
 *
 * The app stores every dimension in INCHES; `SetRectangle` takes the model's PRESENT
 * units. Converting here rather than calling `SetPresentUnits` is deliberate: setting
 * units unlocks the model and discards results, and doing that as a side effect of a
 * unit mismatch — on a model the engineer may not have meant to push yet — is a bad
 * trade for arithmetic the app can do itself. (See the note above `SelectCombos` in the
 * sidecar, which avoids the same call for the same reason.)
 *
 * eUnits: 1=lb_in 2=lb_ft 3=kip_in 4=kip_ft 5=kN_mm 6=kN_m 7=kgf_mm 8=kgf_m 9=N_mm
 * 10=N_m 11=Ton_mm 12=Ton_m 13=kN_cm 14=kgf_cm 15=N_cm 16=Ton_cm
 */
const IN_PER_UNIT: Record<number, number> = {
  1: 1, 2: 1 / 12, 3: 1, 4: 1 / 12,
  5: 25.4, 6: 0.0254, 7: 25.4, 8: 0.0254, 9: 25.4,
  10: 0.0254, 11: 25.4, 12: 0.0254, 13: 2.54, 14: 2.54, 15: 2.54, 16: 2.54,
};

/** Length factor for an eUnits value; 1 (inches) when the enum is unknown or unread. */
export function lengthFactorFor(eUnits: number | null | undefined): number {
  return (eUnits != null && IN_PER_UNIT[eUnits]) || 1;
}

/** Stress factor: psi → the model's force/length². Only f'c travels, for a new material. */
function stressFactorFor(eUnits: number | null | undefined): number {
  // force per app kip × (app in / model length)²  — derived from the same table rather
  // than a second one, so the two cannot disagree about what unit system 6 is.
  const len = lengthFactorFor(eUnits);              // model length per inch
  const kipPerForce: Record<number, number> = {
    1: 1e-3, 2: 1e-3, 3: 1, 4: 1,                    // lb, kip
    5: 4.4482, 6: 4.4482, 13: 4.4482,                // kN
    7: 453.59, 8: 453.59, 14: 453.59,                // kgf
    9: 4448.2, 10: 4448.2, 15: 4448.2,               // N
    11: 0.45359, 12: 0.45359, 16: 0.45359,           // Ton (metric)
  };
  const force = (eUnits != null && kipPerForce[eUnits]) || 1e-3;  // psi is lb/in² by default
  return (force / 1000) / (len * len);
}

/**
 * Turn the resized properties into the exact call sequence, in the model's units.
 *
 * `savePath` must be a PATH, not a name: `File.Save` writes where it is told, and a bare
 * "model_rev2.EDB" would land wherever ETABS' working directory happens to point.
 */
export function buildSectionPushPlan(
  properties: SectionPushProperty[],
  savePath: string,
  opts: { eUnits?: number | null; runAnalysis?: boolean; combos?: string[] } = {},
): SectionPushPlan {
  const len = lengthFactorFor(opts.eUnits);
  const stress = stressFactorFor(opts.eUnits);
  const area = len * len;

  // Two groups that resized to the same section share one property: ETABS rejects the
  // second definition of a name, and an engineer reading the schedule should not find
  // B16X32-C5000 twice. Frames merge; the first definition's geometry wins, and
  // `validateSectionPush` is what stops two DIFFERENT sections sharing a name.
  const byName = new Map<string, SectionPushProperty>();
  for (const p of properties) {
    const seen = byName.get(p.name);
    if (seen) seen.frameNames = [...new Set([...seen.frameNames, ...p.frameNames])];
    else byName.set(p.name, { ...p, frameNames: [...new Set(p.frameNames)] });
  }
  const props = [...byName.values()];

  return {
    define: props.map(p => ({
      name: p.name,
      matProp: p.matProp,
      ...(p.fc != null ? { fc: p.fc * stress } : {}),
      depth: p.depth * len,
      width: p.width * len,
    })),
    rebar: props.filter(p => p.rebar).map(p => ({
      name: p.name,
      matLong: p.rebar!.matLong,
      matConfine: p.rebar!.matConfine,
      coverTop: p.rebar!.coverTop * len,
      coverBot: p.rebar!.coverBot * len,
      // ETABS takes a corner area per face; the app designs a face total. Splitting it
      // in half keeps the FACE total right, which is what the capacity depends on.
      topLeftArea: (p.rebar!.topArea / 2) * area,
      topRightArea: (p.rebar!.topArea / 2) * area,
      botLeftArea: (p.rebar!.botArea / 2) * area,
      botRightArea: (p.rebar!.botArea / 2) * area,
    })),
    assign: props.map(p => ({ name: p.name, frameNames: p.frameNames })),
    savePath,
    runAnalysis: opts.runAnalysis ?? true,
    combos: opts.combos ?? [],
    propertyCount: props.length,
    frameCount: props.reduce((n, p) => n + p.frameNames.length, 0),
    lengthFactor: len,
  };
}

/** Everything that would make ETABS reject the push, checked before anything is written. */
export function validateSectionPush(properties: SectionPushProperty[], savePath: string): string[] {
  const errors: string[] = [];
  if (!savePath.trim()) errors.push('Give the new model a file path.');
  else if (!/\.edb$/i.test(savePath.trim())) errors.push('The model path must end in .EDB.');

  const bySig = new Map<string, string>();
  for (const p of properties) {
    const name = p.name.trim();
    if (!name) { errors.push('Every resized group needs a frame-property name.'); break; }
    if (!(p.depth > 0) || !(p.width > 0)) errors.push(`"${name}" has a zero dimension.`);
    if (!p.frameNames.length) errors.push(`"${name}" has no frames to assign.`);
    const sig = `${p.depth}x${p.width}`;
    if (bySig.has(name) && bySig.get(name) !== sig) {
      errors.push(`"${name}" is used for two different sections — give one of them another name.`);
      break;
    }
    bySig.set(name, sig);
  }
  return errors;
}

/** What actually happened. `failures` is per-item and non-fatal — a push that could not
 *  place three frames still reports the rest as done, rather than reading as a failure. */
export interface SectionPushOutcome {
  defined: number;
  assigned: number;
  frames: number;
  saved: string | null;
  ran: boolean;
  failures: string[];
  /**
   * Station forces read back from the re-analysed copy, keyed by ETABS frame name —
   * the output of the last step and the thing that closes the loop.
   *
   * Until this existed the round trip stopped one step short: the app pushed bigger
   * sections, ETABS re-ran, and the app went on checking those sections against the
   * forces from BEFORE the resize. In an indeterminate frame that is the unconservative
   * direction for exactly the members that were enlarged — a stiffer beam attracts more
   * moment, and the DCR shown would have been better than the truth.
   */
  forces?: Record<string, ComboForces[]>;
  /** How many members the caller updated from `forces`. Filled in by the caller. */
  reimported?: number;
}

/** The five steps a connection must expose for the write half. All optional on the
 *  interface, so a read-only transport (file import, mock) simply does not offer it. */
export type SectionPushCapable = Pick<EtabsConnection,
  'defineFrameSections' | 'assignSections' | 'setRebarBeam' | 'saveModelAs' | 'runAnalysis'
  | 'getStationForces'>;

/** True when this connection can actually perform the write half. */
export function canPushSections(conn: Partial<SectionPushCapable> | null | undefined): boolean {
  return !!(conn?.defineFrameSections && conn?.assignSections && conn?.saveModelAs && conn?.runAnalysis);
}

/**
 * Run the plan. Stops at the first step that fails outright, because the steps are
 * ordered by dependency — assigning frames to properties that were not defined would
 * report a second, derived failure and bury the first.
 *
 * Per-item failures (one frame that would not move) are COLLECTED, not thrown: a push
 * that moved 39 of 40 frames is a result the engineer needs to see, not an exception.
 */
export async function runSectionPush(
  conn: Partial<SectionPushCapable>,
  plan: SectionPushPlan,
  onProgress?: (step: string) => void,
): Promise<SectionPushOutcome> {
  const out: SectionPushOutcome = { defined: 0, assigned: 0, frames: plan.frameCount, saved: null, ran: false, failures: [] };
  if (!canPushSections(conn)) throw new Error('This ETABS connection cannot write sections — a live desktop connection is required.');

  // Walks the SAME list the stepped UI walks. Two copies of this sequence is how the
  // one-click push and the button-at-a-time push would come to do subtly different
  // things — a different order, or a step one of them forgets.
  for (const step of SECTION_PUSH_STEPS) {
    if (!step.applies(plan)) continue;
    onProgress?.(`${step.detail(plan)}…`);
    await step.run(conn, plan, out);
  }
  onProgress?.('Done.');
  return out;
}

/**
 * The push, as SEPARATELY RUNNABLE steps.
 *
 * `runSectionPush` above fires all five back to back, which is right for a one-click
 * push and wrong for a careful one: the five do very different things — three edit the
 * open model in memory, one writes a file, one can take minutes — and an engineer
 * pushing to a real job wants to watch each land before authorising the next. On a
 * shared model that is not fussiness; steps 1–3 UNLOCK the model and discard its
 * results, so "did the assign actually take?" is worth answering before saving over
 * anything.
 *
 * One list, in call order, with the ORDER'S REASONS attached — because the order is not
 * arbitrary and a caller reordering the buttons would silently break the push:
 *
 *   saveAs → define   defining unlocks the model and clears its results; do it AFTER
 *                     the Save As and it is the copy that gets unlocked, not the
 *                     analysed model the engineer has open
 *   define → assign   a frame cannot go on a property that does not exist yet
 *   assign → run      ETABS refuses to run an unsaved model, and the save already
 *                     happened at step 1
 *
 * `applies` is what keeps the list honest when a step has nothing to do — no designed
 * cage to write, or the engineer unticked "re-run" — so the UI shows four buttons
 * rather than five with one permanently inert.
 */
export interface SectionPushStep {
  id: 'define' | 'rebar' | 'assign' | 'save' | 'run' | 'reimport';
  /** Button label. */
  label: string;
  /** What it will do, for the tooltip — in the plan's own numbers. */
  detail: (plan: SectionPushPlan) => string;
  /** False when this plan has nothing for this step to do. */
  applies: (plan: SectionPushPlan) => boolean;
  /** Run it, folding what happened into `out`. Throws on a transport failure. */
  run: (conn: Partial<SectionPushCapable>, plan: SectionPushPlan, out: SectionPushOutcome) => Promise<void>;
}

export const SECTION_PUSH_STEPS: SectionPushStep[] = [
  {
    id: 'save',
    label: 'Save a copy as',
    detail: p => `Save the model as ${p.savePath} and continue in THAT file — the original `
      + 'stays on disk with its analysis results intact',
    applies: () => true,
    run: async (conn, plan, out) => {
      const s = await conn.saveModelAs!(plan.savePath);
      out.saved = s.path;
    },
  },
  {
    id: 'define',
    label: 'Define properties',
    detail: p => `Unlock the saved copy and create ${p.define.length} frame `
      + `propert${p.define.length === 1 ? 'y' : 'ies'} in it`,
    applies: p => p.define.length > 0,
    run: async (conn, plan, out) => {
      const d = await conn.defineFrameSections!(plan.define);
      out.defined = d.defined;
      out.failures.push(...(d.failures ?? []));
    },
  },
  {
    id: 'rebar',
    label: 'Write rebar',
    detail: p => `Put the designed cage on ${p.rebar.length} propert${p.rebar.length === 1 ? 'y' : 'ies'}, so ETABS sees this app's steel`,
    applies: p => p.rebar.length > 0,
    run: async (conn, plan, out) => {
      if (!conn.setRebarBeam) return;
      const r = await conn.setRebarBeam(plan.rebar);
      out.failures.push(...(r.failures ?? []));
    },
  },
  {
    id: 'assign',
    label: 'Assign frames',
    detail: p => `Move ${p.frameCount} frame${p.frameCount === 1 ? '' : 's'} onto the new properties`,
    applies: p => p.assign.length > 0,
    run: async (conn, plan, out) => {
      const a = await conn.assignSections!(plan.assign);
      out.assigned = a.assigned;
      out.failures.push(...(a.failures ?? []));
    },
  },
  {
    id: 'run',
    label: 'Run analysis',
    detail: () => 'Re-run the analysis — editing the sections discarded the old results',
    applies: p => p.runAnalysis,
    run: async (conn, _plan, out) => {
      const ran = await conn.runAnalysis!();
      out.ran = !!ran.ran;
    },
  },
  {
    id: 'reimport',
    label: 'Import forces',
    detail: p => `Read the re-analysed forces for ${p.frameCount} frame`
      + `${p.frameCount === 1 ? '' : 's'} back, over ${p.combos.length} `
      + `combination${p.combos.length === 1 ? '' : 's'} — the same set the model was imported under`,
    // Needs an analysis to read and a combo set to read it over. Without either there is
    // nothing to import, and a button that reads zero combos and reports success would
    // be worse than no button.
    applies: p => p.runAnalysis && p.combos.length > 0 && p.frameCount > 0,
    run: async (conn, plan, out) => {
      if (!conn.getStationForces) return;
      const frames = [...new Set(plan.assign.flatMap(a => a.frameNames))];
      out.forces = await conn.getStationForces(frames, plan.combos);
    },
  },
];

/** A fresh, zeroed outcome for a stepped push to accumulate into. */
export function emptyPushOutcome(plan: SectionPushPlan): SectionPushOutcome {
  return { defined: 0, assigned: 0, frames: plan.frameCount, saved: null, ran: false, failures: [] };
}

/** One-line human summary, in the shape `summarizePushResults` set for group pushes. */
export function summarizeSectionPush(o: SectionPushOutcome): string {
  const tail = o.failures.length ? ` (${o.failures.length} failed)` : '';
  const ran = o.ran ? ', analysis re-run' : '';
  return `Defined ${o.defined} propert${o.defined === 1 ? 'y' : 'ies'}, assigned ${o.assigned}/${o.frames} frames${tail}`
    + `${o.saved ? `, saved as ${o.saved}` : ''}${ran}.`;
}
