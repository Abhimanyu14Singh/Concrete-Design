/**
 * EtabsConnection — transport-agnostic interface for pulling beam data out of
 * an ETABS model. Three implementations:
 *
 *   ComConnection  — live CSI OAPI via the Electron main process (Windows,
 *                    ETABS running). See comClient.ts + electron/etabsBridge.cjs.
 *   FileConnection — exported ETABS tables workbook (.xlsx). Works anywhere.
 *   MockConnection — built-in sample model for demos and tests.
 *
 * The import wizard talks only to this interface, so all three sources share
 * the exact same UI flow.
 */
import type { ComboForces, Point3D } from '../../types';

export interface EtabsConnectInfo {
  modelName: string;
  units: string; // display only, e.g. "kip-ft"
}

export interface EtabsSectionInfo {
  name: string;
  material: string;
  shape: 'Rectangular' | 'T' | 'L' | 'Circle';
  depth: number;  // t3 (in)
  width: number;  // t2 (in)
}

export interface EtabsMaterialInfo {
  name: string;
  fc?: number; // psi
  fy?: number; // psi
}

export interface EtabsBeamGeom {
  name: string;       // unique frame name
  story: string;
  section: string;    // frame property name
  pt1: Point3D;       // ft
  pt2: Point3D;       // ft
  groups: string[];
  lengthFt: number;
}

export interface BeamFilter {
  stories?: string[];   // empty/undefined = all
  sections?: string[];
  groups?: string[];    // beam must belong to at least one
}

export interface EtabsConnection {
  readonly kind: 'com' | 'file' | 'mock' | 'bridge';
  connect(): Promise<EtabsConnectInfo>;
  getStories(): Promise<string[]>;
  getGroups(): Promise<string[]>;
  getFrameSections(): Promise<EtabsSectionInfo[]>;
  getMaterials(): Promise<EtabsMaterialInfo[]>;
  getCombos(): Promise<string[]>;
  getBeams(filter: BeamFilter): Promise<EtabsBeamGeom[]>;
  /** Station forces per frame for the selected combos. Key = frame name. */
  getStationForces(frameNames: string[], combos: string[], sourceGroup?: string): Promise<Record<string, ComboForces[]>>;
}

export function matchesFilter(beam: EtabsBeamGeom, filter: BeamFilter): boolean {
  // Story is a hard scope — AND.
  if (filter.stories?.length && !filter.stories.includes(beam.story)) return false;

  // Sections + groups are additive (union). If either selector is active, the
  // beam must match at least one of them. If neither is active, all beams pass.
  const hasSecFilter = !!filter.sections?.length;
  const hasGrpFilter = !!filter.groups?.length;
  if (hasSecFilter || hasGrpFilter) {
    const matchesSec = hasSecFilter && filter.sections!.includes(beam.section);
    const matchesGrp = hasGrpFilter && beam.groups.some(g => filter.groups!.includes(g));
    if (!matchesSec && !matchesGrp) return false;
  }

  return true;
}
