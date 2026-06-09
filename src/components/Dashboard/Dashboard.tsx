import type { Project, Member, DesignResults } from '../../types';
import { designMember } from '../../utils/concreteDesign';
import StatusBadge from '../common/StatusBadge';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, Legend, ResponsiveContainer, RadarChart, Radar, PolarGrid, PolarAngleAxis } from 'recharts';

interface Props {
  project: Project;
  onSelectMember: (id: string) => void;
}

interface MemberSummary {
  member: Member;
  worstResult: DesignResults;
  maxDCR: number;
}

function summarize(m: Member): MemberSummary {
  const results = m.loads.map(l => designMember(m.section, m.material, m.rebar, l, m.span));
  const maxDCR = Math.max(...results.map(r => Math.max(r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion)));
  const worstResult = results.reduce((a, b) =>
    Math.max(b.DCR_flex_pos, b.DCR_flex_neg, b.DCR_shear) >
    Math.max(a.DCR_flex_pos, a.DCR_flex_neg, a.DCR_shear) ? b : a
  );
  return { member: m, worstResult, maxDCR };
}

export default function Dashboard({ project, onSelectMember }: Props) {
  const summaries = project.members.map(summarize);
  const okCount = summaries.filter(s => s.worstResult.status === 'OK').length;
  const ngCount = summaries.filter(s => s.worstResult.status === 'NG').length;
  const warnCount = summaries.filter(s => s.worstResult.status === 'Warning').length;

  const barData = summaries.map(s => ({
    name: s.member.id,
    label: s.member.label.split(' ')[0] + ' ' + s.member.label.split(' ')[1],
    'Flex+': parseFloat(s.worstResult.DCR_flex_pos.toFixed(3)),
    'Flex-': parseFloat(s.worstResult.DCR_flex_neg.toFixed(3)),
    Shear: parseFloat(s.worstResult.DCR_shear.toFixed(3)),
    Torsion: parseFloat(s.worstResult.DCR_torsion.toFixed(3)),
  }));

  return (
    <div className="space-y-6">
      {/* Project header */}
      <div className="bg-gradient-to-r from-blue-900/40 to-purple-900/40 rounded-2xl p-6 border border-blue-500/20">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white">{project.name}</h2>
            <p className="text-gray-400 text-sm mt-1">{project.description}</p>
            <div className="flex gap-4 mt-3 text-xs text-gray-500">
              <span>Engineer: <span className="text-gray-300">{project.engineer}</span></span>
              <span>Code: <span className="text-blue-400 font-bold">{project.code}</span></span>
              <span>Date: <span className="text-gray-300">{project.date}</span></span>
            </div>
          </div>
          <div className="flex gap-3">
            <div className="text-center bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-2">
              <div className="text-2xl font-bold text-emerald-400">{okCount}</div>
              <div className="text-xs text-emerald-500">PASS</div>
            </div>
            <div className="text-center bg-amber-400/10 border border-amber-400/30 rounded-xl px-4 py-2">
              <div className="text-2xl font-bold text-amber-400">{warnCount}</div>
              <div className="text-xs text-amber-500">WARN</div>
            </div>
            <div className="text-center bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-2">
              <div className="text-2xl font-bold text-red-400">{ngCount}</div>
              <div className="text-xs text-red-500">FAIL</div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Member table */}
        <div className="xl:col-span-2 bg-gray-800 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-700 flex justify-between items-center">
            <h3 className="text-sm font-bold text-white uppercase tracking-wide">Member Summary</h3>
            <span className="text-xs text-gray-500">{project.members.length} members</span>
          </div>
          <table className="w-full text-xs">
            <thead className="bg-gray-900/50">
              <tr>
                {['ID', 'Label', 'Type', 'f\'c', 'Section', 'Max DCR', 'Status', ''].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-gray-400 font-semibold uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700/50">
              {summaries.map(({ member, worstResult, maxDCR }) => (
                <tr
                  key={member.id}
                  className="hover:bg-gray-700/40 cursor-pointer transition-colors"
                  onClick={() => onSelectMember(member.id)}
                >
                  <td className="px-3 py-2.5 font-mono text-blue-400 font-bold">{member.id}</td>
                  <td className="px-3 py-2.5 text-gray-300 max-w-[140px] truncate">{member.label}</td>
                  <td className="px-3 py-2.5 text-gray-400 capitalize">{member.memberType}</td>
                  <td className="px-3 py-2.5 text-gray-400 font-mono">{member.material.fc / 1000}k</td>
                  <td className="px-3 py-2.5 text-gray-400 font-mono">
                    {`${member.section.b}"×${member.section.h}"`}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className={`font-mono font-bold ${
                      maxDCR > 1 ? 'text-red-400' : maxDCR > 0.9 ? 'text-amber-400' : 'text-emerald-400'
                    }`}>
                      {maxDCR.toFixed(3)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={worstResult.status} size="sm" />
                  </td>
                  <td className="px-3 py-2.5">
                    <button className="text-blue-400 hover:text-blue-300 font-semibold">
                      View →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Stats sidebar */}
        <div className="space-y-4">
          <div className="bg-gray-800 rounded-2xl p-4">
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-3">Project Stats</h3>
            <div className="space-y-2">
              {[
                ['Total Beams', project.members.length],
                ['Load Cases', project.members.reduce((s, m) => s + m.loads.length, 0)],
                ['Avg Max DCR', (summaries.reduce((s, m) => s + m.maxDCR, 0) / summaries.length).toFixed(3)],
              ].map(([label, val]) => (
                <div key={String(label)} className="flex justify-between items-center py-1">
                  <span className="text-xs text-gray-400">{label}</span>
                  <span className="text-sm font-bold text-white">{val}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-gray-800 rounded-2xl p-4">
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">Design Code</h3>
            <p className="text-blue-400 font-bold text-lg">{project.code}</p>
            <p className="text-gray-500 text-xs mt-1">ACI 318-19 Strength Design Method</p>
            <div className="mt-3 space-y-1 text-xs text-gray-500">
              <div>φ_flex = 0.90 (tension-controlled)</div>
              <div>φ_shear = 0.75</div>
              <div>φ_comp = 0.65 (tied) / 0.75 (spiral)</div>
            </div>
          </div>
        </div>
      </div>

      {/* DCR Overview Chart */}
      <div className="bg-gray-800 rounded-2xl p-4">
        <h3 className="text-sm font-bold text-white uppercase tracking-wide mb-4">DCR Overview — All Members</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={barData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
            <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 10 }} />
            <YAxis domain={[0, 1.3]} tick={{ fill: '#64748b', fontSize: 10 }} />
            <Tooltip
              contentStyle={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
              labelStyle={{ color: '#94a3b8' }}
              itemStyle={{ fontSize: 11 }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
            {/* Reference line at 1.0 */}
            <Bar dataKey="Flex+" stackId="no" fill="#3b82f6" />
            <Bar dataKey="Flex-" stackId="no" fill="#8b5cf6" />
            <Bar dataKey="Shear" stackId="no" fill="#f59e0b" />
            <Bar dataKey="Torsion" stackId="no" fill="#6ee7b7" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
