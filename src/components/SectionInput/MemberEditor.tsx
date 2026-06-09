import { useState } from 'react';
import type { Member, SectionType, MemberType } from '../../types';
import LoadCaseTable from './LoadCaseTable';

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
}

export default function MemberEditor({ member, onUpdate }: Props) {
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

  return (
    <div style={{ fontSize: 14 }}>
      {showLoads && (
        <LoadCaseTable
          loads={m.loads}
          onDone={loads => { setShowLoads(false); update({ loads }); }}
          onCancel={() => setShowLoads(false)}
        />
      )}

      {/* General */}
      <div style={cardStyle}>
        <div style={headingStyle}>General</div>
        <InputRow label="Label" value={m.label} type="text" onChange={v => update({ label: v })} />
        <InputRow label="Span" value={m.span ?? 20} unit="ft" onChange={v => update({ span: +v })} />
        <SelectRow label="Member type" value={m.memberType}
          options={[{ value: 'beam', label: 'Beam' }, { value: 'column', label: 'Column' }, { value: 'wall', label: 'Wall' }]}
          onChange={v => update({ memberType: v as MemberType })} />
      </div>

      {/* Materials */}
      <div style={cardStyle}>
        <div style={headingStyle}>Materials</div>
        <InputRow label="f'c" value={m.material.fc} unit="psi" onChange={v => mat({ fc: +v })} />
        <InputRow label="fy (longit.)" value={m.material.fy} unit="psi" onChange={v => mat({ fy: +v })} />
        <InputRow label="fyt (trans.)" value={m.material.fyt} unit="psi" onChange={v => mat({ fyt: +v })} />
        <InputRow label="λ (concrete)" value={m.material.lambdaConcrete} step={0.05} onChange={v => mat({ lambdaConcrete: +v })} />
      </div>

      {/* Section */}
      <div style={cardStyle}>
        <div style={headingStyle}>Section Dimensions</div>
        <SelectRow label="Section type" value={m.section.type} options={SECTION_TYPES}
          onChange={v => sec({ type: v as SectionType })} />
        {m.section.type === 'circular_column' ? (
          <InputRow label="Diameter" value={m.section.diameter ?? 20} unit="in"
            onChange={v => sec({ diameter: +v, b: +v, h: +v })} />
        ) : (
          <>
            <InputRow
              label={m.section.type === 'T_beam' || m.section.type === 'L_beam' ? 'Flange width b' : 'Width b'}
              value={m.section.b} unit="in" onChange={v => sec({ b: +v })} />
            <InputRow label="Depth h" value={m.section.h ?? 24} unit="in" onChange={v => sec({ h: +v })} />
            {(m.section.type === 'T_beam' || m.section.type === 'L_beam') && (
              <>
                <InputRow label="Web width bw" value={m.section.bw ?? 14} unit="in" onChange={v => sec({ bw: +v })} />
                <InputRow label="Flange thk hf" value={m.section.hf ?? 5} unit="in" onChange={v => sec({ hf: +v })} />
              </>
            )}
          </>
        )}
        <InputRow label="Clear cover" value={m.section.coverClear} unit="in" onChange={v => sec({ coverClear: +v })} />
        <SelectRow label="Stirrup size" value={m.section.stirrupDia}
          options={BAR_SIZES.map(s => ({ value: s, label: `#${s}` }))}
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
              options={BAR_SIZES.map(s => ({ value: s, label: `#${s}` }))}
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
              options={BAR_SIZES.map(s => ({ value: s, label: `#${s}` }))}
              onChange={v => botBar({ barSize: +v })} />
          </div>
        </div>
        <p style={{ fontSize: 11, color: '#9ca3af', margin: '8px 0 6px' }}>Stirrups / Ties</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <SelectRow label="Size" value={m.rebar.ties?.barSize ?? 4}
              options={BAR_SIZES.map(s => ({ value: s, label: `#${s}` }))}
              onChange={v => ties({ barSize: +v })} />
          </div>
          <div style={{ flex: 1 }}>
            <InputRow label="Spacing" value={m.rebar.ties?.spacing ?? 6} unit="in"
              onChange={v => ties({ spacing: +v })} />
          </div>
          <div style={{ flex: 1 }}>
            <InputRow label="Legs" value={m.rebar.ties?.legs ?? 2} min={2}
              onChange={v => ties({ legs: +v })} />
          </div>
        </div>
      </div>

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
    </div>
  );
}
