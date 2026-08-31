/**
 * SuggestSizeDialog — the modal shown before the ✨ Suggest auto-designer runs.
 *
 * It collects a WINDOW rather than a floor: the smallest and largest bar Suggest may use
 * on the top face, the bottom face and the links, plus the stirrup spacing range. The
 * two ends answer different questions — a minimum is constructability ("do not detail me
 * #4s"), a maximum is what the yard stocks, what will fit the congestion, or a practice
 * standard that stops at #9 — which is why both are offered rather than one.
 *
 * Defaults span the full practical ladder, i.e. no constraint at all, so the dialog's
 * default result is bit-for-bit the search that ran before it existed. Because Suggest
 * keeps top and bottom at a single bar size (constructability), the longitudinal window
 * it applies is the INTERSECTION of the two faces' — disclosed below, so a result that
 * ignores half of what was asked for is never a surprise.
 */
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { BarFamily, Project } from '../../types';
import { useUnits } from '../../contexts/UnitsContext';
import { suggestSizeCandidates, type SuggestFloors } from '../../utils/suggestRebar';
import { formatBarLabel } from '../../utils/rebar';
import Dropdown from './Dropdown';
import { ACCENT, BORDER, INK, STATUS, SURFACE, TYPE, WEIGHT, MONO_NUM, Z } from '../../theme';

const DD_STYLE: React.CSSProperties = {
  width: 96, padding: '5px 8px', border: `1px solid ${BORDER.strong}`,
  borderRadius: 5, fontSize: TYPE.body, ...MONO_NUM,
};

/** One row: a label and a min→max pair drawn from the same ladder Suggest searches. */
function RangeRow({ label, min, max, onMin, onMax, options, unit }: {
  label: string;
  min: number; max: number;
  onMin: (v: number) => void; onMax: (v: number) => void;
  options: { value: number; label: string }[];
  unit?: string;
}) {
  // An inverted window would silently search nothing, so the two ends clamp each other
  // rather than being validated on submit — you cannot express the bad state.
  const setMin = (v: number) => { onMin(v); if (Math.abs(v) > Math.abs(max)) onMax(v); };
  const setMax = (v: number) => { onMax(v); if (Math.abs(v) < Math.abs(min)) onMin(v); };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
      <span style={{ fontSize: TYPE.body, color: INK.base, width: 148, flexShrink: 0 }}>{label}</span>
      <Dropdown value={min} options={options} onChange={v => setMin(parseFloat(v))} style={DD_STYLE} />
      <span style={{ fontSize: TYPE.label, color: INK.muted }}>to</span>
      <Dropdown value={max} options={options} onChange={v => setMax(parseFloat(v))} style={DD_STYLE} />
      {unit ? <span style={{ fontSize: TYPE.label, color: INK.muted }}>{unit}</span> : null}
    </div>
  );
}

