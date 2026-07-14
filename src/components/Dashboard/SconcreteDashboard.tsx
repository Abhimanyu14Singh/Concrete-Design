/**
 * SconcreteDashboard — the standalone "🔬 Verify" pane, split beside the plan just
 * like the Group Dashboard. Top: the S-Concrete run controls (Push to ETABS · ⚙ Batch ·
 * ↻ Re-run · 📂 Open folder · ⚙ Output) moved out of the old ② Verify panel, then a
 * grid of SconcreteCards (one per group, each with its verification status). Clicking
 * a card fills the lower half with that group's full S-Concrete detail — warnings and
 * every extracted DCR (status, governing DCR, N-M / V&T utilization, ULS/crack tag,
 * cage used, member list).
 */
import { Fragment } from 'react';
import type { Project, SconcreteResult } from '../../types';
import type { DashboardPayload } from '../../utils/dashboardPayload';
import SconcreteCard from './SconcreteCard';
import { useSconcreteBatch, matchResultsToGroup, friendlyStep } from '../../utils/sco/useSconcreteBatch';
import { governingDcr, statusView, dcrTone, type StatusTone } from '../../utils/sco/resultStatus';
import { ACCENT, BORDER, CODE_ACCENT, INK, MONO_NUM, STATUS, SURFACE, TYPE, WEIGHT } from '../../theme';

const TONE: Record<StatusTone, string> = { ok: STATUS.ok, warn: STATUS.warn, ng: STATUS.fail, none: STATUS.none };
const dcrColor = (dcr: number | null): string => TONE[dcrTone(dcr)];

const hdrBtn = (extra?: React.CSSProperties): React.CSSProperties => ({
  padding: '5px 9px', borderRadius: 6, border: `1px solid ${BORDER.strong}`, cursor: 'pointer',
  fontWeight: WEIGHT.bold, fontSize: TYPE.body, background: 'white', color: INK.base, ...extra,
});
const primaryBtn: React.CSSProperties = { border: 'none', background: ACCENT.primary, color: '#fff' };
const disabledBtn: React.CSSProperties = { border: 'none', background: BORDER.default, color: INK.muted };
const inp: React.CSSProperties = {
  width: '100%', padding: '4px 6px', borderRadius: 4, fontSize: TYPE.label,
  background: 'white', border: `1px solid ${BORDER.strong}`, color: INK.strong, marginTop: 2,
};
const fieldLbl: React.CSSProperties = { fontSize: TYPE.micro, color: INK.secondary, display: 'block', marginTop: 6 };

