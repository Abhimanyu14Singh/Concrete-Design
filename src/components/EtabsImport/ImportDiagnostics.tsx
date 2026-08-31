/**
 * Why a geometry layer came back empty.
 *
 * The import is deliberately forgiving: every optional layer (walls, slabs, columns,
 * grids, openings) catches its own failure so a missing table never breaks a run. That
 * is right for the import and useless for the person asking why their walls are absent,
 * because it makes four different causes look identical —
 *
 *   • ETABS does not recognise the table key this build asks for
 *   • the table exists but its columns are spelled differently
 *   • the corner point names do not resolve against the joint table
 *   • the model genuinely has none of that object
 *
 * This panel separates them. `Run geometry probe` calls the layer getters directly and
 * reports what each returned; the probe log underneath shows ETABS's own return code and
 * the column names it used; `List ETABS tables` asks the model for its catalogue, so a
 * key mismatch is a lookup rather than a guess.
 *
 * Read-only throughout — nothing here writes to the model or changes the import.
 */
import { useState } from 'react';
import type { EtabsConnection, EtabsTableInfo, TableProbe } from '../../adapters/etabs/connection';
import { ACCENT, BORDER, INK, MONO_NUM, STATUS, SURFACE } from '../../theme';

interface Props {
  /** True once a connection exists. A boolean rather than the connection itself: the
   *  wizard holds it in a ref, and a ref must not be read during render. */
  connected: boolean;
  /** Fetches the live connection. Called only from event handlers, where a ref is fair
   *  game — this panel never reads it while rendering. */
  getConn: () => EtabsConnection | null;
  /** Whether this source can report ETABS's table catalogue (live COM only). */
  canListTables: boolean;
  /** The wizard's button style, so this looks like the rest of the dialog. */
  btn: (primary?: boolean) => React.CSSProperties;
}

type LayerCount = { layer: string; count: number | null; error?: string };

