/**
 * GroupDashboard — the window-agnostic Map dashboard. Top: a grid of SectionCards
 * (one per design group). Bottom (when a group is selected): the group's beams like
 * the Dashboard tab (DCR chips + warning tags) with a status-banded DCR histogram.
 * Renders identically in-app or in a popped-out window; all data arrives as a plain
 * DashboardPayload and selection/edits flow out through callbacks.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { RebarLayout } from '../../types';
import { membersForGroup, type DashboardPayload } from '../../utils/dashboardPayload';
import SectionCard from './SectionCard';
import { DCRChip, DcrHistogram } from './dashboardShared';
import { ACCENT, BORDER, INK, STATUS, SURFACE, MONO_NUM, LABEL_STYLE, dcrColor, dcrBg } from '../../theme';

const hdrBtn: CSSProperties = {
  padding: '4px 8px', border: `1px solid ${BORDER.strong}`, borderRadius: 6,
  background: 'white', fontSize: 11, cursor: 'pointer', color: INK.base, fontWeight: 600,
};
const GRID = 'minmax(0, 1fr) 42px 42px 42px 52px 56px 34px';

export default function GroupDashboard({
  payload, selectedGroupId, onSelectGroup, onApplyRebar,
  canPopOut, onPopOut, onClose, closeLabel = '✕',
  onOpenMember, onHoverMember, onMoveMember, onCreateGroupForMember,
  onSuggestAll, onToggleCurtailmentNote, onSetOppositeTop, onSetMidThirdTop,
}: {
  payload: DashboardPayload;
  selectedGroupId: string | null;
  onSelectGroup: (id: string | null) => void;
  onApplyRebar: (groupId: string, rebar: RebarLayout) => void;
  canPopOut?: boolean;
  onPopOut?: () => void;
  onClose?: () => void;
  closeLabel?: string;
  /** Double-click a beam row → open that member's design tab (in-app only). */
  onOpenMember?: (memberId: string) => void;
  /** Hover a beam row → highlight that beam on the plan (in-app only). */
  onHoverMember?: (memberId: string | null) => void;
  /** Right-click → move the beam to another group. */
  onMoveMember?: (memberId: string, groupId: string) => void;
  /** Right-click → split the beam out into its own new group. */
  onCreateGroupForMember?: (memberId: string) => void;
  /** Auto-size every group's cage to satisfy DCRs / clear errors. */
  onSuggestAll?: () => void;
  /** Pin/unpin a face's L/3 curtailment % to the beam schedule notes. */
  onToggleCurtailmentNote?: (groupId: string, face: 'top' | 'bot', on: boolean) => void;
  /** Set (or clear) the group's reduced opposite-end top reinforcement. */
  onSetOppositeTop?: (groupId: string, bars: import('../../types').BarGroup[] | null) => void;
  /** Set (or clear) the group's reduced middle-third top reinforcement. */
  onSetMidThirdTop?: (groupId: string, bars: import('../../types').BarGroup[] | null) => void;
}) {
  const groups = payload.groups;
  const selGroup = groups.find(g => g.id === selectedGroupId) ?? null;
  // Resolve the selected group's beams by its own memberIds (overlap-safe) — a beam
  // shared by several groups is tagged to only one in member.groupId, so filtering
  // by that tag would empty this table (see membersForGroup).
  const selMembers = useMemo(() => membersForGroup(payload, selectedGroupId), [payload, selectedGroupId]);
  const govDCRs = selMembers.map(m => m.maxDCR);
  // How many of the group's beams are failing (NG) vs merely warned.
  const ngCount = selMembers.filter(m => m.status === 'NG').length;
  const warnCount = selMembers.filter(m => m.status !== 'NG' && (m.status === 'Warning' || m.warnings.length > 0)).length;

  // Right-click row menu (move to group / new group). Kept local so the dashboard
  // works the same in-app or popped out; the host decides what the callbacks do.
  const [rowMenu, setRowMenu] = useState<{ memberId: string; x: number; y: number } | null>(null);
  const canContext = !!onMoveMember || !!onCreateGroupForMember;

  // Draggable divider between the card grid (top) and the beam-list detail (bottom).
  // Persisted (localStorage) so the split survives re-open and reads the same whether
  // the dashboard is docked or in its own window — this component renders both.
  const rootRef = useRef<HTMLDivElement>(null);
  const [containerH, setContainerH] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => { for (const e of entries) setContainerH(e.contentRect.height); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [detailH, setDetailH] = useState<number>(() => {
    const v = Number(typeof localStorage !== 'undefined' ? localStorage.getItem('dashDetailH') : NaN);
    return Number.isFinite(v) && v > 0 ? v : 300;
  });
  const MIN_DETAIL = 96;
  // Leave headroom for the header + at least a couple of card rows above the divider.
  const maxDetail = containerH > 0 ? Math.max(MIN_DETAIL, containerH - 220) : Number.MAX_SAFE_INTEGER;
  const detailHClamped = Math.min(Math.max(detailH, MIN_DETAIL), maxDetail);

  function startDetailDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = detailHClamped;
    let latest = startH;
    const move = (ev: MouseEvent) => {
      // Drag up → taller beam list (the boundary follows the cursor).
      latest = Math.min(Math.max(startH - (ev.clientY - startY), MIN_DETAIL), maxDetail);
      setDetailH(latest);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      try { localStorage.setItem('dashDetailH', String(Math.round(latest))); } catch { /* non-fatal */ }
    };
    document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, flex: 1, width: '100%', background: SURFACE.app }}
      onMouseLeave={() => onHoverMember?.(null)}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${BORDER.default}`, background: 'white', flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: INK.strong }}>Group Dashboard</span>
        <span style={{ fontSize: 11, color: INK.muted }}>{groups.length} group{groups.length === 1 ? '' : 's'}</span>
        <div style={{ flex: 1 }} />
        {onSuggestAll && (
          <button
            onClick={onSuggestAll}
            title="Auto-size every group's cage to satisfy the DCRs and clear errors"
            style={{ ...hdrBtn, color: ACCENT.primary, borderColor: ACCENT.primary }}
          >✨ Suggest</button>
        )}
        {canPopOut && onPopOut && (
          <button onClick={onPopOut} title="Open the dashboard in a separate window" style={hdrBtn}>⤢ Pop out</button>
        )}
        {onClose && (
          <button onClick={onClose} title="Close" style={{ ...hdrBtn, fontWeight: 700 }}>{closeLabel}</button>
        )}
      </div>

      {/* Card grid */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))', gap: 10, alignContent: 'start' }}>
        {groups.length === 0 && (
          <div style={{ color: INK.muted, fontSize: 12, padding: 20 }}>No design groups yet — create groups in the Design panel first.</div>
        )}
        {groups.map(g => (
          <SectionCard
            key={g.id}
            group={g}
            selected={g.id === selectedGroupId}
            onSelect={() => onSelectGroup(g.id === selectedGroupId ? null : g.id)}
            onApplyRebar={onApplyRebar}
            onToggleCurtailmentNote={onToggleCurtailmentNote}
            onSetOppositeTop={onSetOppositeTop}
            onSetMidThirdTop={onSetMidThirdTop}
          />
        ))}
      </div>

      {/* Draggable divider — drop it where you like; the beam list keeps that height. */}
      {selGroup && (
        <div
          onMouseDown={startDetailDrag}
          title="Drag to resize the beam list"
          style={{ flexShrink: 0, height: 9, cursor: 'row-resize', background: SURFACE.subtle, borderTop: `1px solid ${BORDER.default}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div style={{ width: 44, height: 3, borderRadius: 2, background: BORDER.strong }} />
        </div>
      )}

      {/* Selected-group detail (bottom half) — height set by the divider above. */}
      {selGroup && (
        <div style={{ flexShrink: 0, height: detailHClamped, overflow: 'auto', background: 'white' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '8px 12px', position: 'sticky', top: 0, background: 'white', borderBottom: `1px solid ${BORDER.default}`, zIndex: 1 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: selGroup.color ?? INK.muted }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: INK.strong }}>{selGroup.label}</span>
            <span style={{ fontSize: 11, color: INK.muted }}>{selMembers.length} beam{selMembers.length === 1 ? '' : 's'}</span>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'flex-end', gap: 16 }}>
              {/* Beams with problems in this group, beside the histogram. */}
              <div>
                <div style={{ ...LABEL_STYLE, marginBottom: 2 }}>Beams flagged</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', height: 30 }}>
                  {ngCount === 0 && warnCount === 0 && (
                    <span style={{ fontSize: 12, fontWeight: 700, color: STATUS.ok }}>✓ all pass</span>
                  )}
                  {ngCount > 0 && (
                    <span title="Beams failing a check (DCR > 1 / NG)" style={{ fontSize: 12, fontWeight: 700, color: STATUS.fail, background: STATUS.failBg, padding: '2px 7px', borderRadius: 5 }}>{ngCount} ✕</span>
                  )}
                  {warnCount > 0 && (
                    <span title="Beams with warnings" style={{ fontSize: 12, fontWeight: 700, color: STATUS.warn, background: STATUS.warnBg, padding: '2px 7px', borderRadius: 5 }}>{warnCount} ⚠</span>
                  )}
                </div>
              </div>
              <div>
                <div style={{ ...LABEL_STYLE, marginBottom: 2 }}>DCR distribution</div>
                <DcrHistogram values={govDCRs} />
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '5px 12px', borderBottom: '1px solid #f3f4f6', background: SURFACE.subtle }}>
            {['Beam', 'M⁺', 'M⁻', 'V', 'DCR', 'Status', '⚠'].map(h => <span key={h} style={LABEL_STYLE}>{h}</span>)}
          </div>
          {selMembers.map(m => (
            <div key={m.id}
              title={onOpenMember ? 'Double-click to open the member · right-click to move to another group' : undefined}
              style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, alignItems: 'center', padding: '5px 12px', borderBottom: '1px solid #f3f4f6', cursor: onOpenMember ? 'pointer' : 'default' }}
              onMouseEnter={e => { onHoverMember?.(m.id); (e.currentTarget as HTMLDivElement).style.background = SURFACE.subtle; }}
              onMouseLeave={e => { onHoverMember?.(null); (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
              onDoubleClick={() => onOpenMember?.(m.id)}
              onContextMenu={canContext ? (e => { e.preventDefault(); setRowMenu({ memberId: m.id, x: e.clientX, y: e.clientY }); }) : undefined}
            >
              <span style={{ fontSize: 12, color: INK.base, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
              <DCRChip label="M⁺" value={m.modeDCRs.flexPos} />
              <DCRChip label="M⁻" value={m.modeDCRs.flexNeg} />
              <DCRChip label="V" value={m.modeDCRs.shear} />
              <span style={{ ...MONO_NUM, fontSize: 11, fontWeight: 700, color: dcrColor(m.maxDCR), background: dcrBg(m.maxDCR), padding: '1px 5px', borderRadius: 4, justifySelf: 'start' }}>{m.maxDCR.toFixed(2)}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: m.status === 'OK' ? STATUS.ok : m.status === 'NG' ? STATUS.fail : STATUS.warn }}>{m.status}</span>
              <span title={m.warnings.map(w => w.message).join('\n')} style={{ fontSize: 10, fontWeight: 700, color: m.warnings.length ? STATUS.warn : INK.muted }}>{m.warnings.length ? `${m.warnings.length}⚠` : '—'}</span>
            </div>
          ))}
          {selMembers.length === 0 && <div style={{ padding: 14, fontSize: 12, color: INK.muted }}>No beams in this group.</div>}
        </div>
      )}

      {rowMenu && (
        <RowMenu
          x={rowMenu.x} y={rowMenu.y}
          groups={groups.filter(g => g.id !== selGroup?.id).map(g => ({ id: g.id, label: g.label, color: g.color }))}
          onMove={onMoveMember ? gid => { onMoveMember(rowMenu.memberId, gid); setRowMenu(null); } : undefined}
          onCreateOwn={onCreateGroupForMember ? () => { onCreateGroupForMember(rowMenu.memberId); setRowMenu(null); } : undefined}
          onClose={() => setRowMenu(null)}
        />
      )}
    </div>
  );
}

