/**
 * ColumnForceGrid — a compact grid to enter the design forces (Pu, Mux, Muy, Vu)
 * for a group's COLUMN members. Columns imported from ETABS land with zero
 * placeholder forces, so this lets the engineer fill them in group-wide instead
 * of opening each member's load-case modal one at a time. Values are in the app's
 * internal units (kip, kip-ft) — the same convention the ETABS import uses.
 *
 * Each cell edits the member's first (governing) load case, creating one if the
 * member has none. Uncontrolled inputs (re-keyed on the committed value) avoid a
 * re-render per keystroke; edits commit on blur / Enter.
 */
import type { Member, Project, LoadCase } from '../../types';

interface Props {
  members: Member[]; // the active group's members
  onProjectChange: (updater: (p: Project) => Project) => void;
}

const th: React.CSSProperties = { padding: '3px 4px', fontSize: 9.5, color: '#6b7280', fontWeight: 700, textAlign: 'right' };
const td: React.CSSProperties = { padding: '2px 4px' };

function NumCell({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  return (
    <input
      key={value}                       // re-init when the stored value changes (no state/effect)
      type="number"
      defaultValue={value}
      onBlur={(e) => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) onCommit(n); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      style={{ width: 56, padding: '2px 4px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 10.5, fontFamily: 'monospace', textAlign: 'right' }}
    />
  );
}

export default function ColumnForceGrid({ members, onProjectChange }: Props) {
  const cols = members.filter((m) => m.memberType === 'column');
  if (!cols.length) return null;

  function setForce(memberId: string, field: 'Pu' | 'Mux' | 'Muy' | 'Vu', value: number) {
    onProjectChange((prev) => ({
      ...prev,
      members: prev.members.map((m) => {
        if (m.id !== memberId) return m;
        const base: LoadCase = m.loads[0] ?? { id: 'LC1', label: 'Column forces', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0, Mux: 0, Muy: 0 };
        const next: LoadCase = { ...base, [field]: value };
        return { ...m, loads: m.loads.length ? m.loads.map((l, i) => (i === 0 ? next : l)) : [next] };
      }),
    }));
  }

  const anyZero = cols.some((m) => {
    const l = m.loads[0];
    return !l || (!(l.Pu ?? 0) && !(l.Mux ?? 0) && !(l.Muy ?? 0));
  });

  return (
    <div style={{ padding: '8px 10px', borderTop: '1px solid #f1f5f9' }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: '#334155', letterSpacing: 0.3, marginBottom: 2 }}>
        COLUMN FORCES <span style={{ fontWeight: 400, color: '#94a3b8' }}>(kip, kip-ft)</span>
      </div>
      {anyZero && (
        <div style={{ fontSize: 9.5, color: '#d97706', marginBottom: 4 }}>
          ⚠ some columns still have zero forces — enter Pu / Mux / Muy before running S-Concrete.
        </div>
      )}
      <div style={{ maxHeight: 200, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Member</th>
              <th style={th}>Pu</th>
              <th style={th}>Mux</th>
              <th style={th}>Muy</th>
              <th style={th}>Vu</th>
            </tr>
          </thead>
          <tbody>
            {cols.map((m) => {
              const l = m.loads[0];
              return (
                <tr key={m.id} style={{ borderTop: '1px solid #f8fafc' }}>
                  <td style={{ ...td, fontSize: 10, color: '#334155', maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.label}>{m.label}</td>
                  <td style={td}><NumCell value={l?.Pu ?? 0} onCommit={(v) => setForce(m.id, 'Pu', v)} /></td>
                  <td style={td}><NumCell value={l?.Mux ?? 0} onCommit={(v) => setForce(m.id, 'Mux', v)} /></td>
                  <td style={td}><NumCell value={l?.Muy ?? 0} onCommit={(v) => setForce(m.id, 'Muy', v)} /></td>
                  <td style={td}><NumCell value={l?.Vu ?? 0} onCommit={(v) => setForce(m.id, 'Vu', v)} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
