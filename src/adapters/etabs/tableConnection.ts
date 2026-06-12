/**
 * TableConnection — shared base for ETABS connections that read the model
 * through ETABS database tables (DatabaseTables.GetTableForDisplayArray).
 *
 * Subclasses provide only the transport:
 *   ComConnection    — IPC to the bundled .NET sidecar (desktop app)
 *   BridgeConnection — HTTP to a local helper server (tools, browser)
 *
 * Tables consumed (model display units; converted here to ft/kip/psi):
 *   "Program Control"                                    → CurrUnits
 *   "Beam Object Connectivity"                           → beams + stories
 *   "Point Object Connectivity"                          → joint coordinates
 *   "Frame Assignments - Section Properties"             → beam → section
 *   "Group Assignments"                                  → ETABS groups
 *   "Frame Section Property Definitions - Concrete Rectangular" → exact b×h
 *   "Frame Section Property Definitions - Summary"       → b×h fallback (Area/I33)
 *   "Material Properties - Concrete Data" / "- Rebar Data" → fc / fy
 *   "Load Combination Definitions" + "Load Case Definitions - Summary" → combos
 *   "Design Forces - Beams" (fallback "Element Forces - Beams") → station P/V2/M3/T
 */
import type { ComboForces, StationForce } from '../../types';
import type {
  EtabsConnection, EtabsConnectInfo, EtabsSectionInfo, EtabsMaterialInfo,
  EtabsBeamGeom, BeamFilter,
} from './connection';
import { matchesFilter } from './connection';

export type TableRow = Record<string, unknown>;

interface UnitFactors {
  lengthToFt: number;   // model length unit → ft
  forceToKip: number;   // model force unit → kip
  label: string;        // e.g. "kip-ft", "kn-m"
}

const LENGTH_TO_FT: Record<string, number> = {
  in: 1 / 12, ft: 1, mm: 1 / 304.8, cm: 1 / 30.48, m: 3.280839895,
};
const FORCE_TO_KIP: Record<string, number> = {
  lb: 0.001, kip: 1, n: 0.0002248089, kn: 0.2248089, kgf: 0.0022046, tonf: 2.2046,
};

/** Parse ETABS "Program Control" CurrUnits, e.g. "Kip, in, F" / "kN, m, C". */
export function parseUnits(currUnits: string): UnitFactors | null {
  const parts = currUnits.split(',').map(p => p.trim().toLowerCase());
  if (parts.length < 2) return null;
  const f = FORCE_TO_KIP[parts[0]];
  const l = LENGTH_TO_FT[parts[1]];
  if (f === undefined || l === undefined) return null;
  return { forceToKip: f, lengthToFt: l, label: `${parts[0]}-${parts[1]}` };
}

const DEFAULT_UNITS: UnitFactors = { forceToKip: 1, lengthToFt: 1, label: 'kip-ft (assumed)' };

/**
 * Map ETABS eUnits integer → UnitFactors.
 * Enum values from ETABS API (cSapModel.eUnits):
 *   1=lb_in  2=lb_ft  3=kip_in  4=kip_ft  5=kN_mm  6=kN_m
 *   7=kgf_mm 8=kgf_m  9=N_mm   10=N_m   11=tonf_mm 12=tonf_m
 *  13=kN_cm 14=kgf_cm 15=N_cm  16=tonf_cm
 */
