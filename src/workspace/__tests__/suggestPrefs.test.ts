/**
 * ✨ Suggest must size the cage against the checks the PROJECT will be judged by.
 *
 * `suggestGroupRebar` takes the project's EC2 strut angle and its "neglect torsion"
 * setting as its 6th and 7th arguments and hands both straight to `runDesign`. Both are
 * optional, so a caller that stops at `barFamily` compiles, runs, and silently designs
 * under different rules than the app displays. `createSweep` — the one path ✨ Suggest
 * actually takes — did exactly that while calling `designMemberAllRows(…, prefs)` two
 * lines later to grade its own work.
 *
 * Under EC2 that is not a rounding difference:
 *
 *     V_Rd,s = (A_sw / s) · z · f_ywd · cot θ
 *
 * is LINEAR in cot θ, and the engine's default is 2.5 — the code maximum, §6.2.3(3).
 * A project set to the S-CONCRETE angle of 1.25 got links sized for exactly twice the
 * shear capacity the section has: Suggest reported DCR 0.84 and the member panel opened
 * the same beam at 1.69. At cot θ = 1.0 it read 2.11. Every one of those groups came
 * back green in the sweep's own note and red on the dashboard.
 *
 * ACI hid it completely — V_s = A_v·f_yt·d/s carries no strut-angle term, so the dropped
 * argument cost nothing there, and the whole US test suite passed throughout.
 */
import { describe, expect, it } from 'vitest';
import { suggestAllGroups } from '../design.js';
import { runDesign } from '../../engines';
import { zoneIndexAtX } from '../../utils/concreteDesign';
import type { LoadCase, Member, RebarLayout } from '../../types';

const MPA = 145.0377;
const SPAN = 26;                       // ft ≈ 8 m
const TARGET = 0.9;

/** Every cot θ the project settings dialog offers (§6.2.3 max down to θ = 45°). */
const COT_THETA = [2.5, 2.0, 1.5, 1.25, 1.0];

/**
 * Station rows spread across all three L/3 zones — shear high at the supports, low at
 * mid-span, which is the whole reason zoned links exist. A single mid-span row would
 * not exercise the zone the relaxation applies to.
 */
function stationRows(): LoadCase[] {
  const n = 13;
  return Array.from({ length: n }, (_, i) => {
    const x = (i / (n - 1)) * SPAN;
    const t = Math.abs(x / SPAN - 0.5) * 2;          // 1 at the ends, 0 at mid-span
    return {
      id: `s${i}`, label: `ULS @ ${x.toFixed(1)}`, x,
      Mu_pos: 200 * (1 - t * t), Mu_neg: 150 * t * t,
      Vu: 90 * t + 12, Tu: 0, Pu: 0,
    } as LoadCase;
  });
}

/** C30/37, B500, 350×700, in the app's internal imperial units. */
const beam = (over: Partial<Member> = {}): Member => ({
  id: 'B1', label: 'B1', memberType: 'beam', span: SPAN,
  material: { fc: 30 * MPA, fy: 500 * MPA, fyt: 500 * MPA, Es: 200000 * MPA, lambdaConcrete: 1.0 },
  section: { type: 'rectangular_beam', b: 350 / 25.4, h: 700 / 25.4, coverClear: 30 / 25.4, stirrupDia: -10 },
  rebar: {
    topBars: [{ numBars: 3, barSize: -20 }],
    botBars: [{ numBars: 4, barSize: -20 }],
    ties: { barSize: -10, spacing: 200 / 25.4, legs: 2 },
  },
  loads: stationRows(),
  ...over,
});

const GROUPS = [{ id: 'g1', label: 'G1', memberIds: ['B1'] }];

/**
 * Run the sweep and hand back the cage it applied.
 *
 * `design.js` is plain JS behind a `.d.ts`, so its Map comes back untyped. One cast
 * here beats one at every call site, and the cast is honest: `suggestGroupRebar`
 * returns a RebarLayout or an error, and the sweep only stores the former.
 */
function suggested(m: Member, code: 'EN1992-1-1' | 'ACI318-19', family: 'euro' | 'us',
  prefs: { cotTheta?: number; ignoreTorsion?: boolean }): RebarLayout | undefined {
  const { rebarByGroup } = suggestAllGroups(
    GROUPS as never, [m], code, family, {}, TARGET, prefs,
  ) as { rebarByGroup: Map<string, RebarLayout> };
  return rebarByGroup.get('g1');
}

/** `ties` is optional on the type; a suggested cage always has one. */
const tiesOf = (c: RebarLayout) => {
  expect(c.ties, 'a suggested cage always carries links').toBeTruthy();
  return c.ties!;
};

