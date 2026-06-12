/**
 * BridgeConnection — HTTP client for the local Python ETABS bridge server
 * (tools/etabs_bridge.py, default http://127.0.0.1:8744).
 *
 * The bridge attaches to a running ETABS via the .NET API (pythonnet +
 * ETABSv1.dll) and serves model tables as JSON. This path needs no COM
 * registration and no native modules, so it works from the browser build
 * as well as the desktop app.
 *
 * Endpoints consumed:
 *   POST /connect                 attach to running ETABS
 *   GET  /status                  {connected, model, error}
 *   GET  /beams                   beam connectivity + sections (b,h in mm)
 *   GET  /joint-coords            Point Object Connectivity (model units)
 *   GET  /cases                   load cases + combos
 *   GET  /beam-forces             "Design Forces - Beams" rows
 *   GET  /table?key=...           any ETABS table (units, materials)
 */
import type { ComboForces, StationForce } from '../../types';
import type {
  EtabsConnection, EtabsConnectInfo, EtabsSectionInfo, EtabsMaterialInfo,
  EtabsBeamGeom, BeamFilter,
} from './connection';
import { matchesFilter } from './connection';

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8744';

interface BridgeBeam {
  uniqueName: string; story: string; beamBay: string;
  ptI: string; ptJ: string; length: string | number;
  section: string; b: number; h: number; material: string;
}

interface UnitFactors {
  lengthToFt: number;   // model length unit → ft
  forceToKip: number;   // model force unit → kip
  label: string;        // e.g. "kip-ft", "kN-m"
}

const LENGTH_TO_FT: Record<string, number> = {
  in: 1 / 12, ft: 1, mm: 1 / 304.8, cm: 1 / 30.48, m: 3.280839895,
};
const FORCE_TO_KIP: Record<string, number> = {
  lb: 0.001, kip: 1, n: 0.0002248089, kn: 0.2248089, kgf: 0.0022046, tonf: 2.2046,
};

/** Parse ETABS "Program Control" CurrUnits, e.g. "Kip, in, F" / "kN, m, C". */
function parseUnits(currUnits: string): UnitFactors | null {
  const parts = currUnits.split(',').map(p => p.trim().toLowerCase());
  if (parts.length < 2) return null;
  const f = FORCE_TO_KIP[parts[0]];
  const l = LENGTH_TO_FT[parts[1]];
  if (f === undefined || l === undefined) return null;
  return { forceToKip: f, lengthToFt: l, label: `${parts[0]}-${parts[1]}` };
}

const DEFAULT_UNITS: UnitFactors = { forceToKip: 1, lengthToFt: 1, label: 'kip-ft (assumed)' };

export class BridgeConnection implements EtabsConnection {
  readonly kind = 'bridge' as const;
  private base: string;
  private units: UnitFactors = DEFAULT_UNITS;
  private beamsCache: EtabsBeamGeom[] | null = null;
  private bridgeBeamsCache: BridgeBeam[] | null = null;
  private storiesCache: string[] = [];
  private forcesCache: Record<string, unknown>[] | null = null;

