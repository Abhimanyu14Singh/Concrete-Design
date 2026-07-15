/**
 * SuggestSizeDialog — a small modal shown before the ✨ Suggest auto-designer runs.
 * It collects a recommended TOP bar, BOTTOM bar, and STIRRUP size, each used as a
 * FLOOR ("that size or larger") in suggestGroupRebar's capacity-inversion search.
 *
 * Defaults are the smallest practical size, i.e. no floor → the auto-designer's
 * original behavior. Because Suggest keeps top and bottom at a single bar size
 * (constructability), the longitudinal floor it applies is the LARGER of the two
 * face minimums — disclosed in the dialog note so the result is never surprising.
 */
import { useState, useEffect } from 'react';
import type { Project } from '../../types';
import { suggestSizeCandidates, type SuggestFloors } from '../../utils/suggestRebar';
import { formatBarLabel } from '../../utils/rebar';
import Dropdown from './Dropdown';
import { ACCENT, BORDER, INK, SURFACE, TYPE, WEIGHT, MONO_NUM } from '../../theme';

const DD_STYLE: React.CSSProperties = {
  width: 96, padding: '5px 8px', border: `1px solid ${BORDER.strong}`,
  borderRadius: 5, fontSize: TYPE.body, ...MONO_NUM,
};

function FloorRow({ label, value, onChange, options }: {
  label: string; value: number; onChange: (v: number) => void;
  options: { value: number; label: string }[];
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
      <span style={{ fontSize: TYPE.body, color: INK.base, width: 160, flexShrink: 0 }}>{label}</span>
      <Dropdown value={value} options={options} onChange={v => onChange(parseInt(v))} style={DD_STYLE} />
      <span style={{ fontSize: TYPE.label, color: INK.muted }}>or larger</span>
    </div>
  );
}

export default function SuggestSizeDialog({ code, title, onCancel, onConfirm }: {
  code: Project['code'];
  /** Heading shown after the ✨, e.g. "Suggest cage — Girders" or "Suggest all groups". */
  title: string;
  onCancel: () => void;
  onConfirm: (floors: SuggestFloors) => void;
}) {
  const { long, stirrup } = suggestSizeCandidates(code);
  const [minTop, setMinTop] = useState(long[0]);
  const [minBot, setMinBot] = useState(long[0]);
  const [minStir, setMinStir] = useState(stirrup[0]);

  // Escape closes the dialog (matches the backdrop click).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onCancel(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const longOpts = long.map(s => ({ value: s, label: formatBarLabel(s) }));
  const stirOpts = stirrup.map(s => ({ value: s, label: formatBarLabel(s) }));
  const effLong = Math.abs(minTop) >= Math.abs(minBot) ? minTop : minBot;

  return (
    <div
      onMouseDown={onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}
    >
      <div
        data-testid="suggest-dialog"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 440, maxWidth: 'calc(100vw - 32px)', background: SURFACE.raised, borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.25)', padding: '18px 20px' }}
      >
        <div style={{ fontSize: TYPE.heading, fontWeight: WEIGHT.bold, color: INK.strong, marginBottom: 4 }}>
          ✨ {title}
        </div>
        <div style={{ fontSize: TYPE.label, color: INK.secondary, marginBottom: 16, lineHeight: 1.5 }}>
          Choose the smallest bar sizes Suggest may use. It picks these sizes <strong>or larger</strong> to
          meet the group's worst demand at the target DCR.
        </div>

        <FloorRow label="Top bars (min)" value={minTop} onChange={setMinTop} options={longOpts} />
        <FloorRow label="Bottom bars (min)" value={minBot} onChange={setMinBot} options={longOpts} />
        <FloorRow label="Stirrups / links (min)" value={minStir} onChange={setMinStir} options={stirOpts} />

        <div style={{ fontSize: TYPE.micro, color: INK.muted, marginTop: 4, marginBottom: 16, lineHeight: 1.5 }}>
          Top and bottom share a single bar size — Suggest uses the larger of the two minimums
          {' '}(<span style={{ ...MONO_NUM }}>{formatBarLabel(effLong)}</span>).
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{ padding: '7px 14px', background: 'white', color: INK.base, border: `1px solid ${BORDER.strong}`, borderRadius: 6, cursor: 'pointer', fontSize: TYPE.body, fontWeight: WEIGHT.semibold }}
          >Cancel</button>
          <button
            onClick={() => onConfirm({ minTopBar: minTop, minBotBar: minBot, minStirrup: minStir })}
            style={{ padding: '7px 14px', background: ACCENT.primary, color: INK.inverse, border: `1px solid ${ACCENT.primary}`, borderRadius: 6, cursor: 'pointer', fontSize: TYPE.body, fontWeight: WEIGHT.bold }}
          >✨ Suggest</button>
        </div>
      </div>
    </div>
  );
}