/** Compact right-click menu for a dashboard beam row: move to a group or split it out. */
function RowMenu({ x, y, groups, onMove, onCreateOwn, onClose }: {
  x: number; y: number;
  groups: { id: string; label: string; color?: string }[];
  onMove?: (groupId: string) => void;
  onCreateOwn?: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [onClose]);
  const item: CSSProperties = { padding: '7px 14px', cursor: 'pointer', color: INK.strong, display: 'flex', alignItems: 'center', gap: 6 };
  return (
    <div ref={ref} style={{ position: 'fixed', left: x, top: y, zIndex: 9999, background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.15)', fontSize: 12, minWidth: 190, maxHeight: 320, overflow: 'auto', paddingBottom: 4 }}>
      <div style={{ padding: '6px 14px 4px', fontSize: 10, color: INK.muted, textTransform: 'uppercase', letterSpacing: 0.4, borderBottom: '1px solid #f3f4f6' }}>Change group</div>
      {onCreateOwn && (
        <div style={item}
          onClick={onCreateOwn}
          onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
          onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
          ＋ New group from this beam
        </div>
      )}
      {onMove && groups.length > 0 && <div style={{ borderTop: '1px solid #f3f4f6', margin: '3px 0' }} />}
      {onMove && groups.map(g => (
        <div key={g.id} style={item}
          onClick={() => onMove(g.id)}
          onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
          onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: g.color ?? INK.muted, flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
        </div>
      ))}
      {onMove && groups.length === 0 && !onCreateOwn && (
        <div style={{ padding: '8px 14px', color: INK.muted }}>No other groups</div>
      )}
    </div>
  );
}
