/**
 * The renderer's view of the desktop shell — types for the preload bridge, plus the
 * save/open entry points the app actually calls.
 *
 * Save and open must work in BOTH shells: Electron (a native dialog, written by the main
 * process) and a plain browser (a download / file-picker, `saveLoad.ts`). Callers should
 * not care which, so each function here branches on `isElectron` once and presents the
 * same contract either way — cancel is `false`/`null`, a real failure throws.
 *
 * The `Window.electronAPI` augmentation below must stay in step with what
 * `electron/preload.cjs` exposes; it is hand-written, so nothing checks the two agree.
 * Everything past `saveFile`/`openFile` is OPTIONAL on purpose — in a browser build the
 * whole object is undefined, and desktop-only features (ETABS, the dashboard pop-out)
 * have to be feature-detected rather than assumed.
 */

import type { Project } from '../types';
import { serializeProject, deserializeProject, downloadProjectFile, loadProjectFile } from './saveLoad';

/** What the Diagnostics panel reads back from the usage log — see electron/usageLog.cjs. */
export interface UsageState {
  /** False when the user has switched recording off; nothing is written while it is. */
  consent: boolean;
  /** Random per-install token. Not derived from the machine or the user. */
  installId: string;
  firstSeen: string;
  sessions: number;
  sessionId: string | null;
  /** Events recorded in THIS session. */
  events: number;
  files: number;
  bytes: number;
  dir: string;
  retentionDays: number;
}

declare global {
  interface Window {
    /** Injected by electron/preload.cjs; undefined in a browser build. */
    electronAPI?: {
      /** `filePath` present = overwrite it silently (Save); absent = ask (Save As). */
      saveFile:       (opts: { content: string; defaultName: string; filePath?: string | null }) => Promise<{ success: boolean; canceled?: boolean; error?: string; filePath?: string }>;
      etabs?:         (method: string, args?: unknown) => Promise<unknown>;
      openFile:       () => Promise<{ content?: string; filePath?: string; error?: string } | null>;
      onTriggerSave:  (cb: () => void) => void;
      onTriggerOpen:  (cb: () => void) => void;
      onNewProject:   (cb: () => void) => void;
      offTriggerSave: () => void;
      offTriggerOpen: () => void;
      offNewProject:  () => void;
      /** Native File → Save Project As… (Ctrl+Shift+S). Optional so a renderer running
       *  against an older preload does not crash on it. */
      onTriggerSaveAs?:  (cb: () => void) => void;
      offTriggerSaveAs?: () => void;
      /** Native File menu → the ETABS import wizard / a workspace reset. Optional so a
       *  renderer running against an older preload does not crash on them. */
      onImportEtabs?:    (cb: () => void) => void;
      offImportEtabs?:   () => void;
      /** Chromium's GPU feature status — the software-rendering check. */
      gpuStatus?:        () => Promise<import('./perfProbe').GpuStatus>;
      /** Usage log (local file only, never the network) — see src/utils/usage.ts and
       *  electron/usageLog.cjs. Optional throughout: the browser build has none of it,
       *  and a renderer running against an older preload must not throw on startup. */
      usageEvents?:      (batch: unknown[]) => Promise<{ ok: boolean }> | undefined;
      usageState?:       () => Promise<UsageState>;
      usageSetConsent?:  (on: boolean) => Promise<UsageState>;
      usageExport?:      () => Promise<{ ok: boolean; canceled?: boolean; error?: string; filePath?: string; bytes?: number; lines?: number; files?: number }>;
      usageOpenFolder?:  () => Promise<{ ok: boolean; error?: string }>;
      onTogglePerf?:     (cb: () => void) => void;
      offTogglePerf?:    () => void;
      onResetWorkspace?: (cb: () => void) => void;
      offResetWorkspace?: () => void;
      /** Native Preferences menu → open the model-appearance dialog. Optional so a
       *  renderer running against an older preload does not throw on startup. */
      onOpenPreferences?:  (cb: () => void) => void;
      offOpenPreferences?: () => void;
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

/** What a save attempt ended up doing. `saved` is false only for a cancelled dialog. */
export interface SaveResult {
  saved: boolean;
  /** Where it was written — remember this so the next plain Save need not ask. */
  filePath?: string;
}

/**
 * Save the project.
 *
 * `filePath` is the file this project is currently associated with; passing it means
 * SAVE (overwrite, no dialog) and omitting it means SAVE AS (ask). A project that has
 * never been saved has no path, so its first Ctrl+S is a Save As — which is what every
 * other desktop app does, and why there is one function here rather than two.
 *
 * In a BROWSER there is no such distinction to make: a page cannot silently overwrite a
 * file it downloaded, so both routes produce a download and no path comes back. The
 * caller keeps working either way; it just never gets to skip the picker.
 *
 * Returns `saved: false` only when the user cancelled. Throws on real I/O errors.
 */
export async function saveProject(project: Project, filePath?: string | null): Promise<SaveResult> {
  const content = serializeProject(project);
  if (isElectron && window.electronAPI) {
    const r = await window.electronAPI.saveFile({
      content,
      defaultName: `${project.name.replace(/\s+/g, '_')}.scdb`,
      filePath: filePath ?? null,
    });
    if (r.error) throw new Error(r.error);
    return { saved: r.success, filePath: r.filePath };
  }
  downloadProjectFile(project);
  return { saved: true };
}

/** What `openProject` read, and where from. */
export interface OpenResult {
  project: Project;
  /** Absent in a browser — a page never learns the real path of a file it was handed. */
  filePath?: string;
}

/**
 * Open a project. Returns null when the user cancelled. Throws on read or
 * parse errors so the caller can surface them.
 */
export async function openProject(): Promise<OpenResult | null> {
  if (isElectron && window.electronAPI) {
    const result = await window.electronAPI.openFile();
    if (!result) return null;
    if (result.error) throw new Error(result.error);
    return { project: deserializeProject(result.content ?? ''), filePath: result.filePath };
  }
  const project = await loadProjectFile();
  return project ? { project } : null;
}
