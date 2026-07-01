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
import type { Member, DesignGroup, Project, SconcreteResult } from '../../types';
import { collectGroupScoFiles, buildGroupEnvelopeScoFiles, parseBatchResults, type ScoFile } from '../../utils/sco/scoBatch';
import { runScoBatch, rerunScoBatch, hasSconcrete, type SconcreteRunConfig, type SconcreteRunResult } from '../../utils/sco/sconcreteClient';
import { buildGroupPushPayload, summarizePushResults } from '../../adapters/etabs/pushGroups';
import { ComConnection } from '../../adapters/etabs/comClient';

interface Props {
  groups: DesignGroup[];
  members: Member[];
  project: Project;
  /** member id → ETABS frame name, from project.modelMap. */
  frameByMemberId: Map<string, string>;
  /** Lets the EC2 SLS-combo selector persist its choice (optional). */
  onProjectChange?: (updater: (prev: Project) => Project) => void;
}

const LS_KEY = 'sconcrete.runConfig';

function loadConfig(): SconcreteRunConfig {
  try {
    return { pythonExe: '', batchReporter: '', outDir: '', ...JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') };
  } catch {
    return { pythonExe: '', batchReporter: '', outDir: '' };
  }
}

// Desktop-only helpers (native file dialogs + open-in-file-manager) — see
// electron/main.cjs. Undefined on web, so callers guard on their presence.
type DesktopAPI = {
  pickPath?: (opts: { mode: 'file' | 'folder' }) => Promise<{ path: string; exists?: boolean } | { error: string } | null>;
  openPath?: (target: string) => Promise<{ success: boolean; error?: string }>;
};
const desktopApi = (): DesktopAPI | undefined =>
  (window as Window & { electronAPI?: DesktopAPI }).electronAPI;

/** Linkage from a written .SCO's name stem back to its group + members. */
type Link = { kind: 'uls' | 'crack' | 'single'; groupLabel: string; memberIds: string[] };

const btn: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
  fontWeight: 700, fontSize: 12, color: '#fff',
};
const input: React.CSSProperties = {
  width: '100%', padding: '4px 6px', borderRadius: 4, fontSize: 11,
  background: '#0b1220', border: '1px solid #1f2937', color: '#e5e7eb', marginTop: 2,
};
const label: React.CSSProperties = { fontSize: 10, color: '#94a3b8', display: 'block', marginTop: 6 };

