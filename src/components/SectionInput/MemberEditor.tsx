import { useState } from 'react';
import type { Member, SectionType } from '../../types';

interface Props {
  member: Member;
  onUpdate: (m: Member) => void;
}

const SECTION_TYPES: { value: SectionType; label: string }[] = [
  { value: 'rectangular_beam', label: 'Rect. Beam' },
  { value: 'T_beam', label: 'T-Beam' },
  { value: 'L_beam', label: 'L-Beam' },
];

const BAR_SIZES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 18];

export default function MemberEditor({ member, onUpdate }: Props) {
  const [m, setM] = useState<Member>(member);

  function update(patch: Partial<Member>) {
    const updated = { ...m, ...patch };
    setM(updated);
    onUpdate(updated);
  }

  function updateSection(patch: Partial<Member['section']>) {
    update({ section: { ...m.section, ...patch } });
  }

  function updateMat(patch: Partial<Member['material']>) {
    update({ material: { ...m.material, ...patch } });
  }

  function updateTopBar(patch: Partial<Member['rebar']['topBars'][0]>) {
    update({ rebar: { ...m.rebar, topBars: [{ ...m.rebar.topBars[0], ...patch }] } });
  }

  function updateBotBar(patch: Partial<Member['rebar']['botBars'][0]>) {
    update({ rebar: { ...m.rebar, botBars: [{ ...m.rebar.botBars[0], ...patch }] } });
  }

  function updateTies(patch: Partial<NonNullable<Member['rebar']['ties']>>) {
    update({ rebar: { ...m.rebar, ties: { ...(m.rebar.ties ?? { barSize: 4, spacing: 6, legs: 2 }), ...patch } } });
  }

  const InputRow = ({ label, value, onChange, unit = '', type = 'number', min, step }:
    { label: string; value: number | string; onChange: (v: string) => void; unit?: string; type?: string; min?: number; step?: number }) => (
    <div className="flex items-center gap-2 py-1">
      <label className="text-xs text-gray-400 w-28 shrink-0">{label}</label>
      <div className="flex items-center gap-1 flex-1">
        <input
          type={type}
          value={value}
          min={min}
          step={step}
          onChange={e => onChange(e.target.value)}
          className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-xs w-full focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
        />
        {unit && <span className="text-xs text-gray-500 shrink-0">{unit}</span>}
      </div>
    </div>
  );

  const SelectRow = ({ label, value, options, onChange }:
    { label: string; value: string | number; options: { value: string | number; label: string }[]; onChange: (v: string) => void }) => (
    <div className="flex items-center gap-2 py-1">
      <label className="text-xs text-gray-400 w-28 shrink-0">{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white text-xs flex-1 focus:border-blue-500 focus:outline-none"
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );

  return (
    <div className="space-y-4 text-sm">
      {/* General */}
      <div className="bg-gray-800 rounded-xl p-4">
        <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">General</h4>
        <InputRow label="Label" value={m.label} type="text" onChange={v => update({ label: v })} />
        <InputRow label="Span" value={m.span ?? 20} unit="ft" onChange={v => update({ span: +v })} />
        <InputRow label="Type" value="Beam" type="text" onChange={() => {}} />
      </div>

      {/* Materials */}
      <div className="bg-gray-800 rounded-xl p-4">
        <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Materials</h4>
        <InputRow label="f'c" value={m.material.fc} unit="psi" onChange={v => updateMat({ fc: +v })} />
        <InputRow label="fy (long.)" value={m.material.fy} unit="psi" onChange={v => updateMat({ fy: +v })} />
        <InputRow label="fyt (trans.)" value={m.material.fyt} unit="psi" onChange={v => updateMat({ fyt: +v })} />
        <InputRow label="λ (conc.)" value={m.material.lambdaConcrete} step={0.05} onChange={v => updateMat({ lambdaConcrete: +v })} />
      </div>

      {/* Section */}
      <div className="bg-gray-800 rounded-xl p-4">
        <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Section Dimensions</h4>
        <SelectRow label="Type" value={m.section.type}
          options={SECTION_TYPES}
          onChange={v => updateSection({ type: v as SectionType })}
        />
        <>
          <InputRow label={m.section.type === 'T_beam' || m.section.type === 'L_beam' ? 'Flange width' : 'Width b'} value={m.section.b} unit="in" onChange={v => updateSection({ b: +v })} />
          <InputRow label="Depth h" value={m.section.h ?? 24} unit="in" onChange={v => updateSection({ h: +v })} />
          {(m.section.type === 'T_beam' || m.section.type === 'L_beam') && (
            <>
              <InputRow label="Web width bw" value={m.section.bw ?? 14} unit="in" onChange={v => updateSection({ bw: +v })} />
              <InputRow label="Flange thick hf" value={m.section.hf ?? 5} unit="in" onChange={v => updateSection({ hf: +v })} />
            </>
          )}
        </>
        <InputRow label="Clear cover" value={m.section.coverClear} unit="in" onChange={v => updateSection({ coverClear: +v })} />
        <SelectRow label="Stirrup size" value={m.section.stirrupDia}
          options={BAR_SIZES.map(s => ({ value: s, label: `#${s}` }))}
          onChange={v => updateSection({ stirrupDia: +v })}
        />
      </div>

      {/* Reinforcement */}
      <div className="bg-gray-800 rounded-xl p-4">
        <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Reinforcement</h4>
        <p className="text-xs text-gray-500 mb-2">Top Bars</p>
        <div className="flex gap-2 mb-3">
          <div className="flex-1">
            <InputRow label="# bars" value={m.rebar.topBars[0]?.numBars ?? 3} min={1} onChange={v => updateTopBar({ numBars: +v })} />
          </div>
          <div className="flex-1">
            <SelectRow label="Size" value={m.rebar.topBars[0]?.barSize ?? 8}
              options={BAR_SIZES.map(s => ({ value: s, label: `#${s}` }))}
              onChange={v => updateTopBar({ barSize: +v })}
            />
          </div>
        </div>
        <p className="text-xs text-gray-500 mb-2">Bottom Bars</p>
        <div className="flex gap-2 mb-3">
          <div className="flex-1">
            <InputRow label="# bars" value={m.rebar.botBars[0]?.numBars ?? 4} min={1} onChange={v => updateBotBar({ numBars: +v })} />
          </div>
          <div className="flex-1">
            <SelectRow label="Size" value={m.rebar.botBars[0]?.barSize ?? 8}
              options={BAR_SIZES.map(s => ({ value: s, label: `#${s}` }))}
              onChange={v => updateBotBar({ barSize: +v })}
            />
          </div>
        </div>
        <p className="text-xs text-gray-500 mb-2">Stirrups / Ties</p>
        <div className="flex gap-2">
          <div className="flex-1">
            <SelectRow label="Size" value={m.rebar.ties?.barSize ?? 4}
              options={BAR_SIZES.map(s => ({ value: s, label: `#${s}` }))}
              onChange={v => updateTies({ barSize: +v })}
            />
          </div>
          <div className="flex-1">
            <InputRow label="Spacing" value={m.rebar.ties?.spacing ?? 6} unit="in" onChange={v => updateTies({ spacing: +v })} />
          </div>
          <div className="flex-1">
            <InputRow label="Legs" value={m.rebar.ties?.legs ?? 2} min={2} onChange={v => updateTies({ legs: +v })} />
          </div>
        </div>
      </div>

      {/* Loads */}
      <div className="bg-gray-800 rounded-xl p-4">
        <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Load Cases</h4>
        {m.loads.map((load, idx) => (
          <div key={load.id} className="mb-4 p-3 bg-gray-700/50 rounded-lg">
            <p className="text-xs font-semibold text-blue-400 mb-2">{load.label}</p>
            <div className="grid grid-cols-2 gap-x-4">
              <InputRow label="Mu+" value={load.Mu_pos} unit="k-ft" onChange={v => {
                const loads = [...m.loads]; loads[idx] = { ...load, Mu_pos: +v };
                update({ loads });
              }} />
              <InputRow label="Mu-" value={load.Mu_neg} unit="k-ft" onChange={v => {
                const loads = [...m.loads]; loads[idx] = { ...load, Mu_neg: +v };
                update({ loads });
              }} />
              <InputRow label="Vu" value={load.Vu} unit="kips" onChange={v => {
                const loads = [...m.loads]; loads[idx] = { ...load, Vu: +v };
                update({ loads });
              }} />
              <InputRow label="Tu" value={load.Tu} unit="k-ft" onChange={v => {
                const loads = [...m.loads]; loads[idx] = { ...load, Tu: +v };
                update({ loads });
              }} />
              <InputRow label="Pu" value={load.Pu} unit="kips" onChange={v => {
                const loads = [...m.loads]; loads[idx] = { ...load, Pu: +v };
                update({ loads });
              }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
