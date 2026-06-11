import { useState } from 'react';
import type { Member, SectionType, MemberType, WallRebarLayout, BarGroup } from '../../types';
import LoadCaseTable from './LoadCaseTable';
import { useUnits } from '../../contexts/UnitsContext';
import type { Quantity } from '../../utils/units';
import { barSizeOptions, formatBarLabel } from '../../utils/rebar';
import { DEFAULT_CRACK_PARAMS } from '../../types';
import { getBarArea } from '../../utils/concreteDesign';
import CodeBadge from '../common/CodeBadge';
import { codeAccent } from '../../theme';

const SECTION_TYPES: { value: SectionType; label: string }[] = [
  { value: 'rectangular_beam', label: 'Rect. Beam' },
  { value: 'T_beam',           label: 'T-Beam' },
  { value: 'L_beam',           label: 'L-Beam' },
  { value: 'rectangular_column', label: 'Rect. Column' },
  { value: 'circular_column',  label: 'Circ. Column' },
  { value: 'shear_wall',       label: 'Shear Wall (ACI 318-25)' },
];

// ── Module-level sub-components — NEVER defined inside a render function ──────
// Defining components inside render would make React treat them as new types on
// every render, causing the input to unmount/remount on every keystroke.

interface InputRowProps {
  label: string; value: number | string; onChange: (v: string) => void;
  unit?: string; type?: string; min?: number; step?: number;
}
function InputRow({ label, value, onChange, unit = '', type = 'number', min, step }: InputRowProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <label style={{ fontSize: 12, color: '#6b7280', width: 112, flexShrink: 0 }}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
        <input
          type={type} value={value} min={min} step={step}
          onChange={e => onChange(e.target.value)}
          style={{
            flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6,
            fontSize: 12, color: '#111827', background: 'white', outline: 'none',
            fontFamily: type === 'text' ? 'inherit' : 'monospace',
          }}
        />
        {unit && <span style={{ fontSize: 11, color: '#9ca3af', flexShrink: 0, width: 32 }}>{unit}</span>}
      </div>
    </div>
  );
}

/**
 * Numeric input that displays/accepts values in the active unit system while
 * storing imperial. value/onChange are always imperial; conversion happens
 * only at this boundary. Rounded display never gets written back to state
 * unless the user actually edits the field.
 */
interface UnitInputRowProps {
  label: string; value: number; quantity: Quantity;
  onChange: (imperialValue: number) => void; min?: number; step?: number;
}
function UnitInputRow({ label, value, quantity, onChange, min, step }: UnitInputRowProps) {
  const { toDisplay, fromDisplay, label: unitLbl } = useUnits();
  // Strip float noise (355.59999 → 355.6) without losing user precision
  const display = +toDisplay(value, quantity).toFixed(4);
  return (
    <InputRow
      label={label} value={display} unit={unitLbl(quantity)} min={min} step={step}
      onChange={v => onChange(fromDisplay(+v, quantity))}
    />
  );
}

interface SelectRowProps {
  label: string; value: string | number;
  options: { value: string | number; label: string }[];
  onChange: (v: string) => void;
}
function SelectRow({ label, value, options, onChange }: SelectRowProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <label style={{ fontSize: 12, color: '#6b7280', width: 112, flexShrink: 0 }}>{label}</label>
      <select
        value={value} onChange={e => onChange(e.target.value)}
        style={{ flex: 1, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, color: '#111827', background: 'white', outline: 'none' }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px', marginBottom: 12,
};
const headingStyle: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10,
};

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  member: Member;
  onUpdate: (m: Member) => void;
  code?: string;
}

