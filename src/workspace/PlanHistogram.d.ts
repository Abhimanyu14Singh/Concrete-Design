/**
 * Type surface for the Model view's histogram — the binning arithmetic, which is what
 * typed code (its test) reads. The component itself is consumed by `.jsx` inside the
 * workspace; same rule as `popoutBus.d.ts`.
 */

/** One beam's contribution: its id, so a bar can point back at it on the map, and its
 *  value in DISPLAY units. */
export interface HistItem { id: string; v: number }

/** What the bars bin: one quantity, chosen by the map's colour-by mode. Null there means
 *  a categorical mode with no numeric axis. */
export interface HistSeries {
  items: HistItem[];
  label: string;
  unit: string;
  decimals: number;
}

export interface HistBin { x0: number; x1: number; n: number; ids: string[] }

/**
 * Count `items` into bins spanning [lo, hi]. Values outside are CLAMPED into the end
 * bins and also counted in `under` / `over`, so nothing vanishes when the limits are
 * tightened. Items with a non-finite value are dropped. Each bin carries the ids of the
 * members in it.
 */
export declare function buildBins(
  items: HistItem[], lo: number, hi: number, nBins?: number,
): { bins: HistBin[]; total: number; under: number; over: number };

/** The data range, padded out to a round step — the default x limits. */
export declare function defaultLimits(items: HistItem[]): { lo: number; hi: number };

/** Up to `max` whole-number count ticks on a 1/2/5 step. */
export declare function countTicks(peak: number, max?: number): number[];

declare const PlanHistogram: (props: {
  series?: HistSeries | null;
  collapsed?: boolean;
  onCollapsed?: (v: boolean) => void;
  /** Sit one row higher — the map's DCR legend owns the bottom-left corner. */
  raised?: boolean;
  /** The colour the map draws one member in; a bar is filled the colour of the beams
   *  inside it, by majority. */
  colorOfMember?: (id: string) => string | undefined;
  /** The member ids under the pointer, empty on leave. */
  onHoverMembers?: (ids: string[]) => void;
}) => JSX.Element | null;
export default PlanHistogram;
