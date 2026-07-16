/**
 * DashboardWindowRoot — the React root mounted in the popped-out Group Dashboard
 * window (main.tsx routes here when the URL hash is #dashboard). It receives the
 * distilled payload from the main window over IPC and sends selection / edit
 * commands back; the main window stays the single source of truth.
 */
import { useState, useEffect } from 'react';
import type { RebarLayout } from '../../types';
import type { DashboardPayload } from '../../utils/dashboardPayload';
import GroupDashboard from './GroupDashboard';
import { useUnits } from '../../contexts/UnitsContext';
import { INK, SURFACE } from '../../theme';

export default function DashboardWindowRoot() {
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const { units, setUnits } = useUnits();
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;

  // Receive state from the main window; ask it to (re)broadcast on mount.
  useEffect(() => {
    if (!api?.onDashboardState) return;
    api.onDashboardState(p => setPayload(p));
    api.dashboardReady?.();
    return () => api.offDashboardState?.();
  }, [api]);

  // Mirror the main window's unit system so labels/sections read consistently.
  useEffect(() => {
    if (payload && (payload.units === 'imperial' || payload.units === 'si') && payload.units !== units) {
      setUnits(payload.units);
    }
  }, [payload, units, setUnits]);

  const center: React.CSSProperties = {
    height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: INK.secondary, fontSize: 13, background: SURFACE.app,
  };

  if (!api?.onDashboardState) return <div style={center}>The Group Dashboard window is only available in the desktop app.</div>;
  if (!payload) return <div style={center}>Loading dashboard…</div>;

  const apply = (groupId: string, rebar: RebarLayout) => api.sendDashboardCommand?.({ type: 'apply-rebar', groupId, rebar });

  return (
    <div style={{ height: '100vh', overflow: 'hidden' }}>
      <GroupDashboard
        payload={payload}
        selectedGroupId={selectedGroupId}
        onSelectGroup={id => { setSelectedGroupId(id); api.sendDashboardCommand?.({ type: 'select-group', groupId: id }); }}
        onApplyRebar={apply}
        onMoveMember={(memberId, groupId) => api.sendDashboardCommand?.({ type: 'move-member', memberId, groupId })}
        onCreateGroupForMember={memberId => api.sendDashboardCommand?.({ type: 'create-group-for-member', memberId })}
        onSuggestAll={() => api.sendDashboardCommand?.({ type: 'suggest-all' })}
        onToggleCurtailmentNote={(groupId, face, on) => api.sendDashboardCommand?.({ type: 'toggle-curtailment-note', groupId, face, on })}
        onSetOppositeTop={(groupId, bars) => api.sendDashboardCommand?.({ type: 'set-opposite-top', groupId, bars })}
        canPopOut={false}
        onClose={() => api.sendDashboardCommand?.({ type: 'pop-in' })}
        closeLabel="⤡ Pop in"
      />
    </div>
  );
}
