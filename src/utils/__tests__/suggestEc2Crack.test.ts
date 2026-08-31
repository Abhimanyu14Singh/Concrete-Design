/**
 * Suggest under Eurocode 2, and the SLS check it used to ignore.
 *
 * Every other check the auto-designer inverts is ULS: they get EASIER with more steel,
 * so "the lightest cage that passes" is a safe objective. EC2 §7.3.4 crack width runs
 * the OTHER WAY — trimming the cage raises σs and widens the crack — so a search that
 * only sees flexure and shear will happily hand back a cage that cracks too wide.
 *
 * It did. On a C30/37 300×600 with a 0.25 mm limit, an 8-Ø20 bottom cage sitting at
 * w/w_lim = 0.21 came back as 4-Ø16 at 1.08 — Suggest turning a PASSING beam into a
 * failing one, and the group card reading red immediately after running the tool meant
 * to fix it. At tighter exposure classes it reached 1.81.
 */
import { describe, it, expect } from 'vitest';
import { suggestGroupRebar, suggestSizeCandidates, isSuggestError } from '../suggestRebar';
import { runDesign } from '../../engines';
import { resolveCrack } from '../resolveCrack';
import type { Member } from '../../types';

/** C30/37, B500, 300×600, in the app's internal imperial units. */
const ec2Beam = (over: Partial<Member> = {}): Member => ({
  id: 'B1', label: 'B1', memberType: 'beam', span: 26,
  material: { fc: 30 * 145.0377, fy: 500 * 145.0377, fyt: 500 * 145.0377, Es: 200000 * 145.0377, lambdaConcrete: 1.0 },
  section: { type: 'rectangular_beam', b: 300 / 25.4, h: 600 / 25.4, coverClear: 30 / 25.4, stirrupDia: -10 },
  rebar: {
    topBars: [{ numBars: 3, barSize: -20 }],
    botBars: [{ numBars: 8, barSize: -20 }],
    ties: { barSize: -10, spacing: 200 / 25.4, legs: 2 },
  },
  loads: [{ id: 'lc1', label: 'ULS', Mu_pos: 120, Mu_neg: 60, Vu: 40, Tu: 0, Pu: 0 }],
  ...over,
});

const withLimit = (w: number) => ec2Beam({
  crackParams: { wLimitTop: w, wLimitBot: w, wLimitFace: w, qpFactor: 0.7, kt: 0.4 } as Member['crackParams'],
});

const design = (m: Member, rebar = m.rebar) =>
  runDesign(m.section, m.material, rebar, m.loads[0], m.span, 'EN1992-1-1', m.crackParams);

describe('the Suggest dialog offers the right catalogue', () => {
  it('EC2 / euro family → metric bars, ACI / us → US bars', () => {
    expect(suggestSizeCandidates('EN1992-1-1', 'euro').long.every(s => s < 0)).toBe(true);
    expect(suggestSizeCandidates('ACI318-19', 'us').long.every(s => s > 0)).toBe(true);
  });

  it('the catalogue follows the BAR FAMILY, not the code — a metric-detailed ACI job', () => {
    expect(suggestSizeCandidates('ACI318-19', 'euro').long.every(s => s < 0)).toBe(true);
  });
});

describe('a suggested EC2 cage satisfies §7.3.4', () => {
  // 0.25 / 0.20 / 0.15 mm all produced a FAILING cage before the fix.
  for (const wLimit of [0.30, 0.25, 0.20, 0.15]) {
    it(`w_max = ${wLimit.toFixed(2)} mm — the suggested cage does not crack too wide`, () => {
      const m = withLimit(wLimit);
      expect(design(m).DCR_crack ?? 0).toBeLessThanOrEqual(1);   // it PASSED to begin with

      const r = suggestGroupRebar([m], 'EN1992-1-1', 0.9, undefined, 'euro');
      expect(isSuggestError(r)).toBe(false);
      if (isSuggestError(r)) return;

      const after = design(m, r.rebar);
      expect(after.DCR_crack ?? 0).toBeLessThanOrEqual(1);
      expect(after.status).not.toBe('NG');
      // …and it is still a real design: flexure at or under the target.
      expect(after.DCR_flex_pos).toBeLessThanOrEqual(0.9 + 1e-6);
    });
  }

  it('reports the crack utilisation it settled on', () => {
    const r = suggestGroupRebar([withLimit(0.20)], 'EN1992-1-1', 0.9, undefined, 'euro');
    if (isSuggestError(r)) throw new Error(r.error);
    expect(r.worstDCRCrack).toBeDefined();
    expect(r.worstDCRCrack!).toBeLessThanOrEqual(1);
  });

  it('a tighter exposure buys crack control with MORE, SMALLER bars', () => {
    const loose = suggestGroupRebar([withLimit(0.30)], 'EN1992-1-1', 0.9, undefined, 'euro');
    const tight = suggestGroupRebar([withLimit(0.15)], 'EN1992-1-1', 0.9, undefined, 'euro');
    if (isSuggestError(loose) || isSuggestError(tight)) throw new Error('suggest failed');
    const bars = (r: typeof loose) => r.rebar.botBars.reduce((n, b) => n + b.numBars, 0);
    const dia = (r: typeof loose) => Math.abs(r.rebar.botBars[0].barSize);
    // Either more bars or smaller ones — the two levers on sr,max and σs.
    expect(bars(tight) > bars(loose) || dia(tight) < dia(loose)).toBe(true);
  });
});

