/**
 * ETABS adapter — maps ETABS beam geometry + station forces into app Members.
 *
 * Used two ways:
 *  - by the import wizard (buildMembers / autoGroup with live connection data)
 *  - as a registered ModelAdapter for raw EtabsModel JSON files
 */
import type {
  Member, Project, LoadCase, ComboForces, DesignGroup, MaterialProps,
} from '../../types';
import type { ModelAdapter } from '../types';
import type { EtabsBeamGeom, EtabsSectionInfo, EtabsMaterialInfo } from './connection';
import { seedRebar, type SeedOptions } from './rebarSeed';

/** Envelope station forces from the selected combos into a single LoadCase. */
export function envelopeLoadCase(forces: ComboForces[], label = 'ETABS Envelope'): LoadCase {
  let maxPos = 0, maxNeg = 0, maxV = 0;
  for (const cf of forces) {
    for (const st of cf.stations) {
      if (st.M > maxPos) maxPos = st.M;
      if (st.M < maxNeg) maxNeg = st.M;
      const v = Math.abs(st.V);
      if (v > maxV) maxV = v;
    }
  }
  return {
    id: 'etabs-env',
    label,
    Mu_pos: +maxPos.toFixed(2),
    Mu_neg: +Math.abs(maxNeg).toFixed(2),
    Vu: +maxV.toFixed(2),
    Tu: 0,
    Pu: 0,
  };
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
): Member[] {
  return beams.map(beam => {
    const sec = sections.find(s => s.name === beam.section);
    const sectionDims = {
      type: 'rectangular_beam' as const,
      b: sec?.width ?? 12,
      h: sec?.depth ?? 24,
      coverClear: 1.5,
      stirrupDia: seed.stirrupBarSize ?? 4,
    };
    const forces = forcesByFrame[beam.name] ?? [];
    return {
      id: beam.name,
      label: `${beam.name} (${beam.story} · ${beam.section})`,
      memberType: 'beam' as const,
      material: materialFor(beam.section, sections, materials),
      section: sectionDims,
      rebar: seedRebar(sectionDims, seed),
      loads: [envelopeLoadCase(forces)],
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
 * Auto-group imported beams: one design group per (story, section) pair.
 * One rebar set per group, checked against every member in the group.
 */
export function autoGroup(members: Member[]): DesignGroup[] {
  const byKey = new Map<string, DesignGroup>();
  for (const m of members) {
    if (!m.etabs) continue;
    const key = `${m.etabs.story}|${m.etabs.sectionName}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        id: `dg-${byKey.size + 1}`,
        label: `${m.etabs.story} · ${m.etabs.sectionName}`,
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