export default function SconcreteDashboard({
  payload, project, frameByMemberId, onProjectChange,
  selectedGroupId, onSelectGroup, onOpenMember, onClose,
}: {
  payload: DashboardPayload;
  project: Project;
  frameByMemberId: Map<string, string>;
  onProjectChange?: (updater: (prev: Project) => Project) => void;
  selectedGroupId: string | null;
  onSelectGroup: (id: string | null) => void;
  /** Double-click a member in the detail → open its design tab (in-app only). */
  onOpenMember?: (memberId: string) => void;
  onClose?: () => void;
}) {
  const batch = useSconcreteBatch(project, frameByMemberId, onProjectChange);
  const results = batch.shownResults ?? [];
  const groups = payload.groups;
  const selGroup = groups.find(g => g.id === selectedGroupId) ?? null;
  const selResults = selGroup ? matchResultsToGroup(results, selGroup.label, selGroup.memberIds) : [];
  const selMemberLabels = selGroup
    ? project.members.filter(m => selGroup.memberIds.includes(m.id)).map(m => m.label)
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, flex: 1, width: '100%', background: SURFACE.app }}>
      {/* Header — title + status roll-up + close */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${BORDER.default}`, background: 'white', flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: INK.strong }}>🔬 S-Concrete Verify</span>
        <span style={{ fontSize: 11, color: INK.muted }}>{groups.length} group{groups.length === 1 ? '' : 's'}</span>
        {batch.resultSummary && (
          <span style={{ display: 'flex', gap: 8, fontSize: 10, fontWeight: 700 }} title="Governing status across all groups">
            {batch.resultSummary.ng > 0 && <span style={{ color: TONE.ng }}>{batch.resultSummary.ng} NG</span>}
            {batch.resultSummary.warn > 0 && <span style={{ color: TONE.warn }}>{batch.resultSummary.warn} near</span>}
            {batch.resultSummary.ok > 0 && <span style={{ color: TONE.ok }}>{batch.resultSummary.ok} OK</span>}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {batch.ranAt && (
          <span style={{ fontSize: TYPE.micro, color: INK.muted }}>Last run {new Date(batch.ranAt).toLocaleString()}</span>
        )}
        {onClose && <button onClick={onClose} title="Close" style={hdrBtn({ fontWeight: 700 })}>✕</button>}
      </div>

      {/* Run controls (moved from the old ② Verify panel) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 12px', borderBottom: `1px solid ${BORDER.default}`, background: 'white', flexShrink: 0 }}>
        {!batch.desktop && (
          <div style={{ fontSize: 11, color: INK.base, background: ACCENT.softBg, border: `1px solid ${ACCENT.softBorder}`, borderRadius: 6, padding: '6px 8px', lineHeight: 1.5 }}>
            You're in the browser. The <strong>S-Concrete batch</strong> and <strong>live ETABS</strong> steps run only in the
            Windows desktop app. Group and design here, then run the batch on desktop.
          </div>
        )}

        {batch.isEc2 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 11, color: INK.secondary }}>
            <span>EC2 SLS crack combo:</span>
            {onProjectChange ? (
              <select
                value={project.slsCombo ?? ''}
                onChange={(e) => onProjectChange((prev) => ({ ...prev, slsCombo: e.target.value || undefined }))}
                style={{ background: 'white', color: INK.strong, border: `1px solid ${BORDER.strong}`, borderRadius: 4, fontSize: 11, padding: '2px 4px' }}
              >
                <option value="">— none (no crack file) —</option>
                {batch.slsCombos.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : (
              <span style={{ color: INK.strong }}>{project.slsCombo ?? '— none —'}</span>
            )}
            {batch.ec2NoSls && <span style={{ color: STATUS.warn }}>⚠ crack-width file will NOT be generated</span>}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            style={hdrBtn(batch.hasEtabs ? primaryBtn : disabledBtn)}
            disabled={!!batch.busy || !batch.hasEtabs}
            title={batch.hasEtabs ? 'Create ETABS groups and assign member frames' : 'Live ETABS requires the Windows desktop app'}
            onClick={batch.pushToEtabs}
          >
            {batch.busy === 'etabs' ? 'Pushing…' : `↑ Push ${batch.groupCount} to ETABS`}
          </button>

          <button
            style={hdrBtn(batch.desktop ? primaryBtn : disabledBtn)}
            disabled={!!batch.busy || !batch.desktop}
            title={batch.desktop
              ? 'REGENERATES one .SCO per group from your CURRENT app design (bars, sections, forces), then runs the batch. Use after changing reinforcement in the app.'
              : 'S-Concrete batch requires the Windows desktop app'}
            onClick={batch.runBatch}
          >
            {batch.busy === 'sco'
              ? 'Running…'
              : batch.groupCount
                ? `⚙ Batch · ${batch.groupCount} group${batch.groupCount !== 1 ? 's' : ''} (${batch.runCount})`
                : `⚙ Batch · ${batch.runCount} file${batch.runCount !== 1 ? 's' : ''}`}
          </button>

          <button
            style={hdrBtn(batch.desktop ? primaryBtn : disabledBtn)}
            disabled={!!batch.busy || !batch.desktop}
            title={batch.desktop
              ? 'Re-runs the .SCO files ALREADY in the folder, as they are — hand-edits survive. Does NOT regenerate from the app.'
              : 'Re-run requires the Windows desktop app'}
            onClick={batch.rerunExisting}
          >
            {batch.busy === 'rerun' ? 'Re-running…' : '↻ Re-run'}
          </button>

          {batch.canPick && (
            <button style={hdrBtn()} disabled={!!batch.busy}
              title="Open the output folder to view or hand-edit the .SCO files, then Re-run"
              onClick={batch.openFolder}>📂 Open folder</button>
          )}

          <button style={hdrBtn()} onClick={() => batch.setShowCfg((s) => !s)} disabled={!!batch.busy}>
            {batch.showCfg ? 'Hide settings' : '⚙ Output folder'}
          </button>
        </div>

        {batch.showCfg && (
          <div style={{ background: SURFACE.subtle, border: `1px solid ${BORDER.default}`, borderRadius: 6, padding: 8 }}>
            {batch.detect && (batch.detect.found
              ? <div style={{ fontSize: TYPE.micro, color: STATUS.ok, marginBottom: 6 }}>✓ S-Concrete detected — no Python needed.</div>
              : batch.desktop && <div style={{ fontSize: TYPE.micro, color: STATUS.warn, marginBottom: 6 }}>⚠ S-Concrete not found under C:\\Program Files (x86)\\S-FRAME Software\\ — install the S-FRAME Product Suite to run the batch.</div>
            )}
            <PathField label="Output folder (.SCO + .SCRS)" placeholder="C:\\…\\scos" value={batch.cfg.outDir}
              onChange={(v) => batch.setCfg({ ...batch.cfg, outDir: v })} onBrowse={batch.canPick ? () => batch.browse('outDir') : undefined} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: TYPE.label, color: INK.base, marginTop: 8, cursor: 'pointer' }}
              title="Pass/fail, DCR and warnings all come from the .SCRS, written before this step. The full PDF is only worth the wait when you need the printable report.">
              <input type="checkbox" checked={!!batch.cfg.makePdf} onChange={(e) => batch.setCfg({ ...batch.cfg, makePdf: e.target.checked })} />
              Also generate a PDF report <span style={{ color: INK.secondary }}>(off by default — slow)</span>
            </label>
            {batch.cfg.makePdf && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input style={{ ...inp, marginTop: 0 }} placeholder="Report title" value={batch.cfg.title ?? ''}
                  onChange={(e) => batch.setCfg({ ...batch.cfg, title: e.target.value })} />
                <input style={{ ...inp, marginTop: 0 }} placeholder="Engineer" value={batch.cfg.engineer ?? ''}
                  onChange={(e) => batch.setCfg({ ...batch.cfg, engineer: e.target.value })} />
              </div>
            )}
            {!batch.canPick && <div style={{ fontSize: TYPE.micro, color: INK.secondary, marginTop: 6 }}>Type or paste a full Windows path (file pickers are in the desktop app).</div>}
          </div>
        )}

        {batch.busy && batch.progress && <div style={{ fontSize: TYPE.label, color: ACCENT.primary }}>⏳ {friendlyStep(batch.progress)}</div>}
        {batch.msg && <div style={{ fontSize: TYPE.label, color: STATUS.ok }}>{batch.msg}</div>}
        {batch.warn && <div style={{ fontSize: TYPE.label, color: STATUS.warn }}>⚠ {batch.warn}</div>}
        {batch.err && <div style={{ fontSize: TYPE.label, color: STATUS.fail }}>{batch.err}</div>}
      </div>

      {/* Card grid — one SconcreteCard per group (status + section drawing) */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))', gap: 10, alignContent: 'start' }}>
        {groups.length === 0 && (
          <div style={{ color: INK.muted, fontSize: 12, padding: 20 }}>No design groups yet — create groups in the Design panel first.</div>
        )}
        {groups.map(g => (
          <SconcreteCard
            key={g.id}
            group={g}
            results={matchResultsToGroup(results, g.label, g.memberIds)}
            selected={g.id === selectedGroupId}
            onSelect={() => onSelectGroup(g.id === selectedGroupId ? null : g.id)}
          />
        ))}
      </div>

      {/* Selected-group S-Concrete detail (lower half) */}
      {selGroup && (
        <div style={{ flexShrink: 0, maxHeight: '46%', overflow: 'auto', borderTop: `1px solid ${BORDER.default}`, background: 'white' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 12px', position: 'sticky', top: 0, background: 'white', borderBottom: `1px solid ${BORDER.default}`, zIndex: 1 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: selGroup.color ?? INK.muted }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: INK.strong }}>{selGroup.label}</span>
            <span style={{ fontSize: 11, color: INK.muted }}>{selGroup.memberIds.length} member{selGroup.memberIds.length === 1 ? '' : 's'}</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: INK.muted }}>{selResults.length ? `${selResults.length} S-Concrete row${selResults.length === 1 ? '' : 's'}` : 'not verified yet'}</span>
          </div>

          {selResults.length === 0 && (
            <div style={{ padding: 14, fontSize: 12, color: INK.secondary }}>
              This group has no S-Concrete result yet. Click <b>⚙ Batch</b> above to generate and run its .SCO
              {batch.desktop ? '.' : ' (Windows desktop app).'}
            </div>
          )}

          {selResults.map((r, i) => <ResultDetail key={r.name + i} r={r} />)}

          {selMemberLabels.length > 0 && (
            <div style={{ padding: '6px 12px 10px', fontSize: TYPE.label, color: INK.secondary }}>
              {selMemberLabels.length} member{selMemberLabels.length !== 1 ? 's' : ''}: {selMemberLabels.slice(0, 16).join(', ')}{selMemberLabels.length > 16 ? '…' : ''}
              {onOpenMember && <span style={{ color: INK.muted }}> — open a member from the Dashboard to compare its app DCR.</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One S-Concrete result row expanded: status, governing DCR, utilizations, tag,
 *  over-capacity note, cage used, and warning list. */
function ResultDetail({ r }: { r: SconcreteResult }) {
  const sv = statusView(r);
  const { dcr, by } = governingDcr(r);
  const overN = (r.nmUtil ?? 0) > 1;
  const overV = (r.vtUtil ?? 0) > 1;
  const failing = [overN ? 'N-M' : null, overV ? 'V&T' : null].filter(Boolean).join(' & ');
  const warns = r.warnings ?? [];
  const badge = r.kind === 'crack' ? { t: 'crack (SLS)', c: CODE_ACCENT['EN1992-1-1'] } : r.kind === 'uls' ? { t: 'ULS', c: ACCENT.primary } : null;
  return (
    <div style={{ padding: '8px 12px', borderBottom: '1px solid #f3f4f6', fontSize: TYPE.label, color: INK.base }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <b style={{ color: TONE[sv.tone], fontSize: TYPE.body }}>{sv.text === '—' ? 'no result' : sv.text}</b>
        {sv.derived && <span style={{ color: INK.secondary }}>(derived from DCR — no status line in the report)</span>}
        {badge && <span style={{ fontSize: 10, fontWeight: 700, color: badge.c, border: `1px solid ${badge.c}`, borderRadius: 4, padding: '0 4px' }}>{badge.t}</span>}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 4 }}>
        <span>Governing DCR <b style={{ ...MONO_NUM, color: dcrColor(dcr) }}>{dcr != null ? dcr.toFixed(2) : '—'}</b>{by && <span style={{ color: INK.secondary }}> ({by})</span>}</span>
        <span>N-M util <b style={{ ...MONO_NUM, color: overN ? STATUS.fail : STATUS.ok }}>{r.nmUtil ?? '—'}</b></span>
        <span>V&amp;T util <b style={{ ...MONO_NUM, color: overV ? STATUS.fail : STATUS.ok }}>{r.vtUtil ?? '—'}</b></span>
      </div>
      {failing && <div style={{ color: STATUS.fail, marginBottom: 4 }}>⚠ over capacity: {failing} (util above 1.0)</div>}
      {r.cage && (
        <div style={{ marginBottom: 4 }}>
          Cage used: <b style={{ ...MONO_NUM, color: INK.strong }}>{r.cage}</b>
          <span style={{ color: INK.secondary }}> — not the bars you picked? Edit them on the Dashboard, then re-run.</span>
        </div>
      )}
      {warns.length > 0 && (
        <div>
          <div style={{ color: TONE.warn, marginBottom: 2 }}>⚠ {warns.length} S-Concrete message{warns.length !== 1 ? 's' : ''}:</div>
          <ul style={{ margin: 0, paddingLeft: 16, color: STATUS.warn }}>
            {warns.slice(0, 10).map((w, i) => <li key={i} style={{ marginBottom: 1 }}>{w}</li>)}
          </ul>
          {warns.length > 10 && <div style={{ color: INK.secondary }}>+{warns.length - 10} more…</div>}
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
    <label style={fieldLbl}>{text}
      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        <input style={{ ...inp, marginTop: 0 }} value={value} placeholder={placeholder}
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
