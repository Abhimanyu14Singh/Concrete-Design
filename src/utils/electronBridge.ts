import type { Project } from '../types';
import { serializeProject, deserializeProject, downloadProjectFile, loadProjectFile } from './saveLoad';

declare global {
  interface Window {
    electronAPI?: {
      saveFile:       (opts: { content: string; defaultName: string }) => Promise<{ success: boolean; canceled?: boolean; error?: string }>;
      etabs?:         (method: string, args?: unknown) => Promise<unknown>;
      openFile:       () => Promise<{ content?: string; error?: string } | null>;
      onTriggerSave:  (cb: () => void) => void;
      onTriggerOpen:  (cb: () => void) => void;
      onNewProject:   (cb: () => void) => void;
      offTriggerSave: () => void;
      offTriggerOpen: () => void;
      offNewProject:  () => void;
      onOpenHelp?:    (cb: (tab: string) => void) => void;
      offOpenHelp?:   () => void;
      // Group Dashboard pop-out window (desktop only).
      openDashboardWindow?:   () => Promise<void>;
      closeDashboardWindow?:  () => Promise<void>;
      sendDashboardState?:    (p: import('./dashboardPayload').DashboardPayload) => void;
      onDashboardState?:      (cb: (p: import('./dashboardPayload').DashboardPayload) => void) => void;
      offDashboardState?:     () => void;
      sendDashboardCommand?:  (c: import('./dashboardPayload').DashboardCommand) => void;
      onDashboardCommand?:    (cb: (c: import('./dashboardPayload').DashboardCommand) => void) => void;
      offDashboardCommand?:   () => void;
      dashboardReady?:        () => void;
      onDashboardReady?:      (cb: () => void) => void;
      offDashboardReady?:     () => void;
      onDashboardPoppedOut?:  (cb: (v: boolean) => void) => void;
      offDashboardPoppedOut?: () => void;
    };
  }
}

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

/**
 * Save the project. Returns true only when the file was actually written
 * (false when the user cancelled the dialog). Throws on real I/O errors so
 * the caller can surface them.
 */
export async function saveProject(project: Project): Promise<boolean> {
  const content = serializeProject(project);
  if (isElectron && window.electronAPI) {
    const r = await window.electronAPI.saveFile({
      content,
      defaultName: `${project.name.replace(/\s+/g, '_')}.scdb`,
    });
    if (r.error) throw new Error(r.error);
    return r.success;
  }
  downloadProjectFile(project);
  return true;
}

/**
 * Open a project. Returns null when the user cancelled. Throws on read or
 * parse errors so the caller can surface them.
 */
export async function openProject(): Promise<Project | null> {
  if (isElectron && window.electronAPI) {
    const result = await window.electronAPI.openFile();
    if (!result) return null;
    if (result.error) throw new Error(result.error);
    return deserializeProject(result.content ?? '');
  }
  return loadProjectFile();
}
