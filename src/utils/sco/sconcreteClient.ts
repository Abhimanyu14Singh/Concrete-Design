/**
 * Renderer-side client for the S-Concrete batch bridge (electron/sconcreteBridge.cjs).
 * Thin typed wrappers over window.electronAPI.sconcrete. Only available in the
 * Windows desktop app with S-Concrete installed. The batch is driven by the
 * bundled native sidecar (SConcreteHelper.exe) — no Python — so the config is
 * just an output folder.
 */
import type { ScoFile } from './scoBatch';

/** Settings for one batch run. The output folder is the only required setting. */
export interface SconcreteRunConfig {
  outDir: string;        // directory to write .SCO files and read the .SCRS
  title?: string;
  engineer?: string;
  makePdf?: boolean;     // ALSO produce a PDF report — opt-in (default off): it's
                         // slow, and the .SCRS already carries every result the app uses.
}

/** What a finished batch reports back. `scrsText` is null when the run produced no
 *  results file — check it before parsing, since a non-zero `exitCode` is not the only
 *  way a run can fail to produce output. */
export interface SconcreteRunResult {
  exitCode: number;
  scoCount: number;
  scrsPath: string;
  scrsText: string | null;
  stderr: string;
  pdf?: string;          // path to the produced PDF report, if any
  status?: string;       // final BatchReporter status line
  /** Artefacts deleted before this run (0 unless it was a clean run). */
  cleanedCount?: number;
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

/**
 * Write .SCO files, launch BatchReporter, and read the resulting .SCRS.
 *
 * `clean` deletes every S-Concrete artefact (.SCO / .SCRS / Report_*.pdf) in the
 * output folder BEFORE writing, so the batch reports on exactly this run's files.
 * Without it the write is additive: BatchReporter reads every .SCO in the folder,
 * so files from an earlier run still show up in the results.
 */
export async function runScoBatch(
  files: ScoFile[], cfg: SconcreteRunConfig, opts: { clean?: boolean } = {},
): Promise<SconcreteRunResult> {
  return await ipc()('run', { ...cfg, files, clean: !!opts.clean }) as SconcreteRunResult;
}

/** Delete the S-Concrete artefacts in `outDir` without running anything. */
export async function cleanScoFolder(outDir: string): Promise<{ removed: string[]; failed: string[]; kept: number }> {
  return await ipc()('clean', { outDir }) as { removed: string[]; failed: string[]; kept: number };
}
