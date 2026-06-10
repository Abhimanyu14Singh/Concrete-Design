/**
 * Column P-M interaction diagram — plots the design envelope (φPn–φMn or
 * N_Rd–M_Rd for EC2) from result.interaction plus the load-case demand points.
 */

import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceDot, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import type { InteractionPoint, LoadCase, DesignCode } from '../../types';
import { useUnits } from '../../contexts/UnitsContext';
import { codeAccent, DCR } from '../../theme';

interface Props {
  points: InteractionPoint[];
  loads: LoadCase[];
  code?: DesignCode;
  activeLoadId?: string;
  width?: number | string;
  height?: number;
}

export default function InteractionDiagram({
  points, loads, code = 'ACI318-19', activeLoadId, height = 260,
}: Props) {
  const { toDisplay, label } = useUnits();
  const isEC2 = code === 'EN1992-1-1';

  const mLabel = isEC2 ? 'M_Rd' : 'φMn';
  const pLabel = isEC2 ? 'N_Rd' : 'φPn';
  const mUnit = label('moment');
  const fUnit = label('force');

  // curve data in display units, sorted by moment for the envelope sweep
  const data = points
    .map(p => ({
      M: +toDisplay(p.phiMn, 'moment').toFixed(1),
      P: +toDisplay(p.phiPn, 'force').toFixed(1),
      Mn: +toDisplay(p.Mn, 'moment').toFixed(1),
      Pn: +toDisplay(p.Pn, 'force').toFixed(1),
    }))
    .sort((a, b) => a.P - b.P);

  const demands = loads.map(l => {
    const Mux = l.Mux ?? l.Mu_pos ?? 0;
    const Muy = l.Muy ?? 0;
    const Mres = Math.hypot(Mux, Muy);
    return {
      id: l.id, label: l.label,
      M: +toDisplay(Mres, 'moment').toFixed(1),
      P: +toDisplay(l.Pu, 'force').toFixed(1),
    };
  });

  const maxM = Math.max(...data.map(d => d.M), ...demands.map(d => d.M)) * 1.1;

  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 6px 4px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, margin: '0 0 4px 12px' }}>
        Interaction Diagram ({pLabel} – {mLabel})
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" />
          <XAxis
            dataKey="M" type="number" domain={[0, +maxM.toFixed(0)]}
            tick={{ fill: '#6b7280', fontSize: 10 }}
            label={{ value: `${mLabel} (${mUnit})`, position: 'insideBottom', offset: -2, fill: '#9ca3af', fontSize: 10 }}
          />
          <YAxis
            dataKey="P" type="number"
            tick={{ fill: '#6b7280', fontSize: 10 }}
            label={{ value: `${pLabel} (${fUnit})`, angle: -90, position: 'insideLeft', fill: '#9ca3af', fontSize: 10 }}
            width={56}
          />
          <Tooltip
            contentStyle={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 11 }}
            formatter={(v, name) => [String(v ?? ''), name === 'P' ? `${pLabel} (${fUnit})` : String(name)]}
            labelFormatter={(v) => `${mLabel} = ${v} ${mUnit}`}
          />
          <ReferenceLine y={0} stroke="#d1d5db" />
          {/* Design envelope — colored by design code */}
          <Line dataKey="P" stroke={codeAccent(code)} strokeWidth={2} dot={false} isAnimationActive={false} name="P" />
          {/* Nominal curve (ACI only — EC2 has no φ so they coincide) */}
          {!isEC2 && (
            <Line dataKey="Pn" stroke={`${codeAccent(code)}60`} strokeWidth={1.5} strokeDasharray="5 3" dot={false} isAnimationActive={false} name="Pn (nominal)" />
          )}
          {/* Demand points */}
          {demands.map(d => (
            <ReferenceDot
              key={d.id} x={d.M} y={d.P} r={d.id === activeLoadId ? 6 : 4}
              fill={d.id === activeLoadId ? DCR.fail : '#f87171'}
              stroke="white" strokeWidth={1.5}
              label={d.id === activeLoadId ? { value: d.label, position: 'right', fill: DCR.fail, fontSize: 10 } : undefined}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <p style={{ fontSize: 9, color: '#9ca3af', margin: '0 0 4px 12px' }}>
        ● demand points (M = resultant √(Mux²+Muy²)){!isEC2 && ' — dashed: nominal Pn–Mn'}
      </p>
    </div>
  );
}
