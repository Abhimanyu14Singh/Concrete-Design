/**
 * useSconcreteBatch — the S-Concrete verification workflow, extracted from the old
 * ② Verify panel so it can drive the standalone "🔬 Verify" dashboard (a split beside
 * the plan, mirroring the Group Dashboard). Owns everything the run needs:
 *   • Push the design groups back into ETABS (named groups + frame assignment).
 *   • Generate one .SCO per group (envelope) or per member, run the S-Concrete batch,
 *     and pull the pass/fail + utilization results back in (persisted on the project).
 *   • Re-run the .SCO files already in the output folder (hand-edits survive).
 *
 * The desktop round-trips only work in the Windows app (live ETABS / installed
 * S-Concrete); on web the derived `desktop`/`hasEtabs` flags let the UI explain why.
 */
import { useState, useEffect } from 'react';
import type { Member, Project, SconcreteResult, RebarLayout } from '../../types';
import { formatBarLabel } from '../rebar';
import { collectGroupScoFiles, buildGroupEnvelopeScoFiles, parseBatchResults, type ScoFile } from './scoBatch';
import type { ScrsResult } from './scrsParser';
import { summarize, governingDcr, statusView, type StatusTone } from './resultStatus';
import { runScoBatch, rerunScoBatch, hasSconcrete, detectSconcrete, type SconcreteRunConfig, type SconcreteRunResult, type SconcreteDetect } from './sconcreteClient';
import { buildGroupPushPayload, summarizePushResults } from '../../adapters/etabs/pushGroups';
import { ComConnection } from '../../adapters/etabs/comClient';

const LS_KEY = 'sconcrete.runConfig';

function loadConfig(): SconcreteRunConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
    return { outDir: saved.outDir ?? '', title: saved.title, engineer: saved.engineer, makePdf: saved.makePdf ?? false };
  } catch {
    return { outDir: '' };
  }
}

// Desktop-only helpers (native file dialogs + open-in-file-manager) — see
// electron/main.cjs. Undefined on web, so callers guard on their presence.
export type DesktopAPI = {
  pickPath?: (opts: { mode: 'file' | 'folder' }) => Promise<{ path: string; exists?: boolean } | { error: string } | null>;
  openPath?: (target: string) => Promise<{ success: boolean; error?: string }>;
  sconcreteAutodetect?: () => Promise<{ outDir: string }>;
  onSconcreteProgress?: (cb: (line: string) => void) => void;
  offSconcreteProgress?: () => void;
};

export const desktopApi = (): DesktopAPI | undefined =>
  (window as Window & { electronAPI?: DesktopAPI }).electronAPI;

/** Map a raw sidecar stderr line to a friendly batch step for the UI. */
export function friendlyStep(line: string): string {
  const l = line.toLowerCase();
  if (l.startsWith('writing')) return line;
  if (l.includes('starting batchreporter') || l.includes('window ready')) return 'Launching S-Concrete BatchReporter…';
  if (l.includes('folder loaded')) return 'Loading the .SCO folder…';
  if (l.includes('run batch') || l.includes('waiting for batch')) return 'Running the batch designer…';
  if (l.includes('status:')) return `Running — ${line.split('Status:').pop()?.trim() || ''}`;
  if (l.includes('batch done')) return 'Reading results…';
  if (l.includes('creating pdf')) return 'Writing the optional PDF report… (BatchReporter renders every section — this can take a minute)';
  return line;
}

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

/** All S-Concrete results belonging to a design group (a ULS row and, for EC2, a
 *  crack-width row share the group's label / members). */
export function matchResultsToGroup(results: SconcreteResult[], groupLabel: string, memberIds: string[]): SconcreteResult[] {
  const idSet = new Set(memberIds);
  return results.filter((r) =>
    (r.groupLabel != null && r.groupLabel === groupLabel)
    || r.name === groupLabel
    || (r.memberIds?.some((id) => idSet.has(id)) ?? false),
  );
}

const TONE_RANK: Record<StatusTone, number> = { none: 0, ok: 1, warn: 2, ng: 3 };

/** Roll a group's S-Concrete rows into one badge: worst status + governing DCR +
 *  total warning count. Null when the group has no results (not verified yet). */
export function summarizeGroupResults(results: SconcreteResult[]):
  { tone: StatusTone; text: string; dcr: number | null; warnCount: number; count: number } | null {
  if (!results.length) return null;
  let dcr: number | null = null;
  let warnCount = 0;
  let worst = statusView(results[0]);
  for (const r of results) {
    const g = governingDcr(r);
    if (g.dcr != null) dcr = dcr == null ? g.dcr : Math.max(dcr, g.dcr);
    warnCount += r.warnings?.length ?? 0;
    const sv = statusView(r);
    if (TONE_RANK[sv.tone] > TONE_RANK[worst.tone]) worst = sv;
  }
  return { tone: worst.tone, text: worst.text, dcr, warnCount, count: results.length };
}

