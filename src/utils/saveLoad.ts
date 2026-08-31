/**
 * Project persistence — the `.scdb` file format, and the migration that keeps every
 * file ever written by this app openable.
 *
 * The on-disk shape is just the `Project` object as JSON with a `_version` stamp. There
 * is no writer-side migration and no "unsupported file" path: reading is forgiving and
 * writing is always current. `migrateProject()` is the whole compatibility story —
 * everything the schema has gained since v1.0 is backfilled there, once, so no consumer
 * downstream has to guard for a field that old files lack.
 *
 * Two rules migration follows, both load-bearing:
 *  • NEVER silently change a design. Backfills are defaults for fields that did not
 *    exist; they must not overwrite a value the engineer chose.
 *  • Cached `results` are dropped on load, so the current engine always recomputes.
 *    A stale DCR from an older build is worse than no DCR.
 *
 * Save/open in the desktop app go through `electronBridge.ts`; the `downloadProjectFile`
 * / `loadProjectFile` pair at the bottom is the browser fallback it falls back to.
 */

import type { DesignCode, Project, Member, MaterialProps, RebarLayout } from '../types';
import { settingsFromProject } from './projectSettings';
import { track } from './usage';

/**
 * Current on-disk schema version, `MAJOR.MINOR`, and the compatibility contract
 * that goes with it. Both halves are load-bearing — read this before changing
 * anything that is written to a file.
 *
 * MINOR bump — purely ADDITIVE. New optional fields; no existing field changes
 *   meaning. Both directions work:
 *     • newer file in an older build — the unknown fields ride through untouched
 *       (every spread in this module is open, and nothing strips what it does not
 *       recognise), so a load → edit → save round trip does not destroy them.
 *     • older file in a newer build — migrateProject() backfills what is missing.
 *
 * MAJOR bump — an existing field changed MEANING, or a value appeared that an
 *   older build cannot honour (a new design code is the obvious one: an old build
 *   has no engine for it and would silently relabel the project to ACI 318-19 on
 *   save). Field-presence backfilling cannot detect either case, so this is the
 *   one thing the version number is actually read for: a file whose MAJOR exceeds
 *   this build's is REFUSED rather than silently misread.
 *
 * Note what migration does NOT do: it never branches on the version. Every backfill
 * keys off whether a FIELD IS PRESENT, which is strictly more robust — it copes with
 * hand-edited files, partial writes and builds that shipped between version bumps.
 * The version is the last resort for what presence cannot express, nothing more.
 *
 * History:
 *   1.0 — initial: project, members, material, section, rebar, loads.
 *   1.1 — material gained fyt / Es / lambdaConcrete.
 *   1.2 — project-wide `settings` (design standards) + per-face cover and the
 *         optional Ec/Gc overrides on each member.
 *   1.3 — everything additive since: project `designGroups`, `modelMap`, `targetDCR`,
 *         `hiddenMemberIds`, `hiddenStories`, `slsCombo`, `cotTheta`, `ignoreTorsion`,
 *         `sconcreteResults` / `sconcreteRanAt`; member `span`, `crackParams`, `etabs`,
 *         `stationForces`, `overrides`; rebar `tieZones`, `sideBars`,
 *         `layerClearSpacing`. Also retires the ACI 318-14 code selection — those
 *         files open as ACI 318-19, which is the engine they always ran, so no
 *         design moves. Minor, not major: nothing an older build reads changes meaning.
 *   1.4 — project `modelVersions`: frozen snapshots of pushed models, so a past design
 *         and its group DCRs survive closing the app. Purely additive — an older build
 *         ignores the field, and because every spread in this file is open it survives
 *         that build's load → save untouched.
 */
export const FILE_VERSION = '1.4';

/** The MAJOR this build can read. A file above it is from the future — refuse it. */
const SCHEMA_MAJOR = 1;
const FILE_EXT = '.scdb';

/** `major.minor` from a `_version` stamp, or null if it is missing or malformed.
 *  Pre-1.0 files with no stamp read as null and are simply migrated — absence has
 *  always meant "old", never "invalid". */
function parseFileVersion(v: unknown): { major: number; minor: number } | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d+)\.(\d+)/.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** Standard material fallbacks (psi) for fields added after v1.0. */
const MATERIAL_DEFAULTS: Pick<MaterialProps, 'fyt' | 'Es' | 'lambdaConcrete'> = {
  fyt: 60000, Es: 29000000, lambdaConcrete: 1.0,
};

/** Serialize a project to `.scdb` JSON. Pretty-printed — these files get diffed. */
export function serializeProject(project: Project): string {
  return JSON.stringify({ _version: FILE_VERSION, ...project }, null, 2);
}

/**
 * Backfill fields that were added to MaterialProps after older files were
 * written. fyt falls back to fy (transverse = longitudinal yield) so legacy
 * single-yield files keep their original behavior.
 */
function migrateMaterial(m: Partial<MaterialProps> | undefined): MaterialProps {
  const fy = m?.fy ?? 60000;
  return {
    fc: m?.fc ?? 4000,
    fy,
    fyt: m?.fyt ?? fy,
    Es: m?.Es ?? MATERIAL_DEFAULTS.Es,
    lambdaConcrete: m?.lambdaConcrete ?? MATERIAL_DEFAULTS.lambdaConcrete,
    // Ec/Gc are absent unless the project overrode them — leave them absent so
    // consumers keep falling back to the code formula.
    ...(m?.Ec ? { Ec: m.Ec } : {}),
    ...(m?.Gc ? { Gc: m.Gc } : {}),
  };
}

