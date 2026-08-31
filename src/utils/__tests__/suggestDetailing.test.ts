/**
 * Suggest must not propose a cage its own engine rejects.
 *
 * Reported from the Group Dashboard: the suggested reinforcement came back carrying bar
 * spacing warnings. A sweep of 180 section/load combinations found 87 suggestions with a
 * leftover violation. Three causes, all fixed and pinned here.
 *
 *   1. §25.2.1 (25 of 180) — `maxBarsPerLayer` measured the usable web from
 *      `section.coverClear`, the single legacy cover, while the engine measures it from
 *      `coverFor(section, 'side')`. On a project whose side cover differs, the suggester
 *      packed a layer the engine then rejected: a 12" web at 2.5" side cover was offered
 *      5 bars where 3 fit, and the cage came back at 0.56" clear against a 1.00" limit.
 *
 *   2. §25.2.2 (8 of 180) — the check itself has since been REMOVED: it wanted
 *      max(1", db) between layers, which is §25.2.1's horizontal rule applied
 *      vertically, where the clause asks only for a flat inch. Suggest details stacked
 *      cages at 1" and the sweep below confirms nothing raises it.
 *
 *   3. §9.3.3 (2 of 180 SILENT) — the ρmax cap was read once off each member's
 *      PRE-EXISTING cage. The limit is written on d, and d depends on the layout being
 *      chosen, so a cage that stacked another layer sat under a limit computed for a
 *      shallower one and came back over-reinforced without the flag that says so.
 *
 * What the search cannot fix — a section at its shear-crushing limit, a ρmax relaxation
 * taken deliberately — now leaves through `residualWarnings` instead of silently.
 */
import { describe, expect, it } from 'vitest';
import { suggestGroupRebar, isSuggestError, maxBarsPerLayer } from '../suggestRebar';
import { runDesign } from '../../engines';
import { coverFor, getBarDiam } from '../concreteDesign';
import type { Member, SectionDimensions } from '../../types';

const MAT = { fc: 4000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1.0 };

function beam(sec: SectionDimensions, o: { Mp?: number; Mn?: number; V?: number; T?: number } = {}): Member {
  return {
    id: 'M', label: 'M', memberType: 'beam', span: 24, material: MAT, section: sec,
    rebar: {
      topBars: [{ numBars: 2, barSize: 5 }], botBars: [{ numBars: 2, barSize: 5 }],
      ties: { barSize: 4, spacing: 12, legs: 2 },
    },
    loads: [{
      id: 'a', label: 'ULS', x: 12,
      Mu_pos: o.Mp ?? 0, Mu_neg: o.Mn ?? 0, Vu: o.V ?? 0, Tu: o.T ?? 0, Pu: 0,
    }],
  } as unknown as Member;
}

/** Every clause the engine raises on `cage`, across every row of every member. */
function clausesOn(members: Member[], cage: Member['rebar']): Set<string> {
  const out = new Set<string>();
  for (const m of members) {
    for (const lc of m.loads) {
      const r = runDesign(m.section, m.material, cage, lc, m.span, 'ACI318-19', undefined, undefined, false);
      for (const w of r.warnings) out.add(w.code);
    }
  }
  return out;
}

describe('the bar fit is measured the way the engine measures it', () => {
  it('maxBarsPerLayer follows the SIDE cover, not coverClear', () => {
    const legacy: SectionDimensions = { type: 'rectangular_beam', b: 12, h: 24, coverClear: 1.5, stirrupDia: 4 };
    const wide: SectionDimensions = { ...legacy, coverTop: 1.5, coverBottom: 1.5, coverSide: 2.5 };
    expect(coverFor(wide, 'side')).toBe(2.5);
    // 2 in of extra cover has to cost bars. It used to cost none.
    expect(maxBarsPerLayer(beam(wide), 6)).toBeLessThan(maxBarsPerLayer(beam(legacy), 6));
  });

  it('is the exact inverse of §25.2.1, so a full layer is never flagged', () => {
    for (const b of [12, 14, 16, 18, 24, 30]) {
      for (const coverSide of [1.5, 2.0, 2.5]) {
        for (const size of [5, 6, 7, 8, 9, 10, 11]) {
          const sec: SectionDimensions = {
            type: 'rectangular_beam', b, h: 30, coverClear: 1.5, stirrupDia: 4,
            coverTop: 1.5, coverBottom: 1.5, coverSide,
          };
          const n = maxBarsPerLayer(beam(sec), size);
          if (n < 2) continue;
          // Fill the layer exactly and confirm the engine is content.
          const cage = {
            topBars: [{ numBars: 2, barSize: 5 }], botBars: [{ numBars: n, barSize: size }],
            ties: { barSize: 4, spacing: 6, legs: 2 },
          };
          const clauses = clausesOn([beam(sec, { Mp: 100 })], cage as Member['rebar']);
          expect(clauses.has('ACI §25.2.1'), `b=${b} cs=${coverSide} #${size} n=${n}`).toBe(false);
          // …and one more bar would NOT fit, or the cap is simply loose.
          const over = { ...cage, botBars: [{ numBars: n + 1, barSize: size }] };
          const db = getBarDiam(size);
          const usable = b - 2 * (coverSide + 0.5);
          const clearAtNPlus1 = (usable - (n + 1) * db) / n;
          if (clearAtNPlus1 < Math.max(1, db) - 1e-9) {
            expect(clausesOn([beam(sec, { Mp: 100 })], over as Member['rebar']).has('ACI §25.2.1'),
              `b=${b} cs=${coverSide} #${size} n+1`).toBe(true);
          }
        }
      }
    }
  });
});

