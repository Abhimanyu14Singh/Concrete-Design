import type { Project } from '../types';

const FILE_VERSION = '1.0';
const FILE_EXT = '.scdb';

export function serializeProject(project: Project): string {
  return JSON.stringify({ _version: FILE_VERSION, ...project }, null, 2);
}

export function deserializeProject(json: string): Project {
  const data = JSON.parse(json);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _version, ...project } = data;
  return project as Project;
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
