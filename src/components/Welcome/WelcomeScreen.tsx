/**
 * The first screen — a launch gate that asks where the model is coming from.
 *
 * Before this, a cold start dropped straight into the workspace on the built-in
 * sample project, which reads as "here is someone else's building" rather than
 * "bring me yours". The gate names the intended path (attach to the ETABS model
 * you already have open) and keeps the other two ways in beside it.
 *
 * It is a GATE, not a route: `App` still holds a real `Project` behind it. That is
 * deliberate — `App.tsx` indexes `project.members[0]` in three places, so an empty
 * project would crash. Nothing downstream ever sees "no model"; the workspace is
 * simply not rendered until a source has been chosen.
 */
import { useCallback, useEffect, useState } from 'react';
import { ACCENT, BORDER, FONT, ICON, INK, STATUS, SURFACE, TYPE } from '../../theme';
import { Icon } from '../common/Icon';
import type { IconName } from '../common/Icon';

/** What the liveness probe found. `checking` is the transient first state. */
type Probe =
  | { state: 'checking' }
  | { state: 'live'; modelName: string }
  | { state: 'idle' }                    // desktop, but nothing answered
  | { state: 'web' };                    // no desktop bridge at all

interface Props {
  /** Open the existing ETABS import wizard. */
  onImportEtabs: () => void;
  /** Open a saved .json project. Resolves false when the user cancelled. */
  onOpenProject: () => Promise<boolean> | void;
  /** Build the built-in two-storey demo frame and dismiss the gate. */
  onUseDemo: () => Promise<void> | void;
}

const etabsApi = (): ((m: string, a?: unknown) => Promise<unknown>) | undefined =>
  (window as Window & { electronAPI?: { etabs?: (m: string, a?: unknown) => Promise<unknown> } })
    .electronAPI?.etabs;

export default function WelcomeScreen({ onImportEtabs, onOpenProject, onUseDemo }: Props) {
  const [probe, setProbe] = useState<Probe>(() => (etabsApi() ? { state: 'checking' } : { state: 'web' }));
  const [busy, setBusy] = useState(false);

  /**
   * Ask the sidecar what model ETABS has open. `connect` is the only call that can
   * answer that, so the probe really does attach — which is fine, it is the same
   * attach the wizard makes a moment later, and leaving it open costs nothing.
   * Any failure is reported as "not detected" rather than surfaced as an error:
   * ETABS being closed is the normal case, not a fault.
   */
  const check = useCallback(async () => {
    const api = etabsApi();
    if (!api) { setProbe({ state: 'web' }); return; }
    setProbe({ state: 'checking' });
    try {
      const r = await api('connect') as { modelName?: string } | null;
      const name = String(r?.modelName ?? '').trim();
      setProbe(name ? { state: 'live', modelName: name } : { state: 'idle' });
    } catch {
      setProbe({ state: 'idle' });
    }
  }, []);

  useEffect(() => { void check(); }, [check]);

  const openSaved = async () => {
    setBusy(true);
    try { await onOpenProject(); } finally { setBusy(false); }
  };

  const live = probe.state === 'live';

  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: SURFACE.app, fontFamily: FONT.ui, padding: 24, overflow: 'auto',
    }}>
      <div style={{ width: '100%', maxWidth: 560 }}>
        <div style={{ marginBottom: 4, fontSize: 26, fontWeight: 800, color: INK.strong, letterSpacing: '-0.02em' }}>
          S-Dashboard
        </div>
        <div style={{ marginBottom: 22, fontSize: TYPE.body, color: INK.secondary }}>
          Reinforced-concrete design — ACI 318-19 and EN 1992-1-1.
        </div>

        {/* Primary: the model you already have open. */}
        <button
          onClick={onImportEtabs}
          disabled={busy}
          style={{
            width: '100%', textAlign: 'left', cursor: 'pointer',
            border: `1px solid ${live ? ACCENT.primary : BORDER.default}`,
            background: live ? ACCENT.softBg : 'white',
            borderRadius: 10, padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'flex-start',
          }}
        >
          <Icon name="etabsImport" size={ICON.lg ?? 20} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: TYPE.body, fontWeight: 700, color: INK.strong }}>
              Import from the running ETABS model
            </span>
            <span style={{ display: 'block', marginTop: 2, fontSize: TYPE.label, color: INK.secondary }}>
              Attaches to the model open in ETABS and reads geometry, sections and forces.
              Run the analysis first.
            </span>
            <ProbeLine probe={probe} onRetry={check} />
          </span>
        </button>

        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <Secondary icon="saved" label="Open a saved project"
            hint="A .json project from a previous session"
            onClick={openSaved} disabled={busy} />
          <Secondary icon="viewer" label="Explore the demo model"
            hint="Built-in 2-storey frame, 34 beams — no ETABS needed"
            onClick={() => void onUseDemo()} disabled={busy} />
        </div>

        <div style={{ marginTop: 18, fontSize: TYPE.micro, color: INK.muted }}>
          Project standards (design code, materials, cover) are confirmed once the model
          is in, so they can be pre-filled from it.
        </div>
      </div>
    </div>
  );
}

/** The live-status line under the primary action. */
function ProbeLine({ probe, onRetry }: { probe: Probe; onRetry: () => void }) {
  const base: React.CSSProperties = { display: 'block', marginTop: 8, fontSize: TYPE.label, fontWeight: 700 };
  if (probe.state === 'checking') {
    return <span style={{ ...base, color: INK.muted }}>Looking for a running ETABS instance…</span>;
  }
  if (probe.state === 'live') {
    return <span style={{ ...base, color: STATUS.ok }}>● ETABS is running — {probe.modelName}</span>;
  }
  if (probe.state === 'web') {
    return (
      <span style={{ ...base, color: INK.muted }}>
        Live ETABS needs the Windows desktop app — the wizard still offers the sample model
      </span>
    );
  }
  return (
    <span style={{ ...base, color: STATUS.warn }}>
      ETABS not detected — open your model, then{' '}
      <span
        role="button"
        tabIndex={0}
        onClick={e => { e.stopPropagation(); onRetry(); }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onRetry(); } }}
        style={{ textDecoration: 'underline', cursor: 'pointer' }}
      >
        check again
      </span>
      . You can still import — it will retry the connection.
    </span>
  );
}

function Secondary({ icon, label, hint, onClick, disabled }: {
  icon: IconName; label: string; hint: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1, textAlign: 'left', cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${BORDER.default}`, background: 'white', borderRadius: 10,
        padding: '12px 14px', opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', color: INK.strong }}>
        <Icon name={icon} size={ICON.sm} />
        <span style={{ fontSize: TYPE.label, fontWeight: 700 }}>{label}</span>
      </span>
      <span style={{ display: 'block', marginTop: 4, fontSize: TYPE.micro, color: INK.secondary }}>{hint}</span>
    </button>
  );
}