describe('a suggested cage is detailed, not just sized', () => {
  it('details stacked cages at a flat 1" gap, and is not flagged for it', () => {
    // An 18×60 at 4500 kip-ft needs three stacked layers of #10 (db = 1.27").
    //
    // This briefly detailed them at max(1", db) = 1.27" to satisfy a §25.2.2 warning that
    // demanded it. The warning is gone — it applied §25.2.1's horizontal rule vertically,
    // where the clause asks for a flat inch — and with it the reason to spend effective
    // depth on the gap. Back to 1", which is the engine's default, the clause's actual
    // minimum, and what S-CONCRETE reports as dz (min).
    const m = beam({ type: 'rectangular_beam', b: 18, h: 60, coverClear: 1.5, stirrupDia: 4 }, { Mp: 4500, V: 50 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    const stacked = r.rebar.botBars.length > 1 || r.rebar.topBars.length > 1;
    expect(stacked).toBe(true);
    expect(r.rebar.layerClearSpacing).toBe(1.0);
    expect(clausesOn([m], r.rebar).has('ACI §25.2.2')).toBe(false);
  });

  it('leaves no bar-spacing clause standing across a 180-case sweep', () => {
    const offenders: string[] = [];
    let suggested = 0;
    for (const b of [12, 14, 16, 18, 24, 30]) {
      for (const h of [20, 24, 30, 36, 44]) {
        for (const coverSide of [undefined, 2.5]) {
          for (const [Mp, Mn, V, T] of [[200, 140, 60, 4], [500, 350, 120, 10], [900, 700, 200, 18]] as const) {
            const sec: SectionDimensions = {
              type: 'rectangular_beam', b, h, coverClear: 1.5, stirrupDia: 4,
              ...(coverSide ? { coverTop: 1.5, coverBottom: 1.5, coverSide } : {}),
            };
            const m = beam(sec, { Mp, Mn, V, T });
            const r = suggestGroupRebar([m], 'ACI318-19', 0.9, undefined, 'us', undefined, false);
            if (isSuggestError(r)) continue;
            suggested++;
            const clauses = clausesOn([m], r.rebar);
            for (const c of ['ACI §25.2.1', 'ACI §25.2.2', 'GEOM']) {
              if (clauses.has(c)) offenders.push(`${b}x${h} cs=${coverSide ?? 1.5} M=${Mp}: ${c}`);
            }
          }
        }
      }
    }
    expect(suggested).toBeGreaterThan(100);   // the sweep must actually produce cages
    expect(offenders).toEqual([]);
  });

  it('reports whatever it could not resolve instead of shipping it silently', () => {
    // 18×60 at 4500 kip-ft carries the moment but is past ρmax — the deliberate
    // last-resort path. It must say so on BOTH channels.
    const m = beam({ type: 'rectangular_beam', b: 18, h: 60, coverClear: 1.5, stirrupDia: 4 }, { Mp: 4500, V: 50 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(r.overReinforced).toBe(true);
    expect(r.residualWarnings?.map(w => w.code)).toContain('ACI §9.3.3');
    // Everything the engine says about the applied cage is in the list, deduplicated.
    const engine = clausesOn([m], r.rebar);
    expect(new Set(r.residualWarnings?.map(w => w.code))).toEqual(engine);
  });

  it('says nothing when there is nothing to say', () => {
    const m = beam({ type: 'rectangular_beam', b: 16, h: 28, coverClear: 1.5, stirrupDia: 4 }, { Mp: 200, Mn: 140, V: 60, T: 4 });
    const r = suggestGroupRebar([m], 'ACI318-19', 0.9, undefined, 'us', undefined, false);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    expect(clausesOn([m], r.rebar).size).toBe(0);
    expect(r.residualWarnings).toBeUndefined();
    expect(r.overReinforced).toBeUndefined();
  });
});

describe('the DCR target is met on every member of the group', () => {
  it('a mixed-width group is sized for the narrowest web and the worst demand', () => {
    const wide = beam({ type: 'rectangular_beam', b: 20, h: 30, coverClear: 1.5, stirrupDia: 4 }, { Mp: 420, Mn: 300, V: 90, T: 6 });
    const narrow = { ...beam({ type: 'rectangular_beam', b: 13, h: 30, coverClear: 1.5, stirrupDia: 4 }, { Mp: 380, Mn: 260, V: 80, T: 5 }), id: 'N', label: 'N' } as Member;
    const group = [wide, narrow];
    const r = suggestGroupRebar(group, 'ACI318-19', 0.9, undefined, 'us', undefined, false);
    expect(isSuggestError(r)).toBe(false);
    if (isSuggestError(r)) return;
    for (const m of group) {
      for (const lc of m.loads) {
        const d = runDesign(m.section, m.material, r.rebar, lc, m.span, 'ACI318-19', undefined, undefined, false);
        const worst = Math.max(d.DCR_flex_pos, d.DCR_flex_neg, d.DCR_shear, d.DCR_torsion, d.VT_util ?? 0);
        expect(worst, `${m.label} worst DCR`).toBeLessThanOrEqual(1.0);
      }
    }
    // and the cage fits the NARROW web, which is the one that constrains it
    expect(clausesOn(group, r.rebar).has('ACI §25.2.1')).toBe(false);
  });
});
