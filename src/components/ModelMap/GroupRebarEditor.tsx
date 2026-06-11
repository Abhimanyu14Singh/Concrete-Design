/**
 * GroupRebarEditor — compact rebar template editor for a DesignGroup.
 * "Apply" fans the layout out to every member in the group.
 */
import { useState, useEffect } from 'react';
import type { DesignGroup, RebarLayout, BarGroup, Member } from '../../types';
import { barSizeOptions, formatBarLabel } from '../../utils/rebar';

interface Props {
  group: DesignGroup;
  members: Member[];
  onApply: (groupId: string, rebar: RebarLayout, memberIds: string[]) => void;
}

const DEFAULT_REBAR: RebarLayout = {
  topBars: [{ numBars: 2, barSize: 5 }],
  botBars: [{ numBars: 2, barSize: 5 }],
  ties: { barSize: 3, spacing: 6, legs: 2 },
};

function BarGroupRow({ bg, onChange, label }: { bg: BarGroup; onChange: (b: BarGroup) => void; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0' }}>
      <span style={{ fontSize: 11, color: '#6b7280', width: 60, flexShrink: 0 }}>{label}</span>
      <input type="number" min={1} max={20} value={bg.numBars}
        onChange={e => onChange({ ...bg, numBars: Math.max(1, parseInt(e.target.value) || 1) })}
        style={{ width: 44, padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, fontFamily: 'monospace' }} />
      <span style={{ fontSize: 11, color: '#9ca3af' }}>×</span>
      <select value={bg.barSize} onChange={e => onChange({ ...bg, barSize: parseInt(e.target.value) })}
        style={{ padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}>
        {barSizeOptions.map(s => <option key={s} value={s}>{formatBarLabel(s)}</option>)}
      </select>
    </div>
  );
}

export default function GroupRebarEditor({ group, members, onApply }: Props) {
  const [rebar, setRebar] = useState<RebarLayout>(group.rebar ?? DEFAULT_REBAR);

  // Sync if group changes
  useEffect(() => {
    setRebar(group.rebar ?? DEFAULT_REBAR);
  }, [group.id, group.rebar]);

  function updateTop(i: number, bg: BarGroup) {
    setRebar(r => ({ ...r, topBars: r.topBars.map((b, j) => j === i ? bg : b) }));
  }
  function updateBot(i: number, bg: BarGroup) {
    setRebar(r => ({ ...r, botBars: r.botBars.map((b, j) => j === i ? bg : b) }));
  }
  function addLayer(face: 'top' | 'bot') {
    setRebar(r => face === 'top'
      ? { ...r, topBars: [...r.topBars, { numBars: 2, barSize: 5 }] }
      : { ...r, botBars: [...r.botBars, { numBars: 2, barSize: 5 }] });
  }
  function removeLayer(face: 'top' | 'bot', i: number) {
    setRebar(r => face === 'top'
      ? { ...r, topBars: r.topBars.filter((_, j) => j !== i) }
      : { ...r, botBars: r.botBars.filter((_, j) => j !== i) });
  }

  const ties = rebar.ties ?? { barSize: 3, spacing: 6, legs: 2 };

  return (
    <div style={{ padding: '10px 12px', borderTop: '1px solid #e5e7eb', background: '#f8fafc' }}>
      <div style={{ fontWeight: 700, fontSize: 11, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {group.label} — Rebar Template
      </div>

      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', marginBottom: 3, textTransform: 'uppercase' }}>Top bars</div>
        {rebar.topBars.map((bg, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <BarGroupRow bg={bg} onChange={bg => updateTop(i, bg)} label={`Layer ${i + 1}`} />
            {rebar.topBars.length > 1 && (
              <button onClick={() => removeLayer('top', i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14 }}>×</button>
            )}
          </div>
        ))}
        <button onClick={() => addLayer('top')} style={{ fontSize: 10, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}>+ layer</button>
      </div>

      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', marginBottom: 3, textTransform: 'uppercase' }}>Bottom bars</div>
        {rebar.botBars.map((bg, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <BarGroupRow bg={bg} onChange={bg => updateBot(i, bg)} label={`Layer ${i + 1}`} />
            {rebar.botBars.length > 1 && (
              <button onClick={() => removeLayer('bot', i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14 }}>×</button>
            )}
          </div>
        ))}
        <button onClick={() => addLayer('bot')} style={{ fontSize: 10, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}>+ layer</button>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: '#9ca3af', marginBottom: 3, textTransform: 'uppercase' }}>Stirrups</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <select value={ties.barSize} onChange={e => setRebar(r => ({ ...r, ties: { ...ties, barSize: parseInt(e.target.value) } }))}
            style={{ padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }}>
            {barSizeOptions.filter(s => s <= 6).map(s => <option key={s} value={s}>{formatBarLabel(s)}</option>)}
          </select>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>@</span>
          <input type="number" min={1} max={24} value={ties.spacing}
            onChange={e => setRebar(r => ({ ...r, ties: { ...ties, spacing: parseFloat(e.target.value) || 6 } }))}
            style={{ width: 50, padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, fontFamily: 'monospace' }} />
          <span style={{ fontSize: 11, color: '#9ca3af' }}>in,</span>
          <input type="number" min={2} max={8} value={ties.legs}
            onChange={e => setRebar(r => ({ ...r, ties: { ...ties, legs: parseInt(e.target.value) || 2 } }))}
            style={{ width: 40, padding: '3px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, fontFamily: 'monospace' }} />
          <span style={{ fontSize: 11, color: '#9ca3af' }}>legs</span>
        </div>
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
