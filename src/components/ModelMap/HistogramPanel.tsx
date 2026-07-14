/**
 * Demand histogram with draggable group-boundary sliders.
 *
 * In read-only mode (no onBreaksChange): shows the distribution with no
 * interaction — used as the metric histogram for flexSteel / stirrups overlays.
 */
import { useMemo } from 'react';
import {
  BarChart, Bar, Cell, XAxis, YAxis, ReferenceLine,
  Tooltip as RechartsTip, ResponsiveContainer,
} from 'recharts';
import { valueToRampColor } from './colorRamp';
import { ACCENT, CATEGORICAL, INK, MONO_NUM } from '../../theme';

const NUM_BINS = 20;

/** Colors for each bin-group assignment — categorical, no status hues. */
const BIN_COLORS = CATEGORICAL;

interface HistogramPanelProps {
  /** Raw values to histogram. */
  values: number[];
  /** Group-assignment index per value (same length as values). */
  binAssignment?: number[];
  /** Interior break values (on the same scale as values). */
  breaks?: number[];
  /** Called when the user drags a break slider. breaks is sorted and clamped. */
  onBreaksChange?: (breaks: number[]) => void;
  xLabel?: string;
  /** Show as continuous ramp (for metric overlays, no assignment coloring). */
  rampMode?: boolean;
  /** Explicit ramp bounds (overrides data min/max) so bar colors match the map legend. */
  rampMin?: number;
  rampMax?: number;
  /** Decimal places for hover-tooltip and min/max readouts (default 0). */
  valueDecimals?: number;
}

export default function HistogramPanel({
  values,
  binAssignment,
  breaks = [],
  onBreaksChange,
  xLabel = 'Demand',
  rampMode = false,
  rampMin,
  rampMax,
  valueDecimals = 0,
}: HistogramPanelProps) {
  const { bins, minVal, maxVal } = useMemo(() => {
    if (!values.length) return { bins: [], minVal: 0, maxVal: 0 };
    const minV = Math.min(...values), maxV = Math.max(...values);
    const range = maxV - minV || 1;
    const step = range / NUM_BINS;

    const buckets = Array.from({ length: NUM_BINS }, (_, i) => ({
      label: minV + (i + 0.5) * step,
      x0: minV + i * step,
      x1: minV + (i + 1) * step,
      count: 0,
      // For assignment coloring: count per group bin
      byGroup: new Array<number>(BIN_COLORS.length).fill(0),
    }));

    values.forEach((v, idx) => {
      const bi = Math.min(NUM_BINS - 1, Math.floor(((v - minV) / range) * NUM_BINS));
      buckets[bi].count++;
      if (binAssignment) {
        const gi = binAssignment[idx] ?? 0;
        buckets[bi].byGroup[Math.min(gi, BIN_COLORS.length - 1)]++;
      }
    });

    return { bins: buckets, minVal: minV, maxVal: maxV };
  }, [values, binAssignment]);

  if (!values.length) return <div style={{ color: INK.muted, fontSize: 11, padding: 8 }}>No data</div>;

  const range = maxVal - minVal || 1;

  // Break positions as fraction of chart domain (0–1)
  function breakToFraction(br: number): number {
    return (br - minVal) / range;
  }

  function handleSlider(idx: number, rawVal: number) {
    if (!onBreaksChange) return;
    const updated = [...breaks];
    updated[idx] = rawVal;
    // Clamp so breaks don't cross each other
    if (idx > 0 && updated[idx] <= updated[idx - 1]) updated[idx] = updated[idx - 1] + range * 0.001;
    if (idx < updated.length - 1 && updated[idx] >= updated[idx + 1]) updated[idx] = updated[idx + 1] - range * 0.001;
    onBreaksChange(updated);
  }

  // Build chart data — one key per group bin for stacked display
  const groupKeys = binAssignment
    ? Array.from({ length: Math.max(...binAssignment) + 1 }, (_, i) => `g${i}`)
    : ['count'];

  const chartData = bins.map(b => {
    const row: Record<string, number | string> = { label: b.label };
    if (binAssignment) {
      groupKeys.forEach((k, i) => { row[k] = b.byGroup[i] ?? 0; });
    } else {
      row['count'] = b.count;
    }
    return row;
  });

  return (
    <div>
      <ResponsiveContainer width="100%" height={100}>
        <BarChart data={chartData} barCategoryGap={1} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
          <XAxis dataKey="label" hide />
          <YAxis tick={{ fontSize: 10 }} width={28} />
          <RechartsTip
            contentStyle={{ fontSize: 10, padding: '2px 6px' }}
            formatter={(v) => [`${v} beams`, '']}
            labelFormatter={(l) => `≈${Number(l).toFixed(valueDecimals)}`}
          />
          {rampMode
            ? (
              <Bar dataKey="count" isAnimationActive={false}>
                {bins.map((b, i) => (
                  <Cell key={i} fill={valueToRampColor(b.label, rampMin ?? minVal, rampMax ?? maxVal)} />
                ))}
              </Bar>
            )
            : groupKeys.map((k, i) => (
                <Bar key={k} dataKey={k} stackId="a" fill={BIN_COLORS[i % BIN_COLORS.length]} isAnimationActive={false} />
              ))
          }
          {/* Snap each break to its bucket midpoint — the categorical XAxis only
              renders ReferenceLines at existing category values. */}
          {breaks.map((br, i) => {
            const bucket = bins.find(b => br >= b.x0 && br <= b.x1) ?? bins[bins.length - 1];
            return (
              <ReferenceLine key={i} x={bucket.label} stroke="#1e293b" strokeWidth={1.5} strokeDasharray="3 2" />
            );
          })}
        </BarChart>
      </ResponsiveContainer>

      {/* Break sliders */}
      {onBreaksChange && breaks.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {breaks.map((br, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ fontSize: 10, color: INK.secondary, width: 50 }}>Cut {i + 1}</span>
              <input
                type="range"
                min={minVal}
                max={maxVal}
                step={(maxVal - minVal) / 200}
                value={br}
                onChange={e => handleSlider(i, parseFloat(e.target.value))}
                style={{ flex: 1, accentColor: ACCENT.primary, height: 4 }}
              />
              <span style={{ fontSize: 10, color: INK.base, width: 44, textAlign: 'right', ...MONO_NUM }}>
                {br.toFixed(0)}
              </span>
            </div>
          ))}
          <div style={{ fontSize: 10, color: INK.muted }}>{xLabel}</div>
        </div>
      )}

      {!onBreaksChange && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: INK.muted, marginTop: 2 }}>
          <span>{minVal.toFixed(Math.max(1, valueDecimals))}</span>
          <span style={{ color: INK.secondary }}>{xLabel}</span>
          <span>{maxVal.toFixed(Math.max(1, valueDecimals))}</span>
        </div>
      )}
    </div>
  );
}
