import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceDot, Legend, ResponsiveContainer } from 'recharts';
import type { Member } from '../../types';
import { computeInteractionDiagram } from '../../utils/concreteDesign';

interface Props {
  member: Member;
}

export default function InteractionDiagram({ member }: Props) {
  const pts = computeInteractionDiagram(member.section, member.material, member.rebar);

  const data = pts.map(p => ({
    Mn: parseFloat(p.Mn.toFixed(1)),
    phi_Mn: parseFloat((p.phi * p.Mn).toFixed(1)),
    Pn: parseFloat(p.Pn.toFixed(1)),
    phi_Pn: parseFloat((p.phi * p.Pn).toFixed(1)),
  }));

  const loadPoints = member.loads.map(l => ({
    name: l.label,
    x: l.Mux ?? l.Mu_pos,
    y: l.Pu,
  }));

  return (
    <div className="bg-gray-800 rounded-xl p-4">
      <h3 className="text-white font-bold mb-3 text-sm">P-M Interaction Diagram</h3>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
          <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
          <XAxis
            dataKey="Mn"
            type="number"
            label={{ value: 'φMn (kip-ft)', position: 'insideBottom', offset: -5, fill: '#94a3b8', fontSize: 11 }}
            tick={{ fill: '#64748b', fontSize: 10 }}
          />
          <YAxis
            dataKey="phi_Pn"
            label={{ value: 'φPn (kips)', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 11 }}
            tick={{ fill: '#64748b', fontSize: 10 }}
          />
          <Tooltip
            contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
            labelStyle={{ color: '#94a3b8' }}
            itemStyle={{ color: '#60a5fa' }}
            formatter={(v) => [`${Number(v).toFixed(1)}`, '']}
          />
          <Legend wrapperStyle={{ color: '#94a3b8', fontSize: 11 }} />
          <Line
            data={data}
            dataKey="phi_Pn"
            type="monotone"
            stroke="#60a5fa"
            strokeWidth={2}
            dot={false}
            name="φPn-φMn"
          />
          <Line
            data={data}
            dataKey="Pn"
            type="monotone"
            stroke="#475569"
            strokeWidth={1}
            strokeDasharray="4,2"
            dot={false}
            name="Nominal"
          />
          {loadPoints.map((lp, i) => (
            <ReferenceDot
              key={i}
              x={lp.x}
              y={lp.y}
              r={5}
              fill="#f59e0b"
              stroke="#fbbf24"
              strokeWidth={1}
              label={{ value: lp.name, position: 'top', fill: '#fbbf24', fontSize: 9 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <p className="text-xs text-gray-500 mt-1">● Load points shown in amber. Points within envelope are adequate.</p>
    </div>
  );
}