/** End-zone link steel rate, mm²/mm — what cot θ should move. */
function endZoneRate(c: RebarLayout): number {
  const t = tiesOf(c);
  const dMm = Math.abs(t.barSize);                      // negative size = metric Ø mm
  const sEnd = (c.tieZones?.[0]?.spacing ?? t.spacing) * 25.4;
  return t.legs * (Math.PI * dMm * dMm / 4) / sEnd;
}

/** A cage's identity, for "did this actually change?" comparisons. */
const cageKey = (c: RebarLayout) => {
  const t = tiesOf(c);
  return `${t.barSize}/${t.legs}/${(c.tieZones ?? [{ spacing: t.spacing }]).map(z => z.spacing.toFixed(3)).join(',')}`;
};

/** Worst shear DCR over every row, and the worst in each L/3 zone separately. */
function shearByZone(m: Member, rebar: Member['rebar'], cotTheta: number) {
  const zone = [0, 0, 0];
  for (const lc of m.loads) {
    const r = runDesign(m.section, m.material, rebar, lc, m.span, 'EN1992-1-1', m.crackParams, cotTheta);
    const z = zoneIndexAtX(lc.x as number, m.span as number);
    zone[z] = Math.max(zone[z], r.DCR_shear);
  }
  return { zone, worst: Math.max(...zone) };
}

describe('the Suggest sweep designs at the project strut angle', () => {
  it.each(COT_THETA)('cot θ = %s — the suggested cage passes shear in EVERY L/3 zone', (cotTheta) => {
    const m = beam();
    const cage = suggested(m, 'EN1992-1-1', 'euro', { cotTheta });
    expect(cage, 'the group should be sizeable at this angle').toBeTruthy();

    // Three zones, judged at the spacing each one is actually detailed to. Before the
    // fix cot θ = 1.25 landed at 1.69 here and 1.0 at 2.11 — both on zone 0.
    const { zone, worst } = shearByZone(m, cage!, cotTheta);
    expect(worst, `zones (end/mid/end) = ${zone.map(v => v.toFixed(2)).join(' / ')}`)
      .toBeLessThanOrEqual(TARGET + 1e-9);
  });

  it('a steeper strut buys real links, not the same cage relabelled', () => {
    // The regression in one line: the cage was IDENTICAL at every angle, because the
    // angle never reached the search.
    const cages = COT_THETA.map((cotTheta) => cageKey(suggested(beam(), 'EN1992-1-1', 'euro', { cotTheta })!));
    expect(new Set(cages).size, `cages: ${cages.join('  |  ')}`).toBeGreaterThan(1);
  });

  it('the link steel rate rises monotonically as the strut steepens', () => {
    // cot θ down ⇒ V_Rd,s down ⇒ more A_sw/s needed. Nothing here should ever get
    // LIGHTER as the design gets more conservative.
    // Judge the END zones — the ones carrying the shear the strut angle is about.
    const rates = COT_THETA.map(cotTheta =>                       // 2.5 → 1.0
      endZoneRate(suggested(beam(), 'EN1992-1-1', 'euro', { cotTheta })!));
    for (let i = 1; i < rates.length; i++) {
      expect(rates[i], `cot θ ${COT_THETA[i]} vs ${COT_THETA[i - 1]}: rates ${rates.map(r => r.toFixed(2)).join(', ')}`)
        .toBeGreaterThanOrEqual(rates[i - 1] - 1e-9);
    }
  });

  it('"neglect torsion" reaches the search too', () => {
    // Same argument list, same failure mode: a project that neglects torsion was still
    // getting links sized to carry it.
    const withTors = beam({ loads: stationRows().map(lc => ({ ...lc, Tu: 30 })) });
    const sized = (ignoreTorsion: boolean) => {
      const c = suggested(beam({ loads: withTors.loads }), 'EN1992-1-1', 'euro', { cotTheta: 2.5, ignoreTorsion });
      return c ? endZoneRate(c) : null;
    };
    const designedFor = sized(false);
    const neglected = sized(true);
    expect(designedFor).toBeTruthy();
    expect(neglected).toBeTruthy();
    expect(neglected!, 'neglecting torsion must not cost MORE link steel').toBeLessThanOrEqual(designedFor! + 1e-9);
  });

  it('ACI is unaffected — V_s has no strut-angle term', () => {
    const aci = (): Member => ({
      ...beam(),
      material: { fc: 4000, fy: 60000, fyt: 60000, Es: 29000000, lambdaConcrete: 1.0 },
      section: { type: 'rectangular_beam', b: 16, h: 28, coverClear: 1.5, stirrupDia: 4 },
      rebar: { topBars: [{ numBars: 3, barSize: 8 }], botBars: [{ numBars: 4, barSize: 8 }], ties: { barSize: 4, spacing: 8, legs: 2 } },
    });
    const cageFor = (cotTheta: number) => cageKey(suggested(aci(), 'ACI318-19', 'us', { cotTheta })!);
    expect(cageFor(2.5)).toBe(cageFor(1.0));
  });
});
