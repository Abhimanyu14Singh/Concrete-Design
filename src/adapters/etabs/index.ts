/**
 * ETABS adapter — maps ETABS beam geometry + station forces into app Members.
 *
 * Used two ways:
 *  - by the import wizard (buildMembers / autoGroup with live connection data)
 *  - as a registered ModelAdapter for raw EtabsModel JSON files
 */
import type {
  Member, Project, LoadCase, ComboForces, DesignGroup, MaterialProps, DesignCode,
} from '../../types';
import type { ModelAdapter } from '../types';
import type { EtabsBeamGeom, EtabsColumnGeom, EtabsSectionInfo, EtabsMaterialInfo } from './connection';
import { seedRebar, type SeedOptions } from './rebarSeed';

/** Envelope station forces from the selected combos into a single LoadCase. */
export function envelopeLoadCase(forces: ComboForces[], label = 'ETABS Envelope'): LoadCase {
  let maxPos = 0, maxNeg = 0, maxV = 0, maxT = 0, worstP = 0;
  for (const cf of forces) {
    for (const st of cf.stations) {
      if (st.M > maxPos) maxPos = st.M;
      if (st.M < maxNeg) maxNeg = st.M;
      const v = Math.abs(st.V);
      if (v > maxV) maxV = v;
      if (st.T !== undefined && Math.abs(st.T) > maxT) maxT = Math.abs(st.T);
      // Keep the sign: + compression / − tension matters for axial checks
      if (st.P !== undefined && Math.abs(st.P) > Math.abs(worstP)) worstP = st.P;
    }
  }
  return {
    id: 'etabs-env',
    label,
    Mu_pos: +maxPos.toFixed(2),
    Mu_neg: +Math.abs(maxNeg).toFixed(2),
    Vu: +maxV.toFixed(2),
    Tu: +maxT.toFixed(2),
    Pu: +worstP.toFixed(2),
  };
}

/**
 * Expand station forces into ONE LoadCase per station per combo, preserving the
 * simultaneous {M, V, T, P} state at each output station instead of collapsing to
 * a single worst-of-each envelope. An envelope over-designs because max moment,
 * max shear, max torsion and max axial never occur at the same station — with the
 * real station rows each check sees the forces that actually act together (this is
 * what S-CONCRETE receives: many sectional-load rows, one per station/combo).
 *
 * A station's signed moment M sets Mu_pos (sagging, M > 0) OR Mu_neg (hogging), not
 * both. Vu/Tu are magnitudes; Pu keeps its sign (+ compression). All-zero stations
 * are dropped, and exact duplicate rows collapsed, to keep the list tight. Falls
 * back to the single envelope row when no station data is available.
 */
