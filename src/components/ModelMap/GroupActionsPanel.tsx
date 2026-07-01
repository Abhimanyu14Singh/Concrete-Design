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
import { useState, useEffect, Fragment } from 'react';
import type { Member, DesignGroup, Project, SconcreteResult, RebarLayout } from '../../types';
import { formatBarLabel } from '../../utils/rebar';
import { collectGroupScoFiles, buildGroupEnvelopeScoFiles, parseBatchResults, type ScoFile } from '../../utils/sco/scoBatch';
import type { ScrsResult } from '../../utils/sco/scrsParser';
import { governingDcr, statusView, summarize, dcrTone, type StatusTone } from '../../utils/sco/resultStatus';
import { runScoBatch, rerunScoBatch, hasSconcrete, detectSconcrete, type SconcreteRunConfig, type SconcreteRunResult, type SconcreteDetect } from '../../utils/sco/sconcreteClient';
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
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
    return { outDir: saved.outDir ?? '', title: saved.title, engineer: saved.engineer, makePdf: saved.makePdf };
  } catch {
    return { outDir: '' };
  }
}

// Desktop-only helpers (native file dialogs + open-in-file-manager) — see
// electron/main.cjs. Undefined on web, so callers guard on their presence.
type DesktopAPI = {
  pickPath?: (opts: { mode: 'file' | 'folder' }) => Promise<{ path: string; exists?: boolean } | { error: string } | null>;
  openPath?: (target: string) => Promise<{ success: boolean; error?: string }>;
  sconcreteAutodetect?: () => Promise<{ outDir: string }>;
  onSconcreteProgress?: (cb: (line: string) => void) => void;
  offSconcreteProgress?: () => void;
};

/** Map a raw sidecar stderr line to a friendly batch step for the UI. */
function friendlyStep(line: string): string {
  const l = line.toLowerCase();
  if (l.startsWith('writing')) return line;
  if (l.includes('starting batchreporter') || l.includes('window ready')) return 'Launching S-Concrete BatchReporter…';
  if (l.includes('folder loaded')) return 'Loading the .SCO folder…';
  if (l.includes('run batch') || l.includes('waiting for batch')) return 'Running the batch designer…';
  if (l.includes('status:')) return `Running — ${line.split('Status:').pop()?.trim() || ''}`;
  if (l.includes('batch done')) return 'Reading results…';
  if (l.includes('creating pdf')) return 'Writing the PDF report…';
  return line;
}
const desktopApi = (): DesktopAPI | undefined =>
  (window as Window & { electronAPI?: DesktopAPI }).electronAPI;

/** Linkage from a written .SCO's name stem back to its group + members. */
type Link = { kind: 'uls' | 'crack' | 'single'; groupLabel: string; memberIds: string[]; cage?: string };

/** One face's bars as "3-#10" / "3-Ø32" (US or metric), or "—" when empty. */
const faceLabel = (bars: { numBars: number; barSize: number }[]): string =>
  bars.length ? bars.map((b) => `${b.numBars}-${formatBarLabel(b.barSize)}`).join('+') : '—';

/** The longitudinal cage a .SCO used, for showing beside the result so a wrong
 *  bar size (e.g. the #8 fallback when a #10 template wasn't applied) is visible. */
