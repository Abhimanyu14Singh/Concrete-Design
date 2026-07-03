/**
 * BeamContextMenu — right-click context menu for a beam on the map.
 * Provides: navigate to design, move to group, hide beam, delete beam.
 */
import { useEffect, useRef, useState } from 'react';
import type { DesignGroup } from '../../types';
import { BORDER, INK, MONO_NUM, STATUS } from '../../theme';

interface Props {
  memberId: string;
  frameName: string;
  x: number;
  y: number;
  groups: DesignGroup[];
  selectedCount: number;
  onNavigate: (memberId: string) => void;
  onMoveToGroup: (memberId: string, groupId: string) => void;
  onHide: (memberId: string) => void;
  onDelete: (memberId: string) => void;
  onCreateGroupFromSelection: () => void;
  onClose: () => void;
}

export default function BeamContextMenu({
  memberId, frameName, x, y, groups, selectedCount,
  onNavigate, onMoveToGroup, onHide, onDelete, onCreateGroupFromSelection, onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [onClose]);

  const menuStyle: React.CSSProperties = {
    position: 'fixed', left: x, top: y, zIndex: 9999,
    background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0,0,0,0.15)', fontSize: 12, minWidth: 180,
    overflow: 'visible',
  };

  const itemStyle = (danger = false): React.CSSProperties => ({
    padding: '7px 14px', cursor: 'pointer', color: danger ? STATUS.fail : INK.strong,
    display: 'flex', alignItems: 'center', gap: 6,
    background: 'none',
  });

  const dividerStyle: React.CSSProperties = { borderTop: '1px solid #f3f4f6', margin: '3px 0' };

  return (
    <div ref={ref} style={menuStyle}>
      {/* Frame name header */}
      <div style={{ padding: '6px 14px 4px', fontSize: 10, color: INK.muted, ...MONO_NUM, borderBottom: '1px solid #f3f4f6' }}>
        {frameName}
      </div>

      <div
        style={itemStyle()}
        onClick={() => { onNavigate(memberId); onClose(); }}
        onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
        onMouseLeave={e => (e.currentTarget.style.background = 'none')}
      >
        ↗ Navigate to Design
      </div>

      <div style={dividerStyle} />

      {/* Move to group */}
      <div
        style={{ ...itemStyle(), justifyContent: 'space-between', position: 'relative' }}
        onClick={() => setGroupsOpen(o => !o)}
        onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
        onMouseLeave={e => (e.currentTarget.style.background = 'none')}
      >
        <span>Move to group</span>
        <span style={{ color: INK.muted }}>▸</span>
        {groupsOpen && (
          <div style={{
            position: 'absolute', left: '100%', top: 0,
            background: 'white', border: `1px solid ${BORDER.default}`, borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.15)', minWidth: 160, fontSize: 12,
          }}>
            {groups.length === 0 && (
              <div style={{ padding: '8px 12px', color: INK.muted }}>No groups yet</div>
            )}
            {groups.map(g => (
              <div key={g.id}
                style={{ padding: '6px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                onClick={e => { e.stopPropagation(); onMoveToGroup(memberId, g.id); onClose(); }}
                onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: g.color ?? INK.muted, flexShrink: 0 }} />
                {g.label}
              </div>
            ))}
          </div>
        )}
      </div>

      {selectedCount >= 2 && (
        <>
          <div style={dividerStyle} />
          <div
            style={itemStyle()}
            onClick={() => { onCreateGroupFromSelection(); onClose(); }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            ＋ Create group from selected ({selectedCount} beams)
          </div>
        </>
      )}

      <div style={dividerStyle} />

      <div
        style={itemStyle()}
        onClick={() => { onHide(memberId); onClose(); }}
        onMouseEnter={e => (e.currentTarget.style.background = '#f3f4f6')}
        onMouseLeave={e => (e.currentTarget.style.background = 'none')}
      >
        👁 Hide beam
      </div>
      <div
        style={{ ...itemStyle(true), marginBottom: 2 }}
        onClick={() => { onDelete(memberId); onClose(); }}
        onMouseEnter={e => (e.currentTarget.style.background = '#fee2e2')}
        onMouseLeave={e => (e.currentTarget.style.background = 'none')}
      >
        🗑 Delete beam
      </div>
    </div>
  );
}
