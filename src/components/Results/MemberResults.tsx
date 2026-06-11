import { useState } from 'react';
import type { Member, DesignResults, RebarLayout, DesignCode } from '../../types';
import { runDesign } from '../../engines';
import { designWallACI } from '../../utils/wallDesign';
import { capacityLabels } from '../../utils/units';
import { formatBarLabel } from '../../utils/rebar';
import { useUnits } from '../../contexts/UnitsContext';
import SectionView from '../Detailing/SectionView';
import ElevationView from '../Detailing/ElevationView';
import InteractionDiagram from '../Detailing/InteractionDiagram';
import WallSectionView from '../Detailing/WallSectionView';
import CalcBreakdownModal from './CalcBreakdownModal';
import CodeBadge from '../common/CodeBadge';
import { codeAccent, dcrColor as themeDcrColor, dcrBg as themeDcrBg, MEMBER_COLOR, DCR } from '../../theme';

interface Props {
  member: Member;
  code?: DesignCode;
  onRebarChange?: (updated: Member) => void;
}

function KV({ k, v, dcr }: { k: string; v: string; dcr?: number }) {
  const dcrColor = dcr !== undefined ? themeDcrColor(dcr) : undefined;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', borderBottom: '1px solid #f3f4f6', gap: 8, minWidth: 0 }}>
      <span style={{ fontSize: 11, color: '#6b7280', flexShrink: 0 }}>{k}</span>
      <span style={{ fontSize: 11, color: dcrColor ?? '#111827', fontFamily: 'monospace', fontWeight: dcr !== undefined ? 700 : 400 }}>{v}</span>
    </div>
  );
}

function SectionLabel({ title }: { title: string }) {
  return <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, margin: '10px 0 4px' }}>{title}</div>;
}

function dcrStyle(dcr: number): React.CSSProperties {
  return { background: themeDcrBg(dcr), color: themeDcrColor(dcr), fontWeight: 700, fontFamily: 'monospace', padding: '1px 5px', borderRadius: 4, fontSize: 11 };
}