export function stationLoadCases(forces: ComboForces[], envLabel?: string): LoadCase[] {
  const out: LoadCase[] = [];
  const seen = new Set<string>();
  for (const cf of forces) {
    const combo = cf.combo || 'LC';
    for (const st of cf.stations) {
      const M = st.M ?? 0;
      const V = Math.abs(st.V ?? 0);
      const T = st.T !== undefined ? Math.abs(st.T) : 0;
      const P = st.P ?? 0;
      if (Math.abs(M) < 1e-6 && V < 1e-6 && T < 1e-6 && Math.abs(P) < 1e-6) continue;
      const Mu_pos = M > 0 ? +M.toFixed(2) : 0;
      const Mu_neg = M < 0 ? +Math.abs(M).toFixed(2) : 0;
      const Vu = +V.toFixed(2), Tu = +T.toFixed(2), Pu = +P.toFixed(2);
      // Collapse exact-duplicate force states (same combo can repeat a value at
      // adjacent stations) so the row list stays as tight as the demand allows.
      const key = `${combo}|${Mu_pos}|${Mu_neg}|${Vu}|${Tu}|${Pu}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `${combo}@${st.x.toFixed(2)}`,
        label: `${combo} @ ${st.x.toFixed(1)} ft`,
        Mu_pos, Mu_neg, Vu, Tu, Pu,
      });
    }
  }
  // No station data (e.g. a forces-less file import) → keep the envelope row so the
  // member still has something to design against.
  return out.length ? out : [envelopeLoadCase(forces, envLabel)];
}

export { zoneShearDemands } from '../../utils/concreteDesign';

const DEFAULT_MATERIAL: MaterialProps = {
  fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0,
};

function materialFor(
  sectionName: string,
  sections: EtabsSectionInfo[],
  materials: EtabsMaterialInfo[],
): MaterialProps {
  const sec = sections.find(s => s.name === sectionName);
  const conc = sec ? materials.find(m => m.name === sec.material) : undefined;
  const rebarMat = materials.find(m => m.fy && !m.fc);
  return {
    ...DEFAULT_MATERIAL,
    fc: conc?.fc ?? DEFAULT_MATERIAL.fc,
    fy: rebarMat?.fy ?? DEFAULT_MATERIAL.fy,
    fyt: rebarMat?.fy ?? DEFAULT_MATERIAL.fyt,
  };
}

/** Build app Members from filtered ETABS beams + forces + seeded rebar. */
export function buildMembers(
  beams: EtabsBeamGeom[],
  sections: EtabsSectionInfo[],
  materials: EtabsMaterialInfo[],
  forcesByFrame: Record<string, ComboForces[]>,
  seed: SeedOptions,
  code?: DesignCode | string,
): Member[] {
  return beams.map(beam => {
    const sec = sections.find(s => s.name === beam.section);
    const sectionDims = {
      type: 'rectangular_beam' as const,
      b: sec?.width ?? 12,
      h: sec?.depth ?? 24,
      coverClear: seed.coverClear ?? 1.5,
      stirrupDia: seed.stirrupBarSize ?? 4,
    };
    const forces = forcesByFrame[beam.name] ?? [];
    return {
      id: beam.name,
      label: `${beam.name} (${beam.story} · ${beam.section})`,
      memberType: 'beam' as const,
      material: materialFor(beam.section, sections, materials),
      section: sectionDims,
      rebar: seedRebar(sectionDims, seed, code),
      loads: stationLoadCases(forces),
      span: +beam.lengthFt.toFixed(2),
      etabs: {
        frameName: beam.name,
        story: beam.story,
        groups: beam.groups,
        pt1: beam.pt1,
        pt2: beam.pt2,
        sectionName: beam.section,
      },
      stationForces: forces,
    };
  });
}

/**
 * Build app Members from ETABS columns. Columns import with their geometry,
 * section, material and a starter symmetric cage, ready to be grouped and
 * exported to S-Concrete. Design forces (Pu/Mux/Muy) start at zero — the user
 * enters them (or a future live-ETABS column-force read fills them in), so the
 * member carries a single placeholder load case whose label prompts for that.
 */
export function buildColumnMembers(
  columns: EtabsColumnGeom[],
  sections: EtabsSectionInfo[],
  materials: EtabsMaterialInfo[],
  seed: SeedOptions,
): Member[] {
  return columns.map(col => {
    const sec = sections.find(s => s.name === col.section);
    const sectionDims = {
      type: 'rectangular_column' as const,
      b: sec?.width ?? 18,
      h: sec?.depth ?? 18,
      coverClear: seed.coverClear ?? 1.5,
      stirrupDia: seed.stirrupBarSize ?? 4,
    };
    const tieBar = seed.stirrupBarSize ?? 4;
    return {
      id: col.name,
      label: `${col.name} (${col.story} · ${col.section})`,
      memberType: 'column' as const,
      material: materialFor(col.section, sections, materials),
      section: sectionDims,
      rebar: {
        topBars: [{ numBars: 3, barSize: 8 }],
        botBars: [{ numBars: 3, barSize: 8 }],
        sideBars: [{ numBars: 2, barSize: 8 }],
        ties: { barSize: tieBar, spacing: 12, legs: 2 },
        tieType: 'tied' as const,
      },
      loads: [{ id: 'LC1', label: 'ETABS (enter column forces)', Mu_pos: 0, Mu_neg: 0, Vu: 0, Tu: 0, Pu: 0, Mux: 0, Muy: 0 }],
      span: +col.heightFt.toFixed(2),
      etabs: {
        frameName: col.name,
        story: col.story,
        groups: col.groups,
        pt1: col.pt1,
        pt2: col.pt2,
        sectionName: col.section,
      },
    };
  });
}

/**
 * Auto-group imported beams: one design group per (story, section) pair,
 * or per ETABS group name for groups the user chose to mirror.
 * One rebar set per group, checked against every member in the group.
 */
export function autoGroup(members: Member[], mirrorGroups?: Set<string>): DesignGroup[] {
  const byKey = new Map<string, DesignGroup>();
  for (const m of members) {
    if (!m.etabs) continue;
    // Mirror an ETABS group name only when the user opted that group in;
    // first matching group wins. Everything else buckets by story·section.
    const etabsGroup = mirrorGroups?.size
      ? m.etabs.groups?.find(g => mirrorGroups.has(g))
      : undefined;
    const key = etabsGroup ?? `${m.etabs.story}|${m.etabs.sectionName}`;
    const label = etabsGroup ?? `${m.etabs.story} · ${m.etabs.sectionName}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        id: `dg-${byKey.size + 1}`,
        label,
        memberIds: [],
      };
      byKey.set(key, g);
    }
    g.memberIds.push(m.id);
    m.etabs.designGroupId = g.id;
  }
  return [...byKey.values()];
}

// ── ModelAdapter for raw EtabsModel JSON (file drop) ─────────────────────────

interface RawEtabsJson {
  frames?: unknown[];
  frameSections?: unknown[];
}

export class EtabsAdapter implements ModelAdapter {
  readonly name = 'ETABS';
  readonly description = 'ETABS model JSON (frames, sections, forces) or tables export';

  canImport(data: unknown): boolean {
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return false; }
    }
    const d = data as RawEtabsJson;
    return !!d && Array.isArray(d.frames) && Array.isArray(d.frameSections);
  }

  async importProject(): Promise<Project> {
    throw new Error('Use the "Import from ETABS" wizard for ETABS models.');
  }
}
