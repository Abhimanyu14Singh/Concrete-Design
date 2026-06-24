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

type EtabsIpc = (method: string, args?: unknown) => Promise<unknown>;

function ipc(): EtabsIpc {
  const api = (window as Window & { electronAPI?: { etabs?: EtabsIpc } }).electronAPI;
  if (!api?.etabs) {
    throw new Error(
      'Live ETABS connection requires the desktop app on Windows with ETABS running.'
    );
  }
  return api.etabs.bind(api);
}

export class ComConnection extends TableConnection {
  readonly kind = 'com' as const;

  protected async openSession(): Promise<{ modelName: string }> {
    const r = await ipc()('connect') as { modelName?: string };
    return { modelName: String(r?.modelName ?? 'ETABS model') };
  }

  protected async fetchUnitsEnum(): Promise<number | null> {
    try {
      const r = await ipc()('getUnits') as number | null;
      return typeof r === 'number' ? r : null;
    } catch { return null; }
  }

  protected async fetchTable(key: string, group?: string): Promise<TableRow[]> {
    const r = await ipc()('getTable', { key, group: group ?? '' }) as { fields?: string[]; rows?: string[][] };
    const fields = r?.fields ?? [];
    const rows = r?.rows ?? [];
    return rows.map(row => {
      const obj: TableRow = {};
      fields.forEach((f, i) => { obj[f] = row[i]; });
      return obj;
    });
  }

  protected async selectCombosAtSource(combos: string[]): Promise<void> {
    try { await ipc()('selectCombos', { combos }); } catch { /* best effort */ }
  }
}