export default function MemberResults({ member, code = 'ACI318-19', onRebarChange }: Props) {
  const [activeLoad, setActiveLoad] = useState(member.loads[0]?.id ?? '');
  const [showCalc, setShowCalc] = useState(false);
  const [showAllLC, setShowAllLC] = useState(false);
  const { fmt } = useUnits();
  const cap = capacityLabels(code);

  const load = member.loads.find(l => l.id === activeLoad) ?? member.loads[0];
  const isWall = member.memberType === 'wall' && !!member.wallRebar;
  const result: DesignResults = isWall
    ? designWallACI(member.section, member.material, member.wallRebar!, load)
    : runDesign(member.section, member.material, member.rebar, load, member.span, code, member.crackParams);

  const isColumn = member.section.type === 'rectangular_column' || member.section.type === 'circular_column';

  // C1: compute all-LC results to find governing cases
  const allResults = member.loads.map(l => ({ id: l.id, label: l.label, r: runDesign(member.section, member.material, member.rebar, l, member.span, code, member.crackParams) }));
  const govFlexPos  = allResults.reduce((a, b) => b.r.DCR_flex_pos  > a.r.DCR_flex_pos  ? b : a).id;
  const govFlexNeg  = allResults.reduce((a, b) => b.r.DCR_flex_neg  > a.r.DCR_flex_neg  ? b : a).id;
  const govShear    = allResults.reduce((a, b) => b.r.DCR_shear     > a.r.DCR_shear     ? b : a).id;
  const govTorsion  = allResults.reduce((a, b) => b.r.DCR_torsion   > a.r.DCR_torsion   ? b : a).id;
  const govPM       = allResults.reduce((a, b) => (b.r.DCR_PM ?? 0) > (a.r.DCR_PM ?? 0) ? b : a).id;
  const govSet      = isColumn
    ? new Set([govPM, govShear])
    : new Set([govFlexPos, govFlexNeg, govShear, govTorsion]);

  function handleRebarChange(rebar: RebarLayout) {
    onRebarChange?.({ ...member, rebar });
  }

  // C5: rebar optimizer
  function handleOptimize() {
    let best = { ...member.rebar };
    const worstDCR = (r: RebarLayout) => {
      const allR = member.loads.map(l => runDesign(member.section, member.material, { ...member.rebar, ...r }, l, member.span, code, member.crackParams));
      return Math.max(...allR.map(res => Math.max(res.DCR_flex_pos, res.DCR_flex_neg, res.DCR_shear)));
    };

    let changed = false;
    // Try reducing bottom bars first
    let rebar = { ...member.rebar };
    while (rebar.botBars[0] && rebar.botBars[0].numBars > 1) {
      const candidate = { ...rebar, botBars: [{ ...rebar.botBars[0], numBars: rebar.botBars[0].numBars - 1 }] };
      if (worstDCR(candidate) < 0.90) {
        rebar = candidate;
        changed = true;
      } else break;
    }
    // Try reducing top bars
    while (rebar.topBars[0] && rebar.topBars[0].numBars > 1) {
      const candidate = { ...rebar, topBars: [{ ...rebar.topBars[0], numBars: rebar.topBars[0].numBars - 1 }] };
      if (worstDCR(candidate) < 0.90) {
        rebar = candidate;
        changed = true;
      } else break;
    }

    if (changed) {
      best = rebar;
      onRebarChange?.({ ...member, rebar: best });
    } else {
      alert('Section is already at or near minimum reinforcement. No reduction possible while keeping DCR < 0.90.');
    }
  }

  const statusColor = result.status === 'OK' ? DCR.pass : result.status === 'NG' ? DCR.fail : DCR.warn;
  const statusBg    = result.status === 'OK' ? DCR.passBg : result.status === 'NG' ? DCR.failBg : DCR.warnBg;
  const s = member.section;
  const t = member.rebar.ties;

  return (
    <div style={{ background: 'white', borderRadius: 12, padding: 16, borderTop: `3px solid ${codeAccent(code)}` }}>
      {showCalc && (
        <CalcBreakdownModal
          member={member}
          loadId={activeLoad || member.loads[0]?.id}
          code={code}
          onClose={() => setShowCalc(false)}
        />
      )}

      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {/* Load case dropdown — C1: mark governing LC */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1 }}>Load Case</span>
          <select
            value={activeLoad}
            onChange={e => setActiveLoad(e.target.value)}
            style={{ padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, color: '#111827', background: 'white', cursor: 'pointer' }}
          >
            {member.loads.map(l => (
              <option key={l.id} value={l.id}>
                {govSet.has(l.id) ? '★ ' : ''}{l.label}
              </option>
            ))}
          </select>
        </div>

        {/* Status pill */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 20, background: statusBg, border: `1px solid ${statusColor}40` }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: statusColor }}>
            {result.status === 'OK' ? 'All checks pass' : result.status === 'NG' ? 'Section inadequate' : 'Near capacity — review'}
          </span>
        </div>

        {/* Code + member-type badges */}
        <CodeBadge code={code} />
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
          color: MEMBER_COLOR[member.memberType] ?? '#6b7280',
          background: `${MEMBER_COLOR[member.memberType] ?? '#6b7280'}14`,
          border: `1px solid ${MEMBER_COLOR[member.memberType] ?? '#6b7280'}40`,
          borderRadius: 12, padding: '2px 8px',
        }}>
          {isColumn ? 'Column' : member.memberType}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {onRebarChange && !isColumn && (
            <button
              onClick={handleOptimize}
              style={{ padding: '5px 10px', border: '1px solid #d97706', borderRadius: 6, background: '#fffbeb', fontSize: 11, cursor: 'pointer', color: '#d97706', fontWeight: 600 }}
              title="Reduce bar count until max DCR ≈ 0.90"
            >
              Optimize
            </button>
          )}
          <button
            onClick={() => setShowCalc(true)}
            style={{ padding: '5px 12px', border: '1px solid #e5e7eb', borderRadius: 6, background: 'white', fontSize: 11, cursor: 'pointer', color: '#374151', fontWeight: 600 }}
          >
            ∑ Calc Sheet
          </button>
        </div>
      </div>

      {/* 3-column layout: properties | section SVG | results */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* Left: member properties + applied loads */}
        <div style={{ width: 168, flexShrink: 0, fontSize: 11 }}>
          <SectionLabel title="Member" />
          <KV k={code === 'EN1992-1-1' ? 'fck (cyl)' : "f'c"} v={fmt(member.material.fc, 'stress')} />
          <KV k="fy" v={fmt(member.material.fy / 1000, 'stressKsi')} />
          <KV k="λ" v={member.material.lambdaConcrete.toFixed(2)} />
          <KV k="b" v={fmt(s.b, 'length')} />
          <KV k="h" v={fmt(s.h, 'length')} />
          {s.bw && <KV k="bw" v={fmt(s.bw, 'length')} />}
          {s.hf && <KV k="hf" v={fmt(s.hf, 'length')} />}
          <KV k="Cover" v={fmt(s.coverClear, 'length')} />
          {t && <KV k="Stirrups" v={`${formatBarLabel(t.barSize)}@${fmt(t.spacing, 'length')}`} />}
          {member.span && <KV k="Span" v={fmt(member.span, 'spanLength')} />}

          <SectionLabel title="Applied Loads" />
          {isColumn ? (
            <>
              <KV k="Pu" v={fmt(load.Pu, 'force')} />
              <KV k="Mux" v={fmt(load.Mux ?? 0, 'moment')} />
              <KV k="Muy" v={fmt(load.Muy ?? 0, 'moment')} />
              <KV k="Vu" v={fmt(load.Vu, 'force')} />
            </>
          ) : (
            <>
              {load.Mu_pos > 0 && <KV k="Mu+" v={fmt(load.Mu_pos, 'moment')} />}
              {load.Mu_neg > 0 && <KV k="Mu−" v={fmt(load.Mu_neg, 'moment')} />}
              <KV k="Vu" v={fmt(load.Vu, 'force')} />
              {load.Tu > 0 && <KV k="Tu" v={fmt(load.Tu, 'moment')} />}
              {load.Pu !== 0 && <KV k="Pu" v={fmt(load.Pu, 'force')} />}
            </>
          )}
        </div>

        {/* Center: Section diagram */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {isWall && member.wallRebar ? (
            <WallSectionView
              section={member.section}
              wallRebar={member.wallRebar}
              Pu={load.Pu}
              Mu={Math.abs(load.Mu_pos > 0 ? load.Mu_pos : load.Mu_neg)}
              c_demand={0}
              fc={member.material.fc}
              fyt={member.material.fyt}
              width={420}
              height={180}
            />
          ) : (
            <SectionView
              section={member.section}
              rebar={member.rebar}
              result={result}
              width={300}
              height={250}
              onRebarChange={onRebarChange ? handleRebarChange : undefined}
            />
          )}
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
          {isWall ? (
            <>
              <SectionLabel title="In-Plane Shear §18.10.4" />
              <KV k="αc" v={(result.alphaC ?? 0).toFixed(2)} />
              <KV k="φVn" v={`${(result.phi_Vn_wall ?? 0).toFixed(1)} k`} />
              <KV k="Vn,max" v={`${(result.wallVnMax ?? 0).toFixed(1)} k`} />
              <KV k="  DCR" v={(result.DCR_shear_wall ?? 0).toFixed(3)} dcr={result.DCR_shear_wall ?? 0} />

              <SectionLabel title="P-M §18.10.5" />
              <KV k="φMn,wall" v={`${(result.phi_Mn_wall ?? 0).toFixed(1)} k-ft`} />
              <KV k="  DCR" v={(result.DCR_flex_wall ?? 0).toFixed(3)} dcr={result.DCR_flex_wall ?? 0} />

              <SectionLabel title="Min. Reinf. §11.6" />
              <KV k="ρl" v={`${((result.rhoL ?? 0) * 100).toFixed(4)}%`}
                dcr={(result.rhoL ?? 0) < 0.0025 ? 1.5 : 0} />
              <KV k="ρt" v={`${((result.rhoT ?? 0) * 100).toFixed(4)}%`}
                dcr={(result.rhoT ?? 0) < 0.0025 ? 1.5 : 0} />

              <SectionLabel title="SBZ §18.10.6" />
              <KV k="Required" v={result.sbzRequired ? '⚠ YES' : '✓ No'} />
              {result.sbzRequired && (
                <>
                  <KV k="lbe" v={`${(result.sbzLength ?? 0).toFixed(1)}"`} />
                  <KV k="Ash,req" v={`${(result.sbzAshRequired ?? 0).toFixed(3)} in²`} />
                  <KV k="Ash,prov" v={`${(result.sbzAshProvided ?? 0).toFixed(3)} in²`} />
                  <KV k="  DCR" v={(result.DCR_sbzAsh ?? 0).toFixed(3)} dcr={result.DCR_sbzAsh ?? 0} />
                </>
              )}
            </>
          ) : isColumn ? (
            <>
              <SectionLabel title="Axial" />
              <KV k={code === 'EN1992-1-1' ? 'N_Rd,max' : 'φPn,max'} v={fmt(result.phi_Pn_max ?? 0, 'force')} />
              <KV k="  DCR" v={(result.DCR_axial ?? 0).toFixed(3)} dcr={result.DCR_axial ?? 0} />

              <SectionLabel title="P-M Interaction" />
              <KV k={code === 'EN1992-1-1' ? 'M_Rd,x @NEd' : 'φMnx @Pu'} v={fmt(result.phi_Mnx ?? 0, 'moment')} />
              <KV k={code === 'EN1992-1-1' ? 'M_Rd,y @NEd' : 'φMny @Pu'} v={fmt(result.phi_Mny ?? 0, 'moment')} />
              <KV k="  DCR" v={(result.DCR_PM ?? 0).toFixed(3)} dcr={result.DCR_PM ?? 0} />

              <SectionLabel title="Shear" />
              <KV k={cap.Vc} v={fmt(result.Vc, 'force')} />
              <KV k={cap.Vs} v={fmt(result.Vs, 'force')} />
              <KV k={cap.Vn} v={fmt(result.phi_Vn, 'force')} />
              <KV k="  DCR" v={result.DCR_shear.toFixed(3)} dcr={result.DCR_shear} />

              <SectionLabel title="Steel Limits" />
              <KV k="As min" v={fmt(result.As_min, 'area')} />
              <KV k="As max" v={fmt(result.As_max, 'area')} />
            </>
          ) : (
            <>
          <SectionLabel title="Flexure" />
          <KV k={`${cap.Mn}+`} v={fmt(result.phi_Mn_pos, 'moment')} />
          <KV k="  DCR" v={result.DCR_flex_pos.toFixed(3)} dcr={result.DCR_flex_pos} />
          <KV k={`${cap.Mn}−`} v={fmt(result.phi_Mn_neg, 'moment')} />
          <KV k="  DCR" v={result.DCR_flex_neg.toFixed(3)} dcr={result.DCR_flex_neg} />
          {code !== 'EN1992-1-1' && <KV k="As req+" v={fmt(result.As_req_pos, 'area')} />}
          {code !== 'EN1992-1-1' && <KV k="As req−" v={fmt(result.As_req_neg, 'area')} />}
          <KV k="As min" v={fmt(result.As_min, 'area')} />
          <KV k="As max" v={fmt(result.As_max, 'area')} />

          <SectionLabel title="Shear" />
          <KV k={cap.Vc} v={fmt(result.Vc, 'force')} />
          <KV k={cap.Vs} v={fmt(result.Vs, 'force')} />
          <KV k={cap.Vn} v={fmt(result.phi_Vn, 'force')} />
          <KV k="  DCR" v={result.DCR_shear.toFixed(3)} dcr={result.DCR_shear} />
          {code !== 'EN1992-1-1' && <KV k="Av req" v={`${result.Av_req.toFixed(4)} in²/in`} />}
          {code !== 'EN1992-1-1' && <KV k="Av min/s" v={`${result.Av_min_per_s.toFixed(4)} in²/in`} />}

          <SectionLabel title="Torsion" />
          <KV k={cap.Tcr} v={fmt(result.Tcr, 'moment')} />
          <KV k={cap.Tn} v={fmt(result.phi_Tn, 'moment')} />
          <KV k="  DCR" v={result.DCR_torsion.toFixed(3)} dcr={result.DCR_torsion} />

          {code === 'EN1992-1-1' && (
            <>
              <SectionLabel title="Crack Width §7.3.4" />
              <KV k="wk bot" v={`${(result.wk_bot ?? 0).toFixed(3)} mm`}
                dcr={(result.wk_bot ?? 0) / (member.crackParams?.wLimitBot ?? 0.3)} />
              <KV k="wk top" v={`${(result.wk_top ?? 0).toFixed(3)} mm`}
                dcr={(result.wk_top ?? 0) / (member.crackParams?.wLimitTop ?? 0.3)} />
              {result.wk_face !== undefined && (
                <KV k="wk face" v={`${result.wk_face.toFixed(3)} mm`}
                  dcr={result.wk_face / (member.crackParams?.wLimitFace ?? 0.3)} />
              )}
              <KV k="w limit" v={`${(member.crackParams?.wLimitBot ?? 0.3).toFixed(2)} mm`} />
            </>
          )}
            </>
          )}
        </div>
      </div>

      {/* Column interaction diagram */}
      {isColumn && result.interaction && (
        <div style={{ marginTop: 14 }}>
          <InteractionDiagram
            points={result.interaction}
            loads={member.loads}
            code={code}
            activeLoadId={activeLoad}
          />
        </div>
      )}

      {/* C2: All-load-cases comparison table */}
      {member.loads.length > 1 && (
        <div style={{ marginTop: 14, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
          <button
            onClick={() => setShowAllLC(v => !v)}
            style={{ fontSize: 11, fontWeight: 700, color: '#374151', background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 6, textTransform: 'uppercase', letterSpacing: 1 }}
          >
            <span style={{ fontSize: 9 }}>{showAllLC ? '▼' : '▶'}</span>
            All Load Cases ({member.loads.length})
          </button>
          {showAllLC && (
            <div style={{ marginTop: 8, overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {(isColumn
                      ? ['Load Case', 'P-M DCR', 'Axial DCR', 'Shear DCR', 'Status']
                      : ['Load Case', 'Flex+ DCR', 'Flex− DCR', 'Shear DCR', 'Torsion DCR', 'Status']
                    ).map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: '#6b7280', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allResults.map(({ id, label, r }) => (
                    <tr
                      key={id}
                      style={{ background: id === activeLoad ? '#eff6ff' : 'white', cursor: 'pointer', borderBottom: '1px solid #f3f4f6' }}
                      onClick={() => setActiveLoad(id)}
                    >
                      <td style={{ padding: '5px 10px', fontWeight: id === activeLoad ? 700 : 400, color: '#374151' }}>
                        {govSet.has(id) && <span style={{ color: '#d97706', marginRight: 4 }}>★</span>}
                        {label}
                      </td>
                      {isColumn ? (
                        <>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_PM ?? 0)}>{(r.DCR_PM ?? 0).toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_axial ?? 0)}>{(r.DCR_axial ?? 0).toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_shear)}>{r.DCR_shear.toFixed(3)}</span></td>
                        </>
                      ) : (
                        <>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_flex_pos)}>{r.DCR_flex_pos.toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_flex_neg)}>{r.DCR_flex_neg.toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_shear)}>{r.DCR_shear.toFixed(3)}</span></td>
                          <td style={{ padding: '5px 10px' }}><span style={dcrStyle(r.DCR_torsion)}>{r.DCR_torsion.toFixed(3)}</span></td>
                        </>
                      )}
                      <td style={{ padding: '5px 10px', fontWeight: 700, color: r.status === 'OK' ? '#16a34a' : r.status === 'NG' ? '#dc2626' : '#d97706', fontSize: 10 }}>
                        {r.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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
