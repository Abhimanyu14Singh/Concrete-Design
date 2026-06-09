import { useState } from 'react';
import type { LoadCase } from '../../types';

interface Props {
  loads: LoadCase[];
  onDone: (loads: LoadCase[]) => void;
  onCancel: () => void;
}

let _uid = 1;
function uid() { return `lc-${Date.now()}-${_uid++}`; }

const INPUT: React.CSSProperties = {
  width: '100%', padding: '4px 6px', border: '1px solid #d1d5db',
  borderRadius: 4, fontSize: 12, color: '#111827', background: 'white',
  textAlign: 'right', fontFamily: 'monospace', boxSizing: 'border-box',
};
const LABEL_INPUT: React.CSSProperties = {
  ...INPUT, textAlign: 'left', fontFamily: 'system-ui',
};

const FIELDS: { key: keyof LoadCase; label: string; unit: string }[] = [
  { key: 'Mu_pos', label: 'Mu+',  unit: 'k-ft'  },
  { key: 'Mu_neg', label: 'Mu−',  unit: 'k-ft'  },
  { key: 'Vu',    label: 'Vu',   unit: 'kips'   },
  { key: 'Tu',    label: 'Tu',   unit: 'k-ft'   },
  { key: 'Pu',    label: 'Pu',   unit: 'kips'   },
];

export default function LoadCaseTable({ loads, onDone, onCancel }: Props) {
  const [rows, setRows] = useState<LoadCase[]>(
    loads.length > 0
      ? loads
      : [{ id: uid(), label: '1.2D+1.6L', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 }]
  );

  function setField(idx: number, patch: Partial<LoadCase>) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
  }

  function addRow() {
    setRows(prev => [...prev, { id: uid(), label: `LC ${prev.length + 1}`, Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0 }]);
  }

  function deleteRow(idx: number) {
    if (rows.length === 1) return;
    setRows(prev => prev.filter((_, i) => i !== idx));
  }

  function handlePaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text/plain');
    const lines = text.trim().split('\n').filter(l => l.trim());
    if (!lines.length) return;
    e.preventDefault();
    const parsed: LoadCase[] = lines.map((line, i) => {
      const cols = line.split('\t');
      return {
        id: uid(),
        label: cols[0]?.trim() || `LC ${i + 1}`,
        Mu_pos: parseFloat(cols[1] ?? '') || 0,
        Mu_neg: parseFloat(cols[2] ?? '') || 0,
        Vu:     parseFloat(cols[3] ?? '') || 0,
        Tu:     parseFloat(cols[4] ?? '') || 0,
        Pu:     parseFloat(cols[5] ?? '') || 0,
      };
    });
    setRows(parsed);
  }

  const th: React.CSSProperties = {
    padding: '8px 6px', fontSize: 11, fontWeight: 700, color: '#374151',
    borderBottom: '2px solid #e5e7eb', whiteSpace: 'nowrap',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: 'white', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.25)', width: '92vw', maxWidth: 820, maxHeight: '82vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#111827' }}>Load Cases</h3>
            <p style={{ margin: '3px 0 0', fontSize: 11, color: '#6b7280' }}>
              Paste from Excel: <code style={{ background: '#f3f4f6', padding: '1px 4px', borderRadius: 3, fontSize: 10 }}>Label&nbsp;&nbsp;Mu+&nbsp;&nbsp;Mu−&nbsp;&nbsp;Vu&nbsp;&nbsp;Tu&nbsp;&nbsp;Pu</code>&nbsp;— replaces all rows
            </p>
          </div>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#9ca3af', lineHeight: 1, padding: '2px 6px' }}>✕</button>
        </div>

        {/* Scrollable table */}
        <div style={{ overflowY: 'auto', flex: 1 }} onPaste={handlePaste}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: '#f9fafb', zIndex: 1 }}>
              <tr>
                <th style={{ ...th, width: 32, textAlign: 'center' }}>#</th>
                <th style={{ ...th, textAlign: 'left' }}>Label</th>
                {FIELDS.map(f => (
                  <th key={f.key} style={{ ...th, textAlign: 'right' }}>
                    {f.label}
                    <span style={{ color: '#9ca3af', fontWeight: 400, marginLeft: 3 }}>{f.unit}</span>
                  </th>
                ))}
                <th style={{ ...th, width: 28 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={row.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '4px 6px', textAlign: 'center', fontSize: 11, color: '#9ca3af' }}>{idx + 1}</td>
                  <td style={{ padding: '4px 6px' }}>
                    <input
                      style={LABEL_INPUT}
                      value={row.label}
                      onChange={e => setField(idx, { label: e.target.value })}
                    />
                  </td>
                  {FIELDS.map(f => (
                    <td key={f.key} style={{ padding: '4px 6px' }}>
                      <input
                        type="number"
                        style={INPUT}
                        value={row[f.key] as number}
                        onChange={e => setField(idx, { [f.key]: Number(e.target.value) })}
                      />
                    </td>
                  ))}
                  <td style={{ padding: '4px 6px', textAlign: 'center' }}>
                    <button
                      onClick={() => deleteRow(idx)}
                      disabled={rows.length === 1}
                      style={{ background: 'none', border: 'none', cursor: rows.length === 1 ? 'default' : 'pointer', color: rows.length === 1 ? '#d1d5db' : '#ef4444', fontSize: 14, lineHeight: 1, padding: '2px 4px' }}
                    >×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            onClick={addRow}
            style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: 'pointer', color: '#374151', background: 'white' }}
          >
            + Add row
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={onCancel}
              style={{ border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: 'pointer', color: '#374151', background: 'white' }}
            >
              Cancel
            </button>
            <button
              onClick={() => onDone(rows)}
              style={{ background: '#2563eb', border: 'none', borderRadius: 6, padding: '6px 18px', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: 'white' }}
            >
              Done — {rows.length} load{rows.length !== 1 ? 's' : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
