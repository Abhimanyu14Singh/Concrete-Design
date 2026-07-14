/**
 * FileConnection — reads an ETABS tables export workbook (.xlsx).
 *
 * Expected workbook (sheet names are matched loosely, columns by header):
 *   Beams     — Story | Frame | Section | X1 Y1 Z1 X2 Y2 Z2 (ft) | Groups (";"-separated, optional)
 *   Sections  — Name | Material | Shape | Depth | Width   (in)
 *   Materials — Name | Fc | Fy                            (psi)
 *   Forces    — Frame | Combo | Station (ft) | V (kips) | M (kip-ft)
 *               (ETABS "Element Forces - Beams" columns V2/M3 are accepted)
 *
 * Any extra sheets/columns are ignored. Headers are case-insensitive.
 */
import * as XLSX from 'xlsx';
import type { ComboForces } from '../../types';
import type {
  EtabsConnection, EtabsConnectInfo, EtabsSectionInfo, EtabsMaterialInfo,
  EtabsBeamGeom, EtabsColumnGeom, BeamFilter,
} from './connection';
import { matchesFilter } from './connection';

type Row = Record<string, unknown>;

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function rekey(rows: Row[]): Row[] {
  return rows.map(r => {
    const o: Row = {};
    for (const [k, v] of Object.entries(r)) o[norm(k)] = v;
    return o;
  });
}

/** Find the first sheet whose headers include all of `required` (normalized),
 *  optionally skipping any sheet whose NAME contains `excludeNameSubstr` — used so
 *  the beam parse never accidentally grabs the "Columns" sheet when it comes first. */
function findSheet(wb: XLSX.WorkBook, required: string[], excludeNameSubstr?: string): Row[] | null {
  for (const name of wb.SheetNames) {
    if (excludeNameSubstr && norm(name).includes(norm(excludeNameSubstr))) continue;
    const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { defval: null });
    if (!rows.length) continue;
    const headers = Object.keys(rows[0]).map(norm);
    if (required.every(r => headers.includes(r))) return rekey(rows);
  }
  return null;
}

/** Find a sheet whose NAME contains `substr` (case-insensitive) and has all
 *  `required` headers — used to pick the explicit "Columns" sheet. */
function findNamedSheet(wb: XLSX.WorkBook, substr: string, required: string[]): Row[] | null {
  for (const name of wb.SheetNames) {
    if (!norm(name).includes(norm(substr))) continue;
    const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { defval: null });
    if (!rows.length) continue;
    const headers = Object.keys(rows[0]).map(norm);
    if (required.every(r => headers.includes(r))) return rekey(rows);
  }
  return null;
}

const num = (v: unknown): number => (v == null || v === '' ? 0 : Number(v));
const str = (v: unknown): string => (v == null ? '' : String(v));

export class FileConnection implements EtabsConnection {
  readonly kind = 'file' as const;

  private beams: EtabsBeamGeom[] = [];
  private columns: EtabsColumnGeom[] = [];
  private sections: EtabsSectionInfo[] = [];
  private materials: EtabsMaterialInfo[] = [];
  private forces = new Map<string, Map<string, ComboForces>>(); // frame → combo → forces
  private modelName: string;
  private data: ArrayBuffer;

  constructor(data: ArrayBuffer, fileName = 'ETABS export') {
    this.data = data;
    this.modelName = fileName;
  }

