import type { Project } from '../types';
import { serializeProject, deserializeProject, downloadProjectFile, loadProjectFile } from './saveLoad';

declare global {
  interface Window {
    electronAPI?: {
      saveFile:       (opts: { content: string; defaultName: string }) => Promise<{ success: boolean }>;
      openFile:       () => Promise<{ content: string } | null>;
      onTriggerSave:  (cb: () => void) => void;
      onTriggerOpen:  (cb: () => void) => void;
      onNewProject:   (cb: () => void) => void;
      offTriggerSave: (cb: () => void) => void;
      offTriggerOpen: (cb: () => void) => void;
      offNewProject:  (cb: () => void) => void;
    };
  }
}

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

export async function saveProject(project: Project): Promise<void> {
  const content = serializeProject(project);
  if (isElectron && window.electronAPI) {
    await window.electronAPI.saveFile({
      content,
      defaultName: `${project.name.replace(/\s+/g, '_')}.scdb`,
    });
  } else {
    downloadProjectFile(project);
  }
}

export async function openProject(): Promise<Project | null> {
  if (isElectron && window.electronAPI) {
    const result = await window.electronAPI.openFile();
    if (!result) return null;
    return deserializeProject(result.content);
  }
  return loadProjectFile();
}