function cageLabel(rebar: RebarLayout | undefined): string | undefined {
  if (!rebar) return undefined;
  return `${faceLabel(rebar.topBars)} top / ${faceLabel(rebar.botBars)} bot`;
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

// Status tone → colour for the results table (logic lives in resultStatus.ts).
const TONE: Record<StatusTone, string> = { ok: '#34d399', warn: '#fbbf24', ng: '#f87171', none: '#94a3b8' };
const dcrColor = (dcr: number | null): string => TONE[dcrTone(dcr)];

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
  const resultSummary = shownResults?.length ? summarize(shownResults) : null;
  const [cfg, setCfgState] = useState<SconcreteRunConfig>(loadConfig);
  const [showCfg, setShowCfg] = useState(false);
  const [progress, setProgress] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detect, setDetect] = useState<SconcreteDetect | null>(null);
  const canPick = !!desktopApi()?.pickPath;

  // Desktop: default a blank output folder + detect whether S-Concrete is
  // installed, once on mount. The batch needs NO Python — the bundled
  // SConcreteHelper.exe drives BatchReporter directly — so an output folder is
  // the only setting left, and even that is auto-defaulted.
  useEffect(() => {
    const api = desktopApi();
    let cancelled = false;
    if (api?.sconcreteAutodetect && !cfg.outDir) {
      api.sconcreteAutodetect().then(found => {
        if (cancelled || !found?.outDir) return;
        setCfgState(prev => {
          if (prev.outDir) return prev;
          const next = { ...prev, outDir: found.outDir };
          localStorage.setItem(LS_KEY, JSON.stringify(next));
          return next;
        });
      }).catch(() => { /* best effort */ });
    }
    detectSconcrete().then(d => { if (!cancelled) setDetect(d); }).catch(() => { /* best effort */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live batch progress: the sidecar streams its current step on stderr; show it.
  useEffect(() => {
    const api = desktopApi();
    if (!api?.onSconcreteProgress) return;
    api.onSconcreteProgress((line) => { if (!line.startsWith('[watcher]')) setProgress(line); });
    return () => { api.offSconcreteProgress?.(); };
  }, []);

  /** Persist results to the project (or keep local when there's no onProjectChange). */
  function saveResults(next: SconcreteResult[] | null) {
    if (onProjectChange) onProjectChange((prev) => ({ ...prev, sconcreteResults: next ?? undefined, sconcreteRanAt: next ? new Date().toISOString() : prev.sconcreteRanAt }));
    else setLocalResults(next);
  }

  /** Turn parsed .SCRS into persisted results, linking each back to its members. */
  function toScoResults(parsed: Record<string, ScrsResult>, linkByStem?: Map<string, Link>): SconcreteResult[] {
    return Object.values(parsed).map((r) => {
      const link = linkByStem?.get(r.name);
      const memberIds = link?.memberIds ?? [
        ...members.filter((m) => m.label === r.name).map((m) => m.id),
        ...groups.filter((g) => g.label === r.name).flatMap((g) => g.memberIds),
      ];
      return {
        name: r.name, status: r.status, nmUtil: r.nmUtil, vtUtil: r.vtUtil,
        kind: link?.kind, groupLabel: link?.groupLabel, memberIds,
        warnings: r.msgs?.length ? r.msgs : undefined, cage: link?.cage,
      };
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
      setProgress('');
    }
  }

  /** Guard the output folder; opens the config panel and throws if unset. */
  function requirePaths() {
    if (!cfg.outDir) {
      setShowCfg(true);
      throw new Error('Set the S-Concrete output folder below first.');
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
    setErr(null); setMsg(null); setWarn(null); saveResults(null); setBusy('sco'); setProgress('Preparing…');
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
        // persist with a group name, a ULS/crack tag, map linkage, and the cage the
        // .SCO actually used (group template, else the representative member's cage —
        // the same resolution the envelope uses) so a wrong bar size is visible.
        linkByStem = new Map(env.map((f) => {
          const grp = groups.find((g) => g.id === f.groupId);
          const memberIds = grp?.memberIds ?? [];
          const repMember = members.find((m) => memberIds.includes(m.id) && isScoEligible(m));
          return [
            f.fileName.replace(/\.SCO$/i, ''),
            { kind: f.kind, groupLabel: f.groupLabel, memberIds, cage: cageLabel(grp?.rebar ?? repMember?.rebar) },
          ];
        }));
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
      setProgress('');
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
      setProgress('');
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
          {showCfg ? 'Hide settings' : '⚙ Output folder'}
        </button>
      </div>

      {showCfg && (
        <div style={{ background: '#0b1220', border: '1px solid #1f2937', borderRadius: 6, padding: 8 }}>
          {detect && (detect.found
            ? <div style={{ fontSize: 9.5, color: '#34d399', marginBottom: 6 }}>✓ S-Concrete detected — no Python needed.</div>
            : desktop && <div style={{ fontSize: 9.5, color: '#fbbf24', marginBottom: 6 }}>⚠ S-Concrete not found under C:\\Program Files (x86)\\S-FRAME Software\\ — install the S-FRAME Product Suite to run the batch.</div>
          )}
          <PathField label="Output folder (.SCO + .SCRS)" placeholder="C:\\…\\scos" value={cfg.outDir}
            onChange={(v) => setCfg({ ...cfg, outDir: v })} onBrowse={canPick ? () => browse('outDir') : undefined} />
          <div style={{ fontSize: 9.5, color: '#64748b', marginTop: 6 }}>
            The batch runs via the bundled S-Concrete helper — no Python or scripts. Defaults to your Documents folder.
          </div>
          {!canPick && <div style={{ fontSize: 9.5, color: '#64748b', marginTop: 6 }}>Type or paste a full Windows path (file pickers are in the desktop app).</div>}
        </div>
      )}

      {busy && progress && (
        <div style={{ fontSize: 10.5, color: '#93c5fd' }}>⏳ {friendlyStep(progress)}</div>
      )}
      {msg && <div style={{ fontSize: 11, color: '#34d399' }}>{msg}</div>}
      {warn && <div style={{ fontSize: 11, color: '#fbbf24' }}>⚠ {warn}</div>}
      {err && <div style={{ fontSize: 11, color: '#f87171' }}>{err}</div>}

      {shownResults && shownResults.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9.5, color: '#64748b' }}>
              {project.sconcreteRanAt ? `Last run ${new Date(project.sconcreteRanAt).toLocaleString()}` : 'S-Concrete results'}
              {' · colour the map by S-Concrete'}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {resultSummary && (
                <span style={{ display: 'flex', gap: 8, fontSize: 10, fontWeight: 700 }} title="Governing status across all groups">
                  {resultSummary.ng > 0 && <span style={{ color: TONE.ng }}>{resultSummary.ng} NG</span>}
                  {resultSummary.warn > 0 && <span style={{ color: TONE.warn }}>{resultSummary.warn} near</span>}
                  {resultSummary.ok > 0 && <span style={{ color: TONE.ok }}>{resultSummary.ok} OK</span>}
                  {resultSummary.none > 0 && <span style={{ color: TONE.none }}>{resultSummary.none} —</span>}
                </span>
              )}
              <button onClick={() => saveResults(null)}
                style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 9.5, cursor: 'pointer', padding: 0 }}>Clear</button>
            </div>
          </div>
          <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid #1f2937', borderRadius: 6 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                  <th style={{ padding: '4px 6px' }}>{groups.length ? 'Group' : 'Member'}</th>
                  <th style={{ padding: '4px 6px' }}>Status</th>
                  <th style={{ padding: '4px 6px' }} title="Governing demand/capacity ratio — the worse of N-M and shear+torsion (>1 = over capacity)">DCR</th>
                  <th style={{ padding: '4px 6px', textAlign: 'center' }} title="S-Concrete messages / warnings for this run">⚠</th>
                </tr>
              </thead>
              <tbody>
                {shownResults.map((r) => {
                  const badge = r.kind === 'crack' ? { t: 'crack', c: '#a78bfa' } : r.kind === 'uls' ? { t: 'ULS', c: '#38bdf8' } : null;
                  const isOpen = expanded === r.name;
                  const memberLabels = members.filter((m) => r.memberIds?.includes(m.id)).map((m) => m.label);
                  const overN = (r.nmUtil ?? 0) > 1;
                  const overV = (r.vtUtil ?? 0) > 1;
                  const failing = [overN ? 'N-M' : null, overV ? 'V&T' : null].filter(Boolean).join(' & ');
                  const sv = statusView(r);
                  const { dcr, by } = governingDcr(r);
                  const warns = r.warnings ?? [];
                  return (
                    <Fragment key={r.name}>
                      <tr style={{ color: '#e5e7eb', borderTop: '1px solid #111827', cursor: 'pointer' }}
                        onClick={() => setExpanded(isOpen ? null : r.name)} title="Click to see this group's checks">
                        <td style={{ padding: '4px 6px' }}>
                          <span style={{ color: '#64748b', marginRight: 3 }}>{isOpen ? '▾' : '▸'}</span>
                          {r.groupLabel ?? r.name}
                          {badge && <span style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, color: badge.c, border: `1px solid ${badge.c}`, borderRadius: 4, padding: '0 4px' }}>{badge.t}</span>}
                        </td>
                        <td style={{ padding: '4px 6px', color: TONE[sv.tone], fontWeight: 700, whiteSpace: 'nowrap' }}>
                          {sv.text}
                          {sv.derived && <span style={{ color: '#64748b', fontWeight: 400 }} title="No status line in the report — derived from the governing DCR">&nbsp;*</span>}
                        </td>
                        <td style={{ padding: '4px 6px', color: dcrColor(dcr), fontWeight: 700, whiteSpace: 'nowrap' }}
                          title={by ? `Governed by ${by} utilization` : undefined}>
                          {dcr != null ? dcr.toFixed(2) : '—'}
                          {by && <span style={{ color: '#64748b', fontWeight: 400, fontSize: 9, marginLeft: 3 }}>{by}</span>}
                        </td>
                        <td style={{ padding: '4px 6px', textAlign: 'center', color: warns.length ? TONE.warn : '#334155', fontWeight: warns.length ? 700 : 400 }}
                          title={warns.length ? `${warns.length} message(s)` : 'no messages'}>
                          {warns.length || '—'}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr style={{ background: '#0b1220' }}>
                          <td colSpan={4} style={{ padding: '6px 10px', fontSize: 10.5, color: '#cbd5e1' }}>
                            <div style={{ marginBottom: 4 }}>
                              <b style={{ color: TONE[sv.tone] }}>{sv.text === '—' ? 'no result' : sv.text}</b>
                              {sv.derived && <span style={{ color: '#64748b' }}> (derived from DCR — no status line in the report)</span>}
                              {r.kind && <span style={{ color: '#64748b' }}> · {r.kind === 'crack' ? 'crack-width (SLS)' : r.kind === 'uls' ? 'strength (ULS)' : 'strength'} check</span>}
                            </div>
                            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
                              <span>Governing DCR <b style={{ color: dcrColor(dcr) }}>{dcr != null ? dcr.toFixed(2) : '—'}</b>{by && <span style={{ color: '#64748b' }}> ({by})</span>}</span>
                              <span>N-M util <b style={{ color: overN ? '#f87171' : '#34d399' }}>{r.nmUtil ?? '—'}</b></span>
                              <span>V&amp;T util <b style={{ color: overV ? '#f87171' : '#34d399' }}>{r.vtUtil ?? '—'}</b></span>
                            </div>
                            {failing && <div style={{ color: '#f87171', marginBottom: 4 }}>⚠ over capacity: {failing} (util above 1.0)</div>}
                            {r.cage && (
                              <div style={{ marginBottom: 4 }}>
                                Cage used: <b style={{ fontFamily: 'monospace', color: '#e5e7eb' }}>{r.cage}</b>
                                <span style={{ color: '#64748b' }}> — not the bars you picked? Set them in ① Design and click “Apply to N members”, then re-run.</span>
                              </div>
                            )}
                            {warns.length > 0 && (
                              <div style={{ marginBottom: 4 }}>
                                <div style={{ color: TONE.warn, marginBottom: 2 }}>⚠ {warns.length} S-Concrete message{warns.length !== 1 ? 's' : ''}:</div>
                                <ul style={{ margin: 0, paddingLeft: 16, color: '#fcd34d' }}>
                                  {warns.slice(0, 8).map((w, i) => <li key={i} style={{ marginBottom: 1 }}>{w}</li>)}
                                </ul>
                                {warns.length > 8 && <div style={{ color: '#64748b' }}>+{warns.length - 8} more…</div>}
                              </div>
                            )}
                            {memberLabels.length > 0 && (
                              <div style={{ color: '#94a3b8' }}>
                                {memberLabels.length} member{memberLabels.length !== 1 ? 's' : ''}: {memberLabels.slice(0, 12).join(', ')}{memberLabels.length > 12 ? '…' : ''}
                              </div>
                            )}
                            <div style={{ color: '#64748b', marginTop: 3 }}>Open a member to compare its app DCR with this S-Concrete result.</div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
