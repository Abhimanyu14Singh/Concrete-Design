import { useState } from 'react';
import type { Member, DesignResults, RebarLayout } from '../../types';
import { designMember } from '../../utils/concreteDesign';
import SectionView from '../Detailing/SectionView';
import ElevationView from '../Detailing/ElevationView';
import CalcBreakdownModal from './CalcBreakdownModal';

interface Props {
  member: Member;
  onRebarChange?: (updated: Member) => void;
}

function KV({ k, v, dcr }: { k: string; v: string; dcr?: number }) {
  const dcrColor = dcr !== undefined ? (dcr > 1 ? '#dc2626' : dcr > 0.9 ? '#d97706' : '#16a34a') : undefined;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid #f3f4f6', gap: 8, minWidth: 0 }}>
      <span style={{ fontSize: 11, color: '#6b7280', flexShrink: 0 }}>{k}</span>
      <span style={{ fontSize: 11, color: dcrColor ?? '#111827', fontFamily: 'monospace', fontWeight: dcr !== undefined ? 700 : 400 }}>{v}</span>
    </div>
  );
}

function Section({ title }: { title: string }) {
  return <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, margin: '10px 0 4px' }}>{title}</div>;
}

export default function MemberResults({ member, onRebarChange }: Props) {
  const [activeLoad, setActiveLoad] = useState(member.loads[0]?.id ?? '');
  const [showCalc, setShowCalc] = useState(false);

  const load = member.loads.find(l => l.id === activeLoad) ?? member.loads[0];
  const result: DesignResults = designMember(member.section, member.material, member.rebar, load, member.span);

  function handleRebarChange(rebar: RebarLayout) {
    onRebarChange?.({ ...member, rebar });
  }

  const statusColor = result.status === 'OK' ? '#16a34a' : result.status === 'NG' ? '#dc2626' : '#d97706';
  const statusBg    = result.status === 'OK' ? '#f0fdf4' : result.status === 'NG' ? '#fef2f2' : '#fffbeb';
  const s = member.section;
  const t = member.rebar.ties;

  return (
    <div style={{ background: 'white', borderRadius: 12, padding: 16 }}>
      {showCalc && (
        <CalcBreakdownModal
          member={member}
          loadId={activeLoad || member.loads[0]?.id}
          onClose={() => setShowCalc(false)}
        />
      )}

      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {/* Load case dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1 }}>Load Case</span>
          <select
            value={activeLoad}
            onChange={e => setActiveLoad(e.target.value)}
            style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, color: '#111827', background: 'white', cursor: 'pointer' }}
          >
            {member.loads.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>

        {/* Status pill */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20, background: statusBg, border: `1px solid ${statusColor}40` }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: statusColor }}>
            {result.status === 'OK' ? 'All checks pass' : result.status === 'NG' ? 'Section inadequate' : 'Near capacity — review'}
          </span>
        </div>

        <button
          onClick={() => setShowCalc(true)}
          style={{ marginLeft: 'auto', padding: '5px 12px', border: '1px solid #e5e7eb', borderRadius: 6, background: 'white', fontSize: 11, cursor: 'pointer', color: '#374151', fontWeight: 600 }}
        >
          ∑ Calc Sheet
        </button>
      </div>

      {/* 3-column layout: properties | section SVG | results */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* Left: member properties + applied loads */}
        <div style={{ width: 168, flexShrink: 0, fontSize: 11 }}>
          <Section title="Member" />
          <KV k="f'c" v={`${member.material.fc} psi`} />
          <KV k="fy" v={`${(member.material.fy / 1000).toFixed(0)} ksi`} />
          <KV k="λ" v={member.material.lambdaConcrete.toFixed(2)} />
          <KV k="b" v={`${s.b}"`} />
          <KV k="h" v={`${s.h}"`} />
          {s.bw && <KV k="bw" v={`${s.bw}"`} />}
          {s.hf && <KV k="hf" v={`${s.hf}"`} />}
          <KV k="Cover" v={`${s.coverClear}"`} />
          {t && <KV k="Stirrups" v={`#${t.barSize}@${t.spacing}"`} />}
          {member.span && <KV k="Span" v={`${member.span} ft`} />}

          <Section title="Applied Loads" />
          {load.Mu_pos > 0 && <KV k="Mu+" v={`${load.Mu_pos.toFixed(1)} k-ft`} />}
          {load.Mu_neg > 0 && <KV k="Mu−" v={`${load.Mu_neg.toFixed(1)} k-ft`} />}
          <KV k="Vu" v={`${load.Vu.toFixed(1)} kips`} />
          {load.Tu > 0 && <KV k="Tu" v={`${load.Tu.toFixed(1)} k-ft`} />}
          {load.Pu !== 0 && <KV k="Pu" v={`${load.Pu.toFixed(1)} kips`} />}
        </div>

        {/* Center: Section diagram */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <SectionView
            section={member.section}
            rebar={member.rebar}
            width={300}
            height={250}
            onRebarChange={onRebarChange ? handleRebarChange : undefined}
          />
          {member.memberType === 'beam' && (
            <ElevationView member={member} width={300} height={90} />
          )}
          {onRebarChange && (
            <p style={{ fontSize: 10, color: '#9ca3af', margin: 0, textAlign: 'center' }}>
              Click bar labels to change count • Left = +1, Right-click = −1
            </p>
          )}
        </div>

        {/* Right: design results */}
        <div style={{ width: 168, flexShrink: 0, fontSize: 11 }}>
          <Section title="Flexure" />
          <KV k="φMn+" v={`${result.phi_Mn_pos.toFixed(1)} k-ft`} />
          <KV k="  DCR" v={result.DCR_flex_pos.toFixed(3)} dcr={result.DCR_flex_pos} />
          <KV k="φMn−" v={`${result.phi_Mn_neg.toFixed(1)} k-ft`} />
          <KV k="  DCR" v={result.DCR_flex_neg.toFixed(3)} dcr={result.DCR_flex_neg} />
          <KV k="As req+" v={`${result.As_req_pos.toFixed(2)} in²`} />
          <KV k="As req−" v={`${result.As_req_neg.toFixed(2)} in²`} />
          <KV k="As min" v={`${result.As_min.toFixed(2)} in²`} />
          <KV k="As max" v={`${result.As_max.toFixed(2)} in²`} />

          <Section title="Shear" />
          <KV k="Vc" v={`${result.Vc.toFixed(1)} kips`} />
          <KV k="Vs" v={`${result.Vs.toFixed(1)} kips`} />
          <KV k="φVn" v={`${result.phi_Vn.toFixed(1)} kips`} />
          <KV k="  DCR" v={result.DCR_shear.toFixed(3)} dcr={result.DCR_shear} />
          <KV k="Av req" v={`${result.Av_req.toFixed(4)} in²/in`} />
          <KV k="Av min/s" v={`${result.Av_min_per_s.toFixed(4)} in²/in`} />

          <Section title="Torsion" />
          <KV k="Tcr" v={`${result.Tcr.toFixed(1)} k-ft`} />
          <KV k="φTn" v={`${result.phi_Tn.toFixed(1)} k-ft`} />
          <KV k="  DCR" v={result.DCR_torsion.toFixed(3)} dcr={result.DCR_torsion} />
        </div>
      </div>

      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div style={{ marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Code Checks / Warnings</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {result.warnings.map((w, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 8px', borderRadius: 6, background: w.severity === 'error' ? '#fef2f2' : '#fffbeb' }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: w.severity === 'error' ? '#dc2626' : '#d97706', flexShrink: 0, marginTop: 1 }}>{w.code}</span>
                <span style={{ fontSize: 11, color: '#374151' }}>{w.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
