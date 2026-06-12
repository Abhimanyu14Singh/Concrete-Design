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
  if (filter.stories?.length && !filter.stories.includes(beam.story)) return false;
  if (filter.sections?.length && !filter.sections.includes(beam.section)) return false;
  if (filter.groups?.length && !beam.groups.some(g => filter.groups!.includes(g))) return false;
  return true;
}
