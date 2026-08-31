/**
 * BridgeConnection — HTTP transport for TableConnection, talking to a local
 * helper server that exposes ETABS tables as JSON (POST /connect,
 * GET /table?key=...). Kept as a developer/advanced path; the desktop app
 * uses the bundled .NET sidecar via ComConnection instead.
 */
import { TableConnection, type TableRow } from './tableConnection';

/** Loopback only — the bridge exposes model data unauthenticated and must never bind
 *  to an external interface. */
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8744';

/** TableConnection over HTTP to a locally-run bridge server. */
export class BridgeConnection extends TableConnection {
  readonly kind = 'bridge' as const;
  private base: string;

  constructor(baseUrl: string = DEFAULT_BRIDGE_URL) {
    super();
    this.base = baseUrl.replace(/\/$/, '');
  }

  /** POST /connect — attach to whatever model the bridge's ETABS has open. Both failure
   *  modes (bridge unreachable / bridge can't attach) get their own message, because
   *  the fix is different and "connection failed" doesn't tell the user which it was. */
  protected async openSession(): Promise<{ modelName: string }> {
    let res: Response;
    try {
      res = await fetch(this.base + '/connect', { method: 'POST' });
    } catch {
      throw new Error(
        `Could not reach the ETABS bridge at ${this.base}. ` +
        'Start it first: open your model in ETABS, run the analysis, then start the bridge server.'
      );
    }
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok || body.ok === false) {
      throw new Error(
        `Bridge could not attach to ETABS: ${body.message ?? body.error ?? res.status}. ` +
        'Make sure ETABS is open with your model loaded.'
      );
    }
    return { modelName: String(body.message ?? 'ETABS model') };
  }

  // group param intentionally omitted — the HTTP bridge can't filter at source;
  // the client-side row filter in TableConnection remains the backstop.
  protected async fetchTable(key: string): Promise<TableRow[]> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/table?key=${encodeURIComponent(key)}`);
    } catch {
      throw new Error(`Could not reach the ETABS bridge at ${this.base}.`);
    }
    if (!res.ok) return [];
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    return (body.rows ?? []) as TableRow[];
  }
}
