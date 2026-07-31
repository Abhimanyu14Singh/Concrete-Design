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
import type { Member, DesignResults, DesignCode, BarGroup } from '../../types';
import { zonedShearCheck, zoneShearDemands } from '../../utils/concreteDesign';
import { zonedShearCheckEC2 } from '../../engines/ec2/ec2Beam';
import { steppedMomentCapacity } from '../../utils/curtailment';
import { useUnits } from '../../contexts/UnitsContext';
import { DIAGRAM, LABEL_STYLE, STATUS } from '../../theme';

interface Props {
  member: Member;
  result: DesignResults;
  code?: DesignCode;
  height?: number;
  /** Project-level EC2 §6.2.3 strut angle cotθ (default 2.5). */
  cotTheta?: number;
  /** The member's group per-region top cages — drive the stepped hogging capacity
   *  (φMn⁻) through the middle third and at the opposite end. */
  midThirdTopBars?: BarGroup[];
  oppositeTopBars?: BarGroup[];
  /** The group's reduced end-third bottom cage — drives the stepped sagging
   *  capacity (φMn⁺) through the two END thirds. */
  endThirdBotBars?: BarGroup[];
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

export default function ForceDiagram({ member, result, code, height = 150, cotTheta, midThirdTopBars, oppositeTopBars, endThirdBotBars }: Props) {
  const { label, toDisplay } = useUnits();
  const raw = buildEnvelope(member);
  if (raw.length < 2) return null;

  const spanRaw = member.span ?? raw[raw.length - 1].x;

  // Stepped shear capacity from tie zones (constant if no zones), in imperial first
  if (member.rebar.tieZones && member.rebar.ties) {
    const demands = zoneShearDemands(member.stationForces ?? [], spanRaw);
    const zones = code === 'EN1992-1-1'
      ? zonedShearCheckEC2(member.section, member.material, member.rebar, demands, cotTheta ?? 2.5)
      : zonedShearCheck(member.section, member.material, member.rebar, demands);
    for (const pt of raw) {
      const zi = Math.min(2, Math.floor((pt.x / spanRaw) * 3));
      pt.phiVn = zones[zi]?.phi_Vn ?? result.phi_Vn;
      pt.phiVnNeg = -(zones[zi]?.phi_Vn ?? result.phi_Vn);
    }
  } else {
    for (const pt of raw) { pt.phiVn = result.phi_Vn; pt.phiVnNeg = -result.phi_Vn; }
  }

  // Stepped ±φMn capacity across the L/3 regions. Top steel is detailed full at
  // the two END thirds and curtailed through the MIDDLE; the group's per-region
  // top cages (middle-third / opposite-end), when set, drive those hogging
  // levels. Bottom steel is the mirror — full mid-span, curtailed at the ends.
  // Precompute the levels once (display units), then bin each station.
  const cap = steppedMomentCapacity(member, result, code ?? 'ACI318-19', { midThirdTopBars, oppositeTopBars, endThirdBotBars });
  const negMarkD = toDisplay(cap.negFull, 'moment');
  const negMidD = toDisplay(cap.negMid, 'moment');
  const negOppD = toDisplay(cap.negOpp, 'moment');
  const posMidD = toDisplay(cap.posFull, 'moment');
  const posEndD = toDisplay(cap.posReduced, 'moment');
  const oppThird = cap.oppEnd === 'start' ? 0 : cap.oppEnd === 'end' ? 2 : -1;
  const thirdOf = (xRaw: number) => (spanRaw > 0 ? Math.min(2, Math.floor((xRaw / spanRaw) * 3)) : 0);

  // Convert every plotted quantity into the active display unit system.
  const data = raw.map(pt => {
    const third = thirdOf(pt.x);
    // Hogging (top) capacity by region: middle third → mid cage; opposite-end
    // third → opposite cage; mark-end third → full cage.
    const negLevel = third === 1 ? negMidD : third === oppThird ? negOppD : negMarkD;
    // Sagging (bottom) capacity: full mid-span, curtailed at the ends.
    const posLevel = third === 1 ? posMidD : posEndD;
    return {
      x: +toDisplay(pt.x, 'spanLength').toFixed(2),
      Vmax: +toDisplay(pt.Vmax, 'force').toFixed(2),
      Vmin: +toDisplay(pt.Vmin, 'force').toFixed(2),
      Mmax: +toDisplay(pt.Mmax, 'moment').toFixed(2),
      Mmin: +toDisplay(pt.Mmin, 'moment').toFixed(2),
      phiVn: pt.phiVn != null ? +toDisplay(pt.phiVn, 'force').toFixed(2) : undefined,
      phiVnNeg: pt.phiVnNeg != null ? +toDisplay(pt.phiVnNeg, 'force').toFixed(2) : undefined,
      // Hogging capacity (top steel), plotted negative (hogging/up side of the
      // reversed axis).
      phiMnNegStep: -(+negLevel.toFixed(2)),
      // Sagging capacity (bottom steel).
      phiMnPosStep: +posLevel.toFixed(2),
    };
  });
  const span = +toDisplay(spanRaw, 'spanLength').toFixed(2);
  const spanUnit = label('spanLength');

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={LABEL_STYLE}>
        Shear Diagram — envelope of imported combos ({label('force')})
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" />
          <XAxis dataKey="x" type="number" domain={[0, span]} tick={axisTick} unit={spanUnit} />
          <YAxis tick={axisTick} width={45} />
          <Tooltip contentStyle={tooltipStyle} />
          <ReferenceLine y={0} stroke="#9ca3af" />
          <Area dataKey="Vmax" stroke={DIAGRAM.shear} fill="#cffafe" fillOpacity={0.5} isAnimationActive={false} name="V max" />
          <Area dataKey="Vmin" stroke={DIAGRAM.shear} fill="#cffafe" fillOpacity={0.5} isAnimationActive={false} name="V min" />
          <Line dataKey="phiVn" stroke={STATUS.fail} strokeDasharray="6 3" dot={false} isAnimationActive={false} name="φVn" type="stepAfter" />
          <Line dataKey="phiVnNeg" stroke={STATUS.fail} strokeDasharray="6 3" dot={false} isAnimationActive={false} name="−φVn" type="stepAfter" legendType="none" />
        </ComposedChart>
      </ResponsiveContainer>

      <div style={{ ...LABEL_STYLE, marginTop: 4 }}>
        Moment Diagram — envelope of imported combos ({label('moment')}, sagging plotted down)
      </div>
      <div style={{ fontSize: 9, color: '#9ca3af', marginBottom: 2 }}>
        Dashed ±φMn step at L/3: top steel full at the end thirds (curtailed mid-span), bottom steel full mid-span (curtailed toward the ends). Hover for the envelope at each station.
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#f3f4f6" strokeDasharray="3 3" />
          <XAxis dataKey="x" type="number" domain={[0, span]} tick={axisTick} unit={spanUnit} />
          {/* Structural convention: sagging (+M) drawn downward. */}
          <YAxis tick={axisTick} width={45} reversed />
          <Tooltip contentStyle={tooltipStyle} />
          <ReferenceLine y={0} stroke="#9ca3af" />
          <Area dataKey="Mmax" stroke="#3b82f6" fill="#bfdbfe" fillOpacity={0.5} isAnimationActive={false} name="M max" />
          <Area dataKey="Mmin" stroke="#3b82f6" fill="#bfdbfe" fillOpacity={0.5} isAnimationActive={false} name="M min" />
          {/* ±φMn capacity, stepped over the L/3 regions to reflect curtailment:
              φMn⁺ (bottom steel) full mid-span & curtailed at the ends; φMn⁻ (top
              steel) full at the end thirds & curtailed mid-span. As Line series
              they auto-extend the Y-axis, so they stay visible when capacity
              envelopes demand. */}
          <Line dataKey="phiMnPosStep" stroke={STATUS.ok} strokeDasharray="6 3" dot={false} isAnimationActive={false} name="φMn⁺" type="stepAfter" />
          <Line dataKey="phiMnNegStep" stroke={DIAGRAM.moment} strokeDasharray="6 3" dot={false} isAnimationActive={false} name="φMn⁻" type="stepAfter" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