  constructor(baseUrl: string = DEFAULT_BRIDGE_URL) {
    this.base = baseUrl.replace(/\/$/, '');
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path);
    } catch {
      throw new Error(
        `Could not reach the ETABS bridge at ${this.base}. ` +
        'Start it first: open your model in ETABS, run the analysis, then run ' +
        '"py -3.11 tools/etabs_bridge.py" (requires: py -3.11 -m pip install pythonnet).'
      );
    }
    if (!res.ok) {
      let detail = `${res.status}`;
      try { detail = JSON.stringify(await res.json()); } catch { /* keep status */ }
      throw new Error(`Bridge request ${path} failed: ${detail}`);
    }
    return res.json() as Promise<T>;
  }

  private async getTable(key: string): Promise<Record<string, unknown>[]> {
    const r = await this.get<{ rows?: Record<string, unknown>[] }>(`/table?key=${encodeURIComponent(key)}`);
    return r.rows ?? [];
  }

  async connect(): Promise<EtabsConnectInfo> {
    let res: Response;
    try {
      res = await fetch(this.base + '/connect', { method: 'POST' });
    } catch {
      throw new Error(
        `Could not reach the ETABS bridge at ${this.base}. ` +
        'Start it first: open your model in ETABS, run the analysis, then run ' +
        '"py -3.11 tools/etabs_bridge.py" (requires: py -3.11 -m pip install pythonnet).'
      );
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      throw new Error(
        `Bridge could not attach to ETABS: ${body.message ?? body.error ?? res.status}. ` +
        'Make sure ETABS is open with your model loaded.'
      );
    }

    // Detect the model's display units from the Program Control table
    try {
      const pc = await this.getTable('Program Control');
      const cu = String(pc[0]?.CurrUnits ?? pc[0]?.['Curr Units'] ?? '');
      const parsed = cu ? parseUnits(cu) : null;
      if (parsed) this.units = parsed;
    } catch { /* keep defaults */ }

    return { modelName: String(body.message ?? 'ETABS model'), units: this.units.label };
  }

  async getStories(): Promise<string[]> {
    await this.loadBeams();
    return this.storiesCache;
  }

  async getGroups(): Promise<string[]> {
    return []; // not exposed by the bridge
  }

  private async loadBeams(): Promise<void> {
    if (this.beamsCache) return;
    const [beamsRes, jointsRes] = await Promise.all([
      this.get<{ beams: BridgeBeam[]; stories: string[] }>('/beams'),
      this.get<{ data: Record<string, unknown>[] }>('/joint-coords'),
    ]);
    this.bridgeBeamsCache = beamsRes.beams;
    this.storiesCache = beamsRes.stories ?? [];

    const lf = this.units.lengthToFt;
    const coords = new Map<string, { x: number; y: number; z: number }>();
    for (const j of jointsRes.data ?? []) {
      const name = String(j.UniqueName ?? j.UniquePtName ?? '');
      if (!name) continue;
      coords.set(name, {
        x: Number(j.X ?? 0) * lf,
        y: Number(j.Y ?? 0) * lf,
        z: Number(j.Z ?? 0) * lf,
      });
    }

    this.beamsCache = beamsRes.beams.map(b => {
      const pt1 = coords.get(String(b.ptI)) ?? { x: 0, y: 0, z: 0 };
      const pt2 = coords.get(String(b.ptJ)) ?? { x: 0, y: 0, z: 0 };
      const lengthFt = Number(b.length) > 0
        ? Number(b.length) * lf
        : Math.hypot(pt2.x - pt1.x, pt2.y - pt1.y, pt2.z - pt1.z);
      return {
        name: String(b.uniqueName),
        story: String(b.story ?? ''),
        section: String(b.section ?? ''),
        pt1, pt2,
        groups: [],
        lengthFt,
      };
    });
  }

  async getBeams(filter: BeamFilter): Promise<EtabsBeamGeom[]> {
    await this.loadBeams();
    return this.beamsCache!.filter(b => matchesFilter(b, filter));
  }

  async getFrameSections(): Promise<EtabsSectionInfo[]> {
    await this.loadBeams();
    // The bridge derives b,h in mm regardless of model units
    const out = new Map<string, EtabsSectionInfo>();
    for (const b of this.bridgeBeamsCache ?? []) {
      if (!b.section || out.has(b.section)) continue;
      out.set(b.section, {
        name: b.section,
        material: String(b.material ?? ''),
        shape: 'Rectangular',
        depth: Number(b.h ?? 0) / 25.4, // mm → in
        width: Number(b.b ?? 0) / 25.4,
      });
    }
    return [...out.values()];
  }

  async getMaterials(): Promise<EtabsMaterialInfo[]> {
    // stress→psi: (force→lbf) / (length→in)²
    const stressToPsi = (this.units.forceToKip * 1000) / Math.pow(this.units.lengthToFt * 12, 2);
    const out: EtabsMaterialInfo[] = [];
    try {
      for (const r of await this.getTable('Material Properties - Concrete Data')) {
        const name = String(r.Material ?? r.Name ?? '');
        const fc = Number(r.Fc ?? r["f'c"] ?? 0);
        if (name && fc > 0) out.push({ name, fc: fc * stressToPsi });
      }
    } catch { /* table may not exist */ }
    try {
      for (const r of await this.getTable('Material Properties - Rebar Data')) {
        const name = String(r.Material ?? r.Name ?? '');
        const fy = Number(r.Fy ?? 0);
        if (name && fy > 0) out.push({ name, fy: fy * stressToPsi });
      }
    } catch { /* table may not exist */ }
    return out;
  }

  async getCombos(): Promise<string[]> {
    const r = await this.get<{ cases: { name: string; type: string }[] }>('/cases');
    return (r.cases ?? []).map(c => c.name);
  }

  async getStationForces(frameNames: string[], combos: string[]): Promise<Record<string, ComboForces[]>> {
    if (!this.forcesCache) {
      const r = await this.get<{ data: Record<string, unknown>[] }>('/beam-forces');
      this.forcesCache = r.data ?? [];
    }
    const wanted = new Set(frameNames);
    const comboSet = new Set(combos);
    const lf = this.units.lengthToFt;
    const ff = this.units.forceToKip;
    const mf = ff * lf; // moment → kip-ft

    const num = (r: Record<string, unknown>, k: string) => {
      const v = r[k];
      const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
      return Number.isFinite(n) ? n : 0;
    };

    const out: Record<string, ComboForces[]> = {};
    const byFrameCombo = new Map<string, Map<string, StationForce[]>>();

    for (const r of this.forcesCache) {
      const frame = String(r.UniqueName ?? '');
      if (!wanted.has(frame)) continue;
      const rawCombo = String(r.Combo ?? r.OutputCase ?? '');
      // ETABS envelope combos get step suffixes: "Env-1" (Max) / "Env-2" (Min)
      const baseCombo = rawCombo.replace(/-\d+$/, '');
      if (!comboSet.has(rawCombo) && !comboSet.has(baseCombo)) continue;

      let frameMap = byFrameCombo.get(frame);
      if (!frameMap) { frameMap = new Map(); byFrameCombo.set(frame, frameMap); }
      let stations = frameMap.get(rawCombo);
      if (!stations) { stations = []; frameMap.set(rawCombo, stations); }
      stations.push({
        x: num(r, 'Station') * lf,
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
    // Frames with no matching rows still get an entry
    for (const f of frameNames) if (!out[f]) out[f] = [];
    return out;
  }
}
