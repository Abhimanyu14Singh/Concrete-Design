/**
 * GroupPanel — list of DesignGroups with create/rename/assign/dissolve actions.
 * Also highlights group members on the map when a group is selected.
 */
import { useState } from 'react';
import type { DesignGroup, MapFrame } from '../../types';

const PALETTE = [
  '#2563eb','#16a34a','#d97706','#9333ea','#0891b2',
  '#dc2626','#65a30d','#7c3aed','#0284c7','#be185d',
];

interface Props {
  groups: DesignGroup[];
  frames: MapFrame[];
  selected: Set<string>;           // selected frameName keys on the map
  activeGroupId: string | null;
  onGroupsChange: (groups: DesignGroup[]) => void;
  onActiveGroupChange: (id: string | null) => void;
  onSelectionChange: (names: Set<string>) => void;
  dcrById?: Record<string, number>;
}

export default function GroupPanel({
  groups, frames, selected, activeGroupId,
  onGroupsChange, onActiveGroupChange, onSelectionChange, dcrById = {},
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');

  const framesByMember = new Map<string, MapFrame>();
  for (const f of frames) if (f.memberId) framesByMember.set(f.memberId, f);

  function worstDCR(g: DesignGroup): number | undefined {
    const dcrs = g.memberIds.map(id => dcrById[id]).filter((d): d is number => d !== undefined);
    return dcrs.length ? Math.max(...dcrs) : undefined;
  }

  function selectGroup(g: DesignGroup) {
    onActiveGroupChange(activeGroupId === g.id ? null : g.id);
    const frameNames = new Set(
      g.memberIds.map(id => framesByMember.get(id)?.frameName).filter(Boolean) as string[]
    );
    onSelectionChange(frameNames);
  }

  function createGroupFromSelection() {
    const memberIds = [...selected]
      .map(fname => frames.find(f => f.frameName === fname)?.memberId)
      .filter(Boolean) as string[];
    if (!memberIds.length) {
      alert('The selection contains no designed members. Only frames that have been imported as design members (solid lines) can be grouped — use "Design selected" or re-run the import first.');
      return;
    }
    const id = `grp-${Date.now()}`;
    const color = PALETTE[groups.length % PALETTE.length];
    const newGroup: DesignGroup = { id, label: `Group ${groups.length + 1}`, memberIds, color };
    onGroupsChange([...groups, newGroup]);
    onActiveGroupChange(id);
  }

  function addSelectionToGroup(gId: string) {
    const memberIds = [...selected]
      .map(fname => frames.find(f => f.frameName === fname)?.memberId)
      .filter(Boolean) as string[];
    onGroupsChange(groups.map(g => g.id === gId
      ? { ...g, memberIds: [...new Set([...g.memberIds, ...memberIds])] }
      : g));
  }

  function removeSelectionFromGroup(gId: string) {
    const selMemberIds = new Set(
      [...selected]
        .map(fname => frames.find(f => f.frameName === fname)?.memberId)
        .filter(Boolean) as string[]
    );
    onGroupsChange(groups.map(g => g.id === gId
      ? { ...g, memberIds: g.memberIds.filter(id => !selMemberIds.has(id)) }
      : g));
  }

  function dissolveGroup(gId: string) {
    const grp = groups.find(g => g.id === gId);
    if (!confirm(`Delete group "${grp?.label ?? 'this group'}"? Members are not removed, only the group.`)) return;
    onGroupsChange(groups.filter(g => g.id !== gId));
    if (activeGroupId === gId) onActiveGroupChange(null);
  }

  function renameStart(g: DesignGroup) {
    setEditingId(g.id);
    setEditLabel(g.label);
  }

  function renameCommit() {
    if (!editingId) return;
    onGroupsChange(groups.map(g => g.id === editingId ? { ...g, label: editLabel } : g));
    setEditingId(null);
  }

  function setGroupColor(gId: string, color: string) {
    onGroupsChange(groups.map(g => g.id === gId ? { ...g, color } : g));
  }

  const unassignedCount = frames.filter(f => f.memberId && !groups.some(g => g.memberIds.includes(f.memberId!))).length;
  const designedCount = frames.filter(f => f.memberId).length;

  // Chips: selected frames that are designed members, with group membership info
  const selectionChips = [...selected]
    .map(fname => {
      const f = frames.find(fr => fr.frameName === fname);
      return f?.memberId ? { frameName: fname, memberId: f.memberId } : null;
    })
    .filter(Boolean) as { frameName: string; memberId: string }[];

  function removeMemberFromGroup(gId: string, memberId: string) {
    onGroupsChange(groups.map(g => g.id === gId
      ? { ...g, memberIds: g.memberIds.filter(id => id !== memberId) }
      : g));
  }

  function addMemberToGroup(gId: string, memberId: string) {
    onGroupsChange(groups.map(g => g.id === gId && !g.memberIds.includes(memberId)
      ? { ...g, memberIds: [...g.memberIds, memberId] }
      : g));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: 12 }}>
      {/* Header actions */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #e5e7eb', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          onClick={createGroupFromSelection}
          disabled={selected.size === 0}
          style={{ flex: 1, padding: '6px 8px', background: selected.size ? '#2563eb' : '#e5e7eb', color: selected.size ? 'white' : '#9ca3af', border: 'none', borderRadius: 6, cursor: selected.size ? 'pointer' : 'default', fontWeight: 600, fontSize: 11 }}
        >
          + Group selection ({selected.size})
        </button>
      </div>

      {/* Selection chips — per-frame add/remove buttons */}
      {selectionChips.length > 0 && activeGroupId && (
        <div style={{ padding: '6px 12px', borderBottom: '1px solid #f3f4f6', background: '#f9fafb' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', marginBottom: 4, textTransform: 'uppercase' }}>
            Selected frames
          </div>
          {(selectionChips.length > 8 ? selectionChips.slice(0, 8) : selectionChips).map(chip => {
            const grp = groups.find(g => g.id === activeGroupId);
            const inGroup = grp?.memberIds.includes(chip.memberId) ?? false;
            return (
              <div key={chip.frameName} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0', fontSize: 11 }}>
                <span style={{ flex: 1, fontFamily: 'monospace', color: '#374151' }}>{chip.frameName}</span>
                {inGroup ? (
                  <button onClick={() => removeMemberFromGroup(activeGroupId, chip.memberId)}
                    style={{ padding: '2px 7px', background: '#fee2e2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 4, cursor: 'pointer', fontSize: 10, fontWeight: 600 }}>
                    − Remove
                  </button>
                ) : (
                  <button onClick={() => addMemberToGroup(activeGroupId, chip.memberId)}
                    style={{ padding: '2px 7px', background: '#dcfce7', color: '#16a34a', border: '1px solid #86efac', borderRadius: 4, cursor: 'pointer', fontSize: 10, fontWeight: 600 }}>
                    + Add
                  </button>
                )}
              </div>
            );
          })}
          {selectionChips.length > 8 && (
            <div style={{ fontSize: 10, color: '#9ca3af' }}>+{selectionChips.length - 8} more selected</div>
          )}
        </div>
      )}

      {/* Group list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
        {groups.length === 0 && (
          <div style={{ padding: 20, color: '#9ca3af', textAlign: 'center' }}>
            No groups yet. Select members on the map and click "+ Group selection".
          </div>
        )}
        {groups.map(g => {
          const dcr = worstDCR(g);
          const isActive = activeGroupId === g.id;
          return (
            <div
              key={g.id}
              onClick={() => selectGroup(g)}
              style={{
                padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                background: isActive ? '#eff6ff' : 'white',
                borderLeft: `3px solid ${isActive ? '#2563eb' : 'transparent'}`,
                borderBottom: '1px solid #f3f4f6',
              }}
            >
              {/* Color chip — click to cycle color */}
              <div
                onClick={e => { e.stopPropagation(); setGroupColor(g.id, PALETTE[(PALETTE.indexOf(g.color ?? PALETTE[0]) + 1) % PALETTE.length]); }}
                style={{ width: 12, height: 12, borderRadius: '50%', background: g.color ?? PALETTE[0], flexShrink: 0, cursor: 'pointer', border: '1px solid rgba(0,0,0,0.12)' }}
                title="Click to change color"
              />

              {/* Label */}
              <div style={{ flex: 1 }}>
                {editingId === g.id ? (
                  <input
                    autoFocus
                    value={editLabel}
                    onChange={e => setEditLabel(e.target.value)}
                    onBlur={renameCommit}
                    onKeyDown={e => { if (e.key === 'Enter') renameCommit(); if (e.key === 'Escape') setEditingId(null); }}
                    onClick={e => e.stopPropagation()}
                    style={{ width: '100%', border: '1px solid #2563eb', borderRadius: 4, padding: '2px 4px', fontSize: 12 }}
                  />
                ) : (
                  <span onDoubleClick={e => { e.stopPropagation(); renameStart(g); }}
                    style={{ fontWeight: 600, color: '#111827' }}>
                    {g.label}
                  </span>
                )}
                <div style={{ color: '#6b7280', fontSize: 10, marginTop: 1 }}>{g.memberIds.length} member{g.memberIds.length !== 1 ? 's' : ''}</div>
              </div>

              {/* Worst DCR badge */}
              {dcr !== undefined && (
                <span style={{
                  padding: '2px 6px', borderRadius: 10, fontSize: 10, fontWeight: 700,
                  background: dcr >= 1 ? '#fee2e2' : dcr >= 0.9 ? '#fef3c7' : '#dcfce7',
                  color: dcr >= 1 ? '#dc2626' : dcr >= 0.9 ? '#b45309' : '#16a34a',
                }}>
                  {dcr.toFixed(2)}
                </span>
              )}

              {/* Dissolve */}
              <button
                onClick={e => { e.stopPropagation(); dissolveGroup(g.id); }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14, padding: '0 2px' }}
                title="Dissolve group"
              >×</button>
            </div>
          );
        })}
      </div>

      {/* Footer stats */}
      <div style={{ padding: '8px 12px', borderTop: '1px solid #e5e7eb', color: '#6b7280', fontSize: 10, display: 'flex', gap: 12 }}>
        <span>{selected.size} selected</span>
        <span>{groups.length} group{groups.length !== 1 ? 's' : ''}</span>
        <span>{unassignedCount} unassigned</span>
        <span>{designedCount} designed</span>
      </div>
    </div>
  );
}
