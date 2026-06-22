/**
 * GroupRebarEditor — compact rebar template editor for a DesignGroup.
 * "Apply" fans the layout out to every member in the group.
 */
import { useState, useEffect } from 'react';
import type { DesignGroup, RebarLayout, BarGroup, Member, Project, TieZone } from '../../types';
import { barSizeOptions, formatBarLabel } from '../../utils/rebar';
import { flexSteelRatioPct } from '../../utils/autoGroup';
import { suggestGroupRebar, isSuggestError } from '../../utils/suggestRebar';
import { useUnits } from '../../contexts/UnitsContext';
import InfoTooltip from '../common/InfoTooltip';
import Dropdown from '../common/Dropdown';

interface Props {
  group: DesignGroup;
  members: Member[];
  onApply: (groupId: string, rebar: RebarLayout, memberIds: string[]) => void;
  code: Project['code'];
  targetDCR: number;
}

function defaultRebar(units: 'imperial' | 'si'): RebarLayout {
  // spacing stored internally in INCHES (engine convention). 150 mm ≈ 5.91 in.
  return units === 'si'
    ? { topBars: [{ numBars: 2, barSize: -16 }], botBars: [{ numBars: 2, barSize: -16 }], ties: { barSize: -8, spacing: 150 / 25.4, legs: 2 } }
    : { topBars: [{ numBars: 2, barSize: 5 }], botBars: [{ numBars: 2, barSize: 5 }], ties: { barSize: 3, spacing: 6, legs: 2 } };
}

/**
 * Numeric input with a local string draft so the user can type freely.
 * Commits (clamps, calls onChange) on blur and Enter; reverts to prop value on invalid.
 */
function NumberField({ value, min, max, onChange, style }: {
  value: number; min: number; max: number;
  onChange: (v: number) => void; style?: React.CSSProperties;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  function commit(raw: string) {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
    setDraft(String(value));
  }
  return (
    <input type="number" min={min} max={max} value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={e => commit(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur(); } }}
      style={style} />
  );
}