export default function SuggestSizeDialog({ code, title, onCancel, onConfirm, barFamily: barFamilyProp }: {
  code: Project['code'];
  /** Heading shown after the ✨, e.g. "Suggest cage — Girders" or "Suggest all groups". */
  title: string;
  onCancel: () => void;
  onConfirm: (floors: SuggestFloors) => void;
  /**
   * The catalogue to offer, when the caller knows it better than this document does.
   *
   * A DETACHED panel is a separate document with its own UnitsProvider, seeded from
   * localStorage rather than from the project — so the context's bar family there is a
   * remembered default, not necessarily the one the sweep will actually search. A panel
   * that carries the project's own value passes it; every other call site omits it and
   * the context answers as before.
   */
  barFamily?: BarFamily;
}) {
  // The floors offered must be the same catalogue Suggest will search, so this
  // reads the project's bar family rather than inferring one from the code.
  const { barFamily: barFamilyCtx, fmtVal, label: unitLabel, units } = useUnits();
  const si = units === 'si';
  const barFamily = barFamilyProp ?? barFamilyCtx;
  const { long, stirrup, spacing } = suggestSizeCandidates(code, barFamily);
  const last = <T,>(a: T[]) => a[a.length - 1];
  // Defaults span the whole ladder — no constraint — so pressing Suggest without
  // touching anything runs exactly the search that ran before this dialog grew a max.
  const [minTop, setMinTop] = useState(long[0]);
  const [maxTop, setMaxTop] = useState(last(long));
  const [minBot, setMinBot] = useState(long[0]);
  const [maxBot, setMaxBot] = useState(last(long));
  const [minStir, setMinStir] = useState(stirrup[0]);
  const [maxStir, setMaxStir] = useState(last(stirrup));
  const [minSp, setMinSp] = useState(spacing[0]);
  const [maxSp, setMaxSp] = useState(last(spacing));

  // Escape closes the dialog (matches the backdrop click).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onCancel(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const longOpts = long.map(s => ({ value: s, label: formatBarLabel(s) }));
  const stirOpts = stirrup.map(s => ({ value: s, label: formatBarLabel(s) }));
  // Spacing is stored in INCHES and shown in the display system — never hand-formatted,
  // the same rule every other length in the app follows.
  const spOpts = spacing.map(x => ({ value: x, label: fmtVal(x, 'length', si ? 0 : 1) }));
  const effLongMin = Math.abs(minTop) >= Math.abs(minBot) ? minTop : minBot;
  const effLongMax = Math.abs(maxTop) <= Math.abs(maxBot) ? maxTop : maxBot;
  // The intersection can be empty — #9-or-larger on top, #8-or-smaller on the bottom. The
  // search would report it, but saying so here is the difference between a constraint you
  // can fix in place and one you have to run a sweep to discover.
  const longWindowEmpty = Math.abs(effLongMin) > Math.abs(effLongMax);

  // Portalled to <body>, not rendered in place. `position: fixed` resolves against the
  // nearest TRANSFORMED ancestor, and App.tsx wraps the whole app in a zoom
  // `transform: scale` — so in place this backdrop is pinned to that scaled box instead
  // of the viewport, and is clipped by any `overflow: hidden` on the way up. All three
  // call sites need that, so it happens here once rather than being remembered thrice.
  return createPortal(
    <div
      onMouseDown={onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: Z.modal }}
    >
      <div
        data-testid="suggest-dialog"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 470, maxWidth: 'calc(100vw - 32px)', background: SURFACE.raised, borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.25)', padding: '18px 20px' }}
      >
        <div style={{ fontSize: TYPE.heading, fontWeight: WEIGHT.bold, color: INK.strong, marginBottom: 4 }}>
          ✨ {title}
        </div>
        <div style={{ fontSize: TYPE.label, color: INK.secondary, marginBottom: 14, lineHeight: 1.5 }}>
          The range of bars and spacings Suggest may use. It searches inside these bounds for
          the lightest cage meeting the group's worst demand at the target DCR — sagging
          moment first, then hogging, then shear.
        </div>

        <RangeRow label="Bottom bars" min={minBot} max={maxBot}
          onMin={setMinBot} onMax={setMaxBot} options={longOpts} />
        <RangeRow label="Top bars" min={minTop} max={maxTop}
          onMin={setMinTop} onMax={setMaxTop} options={longOpts} />
        <RangeRow label="Stirrups / links" min={minStir} max={maxStir}
          onMin={setMinStir} onMax={setMaxStir} options={stirOpts} />
        <RangeRow label="Stirrup spacing" min={minSp} max={maxSp}
          onMin={setMinSp} onMax={setMaxSp} options={spOpts} unit={unitLabel('length')} />

        <div style={{ fontSize: TYPE.micro, color: longWindowEmpty ? STATUS.fail : INK.muted, marginTop: 6, marginBottom: 14, lineHeight: 1.5 }}>
          {longWindowEmpty ? (
            <>Top and bottom share a single bar size, and these two ranges do not overlap —
              widen one of them or Suggest has nothing to search.</>
          ) : (
            <>Top and bottom share a single bar size — Suggest searches the overlap,
              {' '}<span style={{ ...MONO_NUM }}>{formatBarLabel(effLongMin)}–{formatBarLabel(effLongMax)}</span>.
              Code spacing limits (§9.7.6.2.2 and the torsion floor) still apply on top and win where tighter.</>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{ padding: '7px 14px', background: 'white', color: INK.base, border: `1px solid ${BORDER.strong}`, borderRadius: 6, cursor: 'pointer', fontSize: TYPE.body, fontWeight: WEIGHT.semibold }}
          >Cancel</button>
          <button
            onClick={() => onConfirm({
              minTopBar: minTop, maxTopBar: maxTop,
              minBotBar: minBot, maxBotBar: maxBot,
              minStirrup: minStir, maxStirrup: maxStir,
              minSpacing: minSp, maxSpacing: maxSp,
            })}
            disabled={longWindowEmpty}
            style={{ padding: '7px 14px', background: longWindowEmpty ? BORDER.default : ACCENT.primary, color: INK.inverse, border: `1px solid ${longWindowEmpty ? BORDER.default : ACCENT.primary}`, borderRadius: 6, cursor: longWindowEmpty ? 'default' : 'pointer', fontSize: TYPE.body, fontWeight: WEIGHT.bold }}
          >✨ Suggest</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