/** Ensure the rebar layout has the required arrays; leave optional fields intact. */
function migrateRebar(r: Partial<RebarLayout> | undefined): RebarLayout {
  return {
    ...r,
    topBars: Array.isArray(r?.topBars) ? r!.topBars : [],
    botBars: Array.isArray(r?.botBars) ? r!.botBars : [],
  };
}

/**
 * Bring one member up to the current schema. Every required field gets a default, so a
 * member written by any older build is safe to hand straight to an engine.
 */
function migrateMember(m: Partial<Member>): Member {
  // Drop any stale cached design `results` from files saved by an older build so the
  // current engine always recomputes (new d / crack logic) on load — nothing in the
  // app writes this field anymore.
  const { results: _staleResults, ...rest } = m;
  void _staleResults;
  return {
    ...rest,
    id: m.id ?? `mem-${Math.random().toString(36).slice(2, 10)}`,
    label: m.label ?? 'Member',
    memberType: m.memberType ?? 'beam',
    material: migrateMaterial(m.material),
    section: m.section ?? { type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 },
    rebar: migrateRebar(m.rebar),
    loads: Array.isArray(m.loads) ? m.loads : [],
  } as Member;
}

/**
 * Coerce a file's stored code to one the app still ships. A code this build has
 * dropped, or a hand-edited value, opens as ACI 318-19 instead of leaving an
 * unknown code in front of the pickers, the badge and the .SCO writer.
 */
function normalizeDesignCode(code: unknown): DesignCode {
  return code === 'EN1992-1-1' ? 'EN1992-1-1' : 'ACI318-19';
}

/**
 * Normalize an arbitrary parsed project object into a current-schema Project.
 * Files written by any prior version load cleanly: every field added since is
 * backfilled with a safe default rather than relying on each consumer to guard
 * for `undefined`. Unknown top-level keys are preserved.
 */
export function migrateProject(raw: Record<string, unknown>): Project {
  const data = raw as Partial<Project>;
  if (!Array.isArray(data.members)) {
    throw new Error('Not a valid S-Concrete project file (missing members list).');
  }
  const project = {
    ...data,
    id: data.id ?? `proj-${Date.now()}`,
    name: data.name ?? 'Untitled Project',
    code: normalizeDesignCode(data.code),
    description: data.description ?? '',
    engineer: data.engineer ?? '',
    date: data.date ?? new Date().toISOString().slice(0, 10),
    // Columns were dropped when the app became beam-only. A file saved by an
    // older build can still contain them, so they are filtered out here rather
    // than loaded into an app that has no engine, editor or .SCO writer for them.
    members: data.members
      .filter(m => {
        const t = (m as Partial<Member>).section?.type as string | undefined;
        return t !== 'rectangular_column' && t !== 'circular_column';
      })
      .map(m => migrateMember(m as Partial<Member>)),
    designGroups: Array.isArray(data.designGroups) ? data.designGroups : undefined,
    hiddenMemberIds: Array.isArray(data.hiddenMemberIds) ? data.hiddenMemberIds : undefined,
    hiddenStories: Array.isArray(data.hiddenStories) ? data.hiddenStories : undefined,
  } as Project;
  // Files written before the setup dialog existed have no project standards.
  // Read them back off the first member rather than imposing generic defaults,
  // so opening an old project and then opening Settings shows what it was
  // actually designed with. Members are NOT rewritten here — migration must not
  // silently change anyone's design.
  return project.settings ? project : { ...project, settings: settingsFromProject(project) };
}

/**
 * Parse `.scdb` JSON into a current-schema Project. Throws with a user-facing message
 * when the text isn't a project file at all, or when it is from a schema MAJOR this
 * build cannot read — the caller shows either in a dialog.
 */
export function deserializeProject(json: string): Project {
  const data = JSON.parse(json);
  if (data === null || typeof data !== 'object') {
    throw new Error('Not a valid S-Concrete project file.');
  }
  const { _version, ...rest } = data;
  // A newer MAJOR means some field this build reads no longer means what it used
  // to. Opening it would not fail loudly — it would quietly design to the wrong
  // interpretation, and the first save would write that back. Refuse instead.
  const v = parseFileVersion(_version);
  // Record which FILE_VERSION was actually on disk. This is the one input the .scdb
  // compatibility contract has never had: MAJOR may only be bumped once no one is still
  // opening files below it, and "no one is" was previously a guess. Here rather than at
  // the call sites because every load path — native dialog and browser picker — funnels
  // through this function, so a route added later is covered without being remembered.
  track('project.file-version', {
    version: typeof _version === 'string' ? _version.slice(0, 16) : null,
    reads: FILE_VERSION,
    tooNew: !!(v && v.major > SCHEMA_MAJOR),
  });
  if (v && v.major > SCHEMA_MAJOR) {
    throw new Error(
      `This project was saved by a newer version of S-Concrete (file format ${_version}; ` +
      `this build reads ${FILE_VERSION}). Update the app to open it.`,
    );
  }
  return migrateProject(rest);
}

/** Browser fallback: trigger file download */
export function downloadProjectFile(project: Project): void {
  const json = serializeProject(project);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${project.name.replace(/\s+/g, '_')}${FILE_EXT}`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Browser fallback: open file picker and parse */
export function loadProjectFile(): Promise<Project> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = `${FILE_EXT},.json`;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { reject(new Error('No file selected')); return; }
      const reader = new FileReader();
      reader.onload = e => {
        // Propagate the real message. deserializeProject() distinguishes "not a
        // project file" from "saved by a newer version of the app", and the second
        // one tells the user what to do about it — a blanket 'Invalid project
        // file' would throw that away.
        try { resolve(deserializeProject(e.target!.result as string)); }
        catch (err) {
          reject(err instanceof Error ? err : new Error('Invalid project file'));
        }
      };
      reader.readAsText(file);
    };
    input.click();
  });
}