function BarGroupRow({ bg, onChange, label, units }: {
  bg: BarGroup; onChange: (b: BarGroup) => void; label: string; units: 'imperial' | 'si';
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
      <span style={{ fontSize: 11, color: '#6b7280', width: 60, flexShrink: 0 }}>{label}</span>
      <NumberField value={bg.numBars} min={1} max={20}
        onChange={v => onChange({ ...bg, numBars: Math.round(v) })}
        style={{ width: 44, padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, fontFamily: 'monospace' }} />
      <span style={{ fontSize: 11, color: '#9ca3af' }}>×</span>
      <Dropdown
        value={bg.barSize}
        options={barSizeOptions(units, bg.barSize).map(s => ({ value: s, label: formatBarLabel(s) }))}
        onChange={v => onChange({ ...bg, barSize: parseInt(v) })}
        style={{ padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
      />
    </div>
  );
}

export default function GroupRebarEditor({ group, members, onApply, code, targetDCR }: Props) {
  const { units, toDisplay, fromDisplay } = useUnits();
  // Spacing is stored in inches; the editor shows it in the active unit system.
  const spacingMax = units === 'si' ? 600 : 24;  // 600 mm ≈ 24 in
  const [rebar, setRebar] = useState<RebarLayout>(group.rebar ?? defaultRebar(units));
  const [suggestNote, setSuggestNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Re-seed only when the SELECTED group changes — keying on group.rebar too
  // would clobber an in-progress edit every time the parent re-renders (which
  // is why bar-size changes appeared to "not stick").
  useEffect(() => {
    const r = group.rebar ?? defaultRebar(units);
    // If the stored rebar was created in the other unit system (e.g. imperial #5
    // bars showing in an SI project), reset to the correct-system default.
    const hasMismatch = units === 'si'
      ? r.topBars.some(b => b.barSize > 0) || r.botBars.some(b => b.barSize > 0) || !!(r.ties && r.ties.barSize > 0)
      : r.topBars.some(b => b.barSize < 0) || r.botBars.some(b => b.barSize < 0) || !!(r.ties && r.ties.barSize < 0);
    setRebar(hasMismatch ? defaultRebar(units) : r);
    setSuggestNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id]);

  function handleSuggest() {
    const r = suggestGroupRebar(members, code, targetDCR);
    if (isSuggestError(r)) {
      setSuggestNote({ kind: 'err', text: r.error });
      return;
    }
    setRebar(r.rebar);
    setSuggestNote({
      kind: 'ok',
      text: `Flex ${r.worstDCRFlex.toFixed(2)} · Shear ${r.worstDCRShear.toFixed(2)} at target ${targetDCR.toFixed(2)} — review, then Apply.`,
    });
  }

  function updateTop(i: number, bg: BarGroup) {
    setRebar(r => ({ ...r, topBars: r.topBars.map((b, j) => j === i ? bg : b) }));
  }
  function updateBot(i: number, bg: BarGroup) {
    setRebar(r => ({ ...r, botBars: r.botBars.map((b, j) => j === i ? bg : b) }));
  }
  function addLayer(face: 'top' | 'bot') {
    const defBar = units === 'si' ? -16 : 5;
    setRebar(r => face === 'top'
      ? { ...r, topBars: [...r.topBars, { numBars: 2, barSize: defBar }] }
      : { ...r, botBars: [...r.botBars, { numBars: 2, barSize: defBar }] });
  }
  function removeLayer(face: 'top' | 'bot', i: number) {
    setRebar(r => face === 'top'
      ? { ...r, topBars: r.topBars.filter((_, j) => j !== i) }
      : { ...r, botBars: r.botBars.filter((_, j) => j !== i) });
  }

  const ties = rebar.ties ?? { barSize: units === 'si' ? -8 : 3, spacing: 6, legs: 2 };

  // Reinforcement ratio ρ = As/(bw·d) for the current template, evaluated on a
  // representative member of the group (members share the same section family).
  const repMember = members[0];
  const rhoTop = repMember ? flexSteelRatioPct({ ...repMember, rebar }, 'top') : 0;
  const rhoBot = repMember ? flexSteelRatioPct({ ...repMember, rebar }, 'bot') : 0;
  const rhoChipStyle: React.CSSProperties = {
    marginLeft: 'auto', fontSize: 9, fontWeight: 700, fontFamily: 'monospace',
    color: '#0369a1', background: '#e0f2fe', borderRadius: 3, padding: '1px 5px',
    textTransform: 'none', letterSpacing: 0,
  };

  return (
    <div style={{ padding: '10px 12px', borderTop: '1px solid #e5e7eb', background: '#f8fafc' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 11, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {group.label} — Rebar Template
        </div>
        <button
          onClick={handleSuggest}
          title={`Pick the lightest practical layout meeting the group's worst demand at target DCR ${targetDCR.toFixed(2)}`}
          style={{ flexShrink: 0, padding: '3px 8px', background: 'white', color: '#7c3aed', border: '1px solid #c4b5fd', borderRadius: 5, cursor: 'pointer', fontWeight: 700, fontSize: 10 }}>
          ✨ Suggest
        </button>
      </div>
      {suggestNote && (
        <div style={{
          fontSize: 10, marginBottom: 8, padding: '4px 8px', borderRadius: 5,
          background: suggestNote.kind === 'ok' ? '#f5f3ff' : '#fef2f2',
          color: suggestNote.kind === 'ok' ? '#6d28d9' : '#dc2626',
          border: `1px solid ${suggestNote.kind === 'ok' ? '#ddd6fe' : '#fecaca'}`,
        }}>
          {suggestNote.text}
        </div>
      )}

      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', marginBottom: 3, textTransform: 'uppercase', display: 'flex', alignItems: 'center' }}>
          Top bars
          <InfoTooltip text="Hogging (negative moment) reinforcement placed near the top face. Used to compute φMn− capacity. Also contributes to compression in sagging regions." />
          <span style={rhoChipStyle} title="Top reinforcement ratio ρ = As,top / (bw · d) for this template">ρ {rhoTop.toFixed(2)}%</span>
        </div>
        {rebar.topBars.map((bg, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <BarGroupRow bg={bg} onChange={bg => updateTop(i, bg)} label={`Layer ${i + 1}`} units={units} />
            {rebar.topBars.length > 1 && (
              <button onClick={() => removeLayer('top', i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14 }}>×</button>
            )}
          </div>
        ))}
        <button onClick={() => addLayer('top')} style={{ fontSize: 10, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}>+ layer</button>
      </div>

      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', marginBottom: 3, textTransform: 'uppercase', display: 'flex', alignItems: 'center' }}>
          Bottom bars
          <InfoTooltip text="Sagging (positive moment) reinforcement placed near the bottom face. Primary tension steel. As_req+ must be ≤ As_prov for status OK." />
          <span style={rhoChipStyle} title="Bottom reinforcement ratio ρ = As,bot / (bw · d) for this template">ρ {rhoBot.toFixed(2)}%</span>
        </div>
        {rebar.botBars.map((bg, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <BarGroupRow bg={bg} onChange={bg => updateBot(i, bg)} label={`Layer ${i + 1}`} units={units} />
            {rebar.botBars.length > 1 && (
              <button onClick={() => removeLayer('bot', i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14 }}>×</button>
            )}
          </div>
        ))}
        <button onClick={() => addLayer('bot')} style={{ fontSize: 10, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}>+ layer</button>
      </div>

      {/* Skin / side-face reinforcement */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', flex: 1 }}>Skin bars (each face)</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: '#6b7280', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!(rebar.sideBars && rebar.sideBars.length > 0)}
              onChange={e => {
                if (e.target.checked) {
                  const defBar = units === 'si' ? -12 : 4;
                  setRebar(r => ({ ...r, sideBars: [{ numBars: 2, barSize: defBar }] }));
                } else {
                  setRebar(r => { const { sideBars, ...rest } = r; return rest; });
                }
              }}
            />
            Enable
          </label>
        </div>
        {rebar.sideBars && rebar.sideBars.length > 0 && (
          <div>
            {rebar.sideBars.map((bg, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <BarGroupRow bg={bg} onChange={bg => setRebar(r => ({ ...r, sideBars: r.sideBars!.map((b, j) => j === i ? bg : b) }))} label={`Row ${i + 1}`} units={units} />
                {rebar.sideBars!.length > 1 && (
                  <button onClick={() => setRebar(r => ({ ...r, sideBars: r.sideBars!.filter((_, j) => j !== i) }))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14 }}>×</button>
                )}
              </div>
            ))}
            <button
              onClick={() => { const defBar = units === 'si' ? -12 : 4; setRebar(r => ({ ...r, sideBars: [...(r.sideBars ?? []), { numBars: 2, barSize: defBar }] })); }}
              style={{ fontSize: 10, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}
            >+ row</button>
          </div>
        )}
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', marginBottom: 3, textTransform: 'uppercase', display: 'flex', alignItems: 'center' }}>
          Stirrups
          <InfoTooltip text="Transverse reinforcement (links) resisting shear and torsion. Vs = Av·fy·d/s (ACI) or V_Rd,s = Asw/s·z·fywd·cotθ (EC2). Spacing must also satisfy maximum spacing limits." />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Dropdown
            value={ties.barSize}
            options={barSizeOptions(units, ties.barSize).filter(s => s === ties.barSize || (s > 0 ? s <= 6 : -s <= 12)).map(s => ({ value: s, label: formatBarLabel(s) }))}
            onChange={v => setRebar(r => ({ ...r, ties: { ...(r.ties ?? ties), barSize: parseInt(v) } }))}
            style={{ padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}
          />
          {!rebar.tieZones && (
            <>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>@</span>
              <NumberField value={+toDisplay(ties.spacing, 'length').toFixed(units === 'si' ? 0 : 2)} min={1} max={spacingMax}
                onChange={v => setRebar(r => ({ ...r, ties: { ...(r.ties ?? ties), spacing: fromDisplay(v, 'length') } }))}
                style={{ width: 50, padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, fontFamily: 'monospace' }} />
              <span style={{ fontSize: 11, color: '#9ca3af' }}>{units === 'si' ? 'mm,' : 'in,'}</span>
            </>
          )}
          <NumberField value={ties.legs} min={2} max={8}
            onChange={v => setRebar(r => ({ ...r, ties: { ...(r.ties ?? ties), legs: Math.round(v) } }))}
            style={{ width: 40, padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, fontFamily: 'monospace' }} />
          <span style={{ fontSize: 11, color: '#9ca3af' }}>legs</span>
        </div>

        {/* Zoned stirrups — three spacings over thirds of span, as in the member screen */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#6b7280', padding: '6px 0 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={!!rebar.tieZones}
            onChange={e => {
              if (e.target.checked) {
                const s = ties.spacing;
                setRebar(r => ({ ...r, tieZones: [{ spacing: s }, { spacing: s * 2 }, { spacing: s }] }));
              } else {
                setRebar(r => { const { tieZones, ...rest } = r; return rest; });
              }
            }} />
          Zoned stirrups — 3 spacings over thirds of span
        </label>
        {rebar.tieZones && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {(['End (0–L/3)', 'Middle', 'End (2L/3–L)'] as const).map((zl, i) => (
              <div key={zl} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 9, color: '#9ca3af' }}>{zl}</span>
                <NumberField value={+toDisplay(rebar.tieZones![i].spacing, 'length').toFixed(units === 'si' ? 0 : 2)} min={1} max={spacingMax}
                  onChange={v => setRebar(r => {
                    const inches = fromDisplay(v, 'length');
                    const zones = r.tieZones!.map((z, zi) => zi === i ? { spacing: inches } : z) as [TieZone, TieZone, TieZone];
                    // keep the single-spacing path governed by the tightest zone
                    return { ...r, tieZones: zones, ties: { ...(r.ties ?? ties), spacing: Math.min(...zones.map(z => z.spacing)) } };
                  })}
                  style={{ width: 56, padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, fontFamily: 'monospace' }} />
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={() => onApply(group.id, rebar, group.memberIds)}
        style={{
          width: '100%', padding: '8px', background: '#2563eb', color: 'white',
          border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: 12,
        }}
      >
        Apply to {group.memberIds.length} member{group.memberIds.length !== 1 ? 's' : ''}
      </button>
    </div>
  );
}
