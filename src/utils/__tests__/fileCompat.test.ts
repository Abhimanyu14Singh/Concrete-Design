/**
 * File-format compatibility, in both directions.
 *
 * saveLoad.test.ts checks the round trip with hand-built objects. This file checks
 * the thing that actually matters to a user: FROZEN ARTEFACTS. Each fixture under
 * fixtures/projects/ is a real `.scdb` payload as some build wrote it, and the point
 * of pinning them is that a future refactor of migrateProject() cannot quietly stop
 * opening files people already have on disk.
 *
 * DO NOT regenerate a fixture to make a test pass. If one of these fails, a build has
 * lost the ability to read a file it used to read, and the fixture is the evidence.
 * Add a NEW fixture per schema version; never edit an old one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { FILE_VERSION, deserializeProject, serializeProject } from '../saveLoad';
import type { Project } from '../../types';

const DIR = new URL('./fixtures/projects/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, DIR), 'utf-8');

describe('backward compatibility — old files still open', () => {
  it('v1.0: backfills every field added since, without inventing a design', () => {
    const p = deserializeProject(read('v1.0-minimal.scdb.json'));
    expect(p.name).toBe('Warehouse Roof');
    expect(p.code).toBe('ACI318-19');
    const m = p.members[0];
    expect(m.memberType).toBe('beam');            // backfilled
    expect(m.material.fyt).toBe(60000);           // falls back to fy
    expect(m.material.Es).toBe(29000000);         // backfilled
    expect(m.material.lambdaConcrete).toBe(1);    // backfilled
    expect(m.material.Ec).toBeUndefined();        // NOT invented — code formula still applies
    // The engineer's own numbers are untouched.
    expect(m.section.b).toBe(12);
    expect(m.rebar.botBars).toEqual([{ numBars: 3, barSize: 8 }]);
    expect(m.loads[0].Mu_pos).toBe(120);
    // Pre-settings file: standards are read back off the member, not defaulted.
    expect(p.settings?.fc).toBe(4000);
    expect(p.settings?.fy).toBe(60000);
  });

  it('v1.2: keeps EC2 code, per-face cover, metric bar sizes and the Ec override', () => {
    const p = deserializeProject(read('v1.2-settings.scdb.json'));
    expect(p.code).toBe('EN1992-1-1');
    expect(p.settings?.barFamily).toBe('euro');
    const m = p.members[0];
    expect(m.section.type).toBe('T_beam');
    expect(m.section.coverBottom).toBe(1.5748);   // per-face cover survives
    expect(m.section.coverTop).toBe(1.1811);
    expect(m.material.Ec).toBe(4700000);          // explicit override preserved
    expect(m.rebar.botBars[0].barSize).toBe(-25); // negative = metric Ø mm
  });

  it('v1.3: a file this build wrote reads back with every field intact', () => {
    const p = deserializeProject(read('v1.3-current.scdb.json'));
    expect(p.targetDCR).toBe(0.9);
    expect(p.cotTheta).toBe(2.5);
    expect(p.designGroups?.[0].label).toBe('L3 gravity');
    expect(p.hiddenStories).toEqual(['Roof']);
    const m = p.members[0];
    expect(m.span).toBe(24);
    expect(m.rebar.tieZones).toEqual([{ spacing: 6 }, { spacing: 12 }, { spacing: 6 }]);
    expect(m.rebar.sideBars).toEqual([{ numBars: 2, barSize: 5 }]);
    expect(m.rebar.layerClearSpacing).toBe(1);
    expect(m.overrides).toBeDefined();
  });

  it('every fixture at or below this MAJOR opens without throwing', () => {
    const files = readdirSync(DIR).filter(f => f.endsWith('.json') && !f.startsWith('v2.'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      expect(() => deserializeProject(read(f)), f).not.toThrow();
    }
  });
});

describe('forward compatibility — a newer file in this build', () => {
  // Points at a fixture genuinely AHEAD of this build. It was v1.4 until this build
  // BECAME 1.4 — at which point the test was quietly checking same-version load rather
  // than forward compatibility. The 1.4 fixture is kept and still asserted below; this
  // is the one that has to stay one MINOR in front.
  const FUTURE = 'v1.5-future-additive.scdb.json';

  it('a newer MINOR opens, because minor bumps are additive by contract', () => {
    const p = deserializeProject(read(FUTURE));
    expect(p.name).toBe('From A Newer Build');
    expect(p.targetDCR).toBe(0.88);               // a field this build does know
    expect(p.members[0].section.b).toBe(14);
  });

  it('fields this build has never seen survive load → save, at every level', () => {
    const p = deserializeProject(read(FUTURE));
    const out = JSON.parse(serializeProject(p));
    expect(out.futureProjectField).toEqual({ seismicCategory: 'D', notes: ['keep me'] });
    const m = out.members[0];
    expect(m.futureMemberField).toBe('shear-friction-check');
    expect(m.section.futureSectionField).toBe(2.5);
    expect(m.rebar.futureRebarField).toEqual({ headedBars: true });
    expect(m.loads[0].futureLoadField).toBe(9);
  });

  it('a newer MAJOR is refused, with a message that says what to do', () => {
    const open = () => deserializeProject(read('v2.0-future-major.scdb.json'));
    expect(open).toThrow(/newer version of S-Concrete/i);
    expect(open).toThrow(/2\.0/);
    expect(open).toThrow(/Update the app/i);
  });

  it('an absent or malformed _version is migrated, not rejected', () => {
    const base = JSON.parse(read('v1.0-minimal.scdb.json')) as Record<string, unknown>;
    for (const v of ['', 'draft', 42, null]) {
      expect(() => deserializeProject(JSON.stringify({ ...base, _version: v })), String(v))
        .not.toThrow();
    }
    const noStamp = { ...base };
    delete noStamp._version;
    expect(() => deserializeProject(JSON.stringify(noStamp))).not.toThrow();
  });
});

describe('the version stamp itself', () => {
  it('writes the current FILE_VERSION', () => {
    const p = deserializeProject(read('v1.0-minimal.scdb.json'));
    expect(JSON.parse(serializeProject(p))._version).toBe(FILE_VERSION);
  });

  it('is a MAJOR.MINOR string this build can parse', () => {
    expect(FILE_VERSION).toMatch(/^\d+\.\d+$/);
  });

  it('re-saving an old file does not silently drop what it carried', () => {
    // The one thing a load → save must never do: lose a field the engineer set.
    const before = JSON.parse(read('v1.2-settings.scdb.json'));
    const after = JSON.parse(serializeProject(deserializeProject(read('v1.2-settings.scdb.json'))));
    for (const k of Object.keys(before)) {
      if (k === '_version' || k === 'members') continue;
      expect(after[k], k).toBeDefined();
    }
    const mBefore = before.members[0], mAfter = after.members[0];
    for (const k of Object.keys(mBefore)) {
      expect(mAfter[k], `member.${k}`).toBeDefined();
    }
  });

  it('a round trip is idempotent — save(load(x)) equals save(load(save(load(x))))', () => {
    const once = serializeProject(deserializeProject(read('v1.3-current.scdb.json')));
    const twice = serializeProject(deserializeProject(once));
    expect(twice).toBe(once);
  });
});

describe('what migration deliberately does NOT preserve', () => {
  it('cached design results are dropped so the current engine recomputes', () => {
    // v1.0 fixture carries a stale `results` block from an older engine.
    expect(JSON.parse(read('v1.0-minimal.scdb.json')).members[0].results).toBeDefined();
    expect(deserializeProject(read('v1.0-minimal.scdb.json')).members[0].results).toBeUndefined();
  });

  it('column members are filtered out — this build has no engine for them', () => {
    const base = JSON.parse(read('v1.0-minimal.scdb.json')) as Project & Record<string, unknown>;
    const withCol = {
      ...base,
      members: [
        ...base.members,
        {
          id: 'c1', label: 'C1', memberType: 'column',
          section: { type: 'rectangular_column', b: 18, h: 18, coverClear: 1.5, stirrupDia: 4 },
          material: { fc: 5000, fy: 60000 }, rebar: { topBars: [], botBars: [] }, loads: [],
        },
      ],
    };
    const p = deserializeProject(JSON.stringify(withCol));
    expect(p.members).toHaveLength(1);
    expect(p.members[0].id).toBe('m-v10-1');
  });
});

/**
 * 1.4 — `modelVersions`: the frozen designs behind the model picker.
 *
 * The reason they are in the project file rather than in memory is that "what did the
 * groups look like on rev 2" gets asked days later. So the thing to pin is that they
 * come back off disk intact, with the code and prefs each one ran under — re-deriving a
 * 2026 design under 2027's torsion policy would silently restate a number the engineer
 * already signed off.
 */
