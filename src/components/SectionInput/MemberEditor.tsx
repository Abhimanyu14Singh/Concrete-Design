import { useState } from 'react';
import type { Member, SectionType, MemberType } from '../../types';
import LoadCaseTable from './LoadCaseTable';
import { useUnits } from '../../contexts/UnitsContext';
import type { Quantity } from '../../utils/units';
import { barSizeOptions, formatBarLabel } from '../../utils/rebar';
import { DEFAULT_CRACK_PARAMS } from '../../types';
import { getBarArea } from '../../utils/concreteDesign';
import SectionView from '../Detailing/SectionView';
import CodeBadge from '../common/CodeBadge';
import { codeAccent } from '../../theme';

const SECTION_TYPES: { value: SectionType; label: string }[] = [
  { value: 'rectangular_beam', label: 'Rect. Beam' },
  { value: 'T_beam',           label: 'T-Beam' },
  { value: 'L_beam',           label: 'L-Beam' },
  { value: 'rectangular_column', label: 'Rect. Column' },
  { value: 'circular_column',  label: 'Circ. Column' },
];
const BAR_SIZES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 18];

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
  const topBar = (p: Partial<Member['rebar']['topBars'][0]>) =>
    update({ rebar: { ...m.rebar, topBars: [{ ...m.rebar.topBars[0], ...p }] } });
  const botBar = (p: Partial<Member['rebar']['botBars'][0]>) =>
    update({ rebar: { ...m.rebar, botBars: [{ ...m.rebar.botBars[0], ...p }] } });
  const ties = (p: Partial<NonNullable<Member['rebar']['ties']>>) =>
    update({ rebar: { ...m.rebar, ties: { ...(m.rebar.ties ?? { barSize: 4, spacing: 6, legs: 2 }), ...p } } });
  const crackP = m.crackParams ?? DEFAULT_CRACK_PARAMS;
  const crack = (p: Partial<NonNullable<Member['crackParams']>>) =>
    update({ crackParams: { ...crackP, ...p } });

  const isColumn = m.section.type === 'rectangular_column' || m.section.type === 'circular_column';
  const sideBar = (p: Partial<Member['rebar']['topBars'][0]>) =>
    update({ rebar: { ...m.rebar, sideBars: [{ ...(m.rebar.sideBars?.[0] ?? { numBars: 0, barSize: 8 }), ...p }] } });

  /** Switching section type to/from a column syncs memberType and seeds sensible defaults. */
  function changeSectionType(v: SectionType) {
    const toColumn = v.endsWith('_column');
    const wasColumn = isColumn;
    const patch: Partial<Member> = { section: { ...m.section, type: v } };
    if (v === 'circular_column' && !m.section.diameter) {
      patch.section = { ...patch.section!, diameter: 20, b: 20, h: 20 };
    }
    if (toColumn && !wasColumn) {
      patch.memberType = 'column';
      patch.rebar = {
        topBars: [{ numBars: 3, barSize: 8 }],
        botBars: [{ numBars: 3, barSize: 8 }],
        sideBars: [{ numBars: 2, barSize: 8 }],
        ties: { barSize: 4, spacing: 12, legs: 2 },
        tieType: 'tied',
      };
    } else if (!toColumn && wasColumn) {
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
        {m.section.type === 'circular_column' ? (
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
        <SelectRow label="Stirrup size" value={m.section.stirrupDia}
          options={barSizeOptions(units, m.section.stirrupDia).map(s => ({ value: s, label: formatBarLabel(s) }))}
          onChange={v => sec({ stirrupDia: +v })} />
      </div>

      {/* Reinforcement */}
      <div style={cardStyle}>
        <div style={headingStyle}>Reinforcement</div>
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
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <SelectRow label="Size" value={m.rebar.ties?.barSize ?? 4}
              options={barSizeOptions(units, m.rebar.ties?.barSize).map(s => ({ value: s, label: formatBarLabel(s) }))}
              onChange={v => ties({ barSize: +v })} />
          </div>
          <div style={{ flex: 1 }}>
            <UnitInputRow label="Spacing" value={m.rebar.ties?.spacing ?? 6} quantity="length"
              onChange={v => ties({ spacing: v })} />
          </div>
          <div style={{ flex: 1 }}>
            <InputRow label="Legs" value={m.rebar.ties?.legs ?? 2} min={2}
              onChange={v => ties({ legs: +v })} />
          </div>
        </div>
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

      {/* Live section preview — redraws as you type */}
      <div style={{ width: 248, flexShrink: 0, position: 'sticky', top: 0 }}>
        <div style={{ ...cardStyle, padding: 10 }}>
          <div style={{ ...headingStyle, marginBottom: 4 }}>Live Preview</div>
          <SectionView section={m.section} rebar={m.rebar} width={228} height={195} />
          {(() => {
            const isCirc = m.section.type === 'circular_column';
            const D = m.section.diameter ?? m.section.b;
            const Ag = isCirc ? Math.PI * D * D / 4 : m.section.b * (m.section.h ?? 12);
            const As = [...m.rebar.topBars, ...m.rebar.botBars, ...(m.rebar.sideBars ?? [])]
              .reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
            const rho = Ag > 0 ? As / Ag : 0;
            return (
              <div style={{ fontSize: 10, color: '#6b7280', fontFamily: 'monospace', marginTop: 6, lineHeight: 1.7 }}>
                <div>Ag = {Ag.toFixed(0)} in² &nbsp; As = {As.toFixed(2)} in²</div>
                <div>ρ = {(rho * 100).toFixed(2)}%
                  {isColumn && (rho < 0.01 || rho > 0.08) && (
                    <span style={{ color: '#dc2626', fontWeight: 700 }}> ⚠ outside 1–8%</span>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      </div>{/* end flex */}
    </div>
  );
}
