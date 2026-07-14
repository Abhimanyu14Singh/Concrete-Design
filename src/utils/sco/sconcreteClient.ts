/**
 * Renderer-side client for the S-Concrete batch bridge (electron/sconcreteBridge.cjs).
 * Thin typed wrappers over window.electronAPI.sconcrete. Only available in the
 * Windows desktop app with S-Concrete installed. The batch is driven by the
 * bundled native sidecar (SConcreteHelper.exe) — no Python — so the config is
 * just an output folder.
 */
import type { ScoFile } from './scoBatch';

export interface SconcreteRunConfig {
  outDir: string;        // directory to write .SCO files and read the .SCRS
  title?: string;
  engineer?: string;
  makePdf?: boolean;     // ALSO produce a PDF report — opt-in (default off): it's
                         // slow, and the .SCRS already carries every result the app uses.
}

export interface SconcreteRunResult {
  exitCode: number;
  scoCount: number;
  scrsPath: string;
  scrsText: string | null;
  stderr: string;
  pdf?: string;          // path to the produced PDF report, if any
  status?: string;       // final BatchReporter status line
}

/** Whether S-Concrete / BatchReporter is installed on this machine. */
export interface SconcreteDetect {
  found: boolean;
  reporter?: string;     // path to BatchReporter.exe
  sconcrete?: string;    // path to Sconcrete.exe
  reason?: string;
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

/** Is S-Concrete / BatchReporter installed on this machine? (desktop only). */
export async function detectSconcrete(): Promise<SconcreteDetect> {
  if (!hasSconcrete()) return { found: false, reason: 'not-desktop' };
  return await ipc()('detect') as SconcreteDetect;
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