describe('1.4 — pushed model versions round-trip', () => {
  const FIX = 'v1.4-modelVersions.scdb.json';

  it('opens a 1.4 file and keeps both frozen models', () => {
    const p = deserializeProject(read(FIX));
    expect(p.modelVersions).toHaveLength(2);
    expect(p.modelVersions!.map(v => v.name)).toEqual(['Tower-rev1.EDB', 'Tower-rev2.EDB']);
  });

  it('keeps what a version needs to be re-derived exactly', () => {
    const v = deserializeProject(read(FIX)).modelVersions![0];
    expect(v.code).toBeTruthy();                 // the code it ran under
    expect(v.prefs?.cotTheta).toBe(2.5);         // ...and the prefs
    expect(v.members.length).toBeGreaterThan(0); // ...and its own frozen members
    expect(v.groups?.[0].memberIds.length).toBeGreaterThan(0);
    expect(v.groupRebar?.g1?.botBars?.[0].numBars).toBe(4);
  });

  it('survives load → save → load unchanged', () => {
    const once = deserializeProject(read(FIX));
    const twice = deserializeProject(serializeProject(once));
    expect(twice.modelVersions).toEqual(once.modelVersions);
  });

  it('a version omitting the optional halves still opens', () => {
    // v2 in the fixture has no prefs, no groupRebar, no properties — an older push, or
    // one where nothing was resized. Absence must read as absence, not as a crash.
    const v = deserializeProject(read(FIX)).modelVersions![1];
    expect(v.prefs).toBeUndefined();
    expect(v.groupRebar).toBeUndefined();
    expect(v.name).toBe('Tower-rev2.EDB');
  });

  it('a 1.3 file simply has none — not an empty one', () => {
    // The distinction matters on save-back: writing `modelVersions: []` into a file that
    // never had the field is a change an older build would then carry around.
    const p = deserializeProject(read('v1.3-current.scdb.json'));
    expect(p.modelVersions).toBeUndefined();
    expect(JSON.parse(serializeProject(p)).modelVersions).toBeUndefined();
  });
});
