/**
 * S-Concrete batch orchestration: turn a design group's beam members into .SCO
 * files (with their factored forces) and parse the .SCRS batch report back into
 * per-member results. Ties scoWriter + scrsParser into the generate → run → pull
 * workflow merged from Column_Design_DW.
 *
 * The actual batch RUN (spawning S-Concrete's BatchReporter and reading the
 * .SCRS) happens in the Electron main process — see electron/sconcreteBridge.cjs.
 * This module is the pure, testable orchestration logic.
 *
 * Beam .SCO load-component convention (to confirm against a real S-Concrete beam
 * file): Mfy (M3) = governing factored moment, Vfy (V3) = Vu, Tf = Tu, Nf = Pu.
 */
import { buildBeamScoText, designCodeToScoHeader, type ScoLoadCase } from './scoWriter';
import { parseScrs, type ScrsResult } from './scrsParser';
import type { BeamMember } from '../../types/beam';
import type { DesignCode } from '../../types/common';

export interface ScoFile {
  fileName: string;
  text: string;
  memberId: string;
}

const barName = (n: number): string => `#${n}`;
const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, '_');

/** Map a beam member's load cases onto S-Concrete Sectional Loads rows. */
function beamLoadCases(m: BeamMember): ScoLoadCase[] {
  return m.loads.map((lc, i) => ({
    name: lc.label || `LC${i + 1}`,
    P: lc.Pu ?? 0,
    M3: Math.max(Math.abs(lc.Mu_pos ?? 0), Math.abs(lc.Mu_neg ?? 0)),
    V3: lc.Vu ?? 0,
    T: lc.Tu ?? 0,
    M2: 0,
    V2: 0,
  }));
}

/**
 * Build one .SCO per beam member. Throws when the selected design code has no
 * confirmed S-Concrete header mapping (e.g. EC2) so a wrong-code file is never
 * emitted — surface this to the user as "configure the code first".
 */
export function buildGroupScoFiles(members: BeamMember[], code: DesignCode): ScoFile[] {
  const hdr = designCodeToScoHeader(code);
  if (!hdr) {
    throw new Error(
      `No confirmed S-Concrete .SCO mapping for design code "${code}". ` +
      `Configure the S-Concrete code header (Codes/Units/Bar Type) for this code before exporting.`,
    );
  }
  return members.map((m) => {
    const topBar = m.rebar.topBars[0] ? barName(m.rebar.topBars[0].barSize) : '#8';
    const stirrupBar = m.rebar.ties ? barName(m.rebar.ties.barSize) : barName(m.section.stirrupDia);
    const text = buildBeamScoText({
      memberName: m.label,
      bIn: m.section.bw ?? m.section.b,
      hIn: m.section.h,
      fcKsi: m.material.fc / 1000,
      fyKsi: m.material.fy / 1000,
      coverIn: m.section.coverClear,
      stirrupBar,
      stirrupSpacingIn: m.rebar.ties?.spacing ?? 12,
      topBar,
      loadCases: beamLoadCases(m),
      codeNumber: hdr.codeNumber,
      units: hdr.units,
      barType: hdr.barType,
    });
    return { fileName: `${sanitize(m.label)}.SCO`, text, memberId: m.id };
  });
}

/** Parse an S-Concrete .SCRS batch report and key the results by member name. */
export function parseBatchResults(scrsText: string): Record<string, ScrsResult> {
  const out: Record<string, ScrsResult> = {};
  for (const r of parseScrs(scrsText)) out[r.name] = r;
  return out;
}
