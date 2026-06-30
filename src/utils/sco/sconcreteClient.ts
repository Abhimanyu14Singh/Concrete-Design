/**
 * Renderer-side client for the S-Concrete batch bridge (electron/sconcreteBridge.cjs).
 * Thin typed wrappers over window.electronAPI.sconcrete. Only available in the
 * Windows desktop app with S-Concrete installed.
 */
import type { ScoFile } from './scoBatch';

export interface SconcreteRunConfig {
  pythonExe: string;     // path to the S-Concrete Python host (python.exe)
  batchReporter: string; // path to run_batch_reporter.py
  outDir: string;        // directory to write .SCO files and read the .SCRS
  title?: string;
  engineer?: string;
}

export interface SconcreteRunResult {
  exitCode: number;
  scoCount: number;
  scrsPath: string;
  scrsText: string | null;
  stderr: string;
}

type Ipc = (method: string, args?: unknown) => Promise<unknown>;

function ipc(): Ipc {
  const api = (window as Window & { electronAPI?: { sconcrete?: Ipc } }).electronAPI;
  if (!api?.sconcrete) {
    throw new Error('The S-Concrete batch runner requires the Windows desktop app with S-Concrete installed.');
  }
  return api.sconcrete.bind(api);
}

/** True when the S-Concrete bridge is present (desktop app). */
export function hasSconcrete(): boolean {
  return !!(window as Window & { electronAPI?: { sconcrete?: unknown } }).electronAPI?.sconcrete;
}

/** Write .SCO files only (no run). */
export async function generateScoFiles(files: ScoFile[], outDir: string): Promise<{ outDir: string; scoCount: number }> {
  return await ipc()('generate', { outDir, files }) as { outDir: string; scoCount: number };
}

/** Write .SCO files, launch BatchReporter, and read the resulting .SCRS. */
export async function runScoBatch(files: ScoFile[], cfg: SconcreteRunConfig): Promise<SconcreteRunResult> {
  return await ipc()('run', { ...cfg, files }) as SconcreteRunResult;
}

/**
 * Re-run BatchReporter on the .SCO files ALREADY in cfg.outDir, without writing
 * anything — so manual tweaks the user made to those files (in S-Concrete or a
 * text editor) are preserved. Reads the freshly produced .SCRS back.
 */
export async function rerunScoBatch(cfg: SconcreteRunConfig): Promise<SconcreteRunResult> {
  return await ipc()('rerun', { ...cfg }) as SconcreteRunResult;
}
