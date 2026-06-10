/**
 * Shared column section geometry — used by both the ACI and EC2 column engines.
 *
 * Unit-agnostic: all functions work in whatever length unit the caller passes
 * (the ACI engine calls in inches, the EC2 engine in mm). Bar areas come from
 * the caller for the same reason.
 *
 * Bar layout convention (maps the existing RebarLayout onto a column):
 *  - Rectangular: topBars = layer nearest the compression (top) face,
 *    botBars = layer at the far face, sideBars = intermediate layers spread
 *    evenly between the two face layers.
 *  - Circular: all bars (topBars + botBars + sideBars) placed evenly on a ring
 *    of radius D/2 − cover − d_tie − d_bar/2, with one bar at the extreme
 *    compression fiber.
 */

export interface BarPoint {
  y: number;    // distance from the extreme compression face
  area: number; // bar area (one bar's area × bars in this layer for rect rows)
}

export interface BarLayoutInput {
  /** [numBars, barArea, barDiam] triplets per group, same length unit as dims */
  top: { n: number; area: number; diam: number }[];
  bot: { n: number; area: number; diam: number }[];
  side: { n: number; area: number; diam: number }[];
}

/**
 * Discrete bar layers for a rectangular column of depth h.
 * cover = clear cover, tieD = tie bar diameter.
 */
export function rectBarLayout(
  h: number, cover: number, tieD: number, bars: BarLayoutInput,
): BarPoint[] {
  const layers: BarPoint[] = [];

  const topD = bars.top[0]?.diam ?? 0;
  const botD = bars.bot[0]?.diam ?? 0;
  const yTop = cover + tieD + topD / 2;
  const yBot = h - cover - tieD - botD / 2;

  for (const g of bars.top) if (g.n > 0) layers.push({ y: yTop, area: g.n * g.area });
  for (const g of bars.bot) if (g.n > 0) layers.push({ y: yBot, area: g.n * g.area });

  // Side bars: spread evenly between the face layers (exclusive of them).
  // Each sideBars group is interpreted as numBars total intermediate bars
  // (split across the two faces of the column — they sit at the same y).
  const nSideLayers = bars.side.reduce((s, g) => s + (g.n > 0 ? 1 : 0), 0);
  if (nSideLayers > 0 && yBot > yTop) {
    let li = 0;
    for (const g of bars.side) {
      if (g.n <= 0) continue;
      // distribute this group's bars over (g.n / 2) layers of 2 bars when even,
      // else single layers of g.n bars at evenly spaced heights
      const rows = Math.max(1, Math.round(g.n / 2));
      for (let r = 0; r < rows; r++) {
        const t = (r + 1) / (rows + 1);
        layers.push({ y: yTop + t * (yBot - yTop), area: (g.n / rows) * g.area });
      }
      li++;
    }
    void li;
  }
  return layers;
}

/**
 * Discrete bar positions for a circular column of diameter D.
 * All groups pooled and placed evenly on the ring; first bar at y = cover line
 * on the compression side.
 */
export function circBarLayout(
  D: number, cover: number, tieD: number, bars: BarLayoutInput,
): BarPoint[] {
  const all = [...bars.top, ...bars.bot, ...bars.side].filter(g => g.n > 0);
  const n = all.reduce((s, g) => s + g.n, 0);
  if (n === 0) return [];
  // Use the largest bar diameter for ring radius (conservative on lever arm)
  const dbar = Math.max(...all.map(g => g.diam));
  const areaPerBar = all.reduce((s, g) => s + g.n * g.area, 0) / n;
  const r = D / 2 - cover - tieD - dbar / 2;

  const pts: BarPoint[] = [];
  for (let i = 0; i < n; i++) {
    const y = D / 2 - r * Math.cos((2 * Math.PI * i) / n);
    pts.push({ y, area: areaPerBar });
  }
  return pts;
}

/**
 * Area and centroid (measured from the compression face) of a circular
 * segment of depth a in a circle of diameter D.
 *
 * Identities: a = D → A = πR², ȳ = R;  a = R → A = πR²/2, ȳ = R − 4R/(3π).
 */
export function circularSegment(a: number, D: number): { A: number; yBar: number } {
  const R = D / 2;
  const aa = Math.min(Math.max(a, 0), D);
  if (aa <= 0) return { A: 0, yBar: 0 };
  const theta = Math.acos((R - aa) / R); // half-angle subtended, 0..π
  const A = R * R * (theta - Math.sin(theta) * Math.cos(theta));
  if (A <= 0) return { A: 0, yBar: 0 };
  const yFromCenter = (2 * Math.pow(R, 3) * Math.pow(Math.sin(theta), 3)) / (3 * A);
  return { A, yBar: R - yFromCenter };
}

/** Gross area of a column section. */
export function grossArea(isCircular: boolean, b: number, h: number, D: number): number {
  return isCircular ? Math.PI * D * D / 4 : b * h;
}
