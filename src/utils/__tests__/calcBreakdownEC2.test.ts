import { describe, it, expect } from 'vitest';
import { generateBreakdownEC2 } from '../calcBreakdownEC2';
import { DEFAULT_CRACK_PARAMS } from '../../types';
import type { SectionDimensions, MaterialProps, RebarLayout, LoadCase } from '../../types';

const KIPFT_TO_KNM = 1.35582;

const section: SectionDimensions = { type: 'rectangular_beam', b: 14, h: 24, coverClear: 1.5, stirrupDia: 4 };
const material: MaterialProps = { fc: 5000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1 };
const rebar: RebarLayout = {
  topBars: [{ numBars: 3, barSize: 8 }],
  botBars: [{ numBars: 4, barSize: 8 }],
  ties: { barSize: 4, spacing: 8, legs: 2 },
};
const load: LoadCase = { id: 'lc1', label: 'Env', Mu_pos: 180, Mu_neg: 120, Vu: 55, Tu: 0, Pu: 0 };

function crackSection(sections: ReturnType<typeof generateBreakdownEC2>) {
  return sections.find(s => s.title.includes('Crack Width'));
}

describe('generateBreakdownEC2 — crack-width M_qp source', () => {
  it('ratio fallback when no SLS combo override: shows ψ·M_Ed and no combo name', () => {
    const sec = crackSection(generateBreakdownEC2(section, material, rebar, load, 20, DEFAULT_CRACK_PARAMS));
    expect(sec).toBeTruthy();
    expect(sec!.title).toBe('5. Crack Width (§7.3.4)');
    const mqpStep = sec!.steps.find(s => s.label.includes('quasi-permanent moment'));
    expect(mqpStep!.equation).toBe('M_qp = ψ·M_Ed');
    expect(mqpStep!.substitution).toContain('0.60 ×');
  });

  it('uses the resolved SLS combo moment (kip-ft → kN·m) and names the combo', () => {
    // Mqp_pos override = 130 kip-ft (≠ 0.6 × 180 = 108) so we can prove it is used.
    const crack = { ...DEFAULT_CRACK_PARAMS, Mqp_pos: 130, Mqp_neg: 95 };
    const sections = generateBreakdownEC2(section, material, rebar, load, 20, crack, 'SLS-QP');
    const sec = crackSection(sections);
    expect(sec!.title).toBe('5. Crack Width (§7.3.4) — SLS combo "SLS-QP"');

    const botStep = sec!.steps.find(s => s.label.startsWith('Bottom face (+M): quasi-permanent moment'));
    expect(botStep!.equation).toBe('M_qp = M_Ed (SLS combo)');
    expect(botStep!.substitution).toContain('SLS-QP');
    // result is 130 kip-ft → kN·m, formatted to 1 dp
    expect(botStep!.result).toContain((130 * KIPFT_TO_KNM).toFixed(1));
  });
});
