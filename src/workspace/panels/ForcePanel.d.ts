/**
 * Type surface for the Force Diagram panel — really just the crosshair's arithmetic,
 * which is the part typed code (its test) reads. The panel itself is only ever mounted
 * from `.jsx` inside the workspace; same rule as `PlanHistogram.d.ts`.
 */

/** One station of the combo envelope, stored-imperial like everything on the bus. */
export interface ForceStation {
  x: number;
  Mlo: number; Mhi: number;
  Vlo: number; Vhi: number;
  /** Absent on imports made before torsion was carried through. */
  Tlo?: number; Thi?: number;
}

/** Same shape with torsion resolved — what the readout prints. */
export interface ForceStationAt {
  x: number;
  Mlo: number; Mhi: number;
  Vlo: number; Vhi: number;
  Tlo: number; Thi: number;
}

/**
 * The envelope at an arbitrary point along the span, linearly interpolated between the
 * bracketing stations so the readout matches the polygon that is drawn. Clamps at both
 * ends; null when there are no stations.
 */
export declare function envelopeAt(
  stations: ForceStation[] | null | undefined, x: number,
): ForceStationAt | null;

declare const ForcePanel: (props: Record<string, unknown>) => JSX.Element;
export default ForcePanel;