export interface SconcreteBatch {
  code: Project['code'];
  busy: 'etabs' | 'sco' | 'rerun' | null;
  msg: string | null;
  err: string | null;
  warn: string | null;
  progress: string;
  cfg: SconcreteRunConfig;
  showCfg: boolean;
  setShowCfg: (v: boolean | ((s: boolean) => boolean)) => void;
  setCfg: (next: SconcreteRunConfig) => void;
  detect: SconcreteDetect | null;
  canPick: boolean;
  desktop: boolean;
  hasEtabs: boolean;
  isEc2: boolean;
  slsCombos: string[];
  ec2NoSls: boolean;
  runCount: number;
  groupCount: number;
  shownResults: SconcreteResult[] | null;
  resultSummary: Record<StatusTone, number> | null;
  ranAt?: string;
  pushToEtabs: () => Promise<void>;
  runBatch: () => Promise<void>;
  rerunExisting: () => Promise<void>;
  browse: (field: keyof SconcreteRunConfig) => Promise<void>;
  openFolder: () => Promise<void>;
  clearResults: () => void;
}

/**
 * The S-Concrete verification workflow as a hook. Derives its groups/members from
 * the project so callers only pass the project (+ frame linkage + a project setter).
 */
export function useSconcreteBatch(
  project: Project,
  frameByMemberId: Map<string, string>,
  onProjectChange?: (updater: (prev: Project) => Project) => void,
): SconcreteBatch {
  const code = project.code;
  const groups = project.designGroups ?? [];
  const members = project.members;

  const [busy, setBusy] = useState<'etabs' | 'sco' | 'rerun' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  // Results are PERSISTED on the project (survive tab switches, colour the map).
  // Local state is only a fallback when the caller has no onProjectChange.
  const [localResults, setLocalResults] = useState<SconcreteResult[] | null>(null);
  const shownResults = project.sconcreteResults ?? localResults;
  const resultSummary = shownResults?.length ? summarize(shownResults) : null;
  const [cfg, setCfgState] = useState<SconcreteRunConfig>(loadConfig);
  const [showCfg, setShowCfg] = useState(false);
  const [progress, setProgress] = useState('');
  const [detect, setDetect] = useState<SconcreteDetect | null>(null);
  const canPick = !!desktopApi()?.pickPath;

  // Desktop: default a blank output folder + detect whether S-Concrete is
  // installed, once on mount. The batch needs NO Python — the bundled
  // SConcreteHelper.exe drives BatchReporter directly.
  useEffect(() => {
    const api = desktopApi();
    let cancelled = false;
    if (api?.sconcreteAutodetect && !cfg.outDir) {
      api.sconcreteAutodetect().then((found) => {
        if (cancelled || !found?.outDir) return;
        setCfgState((prev) => {
          if (prev.outDir) return prev;
          const next = { ...prev, outDir: found.outDir };
          localStorage.setItem(LS_KEY, JSON.stringify(next));
          return next;
        });
      }).catch(() => { /* best effort */ });
    }
    detectSconcrete().then((d) => { if (!cancelled) setDetect(d); }).catch(() => { /* best effort */ });
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

  // S-Concrete sections: beams (Member Type 1), rectangular columns (Type 3), and
  // — for ACI — circular columns (Member Type 4, Version 2026.0). EC2 circular
  // columns have no sample yet, so they stay ineligible under EN 1992-1-1.
  const isScoEligible = (m: Member) =>
    m.memberType === 'beam'
    || m.section.type === 'rectangular_column'
    || (m.section.type === 'circular_column' && code !== 'EN1992-1-1');
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
        // .SCO actually used (group template, else the representative member's cage).
        linkByStem = new Map(env.map((f) => {
          const grp = groups.find((g) => g.id === f.groupId);
          const memberIds = grp?.memberIds ?? [];
          const repMember = members.find((m) => memberIds.includes(m.id) && isScoEligible(m));
          return [
            f.fileName.replace(/\.SCO$/i, ''),
            { kind: f.kind, groupLabel: f.groupLabel, memberIds, cage: cageLabel(grp?.rebar ?? repMember?.rebar) },
          ];
        }));
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

  return {
    code,
    busy, msg, err, warn, progress,
    cfg, showCfg, setShowCfg, setCfg,
    detect, canPick, desktop, hasEtabs,
    isEc2, slsCombos, ec2NoSls,
    runCount, groupCount: groups.length,
    shownResults, resultSummary, ranAt: project.sconcreteRanAt,
    pushToEtabs, runBatch, rerunExisting, browse, openFolder,
    clearResults: () => saveResults(null),
  };
}