export function eUnitsToFactors(e: number): UnitFactors | null {
  const map: Record<number, UnitFactors> = {
    1:  { forceToKip: 0.001,       lengthToFt: 1/12,           label: 'lb-in'   },
    2:  { forceToKip: 0.001,       lengthToFt: 1,              label: 'lb-ft'   },
    3:  { forceToKip: 1,           lengthToFt: 1/12,           label: 'kip-in'  },
    4:  { forceToKip: 1,           lengthToFt: 1,              label: 'kip-ft'  },
    5:  { forceToKip: 0.2248089,   lengthToFt: 1/304.8,        label: 'kn-mm'   },
    6:  { forceToKip: 0.2248089,   lengthToFt: 3.280839895,    label: 'kn-m'    },
    7:  { forceToKip: 0.0022046,   lengthToFt: 1/304.8,        label: 'kgf-mm'  },
    8:  { forceToKip: 0.0022046,   lengthToFt: 3.280839895,    label: 'kgf-m'   },
    9:  { forceToKip: 0.0002248089,lengthToFt: 1/304.8,        label: 'n-mm'    },
    10: { forceToKip: 0.0002248089,lengthToFt: 3.280839895,    label: 'n-m'     },
    11: { forceToKip: 2.2046,      lengthToFt: 1/304.8,        label: 'tonf-mm' },
    12: { forceToKip: 2.2046,      lengthToFt: 3.280839895,    label: 'tonf-m'  },
    13: { forceToKip: 0.2248089,   lengthToFt: 1/30.48,        label: 'kn-cm'   },
    14: { forceToKip: 0.0022046,   lengthToFt: 1/30.48,        label: 'kgf-cm'  },
    15: { forceToKip: 0.0002248089,lengthToFt: 1/30.48,        label: 'n-cm'    },
    16: { forceToKip: 2.2046,      lengthToFt: 1/30.48,        label: 'tonf-cm' },
  };
  return map[e] ?? null;
}

