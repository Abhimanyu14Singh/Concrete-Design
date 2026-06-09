import { useState } from 'react';
import type { Member, DesignResults } from '../../types';
import { designMember } from '../../utils/concreteDesign';
import DCRBar from '../common/DCRBar';
import StatusBadge from '../common/StatusBadge';
import SectionView from '../Detailing/SectionView';
import ElevationView from '../Detailing/ElevationView';
import InteractionDiagram from '../Detailing/InteractionDiagram';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, Cell } from 'recharts';

interface Props {
  member: Member;
}

export default function MemberResults({ member }: Props) {
  const [activeLoad, setActiveLoad] = useState(member.loads[0]?.id);
  const load = member.loads.find(l => l.id === activeLoad) ?? member.loads[0];
  const result: DesignResults = designMember(member.section, member.material, member.rebar, load, member.span);

  const isColumn = member.memberType === 'column';

  const dcrData = isColumn
    ? [
        { name: 'Shear', dcr: result.DCR_shear },
        { name: 'P-M', dcr: result.DCR_PM ?? result.DCR_axial ?? 0 },
      ]
    : [
        { name: 'Flex+', dcr: result.DCR_flex_pos },
        { name: 'Flex-', dcr: result.DCR_flex_neg },
        { name: 'Shear', dcr: result.DCR_shear },
        { name: 'Torsion', dcr: result.DCR_torsion },
      ];

  return (
    <div className="space-y-4">
      {/* Load case selector */}
      <div className="flex gap-2 flex-wrap">
        {member.loads.map(l => (
          <button
            key={l.id}
            onClick={() => setActiveLoad(l.id)}
            className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
              activeLoad === l.id
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>

      {/* Overall status */}
      <div className={`rounded-xl p-3 flex items-center gap-3 ${
        result.status === 'OK' ? 'bg-emerald-500/10 border border-emerald-500/30'
        : result.status === 'NG' ? 'bg-red-500/10 border border-red-500/30'
        : 'bg-amber-400/10 border border-amber-400/30'
      }`}>
        <StatusBadge status={result.status} />
        <span className="text-sm text-gray-300">
          {result.status === 'OK' ? 'All checks pass' : result.status === 'NG' ? 'Section inadequate – see DCRs' : 'Near capacity – review'}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: Section + Elevation */}
        <div className="space-y-3">
          <div className="bg-gray-800 rounded-xl p-3">
            <h4 className="text-xs font-bold text-gray-400 uppercase mb-2 tracking-wide">Section Detailing</h4>
            <div className="flex justify-center">
              <SectionView section={member.section} rebar={member.rebar} width={280} height={240} />
            </div>
          </div>
          {member.memberType === 'beam' && (
            <div className="bg-gray-800 rounded-xl p-3">
              <h4 className="text-xs font-bold text-gray-400 uppercase mb-2 tracking-wide">Elevation</h4>
              <ElevationView member={member} width={400} height={120} />
            </div>
          )}
          {isColumn && <InteractionDiagram member={member} />}
        </div>

        {/* Right: DCRs + details */}
        <div className="space-y-3">
          {/* DCR Bar chart */}
          <div className="bg-gray-800 rounded-xl p-4">
            <h4 className="text-xs font-bold text-gray-400 uppercase mb-3 tracking-wide">Demand-Capacity Ratios</h4>
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={dcrData} layout="vertical" margin={{ left: 10, right: 30 }}>
                <CartesianGrid horizontal={false} stroke="#1e293b" />
                <XAxis type="number" domain={[0, Math.max(1.2, ...dcrData.map(d => d.dcr + 0.1))]}
                  tick={{ fill: '#64748b', fontSize: 10 }} />
                <YAxis dataKey="name" type="category" tick={{ fill: '#94a3b8', fontSize: 11 }} width={55} />
                <Tooltip
                  contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6 }}
                  formatter={(v) => [Number(v).toFixed(3), 'DCR']}
                  labelStyle={{ color: '#94a3b8' }}
                />
                <ReferenceLine x={1.0} stroke="#ef4444" strokeDasharray="4,2" strokeWidth={2} />
                <Bar dataKey="dcr" radius={[0, 4, 4, 0]}>
                  {dcrData.map((entry, idx) => (
                    <Cell key={idx} fill={entry.dcr > 1 ? '#ef4444' : entry.dcr > 0.9 ? '#f59e0b' : '#10b981'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {/* Individual DCR bars */}
            <div className="mt-4 space-y-1">
              {!isColumn && (
                <>
                  <DCRBar label="Positive Flexure" dcr={result.DCR_flex_pos}
                    demand={load.Mu_pos} capacity={result.phi_Mn_pos} />
                  <DCRBar label="Negative Flexure" dcr={result.DCR_flex_neg}
                    demand={load.Mu_neg} capacity={result.phi_Mn_neg} />
                </>
              )}
              <DCRBar label="Shear" dcr={result.DCR_shear}
                demand={load.Vu} capacity={result.phi_Vn} unit="kips" />
              {!isColumn && (
                <DCRBar label="Torsion" dcr={result.DCR_torsion}
                  demand={load.Tu} capacity={result.phi_Tn} />
              )}
            </div>
          </div>

          {/* Key values table */}
          <div className="bg-gray-800 rounded-xl p-4">
            <h4 className="text-xs font-bold text-gray-400 uppercase mb-3 tracking-wide">Design Summary</h4>
            <table className="w-full text-xs">
              <tbody className="divide-y divide-gray-700">
                {[
                  ['f\'c', `${member.material.fc} psi`],
                  ['fy', `${member.material.fy / 1000} ksi`],
                  !isColumn && ['φMn+ (pos)', `${result.phi_Mn_pos.toFixed(1)} kip-ft`],
                  !isColumn && ['φMn- (neg)', `${result.phi_Mn_neg.toFixed(1)} kip-ft`],
                  ['φVn', `${result.phi_Vn.toFixed(1)} kips`],
                  ['  Vc', `${result.Vc.toFixed(1)} kips`],
                  ['  Vs', `${result.Vs.toFixed(1)} kips`],
                  !isColumn && ['As_req+', `${result.As_req_pos.toFixed(2)} in²`],
                  !isColumn && ['As_req-', `${result.As_req_neg.toFixed(2)} in²`],
                  !isColumn && ['As_min', `${result.As_min.toFixed(2)} in²`],
                  !isColumn && ['As_max', `${result.As_max.toFixed(2)} in²`],
                  !isColumn && ['Av_req', `${result.Av_req.toFixed(4)} in²/in`],
                  !isColumn && ['Tcr', `${result.Tcr.toFixed(1)} kip-ft`],
                ].filter((x): x is string[] => Boolean(x)).map(([k, v], i) => (
                  <tr key={i} className="hover:bg-gray-700/50">
                    <td className="py-1 pr-3 text-gray-400 font-mono">{k}</td>
                    <td className="py-1 text-white font-mono text-right">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Warnings */}
          {result.warnings.length > 0 && (
            <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-3">
              <h4 className="text-xs font-bold text-red-400 uppercase mb-2">Warnings / Code Checks</h4>
              <ul className="space-y-1">
                {result.warnings.map((w, i) => (
                  <li key={i} className="text-xs text-red-300 flex gap-2">
                    <span>⚠</span><span>{w}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
