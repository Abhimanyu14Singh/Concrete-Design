/**
 * ComConnection — "ETABS Active Instance", the app's primary import source.
 *
 * Transport for TableConnection over the context-isolated
 * `window.electronAPI.etabs(method, args)` IPC channel. The Electron main
 * process (electron/etabsBridge.cjs) spawns the bundled .NET sidecar
 * (EtabsHelper.exe), which attaches to the running ETABS through the .NET
 * API — no COM registration, no scripts, one click.
 *
 * In the browser (no Electron) construction succeeds but connect() rejects
 * with a clear message so the wizard can offer the demo model.
 */
import { TableConnection, type TableRow } from './tableConnection';
import type { EtabsTableInfo, PushGroupResult } from './connection';

type EtabsIpc = (method: string, args?: unknown) => Promise<unknown>;

/** The `etabs` IPC channel, or a user-readable error explaining what is missing.
 *  Resolved per call rather than cached — the preload may not have run at import time. */
function ipc(): EtabsIpc {
  const api = (window as Window & { electronAPI?: { etabs?: EtabsIpc } }).electronAPI;
  if (!api?.etabs) {
    throw new Error(
      'Live ETABS connection requires the desktop app on Windows with ETABS running.'
    );
  }
  return api.etabs.bind(api);
}

/** TableConnection over the Electron IPC channel to the bundled .NET sidecar. */
export class ComConnection extends TableConnection {
  readonly kind = 'com' as const;

  /** Attach to the running ETABS instance and report the model it has open. */
  protected async openSession(): Promise<{ modelName: string }> {
    const r = await ipc()('connect') as { modelName?: string };
    return { modelName: String(r?.modelName ?? 'ETABS model') };
  }

  /** The model's current unit enum. Returns null rather than throwing — units are
   *  recoverable from the table headers, so a failure here must not abort the import. */
  protected async fetchUnitsEnum(): Promise<number | null> {
    try {
      const r = await ipc()('getUnits') as number | null;
      return typeof r === 'number' ? r : null;
    } catch { return null; }
  }

  /** Fetch one ETABS table. The sidecar returns columnar `{fields, rows}` to keep the
   *  IPC payload small; this widens it back into the row objects TableConnection reads.
   *  `group` filters at source when ETABS supports it for that table. */
  protected async fetchTable(key: string, group?: string): Promise<TableRow[]> {
    // `ret` used to be dropped here, and that is what made a wrong table key
    // indistinguishable from a model with none of that object: ETABS answers an
    // unrecognised key with a non-zero code and no rows, so the caller saw an empty
    // array either way. It is recorded now — the rows still come back exactly as before,
    // so nothing downstream changes, but the reason is no longer lost.
    let r: { fields?: string[]; rows?: string[][]; ret?: number };
    try {
      r = await ipc()('getTable', { key, group: group ?? '' }) as typeof r;
    } catch (e) {
      this.noteProbe({ key, ret: null, rows: 0, fields: [], error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    const fields = r?.fields ?? [];
    const rows = r?.rows ?? [];
    this.noteProbe({ key, ret: typeof r?.ret === 'number' ? r.ret : null, rows: rows.length, fields });
    return rows.map(row => {
      const obj: TableRow = {};
      fields.forEach((f, i) => { obj[f] = row[i]; });
      return obj;
    });
  }

  /** ETABS's own table catalogue — the exact keys this build accepts. */
  async listTables(): Promise<EtabsTableInfo[]> {
    const r = await ipc()('listTables') as { tables?: EtabsTableInfo[] };
    return r?.tables ?? [];
  }

  /** Ask ETABS to select these combos for output before the force tables are read, so
   *  it returns only what we need. Best-effort: on failure the full table comes back and
   *  the client-side filter handles it, so this must not fail the import. */
  protected async selectCombosAtSource(combos: string[]): Promise<void> {
    try { await ipc()('selectCombos', { combos }); } catch { /* best effort */ }
  }

  // ── the write half ────────────────────────────────────────────────────────
  // Thin passthroughs: every decision (names, materials, unit conversion, order) is
  // made in `pushSections.ts` where it can be tested without a running ETABS, and
  // these just carry the already-decided arguments across the IPC boundary.

  /** Create (or redefine) rectangular concrete frame sections. Dimensions arrive already
   *  converted to the model's units by `pushSections.ts`. */
  async defineFrameSections(sections: Array<{ name: string; matProp: string; fc?: number; depth: number; width: number }>) {
    const r = await ipc()('defineFrameSections', { sections }) as { defined?: number; failures?: string[] };
    return { defined: r?.defined ?? 0, failures: r?.failures ?? [] };
  }

  /** Assign defined sections to frames. `total` is recomputed locally as a fallback so
   *  the caller can always report "n of m" even if the sidecar omits it. */
  async assignSections(assignments: Array<{ name: string; frameNames: string[] }>) {
    const r = await ipc()('assignSections', { assignments }) as
      { assigned?: number; total?: number; failures?: string[] };
    const total = assignments.reduce((n, a) => n + a.frameNames.length, 0);
    return { assigned: r?.assigned ?? 0, total: r?.total ?? total, failures: r?.failures ?? [] };
  }

  /** Write beam rebar data (cover + the four end areas) onto the frame sections. */
  async setRebarBeam(beams: Array<{
    name: string; matLong: string; matConfine: string;
    coverTop: number; coverBot: number;
    topLeftArea: number; topRightArea: number; botLeftArea: number; botRightArea: number;
  }>) {
    const r = await ipc()('setRebarBeam', { beams }) as { set?: number; failures?: string[] };
    return { set: r?.set ?? 0, failures: r?.failures ?? [] };
  }

  /** Save the model to a NEW path. Deliberately save-as, never save-in-place: a push
   *  writes to the user's model, and the original must survive an unwanted result. */
  async saveModelAs(path: string) {
    const r = await ipc()('saveModelAs', { path }) as { path?: string };
    return { path: r?.path ?? path };
  }

  /** Run the ETABS analysis. Long-running — the caller shows progress. */
  async runAnalysis() {
    const r = await ipc()('runAnalysis') as { ran?: boolean };
    return { ran: !!r?.ran };
  }

  /** Create each named group in ETABS and assign its member frames. */
  async pushGroups(groups: Array<{ name: string; frameNames: string[] }>): Promise<PushGroupResult[]> {
    const results: PushGroupResult[] = [];
    for (const g of groups) {
      const r = await ipc()('setGroupAssign', { groupName: g.name, frameNames: g.frameNames }) as
        { groupName?: string; assigned?: number; total?: number; failures?: string[] };
      results.push({
        groupName: r?.groupName ?? g.name,
        assigned: r?.assigned ?? 0,
        total: r?.total ?? g.frameNames.length,
        failures: r?.failures,
      });
    }
    return results;
  }
}
