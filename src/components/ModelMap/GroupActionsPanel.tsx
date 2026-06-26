/**
 * GroupActionsPanel — merges the column repo's external-tool workflows into the
 * Map/Groups view:
 *   • Push the design groups back into ETABS (create named groups + assign frames).
 *   • Generate .SCO files for the beams, run the S-Concrete batch, and pull the
 *     pass/fail + utilization results back in.
 *
 * Both actions require the Windows desktop app (live ETABS / installed S-Concrete);
 * outside it the buttons explain why they're unavailable. The .SCO/.SCRS logic is
 * unit-tested; the runtime round-trips can only be exercised on Windows.
 */
import { useState } from 'react';
import type { Member, DesignGroup, DesignCode } from '../../types';
import type { BeamMember } from '../../types/beam';
import { buildGroupScoFiles, parseBatchResults } from '../../utils/sco/scoBatch';
import { runScoBatch, hasSconcrete, type SconcreteRunConfig } from '../../utils/sco/sconcreteClient';
import type { ScrsResult } from '../../utils/sco/scrsParser';
import { buildGroupPushPayload, summarizePushResults } from '../../adapters/etabs/pushGroups';
import { ComConnection } from '../../adapters/etabs/comClient';

interface Props {
  groups: DesignGroup[];
  members: Member[];
  code: DesignCode;
  /** member id → ETABS frame name, from project.modelMap. */
  frameByMemberId: Map<string, string>;
}

const LS_KEY = 'sconcrete.runConfig';

function loadConfig(): SconcreteRunConfig {
  try {
    return { pythonExe: '', batchReporter: '', outDir: '', ...JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') };
  } catch {
    return { pythonExe: '', batchReporter: '', outDir: '' };
  }
}

const btn: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
  fontWeight: 700, fontSize: 12, color: '#fff',
};
const input: React.CSSProperties = {
  width: '100%', padding: '4px 6px', borderRadius: 4, fontSize: 11,
  background: '#0b1220', border: '1px solid #1f2937', color: '#e5e7eb', marginTop: 2,
};
const label: React.CSSProperties = { fontSize: 10, color: '#94a3b8', display: 'block', marginTop: 6 };

export default function GroupActionsPanel({ groups, members, code, frameByMemberId }: Props) {
  const [busy, setBusy] = useState<'etabs' | 'sco' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<ScrsResult[] | null>(null);
  const [cfg, setCfgState] = useState<SconcreteRunConfig>(loadConfig);
  const [showCfg, setShowCfg] = useState(false);

  const beams = members.filter((m): m is BeamMember => m.memberType === 'beam');
  const desktop = hasSconcrete();
  const hasEtabs = !!(window as Window & { electronAPI?: { etabs?: unknown } }).electronAPI?.etabs;

  function setCfg(next: SconcreteRunConfig) {
    setCfgState(next);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  }

  async function pushToEtabs() {
    setErr(null); setMsg(null); setResults(null); setBusy('etabs');
    try {
      const payload = buildGroupPushPayload(groups, frameByMemberId);
      if (!payload.length) throw new Error('No groups with ETABS-linked frames. Import members from ETABS first.');
      const conn = new ComConnection();
      await conn.connect();
      const res = await conn.pushGroups!(payload);
      setMsg(summarizePushResults(res));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runBatch() {
    setErr(null); setMsg(null); setResults(null); setBusy('sco');
    try {
      const files = buildGroupScoFiles(beams, code);
      if (!files.length) throw new Error('No beam members to export.');
      if (!cfg.pythonExe || !cfg.batchReporter || !cfg.outDir) {
        setShowCfg(true);
        throw new Error('Set the S-Concrete paths (Python, BatchReporter, output folder) below first.');
      }
      const out = await runScoBatch(files, cfg);
      if (out.scrsText) {
        setResults(Object.values(parseBatchResults(out.scrsText)));
        setMsg(`Ran ${out.scoCount} .SCO file(s) through S-Concrete.`);
      } else {
        setErr(`Wrote ${out.scoCount} .SCO file(s) but no .SCRS was produced. ${out.stderr || ''}`.trim());
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ borderTop: '1px solid #1f2937', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: '#cbd5e1', letterSpacing: 0.3 }}>EXTERNAL TOOLS</div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          style={{ ...btn, background: hasEtabs ? '#10b981' : '#374151', opacity: busy ? 0.6 : 1 }}
          disabled={!!busy || !hasEtabs}
          title={hasEtabs ? 'Create ETABS groups and assign member frames' : 'Live ETABS requires the Windows desktop app'}
          onClick={pushToEtabs}
        >
          {busy === 'etabs' ? 'Pushing…' : `↑ Push ${groups.length} group(s) to ETABS`}
        </button>

        <button
          style={{ ...btn, background: desktop ? '#6366f1' : '#374151', opacity: busy ? 0.6 : 1 }}
          disabled={!!busy || !desktop}
          title={desktop ? 'Generate .SCO, run S-Concrete batch, pull results' : 'S-Concrete batch requires the Windows desktop app'}
          onClick={runBatch}
        >
          {busy === 'sco' ? 'Running…' : `⚙ S-Concrete batch (${beams.length} beams)`}
        </button>

        <button style={{ ...btn, background: '#374151' }} onClick={() => setShowCfg((s) => !s)} disabled={!!busy}>
          {showCfg ? 'Hide paths' : 'S-Concrete paths'}
        </button>
      </div>

      {showCfg && (
        <div style={{ background: '#0b1220', border: '1px solid #1f2937', borderRadius: 6, padding: 8 }}>
          <label style={label}>Python executable
            <input style={input} value={cfg.pythonExe} placeholder="C:\\…\\python.exe"
              onChange={(e) => setCfg({ ...cfg, pythonExe: e.target.value })} />
          </label>
          <label style={label}>run_batch_reporter.py
            <input style={input} value={cfg.batchReporter} placeholder="C:\\…\\run_batch_reporter.py"
              onChange={(e) => setCfg({ ...cfg, batchReporter: e.target.value })} />
          </label>
          <label style={label}>Output folder (.SCO + .SCRS)
            <input style={input} value={cfg.outDir} placeholder="C:\\…\\scos"
              onChange={(e) => setCfg({ ...cfg, outDir: e.target.value })} />
          </label>
        </div>
      )}

      {msg && <div style={{ fontSize: 11, color: '#34d399' }}>{msg}</div>}
      {err && <div style={{ fontSize: 11, color: '#f87171' }}>{err}</div>}

      {results && results.length > 0 && (
        <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid #1f2937', borderRadius: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                <th style={{ padding: '4px 6px' }}>Member</th>
                <th style={{ padding: '4px 6px' }}>Status</th>
                <th style={{ padding: '4px 6px' }}>N-M</th>
                <th style={{ padding: '4px 6px' }}>V&amp;T</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.name} style={{ color: '#e5e7eb', borderTop: '1px solid #111827' }}>
                  <td style={{ padding: '4px 6px' }}>{r.name}</td>
                  <td style={{ padding: '4px 6px', color: r.status === 'OK' ? '#34d399' : r.status ? '#f87171' : '#94a3b8' }}>{r.status ?? '—'}</td>
                  <td style={{ padding: '4px 6px' }}>{r.nmUtil ?? '—'}</td>
                  <td style={{ padding: '4px 6px' }}>{r.vtUtil ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
