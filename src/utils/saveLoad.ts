import type { Project, Member, MaterialProps, RebarLayout } from '../types';

/**
 * Current on-disk schema version. Bump when the persisted shape changes in a
 * way migrateProject() needs to know about. Older files are always accepted —
 * migrateProject() fills in any fields added since they were saved.
 */
const FILE_VERSION = '1.1';
const FILE_EXT = '.scdb';

/** Standard material fallbacks (psi) for fields added after v1.0. */
const MATERIAL_DEFAULTS: Pick<MaterialProps, 'fyt' | 'Es' | 'lambdaConcrete'> = {
  fyt: 60000, Es: 29000000, lambdaConcrete: 1.0,
};

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

function migrateMember(m: Partial<Member>): Member {
  return {
    ...m,
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
  return {
    ...data,
    id: data.id ?? `proj-${Date.now()}`,
    name: data.name ?? 'Untitled Project',
    code: data.code ?? 'ACI318-19',
    description: data.description ?? '',
    engineer: data.engineer ?? '',
    date: data.date ?? new Date().toISOString().slice(0, 10),
    members: data.members.map(m => migrateMember(m as Partial<Member>)),
    designGroups: Array.isArray(data.designGroups) ? data.designGroups : undefined,
    hiddenMemberIds: Array.isArray(data.hiddenMemberIds) ? data.hiddenMemberIds : undefined,
    hiddenStories: Array.isArray(data.hiddenStories) ? data.hiddenStories : undefined,
  } as Project;
}

export function deserializeProject(json: string): Project {
  const data = JSON.parse(json);
  if (data === null || typeof data !== 'object') {
    throw new Error('Not a valid S-Concrete project file.');
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _version, ...rest } = data;
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
        try { resolve(deserializeProject(e.target!.result as string)); }
        catch { reject(new Error('Invalid project file')); }
      };
      reader.readAsText(file);
    };
    input.click();
  });
}