export default function MemberEditor({ member, onUpdate, code = 'ACI318-19' }: Props) {
  const { units } = useUnits();
  const [m, setM] = useState<Member>(member);
  const [showLoads, setShowLoads] = useState(false);

  function update(patch: Partial<Member>) {
    const updated = { ...m, ...patch };
    setM(updated);
    onUpdate(updated);
  }
  const sec = (p: Partial<Member['section']>) => update({ section: { ...m.section, ...p } });
  const mat = (p: Partial<Member['material']>) => update({ material: { ...m.material, ...p } });
  // Each array entry = one layer, outermost first (multi-layer beams).
  const setFaceLayer = (face: 'topBars' | 'botBars', i: number, p: Partial<BarGroup>) =>
    update({ rebar: { ...m.rebar, [face]: m.rebar[face].map((g, gi) => gi === i ? { ...g, ...p } : g) } });
  const addLayer = (face: 'topBars' | 'botBars') => {
    const last = m.rebar[face][m.rebar[face].length - 1] ?? { numBars: 2, barSize: 8 };
    update({ rebar: { ...m.rebar, [face]: [...m.rebar[face], { numBars: 2, barSize: last.barSize }] } });
  };
  const removeLayer = (face: 'topBars' | 'botBars', i: number) => {
    if (m.rebar[face].length <= 1) return;
    update({ rebar: { ...m.rebar, [face]: m.rebar[face].filter((_, gi) => gi !== i) } });
  };
  const topBar = (p: Partial<Member['rebar']['topBars'][0]>) => setFaceLayer('topBars', 0, p);
  const botBar = (p: Partial<Member['rebar']['botBars'][0]>) => setFaceLayer('botBars', 0, p);
  const ties = (p: Partial<NonNullable<Member['rebar']['ties']>>) =>
    update({ rebar: { ...m.rebar, ties: { ...(m.rebar.ties ?? { barSize: 4, spacing: 6, legs: 2 }), ...p } } });
  const crackP = m.crackParams ?? DEFAULT_CRACK_PARAMS;
  const crack = (p: Partial<NonNullable<Member['crackParams']>>) =>
    update({ crackParams: { ...crackP, ...p } });

  const isColumn = m.section.type === 'rectangular_column' || m.section.type === 'circular_column';
  const isWall = m.section.type === 'shear_wall';
  const sideBar = (p: Partial<Member['rebar']['topBars'][0]>) =>
    update({ rebar: { ...m.rebar, sideBars: [{ ...(m.rebar.sideBars?.[0] ?? { numBars: 0, barSize: 8 }), ...p }] } });

  function updateWallRebar(patch: Partial<WallRebarLayout>) {
    const defaultWR: WallRebarLayout = {
      vertBarSize: 5, vertSpacing: 12, horizBarSize: 5, horizSpacing: 12,
      numCurtains: 2, sbzBarSize: 8, sbzNumBars: 8,
      sbzTieBarSize: 4, sbzTieSpacing: 4, sbzTieLegs: 4, driftRatio: 0.015,
    };
    update({ wallRebar: { ...(m.wallRebar ?? defaultWR), ...patch } });
  }

  /** Switching section type to/from a column syncs memberType and seeds sensible defaults. */
  function changeSectionType(v: SectionType) {
    const toColumn = v.endsWith('_column');
    const toWall = v === 'shear_wall';
    const wasColumn = isColumn;
    const patch: Partial<Member> = { section: { ...m.section, type: v } };
    if (v === 'circular_column' && !m.section.diameter) {
      patch.section = { ...patch.section!, diameter: 20, b: 20, h: 20 };
    }
    if (toWall) {
      patch.memberType = 'wall';
      patch.section = { ...patch.section!, b: 120, h: 12, lw: 120, tw: 12, hw: 180 };
      if (!m.wallRebar) {
        patch.wallRebar = {
          vertBarSize: 5, vertSpacing: 12, horizBarSize: 5, horizSpacing: 12,
          numCurtains: 2, sbzBarSize: 8, sbzNumBars: 8,
          sbzTieBarSize: 4, sbzTieSpacing: 4, sbzTieLegs: 4, driftRatio: 0.015,
        };
      }
    } else if (toColumn && !wasColumn) {
      patch.memberType = 'column';
      patch.rebar = {
        topBars: [{ numBars: 3, barSize: 8 }],
        botBars: [{ numBars: 3, barSize: 8 }],
        sideBars: [{ numBars: 2, barSize: 8 }],
        ties: { barSize: 4, spacing: 12, legs: 2 },
        tieType: 'tied',
      };
    } else if (!toColumn && !toWall && wasColumn) {
      patch.memberType = 'beam';
    } else if (!toColumn && !toWall && isWall) {
      patch.memberType = 'beam';
    }
    update(patch);
  }

  return (
    <div style={{ fontSize: 14 }}>
      {showLoads && (
        <LoadCaseTable
          loads={m.loads}
          isColumn={isColumn}
          onDone={loads => { setShowLoads(false); update({ loads }); }}
          onCancel={() => setShowLoads(false)}
        />
      )}

      {/* Context header: design code + active unit system */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
        padding: '8px 12px', background: 'white', borderRadius: 10,
        border: '1px solid #e5e7eb', borderLeft: `3px solid ${codeAccent(code)}`,
      }}>
        <CodeBadge code={code} />
        <span style={{
          fontSize: 10, fontWeight: 700, color: '#6b7280', background: '#f3f4f6',
          border: '1px solid #e5e7eb', borderRadius: 12, padding: '2px 8px',
        }}>
          {units === 'si' ? 'SI — mm / MPa / kN' : 'Imperial — in / psi / kips'}
        </span>
        <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 'auto' }}>
          {isColumn ? 'Column' : 'Beam'} input
        </span>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 300px', minWidth: 280 }}>

      {/* General */}
      <div style={cardStyle}>
        <div style={headingStyle}>General</div>
        <InputRow label="Label" value={m.label} type="text" onChange={v => update({ label: v })} />
        <UnitInputRow label="Span" value={m.span ?? 20} quantity="spanLength" onChange={v => update({ span: v })} />
        <SelectRow label="Member type" value={m.memberType}
          options={[{ value: 'beam', label: 'Beam' }, { value: 'column', label: 'Column' }, { value: 'wall', label: 'Wall' }]}
          onChange={v => update({ memberType: v as MemberType })} />
      </div>

      {/* Materials */}
      <div style={cardStyle}>
        <div style={headingStyle}>Materials</div>
        <UnitInputRow label="f'c (cylinder)" value={m.material.fc} quantity="stress" onChange={v => mat({ fc: v })} />
        <UnitInputRow label="fy (longit.)" value={m.material.fy} quantity="stress" onChange={v => mat({ fy: v })} />
        <UnitInputRow label="fyt (trans.)" value={m.material.fyt} quantity="stress" onChange={v => mat({ fyt: v })} />
        <InputRow label="λ (concrete)" value={m.material.lambdaConcrete} step={0.05} onChange={v => mat({ lambdaConcrete: +v })} />
      </div>

      {/* Section */}
      <div style={cardStyle}>
        <div style={headingStyle}>Section Dimensions</div>
        <SelectRow label="Section type" value={m.section.type} options={SECTION_TYPES}
          onChange={v => changeSectionType(v as SectionType)} />
        {m.section.type === 'shear_wall' ? (
          <>
            <UnitInputRow label="Wall length lw" value={m.section.lw ?? m.section.b} quantity="length"
              onChange={v => sec({ b: v, lw: v })} />
            <UnitInputRow label="Wall thickness tw" value={m.section.tw ?? m.section.h} quantity="length"
              onChange={v => sec({ h: v, tw: v })} />
            <UnitInputRow label="Wall height hw" value={m.section.hw ?? (m.section.b * 2)} quantity="length"
              onChange={v => sec({ hw: v })} />
          </>
        ) : m.section.type === 'circular_column' ? (
          <UnitInputRow label="Diameter" value={m.section.diameter ?? 20} quantity="length"
            onChange={v => sec({ diameter: v, b: v, h: v })} />
        ) : (
          <>
            <UnitInputRow
              label={m.section.type === 'T_beam' || m.section.type === 'L_beam' ? 'Flange width b' : 'Width b'}
              value={m.section.b} quantity="length" onChange={v => sec({ b: v })} />
            <UnitInputRow label="Depth h" value={m.section.h ?? 24} quantity="length" onChange={v => sec({ h: v })} />
            {(m.section.type === 'T_beam' || m.section.type === 'L_beam') && (
              <>
                <UnitInputRow label="Web width bw" value={m.section.bw ?? 14} quantity="length" onChange={v => sec({ bw: v })} />
                <UnitInputRow label="Flange thk hf" value={m.section.hf ?? 5} quantity="length" onChange={v => sec({ hf: v })} />
              </>
            )}
          </>
        )}
        <UnitInputRow label="Clear cover" value={m.section.coverClear} quantity="length" onChange={v => sec({ coverClear: v })} />
        {!isWall && (
          <SelectRow label="Stirrup size" value={m.section.stirrupDia}
            options={barSizeOptions(units, m.section.stirrupDia).map(s => ({ value: s, label: formatBarLabel(s) }))}
            onChange={v => sec({ stirrupDia: +v })} />
        )}
      </div>

      {/* Wall Reinforcement */}
      {isWall && (
        <>
          <div style={cardStyle}>
            <div style={headingStyle}>Distributed Web Reinforcement</div>
            <div style={{ background: '#eff6ff', borderRadius: 6, padding: '8px', marginBottom: 8 }}>
              <p style={{ fontSize: 11, color: '#2563eb', fontWeight: 600, margin: '0 0 6px' }}>Vertical (Longitudinal) Bars §11.6</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <SelectRow label="Bar size" value={m.wallRebar?.vertBarSize ?? 5}
                    options={barSizeOptions(units, m.wallRebar?.vertBarSize).map(s => ({ value: s, label: formatBarLabel(s) }))}
                    onChange={v => updateWallRebar({ vertBarSize: +v })} />
                </div>
                <div style={{ flex: 1 }}>
                  <UnitInputRow label="Spacing sv" value={m.wallRebar?.vertSpacing ?? 12} quantity="length"
                    onChange={v => updateWallRebar({ vertSpacing: v })} />
                </div>
              </div>
            </div>
            <div style={{ background: '#f0fdf4', borderRadius: 6, padding: '8px', marginBottom: 8 }}>
              <p style={{ fontSize: 11, color: '#16a34a', fontWeight: 600, margin: '0 0 6px' }}>Horizontal (Transverse) Bars §11.6</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <SelectRow label="Bar size" value={m.wallRebar?.horizBarSize ?? 5}
                    options={barSizeOptions(units, m.wallRebar?.horizBarSize).map(s => ({ value: s, label: formatBarLabel(s) }))}
                    onChange={v => updateWallRebar({ horizBarSize: +v })} />
                </div>
                <div style={{ flex: 1 }}>
                  <UnitInputRow label="Spacing sh" value={m.wallRebar?.horizSpacing ?? 12} quantity="length"
                    onChange={v => updateWallRebar({ horizSpacing: v })} />
                </div>
              </div>
            </div>
            <SelectRow label="Curtains" value={m.wallRebar?.numCurtains ?? 2}
              options={[{ value: 1, label: 'Single curtain' }, { value: 2, label: 'Double curtain' }]}
              onChange={v => updateWallRebar({ numCurtains: +v as 1 | 2 })} />
          </div>

          <div style={cardStyle}>
            <div style={{ ...headingStyle, color: '#d97706' }}>Special Boundary Zone (SBZ) §18.10.6</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <SelectRow label="SBZ bar size" value={m.wallRebar?.sbzBarSize ?? 8}
                  options={barSizeOptions(units, m.wallRebar?.sbzBarSize).map(s => ({ value: s, label: formatBarLabel(s) }))}
                  onChange={v => updateWallRebar({ sbzBarSize: +v })} />
              </div>
              <div style={{ flex: 1 }}>
                <InputRow label="# SBZ bars" value={m.wallRebar?.sbzNumBars ?? 8} min={2}
                  onChange={v => updateWallRebar({ sbzNumBars: +v })} />
              </div>
            </div>
            <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 6px' }}>SBZ Confinement Ties §18.10.6.4</p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <SelectRow label="Tie size" value={m.wallRebar?.sbzTieBarSize ?? 4}
                  options={barSizeOptions(units, m.wallRebar?.sbzTieBarSize).map(s => ({ value: s, label: formatBarLabel(s) }))}
                  onChange={v => updateWallRebar({ sbzTieBarSize: +v })} />
              </div>
              <div style={{ flex: 1 }}>
                <UnitInputRow label="Tie spacing" value={m.wallRebar?.sbzTieSpacing ?? 4} quantity="length"
                  onChange={v => updateWallRebar({ sbzTieSpacing: v })} />
              </div>
              <div style={{ flex: 1 }}>
                <InputRow label="Legs" value={m.wallRebar?.sbzTieLegs ?? 4} min={2}
                  onChange={v => updateWallRebar({ sbzTieLegs: +v })} />
              </div>
            </div>
            <InputRow label="Drift δu/hw" value={m.wallRebar?.driftRatio ?? 0.015} step={0.005}
              onChange={v => updateWallRebar({ driftRatio: +v })} />
          </div>
        </>
      )}

      {/* Beam/Column Reinforcement */}
      {!isWall && (<>
      <div style={cardStyle}>
        <div style={headingStyle}>Reinforcement</div>
        {(!isColumn ? (['topBars', 'botBars'] as const) : []).map(face => (
          <div key={face}>
            <p style={{ fontSize: 11, color: '#9ca3af', margin: face === 'topBars' ? '0 0 6px' : '8px 0 6px' }}>
              {face === 'topBars' ? 'Top Bars' : 'Bottom Bars'}
            </p>
            {m.rebar[face].map((g, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ flex: '1 1 110px', minWidth: 110 }}>
                  <InputRow label={m.rebar[face].length > 1 ? `L${i + 1}${i === 0 ? ' (outer)' : ''} # bars` : '# bars'}
                    value={g.numBars} min={1}
                    onChange={v => setFaceLayer(face, i, { numBars: +v })} />
                </div>
                <div style={{ flex: '1 1 110px', minWidth: 110 }}>
                  <SelectRow label="Size" value={g.barSize}
                    options={barSizeOptions(units, g.barSize).map(s => ({ value: s, label: formatBarLabel(s) }))}
                    onChange={v => setFaceLayer(face, i, { barSize: +v })} />
                </div>
                {m.rebar[face].length > 1 && (
                  <button onClick={() => removeLayer(face, i)} title="Remove layer"
                    style={{ border: '1px solid #e5e7eb', background: 'white', color: '#9ca3af', borderRadius: 6, width: 22, height: 22, cursor: 'pointer', fontSize: 12, lineHeight: 1, flexShrink: 0 }}>×</button>
                )}
              </div>
            ))}
            <button onClick={() => addLayer(face)}
              style={{ border: 'none', background: 'none', color: '#2563eb', fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: '2px 0 0' }}>
              + Add layer
            </button>
          </div>
        ))}
        {isColumn && (<>
        <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 6px' }}>Top Bars</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <InputRow label="# bars" value={m.rebar.topBars[0]?.numBars ?? 3} min={1}
              onChange={v => topBar({ numBars: +v })} />
          </div>
          <div style={{ flex: 1 }}>
            <SelectRow label="Size" value={m.rebar.topBars[0]?.barSize ?? 8}
              options={barSizeOptions(units, m.rebar.topBars[0]?.barSize).map(s => ({ value: s, label: formatBarLabel(s) }))}
              onChange={v => topBar({ barSize: +v })} />
          </div>
        </div>
        <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 6px' }}>Bottom Bars</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <InputRow label="# bars" value={m.rebar.botBars[0]?.numBars ?? 4} min={1}
              onChange={v => botBar({ numBars: +v })} />
          </div>
          <div style={{ flex: 1 }}>
            <SelectRow label="Size" value={m.rebar.botBars[0]?.barSize ?? 8}
              options={barSizeOptions(units, m.rebar.botBars[0]?.barSize).map(s => ({ value: s, label: formatBarLabel(s) }))}
              onChange={v => botBar({ barSize: +v })} />
          </div>
        </div>
        </>)}
        {!isColumn && (m.rebar.topBars.length > 1 || m.rebar.botBars.length > 1) && (
          <UnitInputRow label="Layer clear spacing" value={m.rebar.layerClearSpacing ?? 1} quantity="length"
            onChange={v => update({ rebar: { ...m.rebar, layerClearSpacing: v } })} />
        )}
        {isColumn && (
          <>
            <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 6px' }}>Side Bars (intermediate layers)</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <InputRow label="# bars" value={m.rebar.sideBars?.[0]?.numBars ?? 0} min={0}
                  onChange={v => sideBar({ numBars: +v })} />
              </div>
              <div style={{ flex: 1 }}>
                <SelectRow label="Size" value={m.rebar.sideBars?.[0]?.barSize ?? 8}
                  options={barSizeOptions(units, m.rebar.sideBars?.[0]?.barSize).map(s => ({ value: s, label: formatBarLabel(s) }))}
                  onChange={v => sideBar({ barSize: +v })} />
              </div>
            </div>
          </>
        )}
        <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 6px' }}>Stirrups / Ties</p>
        {isColumn && (
          <SelectRow label="Transverse type" value={m.rebar.tieType ?? 'tied'}
            options={[
              { value: 'tied', label: 'Tied (φc = 0.65, 0.80·P₀)' },
              { value: 'spiral', label: 'Spiral (φc = 0.75, 0.85·P₀)' },
            ]}
            onChange={v => update({ rebar: { ...m.rebar, tieType: v as 'tied' | 'spiral' } })} />
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 140px', minWidth: 140 }}>
            <SelectRow label="Size" value={m.rebar.ties?.barSize ?? 4}
              options={barSizeOptions(units, m.rebar.ties?.barSize).map(s => ({ value: s, label: formatBarLabel(s) }))}
              onChange={v => ties({ barSize: +v })} />
          </div>
          {!m.rebar.tieZones && (
            <div style={{ flex: '1 1 140px', minWidth: 140 }}>
              <UnitInputRow label="Spacing" value={m.rebar.ties?.spacing ?? 6} quantity="length"
                onChange={v => ties({ spacing: v })} />
            </div>
          )}
          <div style={{ flex: '1 1 140px', minWidth: 140 }}>
            <InputRow label="Legs" value={m.rebar.ties?.legs ?? 2} min={2}
              onChange={v => ties({ legs: +v })} />
          </div>
        </div>
        {m.rebar.tieZones && (
          <p style={{ fontSize: 10, color: '#9ca3af', margin: '2px 0 0' }}>
            Zoned stirrups active — the three zone spacings below govern the shear check.
          </p>
        )}
        {!isColumn && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6b7280', padding: '6px 0 0', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!m.rebar.tieZones}
              onChange={e => {
                if (e.target.checked) {
                  const s = m.rebar.ties?.spacing ?? 6;
                  update({ rebar: { ...m.rebar, tieZones: [{ spacing: s }, { spacing: s * 2 }, { spacing: s }] } });
                } else {
                  const rest = { ...m.rebar };
                  delete rest.tieZones;
                  update({ rebar: rest });
                }
              }} />
            Zoned stirrups — 3 spacings over thirds of span
          </label>
        )}
        {m.rebar.tieZones && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['End (0–L/3)', 'Middle', 'End (2L/3–L)'] as const).map((zl, i) => (
              <div key={zl} style={{ flex: '1 1 150px', minWidth: 150 }}>
                <UnitInputRow label={zl} value={m.rebar.tieZones![i].spacing} quantity="length"
                  onChange={v => {
                    const zones = m.rebar.tieZones!.map((z, zi) => zi === i ? { spacing: v } : z) as
                      [{ spacing: number }, { spacing: number }, { spacing: number }];
                    // Engine single-spacing path stays governed by the tightest zone
                    update({ rebar: { ...m.rebar, tieZones: zones, ties: { ...(m.rebar.ties ?? { barSize: 4, legs: 2, spacing: v }), spacing: Math.min(...zones.map(z => z.spacing)) } } });
                  }} />
              </div>
            ))}
          </div>
        )}
        {(() => {
          const isCirc = m.section.type === 'circular_column';
          const D = m.section.diameter ?? m.section.b;
          const Ag = isCirc ? Math.PI * D * D / 4 : m.section.b * (m.section.h ?? 12);
          const As = [...m.rebar.topBars, ...m.rebar.botBars, ...(m.rebar.sideBars ?? [])]
            .reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
          const rho = Ag > 0 ? As / Ag : 0;
          return (
            <div style={{ fontSize: 10, color: '#6b7280', fontFamily: 'monospace', marginTop: 8, paddingTop: 6, borderTop: '1px dashed #e5e7eb', lineHeight: 1.7 }}>
              Ag = {Ag.toFixed(0)} in² &nbsp; As = {As.toFixed(2)} in² &nbsp; ρ = {(rho * 100).toFixed(2)}%
              {isColumn && (rho < 0.01 || rho > 0.08) && (
                <span style={{ color: '#dc2626', fontWeight: 700 }}> ⚠ outside 1–8%</span>
              )}
            </div>
          );
        })()}
      </div>

      {/* Crack Control (EC2 beams only) */}
      {code === 'EN1992-1-1' && !isColumn && (
      <div style={{ ...cardStyle, borderLeft: `3px solid ${codeAccent('EN1992-1-1')}` }}>
        <div style={headingStyle}>Crack Control — EN 1992-1-1 §7.3.4</div>
        <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 6px' }}>
          Limits and crack widths are always in mm regardless of the display unit system.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <InputRow label="w limit, bottom" value={crackP.wLimitBot} unit="mm" step={0.05} min={0}
              onChange={v => crack({ wLimitBot: +v })} />
          </div>
          <div style={{ flex: 1 }}>
            <InputRow label="w limit, top" value={crackP.wLimitTop} unit="mm" step={0.05} min={0}
              onChange={v => crack({ wLimitTop: +v })} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <InputRow label="w limit, face" value={crackP.wLimitFace} unit="mm" step={0.05} min={0}
              onChange={v => crack({ wLimitFace: +v })} />
          </div>
          <div style={{ flex: 1 }}>
            <InputRow label="M_qp / Mu ratio" value={crackP.qpFactor} step={0.05} min={0}
              onChange={v => crack({ qpFactor: +v })} />
          </div>
        </div>
        <SelectRow label="Load duration kt" value={crackP.kt}
          options={[
            { value: 0.4, label: 'kt = 0.4 — long-term / repeated' },
            { value: 0.6, label: 'kt = 0.6 — short-term' },
          ]}
          onChange={v => crack({ kt: +v })} />
      </div>
      )}
      </>) } {/* end !isWall */}

      {/* Load Cases */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={headingStyle}>Load Cases</div>
          <span style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10 }}>{m.loads.length} case{m.loads.length !== 1 ? 's' : ''}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {m.loads.slice(0, 4).map(l => (
            <span key={l.id} style={{ fontSize: 11, background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 4, padding: '2px 8px', color: '#374151' }}>{l.label}</span>
          ))}
          {m.loads.length > 4 && <span style={{ fontSize: 11, color: '#9ca3af' }}>+{m.loads.length - 4} more</span>}
        </div>
        <button
          onClick={() => setShowLoads(true)}
          style={{ width: '100%', padding: '7px 0', border: '1px solid #2563eb', borderRadius: 7, background: 'white', color: '#2563eb', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
        >
          Edit Load Cases ({m.loads.length})
        </button>
      </div>

      </div>{/* end inputs column */}
      </div>{/* end flex */}
    </div>
  );
}