export default function ImportDiagnostics({ connected, getConn, canListTables, btn }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [layers, setLayers] = useState<LayerCount[] | null>(null);
  const [probes, setProbes] = useState<TableProbe[] | null>(null);
  const [tables, setTables] = useState<EtabsTableInfo[] | null>(null);
  // Pre-filtered to the layer that prompted this. Clearing it shows the whole catalogue.
  const [filter, setFilter] = useState('area');

  if (!connected) return null;

  /**
   * Ask for each optional layer and report what came back.
   *
   * Deliberately calls the SAME getters the wizard uses, rather than re-reading tables
   * here — a probe that took a different route could pass while the import still failed.
   */
  async function runProbe() {
    const conn = getConn();
    if (!conn) return;
    setBusy('probe');
    const out: LayerCount[] = [];
    const one = async (layer: string, fn: (() => Promise<unknown[]>) | undefined) => {
      if (!fn) { out.push({ layer, count: null, error: 'this source has no such method' }); return; }
      try { out.push({ layer, count: (await fn()).length }); }
      catch (e) { out.push({ layer, count: null, error: e instanceof Error ? e.message : String(e) }); }
    };
    await one('Areas (walls + floor slabs)', conn.getAreas && (() => conn.getAreas!({})));
    await one('Columns', conn.getColumns && (() => conn.getColumns!({})));
    await one('Grids', conn.getGrids && (() => conn.getGrids!()));
    await one('Openings', conn.getOpenings && (() => conn.getOpenings!({})));
    setLayers(out);
    setProbes(conn.tableProbes?.() ?? []);
    setBusy(null);
  }

  async function loadTables() {
    const conn = getConn();
    if (!conn?.listTables) return;
    setBusy('tables');
    try { setTables(await conn.listTables()); }
    catch (e) { setTables([{ key: `— ${e instanceof Error ? e.message : String(e)}`, name: '', importType: -1 }]); }
    setBusy(null);
  }

  /** The whole report as text, so it can be pasted into a bug report verbatim. */
  function report(): string {
    const lines: string[] = ['S-Dashboard — ETABS import diagnostics'];
    if (layers) {
      lines.push('', 'Layers:');
      for (const l of layers) lines.push(`  ${l.layer}: ${l.error ? `ERROR ${l.error}` : `${l.count} object(s)`}`);
    }
    if (probes?.length) {
      lines.push('', 'Table reads (ret 0 = ETABS delivered the table):');
      for (const p of probes) {
        lines.push(`  ${p.key} — ret ${p.ret ?? 'n/a'}, ${p.rows} row(s)${p.error ? `, ERROR ${p.error}` : ''}`);
        if (p.fields.length) lines.push(`      fields: ${p.fields.join(', ')}`);
      }
    }
    if (tables) {
      lines.push('', `ETABS table catalogue (${tables.length} shown${filter ? `, filter "${filter}"` : ''}):`);
      for (const t of shownTables) lines.push(`  ${t.key}${t.name && t.name !== t.key ? `  [${t.name}]` : ''}`);
    }
    return lines.join('\n');
  }

  const shownTables = (tables ?? []).filter(t =>
    !filter || `${t.key} ${t.name}`.toLowerCase().includes(filter.toLowerCase()));

  const mono: React.CSSProperties = { ...MONO_NUM, fontSize: 11 };

  return (
    <div style={{ marginTop: 14, border: `1px solid ${BORDER.default}`, borderRadius: 8, background: SURFACE.subtle }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left', background: 'transparent', border: 0,
          padding: '8px 12px', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: INK.secondary,
        }}
      >
        {open ? '▾' : '▸'} Diagnostics — why is a layer empty?
      </button>

      {open && (
        <div style={{ padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11, color: INK.secondary }}>
            Read-only. Walls and floor slabs arrive together as area objects; if the count
            below is 0 while columns are not, the area table is the thing to look at.
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button style={btn()} disabled={!!busy} onClick={runProbe}>
              {busy === 'probe' ? 'Probing…' : 'Run geometry probe'}
            </button>
            <button style={btn()} disabled={!!busy || !canListTables} onClick={loadTables}
              title={canListTables ? 'Ask ETABS which tables it offers' : 'Live ETABS connection only'}>
              {busy === 'tables' ? 'Reading…' : 'List ETABS tables'}
            </button>
            {(layers || probes || tables) && (
              <button style={btn()} onClick={() => void navigator.clipboard?.writeText(report())}>
                Copy report
              </button>
            )}
          </div>

          {layers && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {layers.map(l => (
                <div key={l.layer} style={{ display: 'flex', gap: 8, fontSize: 11 }}>
                  <span style={{ minWidth: 200, color: INK.secondary }}>{l.layer}</span>
                  <b style={{ ...mono, color: l.error ? STATUS.fail : l.count ? STATUS.ok : STATUS.warn }}>
                    {l.error ? l.error : `${l.count} object${l.count === 1 ? '' : 's'}`}
                  </b>
                </div>
              ))}
            </div>
          )}

          {probes && probes.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: INK.muted, marginBottom: 4 }}>
                TABLE READS — ret 0 means ETABS delivered the table
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {probes.map((p, i) => {
                  const refused = p.ret !== null && p.ret !== 0;
                  return (
                    <div key={`${p.key}-${i}`} style={{ fontSize: 11 }}>
                      <span style={{ ...mono, color: refused ? STATUS.fail : INK.base }}>{p.key}</span>
                      <span style={{ color: INK.secondary }}>
                        {' '}— ret <b style={{ color: refused ? STATUS.fail : STATUS.ok }}>{p.ret ?? 'n/a'}</b>
                        , <b style={{ color: p.rows ? INK.base : STATUS.warn }}>{p.rows}</b> row{p.rows === 1 ? '' : 's'}
                        {p.error ? ` — ${p.error}` : ''}
                      </span>
                      {p.fields.length > 0 && (
                        <div style={{ ...mono, color: INK.muted, paddingLeft: 12 }}>{p.fields.join(' · ')}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tables && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: INK.muted }}>
                  ETABS TABLES — {shownTables.length} of {tables.length}
                </span>
                <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="filter…"
                  style={{ padding: '3px 6px', border: `1px solid ${BORDER.strong}`, borderRadius: 5, fontSize: 11 }} />
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
                {shownTables.map(t => (
                  <div key={t.key} style={{ ...mono, color: INK.base }}>
                    {t.key}
                    {t.name && t.name !== t.key && <span style={{ color: INK.muted }}>  [{t.name}]</span>}
                  </div>
                ))}
                {shownTables.length === 0 && (
                  <div style={{ fontSize: 11, color: STATUS.warn }}>
                    Nothing matches “{filter}”. Clear the filter to see all {tables.length}.
                  </div>
                )}
              </div>
              <div style={{ fontSize: 10, color: INK.muted, marginTop: 4 }}>
                The app asks for <span style={{ ...mono, color: ACCENT.primary }}>Area Object Connectivity</span>.
                If that key is not in this list, that is the reason the layer is empty.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