/** Read a column by any of several names; falls back to case-insensitive match. */
function col(r: TableRow, ...names: string[]): unknown {
  for (const n of names) if (n in r) return r[n];
  const lower = new Map(Object.keys(r).map(k => [k.toLowerCase().replace(/\s+/g, ''), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase().replace(/\s+/g, ''));
    if (k !== undefined) return r[k];
  }
  return undefined;
}

function num(r: TableRow, ...names: string[]): number {
  const v = col(r, ...names);
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function str(r: TableRow, ...names: string[]): string {
  const v = col(r, ...names);
  return v === undefined || v === null ? '' : String(v);
}

export abstract class TableConnection implements EtabsConnection {
  abstract readonly kind: 'com' | 'bridge';

  /** Transport: establish the session, return the model name. */
  protected abstract openSession(): Promise<{ modelName: string }>;
  /** Transport: fetch one ETABS table as row objects ([] when unavailable). */
  protected abstract fetchTable(key: string): Promise<TableRow[]>;
  /**
   * Optional transport hook: return the ETABS eUnits integer for the present
   * display units, or null if not available (e.g. HTTP bridge).
   * ComConnection overrides this to query the sidecar after SetPresentUnits.
   */
  protected fetchUnitsEnum(): Promise<number | null> { return Promise.resolve(null); }

  protected units: UnitFactors = DEFAULT_UNITS;
  private beamsCache: EtabsBeamGeom[] | null = null;
  private sectionNamesUsed = new Set<string>();
  private storiesCache: string[] = [];
  private groupsByBeam = new Map<string, string[]>();
  private groupNames: string[] = [];
  private forcesCache: TableRow[] | null = null;

  async connect(): Promise<EtabsConnectInfo> {
    const { modelName } = await this.openSession();

    // Primary: enum-based units from transport (deterministic, set by sidecar via SetPresentUnits)
    let resolvedFromEnum = false;
    try {
      const enumVal = await this.fetchUnitsEnum();
      if (enumVal != null) {
        const factors = eUnitsToFactors(enumVal);
        if (factors) { this.units = factors; resolvedFromEnum = true; }
      }
    } catch { /* best effort */ }

    // Fallback: parse the "Program Control" CurrUnits string
    if (!resolvedFromEnum) {
      try {
        const pc = await this.fetchTable('Program Control');
        const cu = str(pc[0] ?? {}, 'CurrUnits', 'Curr Units');
        const parsed = cu ? parseUnits(cu) : null;
        if (parsed) this.units = parsed;
      } catch { /* keep defaults */ }
    }

    return { modelName, units: this.units.label };
  }

  async getStories(): Promise<string[]> {
    await this.loadBeams();
    return this.storiesCache;
  }

  async getGroups(): Promise<string[]> {
    await this.loadBeams();
    return this.groupNames;
  }

  private async loadBeams(): Promise<void> {
    if (this.beamsCache) return;
    const [connectivity, joints, assignments, groupRows] = await Promise.all([
      this.fetchTable('Beam Object Connectivity'),
      this.fetchTable('Point Object Connectivity'),
      this.fetchTable('Frame Assignments - Section Properties'),
      this.fetchTable('Group Assignments').catch(() => [] as TableRow[]),
    ]);
    if (!connectivity.length) {
      throw new Error(
        'ETABS returned no beams ("Beam Object Connectivity" is empty) — ' +
        'is a model open in ETABS?'
      );
    }

    const lf = this.units.lengthToFt;
    const coords = new Map<string, { x: number; y: number; z: number }>();
    for (const j of joints) {
      const name = str(j, 'UniqueName', 'UniquePtName');
      if (!name) continue;
      coords.set(name, { x: num(j, 'X') * lf, y: num(j, 'Y') * lf, z: num(j, 'Z') * lf });
    }

    const sectionByBeam = new Map<string, string>();
    for (const a of assignments) {
      const un = str(a, 'UniqueName');
      const sect = str(a, 'SectProp', 'SectionProperty', 'AnalysisSect');
      if (un && sect) sectionByBeam.set(un, sect);
    }

    // ETABS groups: name list + per-object membership
    this.groupsByBeam = new Map();
    const names = new Set<string>();
    for (const g of groupRows) {
      const group = str(g, 'GroupName', 'Group');
      const obj = str(g, 'ObjectUniqueName', 'UniqueName', 'ObjectName');
      if (!group || !obj) continue;
      names.add(group);
      const list = this.groupsByBeam.get(obj) ?? [];
      list.push(group);
      this.groupsByBeam.set(obj, list);
    }
    this.groupNames = [...names].sort();

    this.sectionNamesUsed = new Set();
    this.beamsCache = connectivity.map(row => {
      const un = str(row, 'UniqueName');
      const section = sectionByBeam.get(un) ?? '';
      if (section) this.sectionNamesUsed.add(section);
      const pt1 = coords.get(str(row, 'UniquePtI', 'PtI')) ?? { x: 0, y: 0, z: 0 };
      const pt2 = coords.get(str(row, 'UniquePtJ', 'PtJ')) ?? { x: 0, y: 0, z: 0 };
      const lengthRaw = num(row, 'Length');
      return {
        name: un,
        story: str(row, 'Story'),
        section,
        pt1, pt2,
        groups: this.groupsByBeam.get(un) ?? [],
        lengthFt: lengthRaw > 0
          ? lengthRaw * lf
          : Math.hypot(pt2.x - pt1.x, pt2.y - pt1.y, pt2.z - pt1.z),
      };
    });
    this.storiesCache = [...new Set(this.beamsCache.map(b => b.story).filter(Boolean))];
  }

  async getBeams(filter: BeamFilter): Promise<EtabsBeamGeom[]> {
    await this.loadBeams();
    return this.beamsCache!.filter(b => matchesFilter(b, filter));
  }

  async getFrameSections(): Promise<EtabsSectionInfo[]> {
    await this.loadBeams();
    const lenToIn = this.units.lengthToFt * 12;
    const out = new Map<string, EtabsSectionInfo>();

    // Exact dimensions from the concrete-rectangular definitions table
    try {
      for (const r of await this.fetchTable('Frame Section Property Definitions - Concrete Rectangular')) {
        const name = str(r, 'Name');
        if (!name) continue;
        out.set(name, {
          name,
          material: str(r, 'Material'),
          shape: 'Rectangular',
          depth: num(r, 't3', 'Depth') * lenToIn,
          width: num(r, 't2', 'Width') * lenToIn,
        });
      }
    } catch { /* table may not exist */ }

    // Fallback for sections used by beams but missing above: derive from Area/I33
    const missing = [...this.sectionNamesUsed].filter(s => !out.has(s));
    if (missing.length) {
      try {
        for (const r of await this.fetchTable('Frame Section Property Definitions - Summary')) {
          const name = str(r, 'Name');
          if (!name || out.has(name) || !missing.includes(name)) continue;
          const area = num(r, 'Area');     // L²
          const i33 = num(r, 'I33');       // L⁴
          if (area <= 0 || i33 <= 0) continue;
          const h = Math.sqrt(12 * i33 / area); // L
          const b = area / h;
          out.set(name, {
            name,
            material: str(r, 'Material'),
            shape: 'Rectangular',
            depth: h * lenToIn,
            width: b * lenToIn,
          });
        }
      } catch { /* table may not exist */ }
    }
    return [...out.values()];
  }

  async getMaterials(): Promise<EtabsMaterialInfo[]> {
    // stress→psi: (force→lbf) / (length→in)²
    const stressToPsi = (this.units.forceToKip * 1000) / Math.pow(this.units.lengthToFt * 12, 2);
    const out: EtabsMaterialInfo[] = [];
    try {
      for (const r of await this.fetchTable('Material Properties - Concrete Data')) {
        const name = str(r, 'Material', 'Name');
        const fc = num(r, 'Fc', "f'c");
        if (name && fc > 0) out.push({ name, fc: fc * stressToPsi });
      }
    } catch { /* optional */ }
    try {
      for (const r of await this.fetchTable('Material Properties - Rebar Data')) {
        const name = str(r, 'Material', 'Name');
        const fy = num(r, 'Fy');
        if (name && fy > 0) out.push({ name, fy: fy * stressToPsi });
      }
    } catch { /* optional */ }
    return out;
  }

  async getCombos(): Promise<string[]> {
    const seen = new Set<string>();
    try {
      for (const r of await this.fetchTable('Load Combination Definitions')) {
        const n = str(r, 'Name', 'ComboName');
        if (n) seen.add(n);
      }
    } catch { /* optional */ }
    if (!seen.size) {
      try {
        for (const r of await this.fetchTable('Load Case Definitions - Summary')) {
          const n = str(r, 'Name');
          if (n) seen.add(n);
        }
      } catch { /* optional */ }
    }
    return [...seen];
  }

  async getStationForces(frameNames: string[], combos: string[]): Promise<Record<string, ComboForces[]>> {
    if (!this.forcesCache) {
      this.forcesCache = await this.fetchTable('Design Forces - Beams');
      if (!this.forcesCache.length) {
        // Design tables need design combos selected; analysis output always exists
        this.forcesCache = await this.fetchTable('Element Forces - Beams');
      }
      if (!this.forcesCache.length) {
        throw new Error(
          'No beam force results — has the analysis been run? ' +
          '(Analyze → Run Analysis in ETABS)'
        );
      }
    }
    const wanted = new Set(frameNames);
    const comboSet = new Set(combos);
    const lf = this.units.lengthToFt;
    const ff = this.units.forceToKip;
    const mf = ff * lf; // moment → kip-ft

    const out: Record<string, ComboForces[]> = {};
    const byFrameCombo = new Map<string, Map<string, StationForce[]>>();

    for (const r of this.forcesCache) {
      const frame = str(r, 'UniqueName');
      if (!wanted.has(frame)) continue;
      const rawCombo = str(r, 'Combo', 'OutputCase', 'Case');
      // ETABS envelope combos get step suffixes: "Env-1" (Max) / "Env-2" (Min)
      const baseCombo = rawCombo.replace(/-\d+$/, '');
      if (!comboSet.has(rawCombo) && !comboSet.has(baseCombo)) continue;

      let frameMap = byFrameCombo.get(frame);
      if (!frameMap) { frameMap = new Map(); byFrameCombo.set(frame, frameMap); }
      let stations = frameMap.get(rawCombo);
      if (!stations) { stations = []; frameMap.set(rawCombo, stations); }
      stations.push({
        x: num(r, 'Station', 'Location', 'Dist') * lf,
        V: num(r, 'V2') * ff,
        M: num(r, 'M3') * mf,
        P: num(r, 'P') * ff,
        T: num(r, 'T') * mf,
      });
    }

    for (const [frame, frameMap] of byFrameCombo) {
      const cfs: ComboForces[] = [];
      for (const [combo, stations] of frameMap) {
        stations.sort((a, b) => a.x - b.x);
        cfs.push({ combo, stations });
      }
      out[frame] = cfs;
    }
    for (const f of frameNames) if (!out[f]) out[f] = [];
    return out;
  }
}