describe('ACI is unaffected — it has no such check', () => {
  it('still returns a cage, and the crack figure is omitted', () => {
    const m = ec2Beam({
      material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 },
      section: { type: 'rectangular_beam', b: 16, h: 24, coverClear: 1.5, stirrupDia: 4 },
      rebar: { topBars: [{ numBars: 2, barSize: 8 }], botBars: [{ numBars: 4, barSize: 8 }], ties: { barSize: 4, spacing: 8, legs: 2 } },
      loads: [{ id: 'lc1', label: 'ULS', Mu_pos: 150, Mu_neg: 90, Vu: 45, Tu: 0, Pu: 0 }],
    });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9, undefined, 'us');
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.worstDCRCrack).toBeUndefined();
    expect(r.rebar.botBars[0].barSize).toBeGreaterThan(0);   // US bars
  });
});

/**
 * The SLS combo gap.
 *
 * The EC2 crack check needs a QUASI-PERMANENT moment. When the project names an SLS
 * combo, `resolveCrack` takes Mqp from that combo's station-force envelope; with no
 * combo the engine falls back to `qpFactor × Mu`. The suggester used to read
 * `member.crackParams` raw, so it never saw the combo — it sized cages against the
 * fallback while the member panel beside it judged them on the real Mqp. Same beam,
 * two different SLS demands, and the disagreement only showed once a cage was applied.
 */
describe('the suggester honours the project SLS combo', () => {
  /** A beam whose real quasi-permanent moment is far BELOW `qpFactor × Mu`. */
  const withCombo = (): Member => {
    const m = withLimit(0.20);
    const stations = [0, 6.5, 13, 19.5, 26].map(x => ({ x, M: 40, V: 20, T: 0 }));
    return { ...m, stationForces: [{ combo: 'SLS-QP', stations }] as Member['stationForces'] };
  };

  it('the combo actually changes the crack demand the engine sees', () => {
    const m = withCombo();
    const fallback = runDesign(m.section, m.material, m.rebar, m.loads[0], m.span, 'EN1992-1-1',
      resolveCrack(m, 'EN1992-1-1', undefined));
    const viaCombo = runDesign(m.section, m.material, m.rebar, m.loads[0], m.span, 'EN1992-1-1',
      resolveCrack(m, 'EN1992-1-1', 'SLS-QP'));
    // Mqp = 40 kip-ft from the combo vs qpFactor(0.7) × 120 = 84 — a real difference.
    expect(viaCombo.DCR_crack).toBeLessThan(fallback.DCR_crack ?? 0);
  });

  it('Suggest sizes against the COMBO, not the fallback', () => {
    const m = withCombo();
    const withoutCombo = suggestGroupRebar([m], 'EN1992-1-1', 0.9, undefined, 'euro');
    const withComboR = suggestGroupRebar([m], 'EN1992-1-1', 0.9, undefined, 'euro', undefined, undefined, 'SLS-QP');
    if (isSuggestError(withoutCombo) || isSuggestError(withComboR)) throw new Error('suggest failed');

    // The combo's Mqp is lighter, so the crack constraint binds less and the cage the
    // search settles on is no heavier than the fallback's.
    const steel = (r: typeof withComboR) =>
      r.rebar.botBars.reduce((n, b) => n + b.numBars * Math.abs(b.barSize) ** 2, 0);
    expect(steel(withComboR)).toBeLessThanOrEqual(steel(withoutCombo));
    expect(withComboR.worstDCRCrack).toBeDefined();
  });

  it('the cage it returns is judged PASSING by the same rule the panel uses', () => {
    const m = withCombo();
    const r = suggestGroupRebar([m], 'EN1992-1-1', 0.9, undefined, 'euro', undefined, undefined, 'SLS-QP');
    if (isSuggestError(r)) throw new Error(r.error);
    // Re-designed exactly as MemberResults does it — through resolveCrack with the combo.
    const after = runDesign(m.section, m.material, r.rebar, m.loads[0], m.span, 'EN1992-1-1',
      resolveCrack(m, 'EN1992-1-1', 'SLS-QP'));
    expect(after.DCR_crack ?? 0).toBeLessThanOrEqual(1);
    expect(after.status).not.toBe('NG');
  });

  it('no combo, or one the member does not carry, falls back safely', () => {
    const m = withCombo();
    const missing = suggestGroupRebar([m], 'EN1992-1-1', 0.9, undefined, 'euro', undefined, undefined, 'NOT-A-COMBO');
    const none = suggestGroupRebar([m], 'EN1992-1-1', 0.9, undefined, 'euro');
    if (isSuggestError(missing) || isSuggestError(none)) throw new Error('suggest failed');
    expect(missing.rebar.botBars).toEqual(none.rebar.botBars);
  });
});
