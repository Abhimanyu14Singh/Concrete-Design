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
import type { Member, DesignGroup, Project } from '../../types';
import { collectGroupScoFiles, buildGroupEnvelopeScoFiles, parseBatchResults, type ScoFile } from '../../utils/sco/scoBatch';
import { runScoBatch, rerunScoBatch, hasSconcrete, type SconcreteRunConfig, type SconcreteRunResult } from '../../utils/sco/sconcreteClient';
import type { ScrsResult } from '../../utils/sco/scrsParser';
import { buildGroupPushPayload, summarizePushResults } from '../../adapters/etabs/pushGroups';
import { ComConnection } from '../../adapters/etabs/comClient';

interface Props {
  groups: DesignGroup[];
  members: Member[];
  project: Project;
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

export default function GroupActionsPanel({ groups, members, project, frameByMemberId }: Props) {
  const code = project.code;
  const [busy, setBusy] = useState<'etabs' | 'sco' | 'rerun' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [results, setResults] = useState<ScrsResult[] | null>(null);
  const [cfg, setCfgState] = useState<SconcreteRunConfig>(loadConfig);
  const [showCfg, setShowCfg] = useState(false);

  // S-Concrete sections: beams (Member Type 1) + rectangular columns (Type 3,
  // validated writer). Circular columns use a template the writer can't emit yet.
  const isScoEligible = (m: typeof members[number]) =>
    m.memberType === 'beam' || m.section.type === 'rectangular_column';
  const scoMembers = members.filter(isScoEligible);
  // When the user has defined design groups, the batch is scoped to the union of
  // their members (deduped); otherwise it falls back to all eligible members.
  const groupedMemberIds = new Set(groups.flatMap((g) => g.memberIds));
  const eligibleInGroups = members.filter((m) => groupedMemberIds.has(m.id) && isScoEligible(m));
  const runCount = groups.length ? eligibleInGroups.length : scoMembers.length;
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

  /** Guard the three S-Concrete paths; opens the config panel and throws if unset. */
  function requirePaths() {
    if (!cfg.pythonExe || !cfg.batchReporter || !cfg.outDir) {
      setShowCfg(true);
      throw new Error('Set the S-Concrete paths (Python, BatchReporter, output folder) below first.');
    }
  }

  /** Parse a run/rerun result into the results table, or report why it produced nothing. */
  function applyResult(out: SconcreteRunResult, ranLabel: string) {
    if (out.scrsText) {
      setResults(Object.values(parseBatchResults(out.scrsText)));
      setMsg(`${ranLabel} — ${out.scoCount} .SCO file(s).`);
    } else {
      setErr(`Ran ${out.scoCount} .SCO file(s) but no .SCRS was produced. ${out.stderr || ''}`.trim());
    }
  }

  async function runBatch() {
    setErr(null); setMsg(null); setWarn(null); setResults(null); setBusy('sco');
    try {
      // One .SCO PER GROUP (envelope): the group's representative section/rebar
      // carrying every member's load cases. Falls back to one file per member
      // when no groups are defined.
      let files: ScoFile[];
      let ranLabel: string;
      if (groups.length) {
        const env = buildGroupEnvelopeScoFiles(groups, members, code, project);
        files = env;
        const totalMembers = env.reduce((s, f) => s + f.memberCount, 0);
        const totalLCs = env.reduce((s, f) => s + f.loadCaseCount, 0);
        ranLabel = `Ran ${env.length} group file(s) (${totalMembers} members, ${totalLCs} load cases)`;
        const mixed = env.filter((f) => f.mixedSections).map((f) => f.groupLabel);
        const dropped = env.filter((f) => f.excludedMemberIds.length);
        const notes: string[] = [];
        if (mixed.length) notes.push(`mixed sections in ${mixed.join(', ')} — used the most common section per group`);
        if (dropped.length) notes.push(`${dropped.reduce((s, f) => s + f.excludedMemberIds.length, 0)} off-type member(s) excluded`);
        if (notes.length) setWarn(notes.join('; '));
      } else {
        files = collectGroupScoFiles(groups, members, code, project);
        ranLabel = `Ran ${files.length} member file(s)`;
      }
      if (!files.length) {
        throw new Error(groups.length
          ? 'No S-Concrete-eligible members in the design groups. Add beams/rectangular columns to a group first.'
          : 'No beam or rectangular-column members to export.');
      }
      requirePaths();
      applyResult(await runScoBatch(files, cfg), ranLabel);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Re-run the batch on the .SCO files ALREADY in the output folder — no
   * regeneration, so manual tweaks the user made (in S-Concrete or a text editor)
   * are preserved — then read the fresh results back.
   */
  async function rerunExisting() {
    setErr(null); setMsg(null); setWarn(null); setResults(null); setBusy('rerun');
    try {
      requirePaths();
      applyResult(await rerunScoBatch(cfg), 'Re-ran the existing folder');
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
          title={desktop
            ? (groups.length
              ? 'Write one .SCO per group (each carrying every member\'s forces), run the S-Concrete batch, pull the governing result per group'
              : 'Write one .SCO per member, run the S-Concrete batch, pull results')
            : 'S-Concrete batch requires the Windows desktop app'}
          onClick={runBatch}
        >
          {busy === 'sco'
            ? 'Running…'
            : groups.length
              ? `⚙ Batch · ${groups.length} group file${groups.length !== 1 ? 's' : ''} (${runCount} member${runCount !== 1 ? 's' : ''})`
              : `⚙ Batch · ${runCount} member file${runCount !== 1 ? 's' : ''}`}
        </button>

        <button
          style={{ ...btn, background: desktop ? '#0ea5e9' : '#374151', opacity: busy ? 0.6 : 1 }}
          disabled={!!busy || !desktop}
          title={desktop
            ? 'Re-run BatchReporter on the .SCO files already in the output folder — your manual edits are preserved — and read the fresh results'
            : 'Re-run requires the Windows desktop app'}
          onClick={rerunExisting}
        >
          {busy === 'rerun' ? 'Re-running…' : '↻ Re-run existing folder'}
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
      {warn && <div style={{ fontSize: 11, color: '#fbbf24' }}>⚠ {warn}</div>}
      {err && <div style={{ fontSize: 11, color: '#f87171' }}>{err}</div>}

      {results && results.length > 0 && (
        <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid #1f2937', borderRadius: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                <th style={{ padding: '4px 6px' }}>{groups.length ? 'Group' : 'Member'}</th>
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