  async connect(): Promise<EtabsConnectInfo> {
    const wb = XLSX.read(this.data, { type: 'array' });

    const geomHeaders = ['story', 'frame', 'section', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2'];
    // Prefer an explicit "Beams" sheet; otherwise the first geometry sheet that
    // ISN'T the columns sheet (so sheet order can't swap beams and columns).
    const beamRows = findNamedSheet(wb, 'beam', geomHeaders) ?? findSheet(wb, geomHeaders, 'column');
    if (!beamRows) throw new Error('No "Beams" sheet found (needs Story, Frame, Section, X1..Z2 columns).');
    this.beams = beamRows.map(r => {
      const pt1 = { x: num(r.x1), y: num(r.y1), z: num(r.z1) };
      const pt2 = { x: num(r.x2), y: num(r.y2), z: num(r.z2) };
      return {
        name: str(r.frame),
        story: str(r.story),
        section: str(r.section),
        pt1, pt2,
        groups: str(r.groups).split(';').map(g => g.trim()).filter(Boolean),
        lengthFt: Math.hypot(pt2.x - pt1.x, pt2.y - pt1.y, pt2.z - pt1.z),
      };
    });

    // Columns are OPTIONAL: an explicit "Columns"-named sheet with the same
    // geometry columns. Only genuinely vertical members are kept.
    const colRows = findNamedSheet(wb, 'column', ['story', 'frame', 'section', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2']) ?? [];
    this.columns = colRows
      .map(r => {
        const pt1 = { x: num(r.x1), y: num(r.y1), z: num(r.z1) };
        const pt2 = { x: num(r.x2), y: num(r.y2), z: num(r.z2) };
        return {
          name: str(r.frame), story: str(r.story), section: str(r.section), pt1, pt2,
          groups: str(r.groups).split(';').map(g => g.trim()).filter(Boolean),
          heightFt: Math.abs(pt2.z - pt1.z) || Math.hypot(pt2.x - pt1.x, pt2.y - pt1.y, pt2.z - pt1.z),
        };
      })
      .filter(c => Math.abs(c.pt2.z - c.pt1.z) >= Math.hypot(c.pt2.x - c.pt1.x, c.pt2.y - c.pt1.y));

    const secRows = findSheet(wb, ['name', 'material', 'depth', 'width']);
    this.sections = (secRows ?? []).map(r => ({
      name: str(r.name),
      material: str(r.material),
      shape: (str(r.shape) || 'Rectangular') as EtabsSectionInfo['shape'],
      depth: num(r.depth),
      width: num(r.width),
    }));

    const matRows = findSheet(wb, ['name', 'fc']);
    this.materials = (matRows ?? []).map(r => ({
      name: str(r.name),
      fc: r.fc != null ? num(r.fc) : undefined,
      fy: r.fy != null ? num(r.fy) : undefined,
    }));

    const forceRows = findSheet(wb, ['frame', 'combo', 'station'])
      ?? findSheet(wb, ['frame', 'loadcombo', 'station']);
    for (const r of forceRows ?? []) {
      const frame = str(r.frame);
      const combo = str(r.combo ?? r.loadcombo);
      const V = num(r.v ?? r.v2);
      const M = num(r.m ?? r.m3);
      const x = num(r.station);
      let byCombo = this.forces.get(frame);
      if (!byCombo) this.forces.set(frame, (byCombo = new Map()));
      let cf = byCombo.get(combo);
      if (!cf) byCombo.set(combo, (cf = { combo, stations: [] }));
      cf.stations.push({ x, V, M });
    }
    for (const byCombo of this.forces.values())
      for (const cf of byCombo.values()) cf.stations.sort((a, b) => a.x - b.x);

    return { modelName: this.modelName, units: 'kip-ft' };
  }

  async getStories(): Promise<string[]> {
    return [...new Set([...this.beams.map(b => b.story), ...this.columns.map(c => c.story)])];
  }

  async getGroups(): Promise<string[]> {
    return [...new Set([...this.beams.flatMap(b => b.groups), ...this.columns.flatMap(c => c.groups)])];
  }

  async getFrameSections(): Promise<EtabsSectionInfo[]> {
    return this.sections;
  }

  async getMaterials(): Promise<EtabsMaterialInfo[]> {
    return this.materials;
  }

  async getCombos(): Promise<string[]> {
    const combos = new Set<string>();
    for (const byCombo of this.forces.values())
      for (const c of byCombo.keys()) combos.add(c);
    return [...combos];
  }

  async getBeams(filter: BeamFilter): Promise<EtabsBeamGeom[]> {
    return this.beams.filter(b => matchesFilter(b, filter));
  }

  async getColumns(filter: BeamFilter): Promise<EtabsColumnGeom[]> {
    return this.columns.filter(c => matchesFilter(c, filter));
  }

  async getStationForces(frameNames: string[], combos: string[]): Promise<Record<string, ComboForces[]>> {
    const out: Record<string, ComboForces[]> = {};
    for (const name of frameNames) {
      const byCombo = this.forces.get(name);
      if (!byCombo) continue;
      out[name] = combos.map(c => byCombo.get(c)).filter((c): c is ComboForces => !!c);
    }
    return out;
  }
}