export default function GroupActionsPanel({ groups, members, project, frameByMemberId, onProjectChange }: Props) {
  const code = project.code;
  const [busy, setBusy] = useState<'etabs' | 'sco' | 'rerun' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  // Results are PERSISTED on the project (survive tab switches, colour the map).
  // Local state is only a fallback when the panel has no onProjectChange.
  const [localResults, setLocalResults] = useState<SconcreteResult[] | null>(null);
  const shownResults = project.sconcreteResults ?? localResults;
  const [cfg, setCfgState] = useState<SconcreteRunConfig>(loadConfig);
  const [showCfg, setShowCfg] = useState(false);
  const canPick = !!desktopApi()?.pickPath;

  /** Persist results to the project (or keep local when there's no onProjectChange). */
  function saveResults(next: SconcreteResult[] | null) {
    if (onProjectChange) onProjectChange((prev) => ({ ...prev, sconcreteResults: next ?? undefined, sconcreteRanAt: next ? new Date().toISOString() : prev.sconcreteRanAt }));
    else setLocalResults(next);
  }

  /** Turn parsed .SCRS into persisted results, linking each back to its members. */
  function toScoResults(parsed: Record<string, { name: string; status: string | null; nmUtil: number | null; vtUtil: number | null }>, linkByStem?: Map<string, Link>): SconcreteResult[] {
    return Object.values(parsed).map((r) => {
      const link = linkByStem?.get(r.name);
      const memberIds = link?.memberIds ?? [
        ...members.filter((m) => m.label === r.name).map((m) => m.id),
        ...groups.filter((g) => g.label === r.name).flatMap((g) => g.memberIds),
      ];
      return { name: r.name, status: r.status, nmUtil: r.nmUtil, vtUtil: r.vtUtil, kind: link?.kind, groupLabel: link?.groupLabel, memberIds };
    });
  }

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

  // EC2 crack width needs an SLS quasi-permanent combo; offer the combos present
  // in the imported forces so the user can set/change it here (not only at import).
  const isEc2 = code === 'EN1992-1-1';
  const slsCombos = isEc2
    ? [...new Set(members.flatMap((m) => m.stationForces?.map((c) => c.combo) ?? []))].sort()
    : [];
  const ec2NoSls = isEc2 && !project.slsCombo;

  function setCfg(next: SconcreteRunConfig) {
    setCfgState(next);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  }

  async function pushToEtabs() {
    setErr(null); setMsg(null); setWarn(null); saveResults(null); setBusy('etabs');
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

  /** Parse a run/rerun result into persisted results, or report why it produced nothing. */
  function applyResult(out: SconcreteRunResult, ranLabel: string, linkByStem?: Map<string, Link>) {
    if (out.scrsText) {
      saveResults(toScoResults(parseBatchResults(out.scrsText), linkByStem));
      setMsg(`${ranLabel} — ${out.scoCount} .SCO file(s).`);
    } else {
      setErr(`Ran ${out.scoCount} .SCO file(s) but no .SCRS was produced. ${out.stderr || ''}`.trim());
    }
  }

  async function runBatch() {
    setErr(null); setMsg(null); setWarn(null); saveResults(null); setBusy('sco');
    try {
      // One .SCO PER GROUP (envelope): the group's representative section/rebar
      // carrying every member's load cases. Falls back to one file per member
      // when no groups are defined.
      let files: ScoFile[];
      let ranLabel: string;
      let linkByStem: Map<string, Link> | undefined;
      if (groups.length) {
        const env = buildGroupEnvelopeScoFiles(groups, members, code, project);
        files = env;
        // Link each file's .SCRS key (its name stem) → group + members, so results
        // persist with a group name, a ULS/crack tag, and map linkage.
        linkByStem = new Map(env.map((f) => [
          f.fileName.replace(/\.SCO$/i, ''),
          { kind: f.kind, groupLabel: f.groupLabel, memberIds: groups.find((g) => g.id === f.groupId)?.memberIds ?? [] },
        ]));
        // One .SCO per (group × member-type), plus a separate crack-width file for
        // EC2 beam groups — so file count can exceed group count. Member/LC counts
        // are de-duplicated (a member appears in a ULS and a crack file) by using
        // the panel's deduped runCount and unique excluded ids.
        const groupsWithFiles = new Set(env.map((f) => f.groupId)).size;
        const totalLCs = env.reduce((s, f) => s + f.loadCaseCount, 0);
        ranLabel = `Ran ${env.length} .SCO file(s) for ${groupsWithFiles} group(s) · ${runCount} member(s), ${totalLCs} load rows`;
        const mixed = [...new Set(env.filter((f) => f.mixedSections).map((f) => f.groupLabel))];
        const mixedR = [...new Set(env.filter((f) => f.mixedRebar).map((f) => f.groupLabel))];
        const excludedIds = new Set(env.flatMap((f) => f.excludedMemberIds));
        const notes: string[] = [];
        if (mixed.length) notes.push(`mixed sections in ${mixed.join(', ')} — used the most common section per group`);
        if (mixedR.length) notes.push(`members have different rebar in ${mixedR.join(', ')} — the file used one member's cage; apply a group rebar to unify`);
        if (excludedIds.size) notes.push(`${excludedIds.size} unsupported member(s) skipped (e.g. circular columns)`);
        if (ec2NoSls) notes.push('EC2: no SLS crack combo set — no crack-width file was generated');
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
      applyResult(await runScoBatch(files, cfg), ranLabel, linkByStem);
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
    // The folder is used as-is; results are linked back by matching file names to
    // group/member labels (best effort).
    setErr(null); setMsg(null); setWarn(null); saveResults(null); setBusy('rerun');
    try {
      requirePaths();
      applyResult(await rerunScoBatch(cfg), 'Re-ran the existing folder');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** Native file/folder picker for a config path (desktop only). */
  async function browse(field: keyof SconcreteRunConfig) {
    const api = desktopApi();
    if (!api?.pickPath) return;
    const res = await api.pickPath({ mode: field === 'outDir' ? 'folder' : 'file' });
    if (res && 'path' in res) setCfg({ ...cfg, [field]: res.path });
  }

  /** Open the output folder in the OS file manager (to tweak .SCO files, then re-run). */
  async function openFolder() {
    const api = desktopApi();
    if (!api?.openPath) return;
    if (!cfg.outDir) { setShowCfg(true); setErr('Set the output folder first.'); return; }
    const res = await api.openPath(cfg.outDir);
    if (res && !res.success) setErr(res.error ?? 'Could not open the folder.');
  }

  return (
    <div style={{ borderTop: '1px solid #1f2937', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: '#cbd5e1', letterSpacing: 0.3 }}>EXTERNAL TOOLS</div>

      {!desktop && (
        <div style={{ fontSize: 10.5, color: '#93c5fd', background: '#0b1220', border: '1px solid #1e3a8a', borderRadius: 6, padding: '6px 8px', lineHeight: 1.5 }}>
          You're in the browser. Grouping and design work here, but the <strong>S-Concrete batch</strong> and
          <strong> live ETABS</strong> steps run only in the Windows desktop app (they launch S-Concrete / ETABS locally).
          Create your groups now, then run the batch on desktop.
        </div>
      )}

      {isEc2 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 10.5, color: '#94a3b8' }}>
          <span>EC2 SLS crack combo:</span>
          {onProjectChange ? (
            <select
              value={project.slsCombo ?? ''}
              onChange={(e) => onProjectChange((prev) => ({ ...prev, slsCombo: e.target.value || undefined }))}
              style={{ background: '#0b1220', color: '#e5e7eb', border: '1px solid #1f2937', borderRadius: 4, fontSize: 10.5, padding: '2px 4px' }}
            >
              <option value="">— none (no crack file) —</option>
              {slsCombos.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          ) : (
            <span style={{ color: '#e5e7eb' }}>{project.slsCombo ?? '— none —'}</span>
          )}
          {ec2NoSls && <span style={{ color: '#fbbf24' }}>⚠ crack-width file will NOT be generated</span>}
          {isEc2 && slsCombos.length === 0 && onProjectChange && <span style={{ color: '#64748b' }}>(no combos in imported forces)</span>}
        </div>
      )}

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
              ? 'Write one .SCO per group (each carrying every member\'s forces; EC2 adds a separate crack-width file), run the S-Concrete batch, pull the governing result per group'
              : 'Write one .SCO per member, run the S-Concrete batch, pull results')
            : 'S-Concrete batch requires the Windows desktop app'}
          onClick={runBatch}
        >
          {busy === 'sco'
            ? 'Running…'
            : groups.length
              ? `⚙ Batch · ${groups.length} group${groups.length !== 1 ? 's' : ''} (${runCount} member${runCount !== 1 ? 's' : ''})`
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

        {canPick && (
          <button
            style={{ ...btn, background: cfg.outDir ? '#475569' : '#374151' }}
            disabled={!!busy}
            title="Open the output folder to view or hand-edit the .SCO files, then use Re-run"
            onClick={openFolder}
          >
            📂 Open folder
          </button>
        )}

        <button style={{ ...btn, background: '#374151' }} onClick={() => setShowCfg((s) => !s)} disabled={!!busy}>
          {showCfg ? 'Hide paths' : 'S-Concrete paths'}
        </button>
      </div>

      {showCfg && (
        <div style={{ background: '#0b1220', border: '1px solid #1f2937', borderRadius: 6, padding: 8 }}>
          <PathField label="Python executable" placeholder="C:\\…\\python.exe" value={cfg.pythonExe}
            onChange={(v) => setCfg({ ...cfg, pythonExe: v })} onBrowse={canPick ? () => browse('pythonExe') : undefined} />
          <PathField label="run_batch_reporter.py" placeholder="C:\\…\\run_batch_reporter.py" value={cfg.batchReporter}
            onChange={(v) => setCfg({ ...cfg, batchReporter: v })} onBrowse={canPick ? () => browse('batchReporter') : undefined} />
          <PathField label="Output folder (.SCO + .SCRS)" placeholder="C:\\…\\scos" value={cfg.outDir}
            onChange={(v) => setCfg({ ...cfg, outDir: v })} onBrowse={canPick ? () => browse('outDir') : undefined} />
          {!canPick && <div style={{ fontSize: 9.5, color: '#64748b', marginTop: 6 }}>Type or paste full Windows paths (file pickers are available in the desktop app).</div>}
        </div>
      )}

      {msg && <div style={{ fontSize: 11, color: '#34d399' }}>{msg}</div>}
      {warn && <div style={{ fontSize: 11, color: '#fbbf24' }}>⚠ {warn}</div>}
      {err && <div style={{ fontSize: 11, color: '#f87171' }}>{err}</div>}

      {shownResults && shownResults.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 9.5, color: '#64748b' }}>
              {project.sconcreteRanAt ? `Last run ${new Date(project.sconcreteRanAt).toLocaleString()}` : 'S-Concrete results'}
              {' · colour the map by S-Concrete'}
            </span>
            <button onClick={() => saveResults(null)}
              style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 9.5, cursor: 'pointer', padding: 0 }}>Clear</button>
          </div>
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
                {shownResults.map((r) => {
                  const badge = r.kind === 'crack' ? { t: 'crack', c: '#a78bfa' } : r.kind === 'uls' ? { t: 'ULS', c: '#38bdf8' } : null;
                  return (
                    <tr key={r.name} style={{ color: '#e5e7eb', borderTop: '1px solid #111827' }}>
                      <td style={{ padding: '4px 6px' }}>
                        {r.groupLabel ?? r.name}
                        {badge && <span style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, color: badge.c, border: `1px solid ${badge.c}`, borderRadius: 4, padding: '0 4px' }}>{badge.t}</span>}
                      </td>
                      <td style={{ padding: '4px 6px', color: r.status === 'OK' ? '#34d399' : r.status ? '#f87171' : '#94a3b8' }}>{r.status ?? '—'}</td>
                      <td style={{ padding: '4px 6px' }}>{r.nmUtil ?? '—'}</td>
                      <td style={{ padding: '4px 6px' }}>{r.vtUtil ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** One labelled path input with an optional native Browse button (desktop). */
function PathField({ label: text, placeholder, value, onChange, onBrowse }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void; onBrowse?: () => void;
}) {
  return (
    <label style={label}>{text}
      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        <input style={{ ...input, marginTop: 0 }} value={value} placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)} />
        {onBrowse && (
          <button type="button" onClick={onBrowse}
            style={{ flexShrink: 0, background: '#334155', border: 'none', color: '#e5e7eb', borderRadius: 4, padding: '0 8px', fontSize: 10, cursor: 'pointer', fontWeight: 600 }}>
            Browse…
          </button>
        )}
      </div>
    </label>
  );
}
