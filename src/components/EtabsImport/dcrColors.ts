/** Plan-map DCR color scale (matches the legend in PlanMap). */
export function dcrToColor(dcr: number): string {
  if (!Number.isFinite(dcr)) return '#9ca3af';
  if (dcr < 0.7) return '#16a34a';   // green
  if (dcr < 0.9) return '#84cc16';   // lime
  if (dcr < 1.0) return '#f59e0b';   // amber
  return '#dc2626';                  // red
}
