/**
 * GroupDashboard — the window-agnostic Map dashboard. Top: a grid of SectionCards
 * (one per design group). Bottom (when a group is selected): the group's beams like
 * the Dashboard tab (DCR chips + warning tags) with a status-banded DCR histogram.
 * Renders identically in-app or in a popped-out window; all data arrives as a plain
 * DashboardPayload and selection/edits flow out through callbacks.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { RebarLayout } from '../../types';
import type { DashboardPayload } from '../../utils/dashboardPayload';
import SectionCard from './SectionCard';
import { DCRChip, DcrHistogram } from './dashboardShared';
import { BORDER, INK, STATUS, SURFACE, MONO_NUM, LABEL_STYLE, dcrColor, dcrBg } from '../../theme';

const hdrBtn: CSSProperties = {
  padding: '4px 8px', border: `1px solid ${BORDER.strong}`, borderRadius: 6,
  background: 'white', fontSize: 11, cursor: 'pointer', color: INK.base, fontWeight: 600,
};
const GRID = 'minmax(0, 1fr) 42px 42px 42px 52px 56px 34px';

export default function GroupDashboard({
  payload, selectedGroupId, onSelectGroup, onApplyRebar,
  canPopOut, onPopOut, onClose, closeLabel = '✕',
  onOpenMember, onHoverMember, onMoveMember, onCreateGroupForMember,
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
}) {
  const groups = payload.groups;
  const selGroup = groups.find(g => g.id === selectedGroupId) ?? null;
  const selMembers = selGroup ? payload.members.filter(m => m.groupId === selGroup.id) : [];
  const govDCRs = selMembers.map(m => m.maxDCR);

  // Right-click row menu (move to group / new group). Kept local so the dashboard
  // works the same in-app or popped out; the host decides what the callbacks do.
  const [rowMenu, setRowMenu] = useState<{ memberId: string; x: number; y: number } | null>(null);
  const canContext = !!onMoveMember || !!onCreateGroupForMember;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, flex: 1, width: '100%', background: SURFACE.app }}
      onMouseLeave={() => onHoverMember?.(null)}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${BORDER.default}`, background: 'white', flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: INK.strong }}>Group Dashboard</span>
        <span style={{ fontSize: 11, color: INK.muted }}>{groups.length} group{groups.length === 1 ? '' : 's'}</span>
        <div style={{ flex: 1 }} />
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
          />
        ))}
      </div>

      {/* Selected-group detail (bottom half) */}
      {selGroup && (
        <div style={{ flexShrink: 0, maxHeight: '44%', overflow: 'auto', borderTop: `1px solid ${BORDER.default}`, background: 'white' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '8px 12px', position: 'sticky', top: 0, background: 'white', borderBottom: `1px solid ${BORDER.default}`, zIndex: 1 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: selGroup.color ?? INK.muted }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: INK.strong }}>{selGroup.label}</span>
            <span style={{ fontSize: 11, color: INK.muted }}>{selMembers.length} beam{selMembers.length === 1 ? '' : 's'}</span>
            <div style={{ marginLeft: 'auto' }}>
              <div style={{ ...LABEL_STYLE, marginBottom: 2 }}>DCR distribution</div>
              <DcrHistogram values={govDCRs} />
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
