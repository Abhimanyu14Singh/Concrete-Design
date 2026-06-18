/**
 * Shear & moment diagrams for a beam imported from ETABS — envelope of the
 * imported combos at each station, with capacity overlays:
 *   shear: stepped φVn per stirrup zone (or flat line for single spacing)
 *   moment: φMn⁺ / φMn⁻ horizontal limits
 */
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts';
import type { Member, DesignResults } from '../../types';
import { zonedShearCheck, zoneShearDemands } from '../../utils/concreteDesign';
import { useUnits } from '../../contexts/UnitsContext';

interface Props {
  member: Member;
  result: DesignResults;
  height?: number;
}

interface DiagramPoint {
  x: number;
  Vmax: number; Vmin: number;
  Mmax: number; Mmin: number;
  phiVn?: number; phiVnNeg?: number;
}

function buildEnvelope(member: Member): DiagramPoint[] {
  const forces = member.stationForces ?? [];
  const xs = new Set<number>();
  for (const cf of forces) for (const st of cf.stations) xs.add(st.x);
  const sorted = [...xs].sort((a, b) => a - b);

  return sorted.map(x => {
    let Vmax = -Infinity, Vmin = Infinity, Mmax = -Infinity, Mmin = Infinity;
    for (const cf of forces) {
      // linear interpolation between bracketing stations of this combo
      const sta = cf.stations;
      let v: number | null = null, m: number | null = null;
      for (let i = 0; i < sta.length; i++) {
        if (sta[i].x === x) { v = sta[i].V; m = sta[i].M; break; }
        if (i > 0 && sta[i - 1].x < x && x < sta[i].x) {
          const t = (x - sta[i - 1].x) / (sta[i].x - sta[i - 1].x);
          v = sta[i - 1].V + t * (sta[i].V - sta[i - 1].V);
          m = sta[i - 1].M + t * (sta[i].M - sta[i - 1].M);
          break;
        }
      }
      if (v == null || m == null) continue;
      Vmax = Math.max(Vmax, v); Vmin = Math.min(Vmin, v);
      Mmax = Math.max(Mmax, m); Mmin = Math.min(Mmin, m);
    }
    return {
      x: +x.toFixed(2),
      Vmax: +Vmax.toFixed(2), Vmin: +Vmin.toFixed(2),
      Mmax: +Mmax.toFixed(2), Mmin: +Mmin.toFixed(2),
    };
  });
}

const axisTick = { fill: '#9ca3af', fontSize: 10 };
const tooltipStyle = { background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 11 };

export default function ForceDiagram({ member, result, height = 150 }: Props) {
  const { label, toDisplay } = useUnits();
  const raw = buildEnvelope(member);
  if (raw.length < 2) return null;

  const spanRaw = member.span ?? raw[raw.length - 1].x;

  // Stepped shear capacity from tie zones (constant if no zones), in imperial first
  if (member.rebar.tieZones && member.rebar.ties) {
    const demands = zoneShearDemands(member.stationForces ?? [], spanRaw);
    const zones = zonedShearCheck(member.section, member.material, member.rebar, demands);
    for (const pt of raw) {
      const zi = Math.min(2, Math.floor((pt.x / spanRaw) * 3));
      pt.phiVn = zones[zi]?.phi_Vn ?? result.phi_Vn;
      pt.phiVnNeg = -(zones[zi]?.phi_Vn ?? result.phi_Vn);
    }
  } else {
    for (const pt of raw) { pt.phiVn = result.phi_Vn; pt.phiVnNeg = -result.phi_Vn; }
  }

  // Convert every plotted quantity into the active display unit system.
  const data = raw.map(pt => ({
    x: +toDisplay(pt.x, 'spanLength').toFixed(2),
    Vmax: +toDisplay(pt.Vmax, 'force').toFixed(2),
    Vmin: +toDisplay(pt.Vmin, 'force').toFixed(2),
    Mmax: +toDisplay(pt.Mmax, 'moment').toFixed(2),
    Mmin: +toDisplay(pt.Mmin, 'moment').toFixed(2),
    phiVn: pt.phiVn != null ? +toDisplay(pt.phiVn, 'force').toFixed(2) : undefined,
    phiVnNeg: pt.phiVnNeg != null ? +toDisplay(pt.phiVnNeg, 'force').toFixed(2) : undefined,
  }));
  const span = +toDisplay(spanRaw, 'spanLength').toFixed(2);
  const phiMnPos = toDisplay(result.phi_Mn_pos, 'moment');
  const phiMnNeg = toDisplay(result.phi_Mn_neg, 'moment');
  const spanUnit = label('spanLength');

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1 }}>
        Shear Diagram — envelope of imported combos ({label('force')})
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" />
          <XAxis dataKey="x" type="number" domain={[0, span]} tick={axisTick} unit={spanUnit} />
          <YAxis tick={axisTick} width={45} />
          <Tooltip contentStyle={tooltipStyle} />
          <ReferenceLine y={0} stroke="#9ca3af" />
          <Area dataKey="Vmax" stroke="#f59e0b" fill="#fde68a" fillOpacity={0.5} isAnimationActive={false} name="V max" />
          <Area dataKey="Vmin" stroke="#f59e0b" fill="#fde68a" fillOpacity={0.5} isAnimationActive={false} name="V min" />
          <Line dataKey="phiVn" stroke="#dc2626" strokeDasharray="6 3" dot={false} isAnimationActive={false} name="φVn" type="stepAfter" />
          <Line dataKey="phiVnNeg" stroke="#dc2626" strokeDasharray="6 3" dot={false} isAnimationActive={false} name="−φVn" type="stepAfter" legendType="none" />
        </ComposedChart>
      </ResponsiveContainer>

      <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 1, marginTop: 4 }}>
        Moment Diagram — envelope ({label('moment')}, sagging plotted down)
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" />
          <XAxis dataKey="x" type="number" domain={[0, span]} tick={axisTick} unit={spanUnit} />
          {/* Structural convention: sagging (+M) drawn downward */}
          <YAxis tick={axisTick} width={45} reversed />
          <Tooltip contentStyle={tooltipStyle} />
          <ReferenceLine y={0} stroke="#9ca3af" />
          <ReferenceLine y={phiMnPos} stroke="#16a34a" strokeDasharray="6 3"
            label={{ value: 'φMn⁺', fontSize: 9, fill: '#16a34a', position: 'insideBottomRight' }} />
          <ReferenceLine y={-phiMnNeg} stroke="#7c3aed" strokeDasharray="6 3"
            label={{ value: 'φMn⁻', fontSize: 9, fill: '#7c3aed', position: 'insideTopRight' }} />
          <Area dataKey="Mmax" stroke="#3b82f6" fill="#bfdbfe" fillOpacity={0.5} isAnimationActive={false} name="M max" />
          <Area dataKey="Mmin" stroke="#3b82f6" fill="#bfdbfe" fillOpacity={0.5} isAnimationActive={false} name="M min" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
