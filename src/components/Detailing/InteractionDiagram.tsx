import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceDot, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { Member } from '../../types';
import { computeInteractionDiagram } from '../../utils/concreteDesign';

interface Props { member: Member; }

export default function InteractionDiagram({ member }: Props) {
  const pts = computeInteractionDiagram(member.section, member.material, member.rebar, 28);

  // Design envelope data (φPn vs φMn)
  const envData = pts
    .filter(p => isFinite(p.phiPn) && isFinite(p.phiMn))
    .map(p => ({ phiMn: +p.phiMn.toFixed(1), phiPn: +p.phiPn.toFixed(1) }));

  // Nominal envelope
  const nomData = pts
    .filter(p => isFinite(p.Pn) && isFinite(p.Mn))
    .map(p => ({ phiMn: +p.Mn.toFixed(1), phiPn: +p.Pn.toFixed(1) }));

  // Demand points — one dot per load case
  const demands = member.loads.map(l => ({
    name: l.label,
    x: Math.abs(l.Mux ?? l.Mu_pos),
    y: l.Pu,
    inside: pts.some((p, i) => {
      // Simple containment: Pu ≤ φPn at that φMn
      const next = pts[i + 1];
      if (!next) return false;
      return l.Pu >= Math.min(p.phiPn, next.phiPn) && l.Pu <= Math.max(p.phiPn, next.phiPn);
    }),
  }));

  const maxPn  = Math.max(...pts.map(p => p.Pn), 0);
  const maxMn  = Math.max(...pts.map(p => p.Mn), 0);
  const minPn  = Math.min(...pts.map(p => p.Pn));
  const pRange = maxPn - minPn;

  return (
    <div style={{ background: '#1e293b', borderRadius: 12, padding: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
        P–M Interaction Diagram
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart margin={{ top: 8, right: 16, left: 8, bottom: 28 }}>
          <CartesianGrid stroke="#0f172a" strokeDasharray="3 3" />
          <XAxis
            type="number"
            dataKey="phiMn"
            domain={[0, maxMn * 1.1]}
            label={{ value: 'φMn  (kip-ft)', position: 'insideBottom', offset: -14, fill: '#64748b', fontSize: 10 }}
            tick={{ fill: '#64748b', fontSize: 10 }}
            tickFormatter={v => v.toFixed(0)}
          />
          <YAxis
            type="number"
            dataKey="phiPn"
            domain={[minPn * 1.1, maxPn * 1.05]}
            label={{ value: 'φPn  (kips)', angle: -90, position: 'insideLeft', offset: 12, fill: '#64748b', fontSize: 10 }}
            tick={{ fill: '#64748b', fontSize: 10 }}
            tickFormatter={v => v.toFixed(0)}
          />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 6, fontSize: 11 }}
            labelStyle={{ color: '#94a3b8' }}
            formatter={(v) => [`${Number(v).toFixed(1)}`, '']}
          />
          <Legend
            wrapperStyle={{ fontSize: 10, color: '#64748b', paddingTop: 8 }}
            verticalAlign="top"
          />
          {/* Nominal envelope (dashed) */}
          <Line
            data={nomData}
            dataKey="phiPn"
            name="Nominal Pn-Mn"
            type="monotoneX"
            stroke="#334155"
            strokeWidth={1}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
          />
          {/* Design envelope */}
          <Line
            data={envData}
            dataKey="phiPn"
            name="Design φPn-φMn"
            type="monotoneX"
            stroke="#3b82f6"
            strokeWidth={2.5}
            dot={false}
            isAnimationActive={false}
          />
          {/* Zero-axial reference */}
          <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 2" strokeWidth={1} />
          {/* Demand points */}
          {demands.map((d, i) => (
            <ReferenceDot
              key={i}
              x={d.x}
              y={d.y}
              r={6}
              fill={d.inside ? '#f59e0b' : '#ef4444'}
              stroke="#0f172a"
              strokeWidth={1.5}
              label={{ value: d.name, position: 'top', fill: '#fbbf24', fontSize: 8 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <p style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>
        ● Amber = demand within envelope (OK) &nbsp;● Red = demand outside envelope (NG)
      </p>
    </div>
  );
}
