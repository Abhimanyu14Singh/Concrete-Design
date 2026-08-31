/**
 * The ETABS section write-back, exercised without ETABS.
 *
 * The transport needs a running model, so everything decidable without one is decided in
 * `buildSectionPushPlan` and asserted here: the call ORDER, the arguments, the unit
 * conversion, the property de-duplication, and the refusal to run before saving. What is
 * left unverified is the reflection inside the C# sidecar — see the validation boundary
 * in README.md.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSectionPushPlan, validateSectionPush, runSectionPush, canPushSections,
  lengthFactorFor, summarizeSectionPush,
  type SectionPushProperty, type SectionPushCapable,
} from '../pushSections';

const prop = (over: Partial<SectionPushProperty> = {}): SectionPushProperty => ({
  name: 'B16X32-C5000', matProp: 'C5000', fc: 5000,
  depth: 32, width: 16, frameNames: ['F1', 'F2'],
  ...over,
});

/** Records every call in order, so a test can assert the sequence and the arguments. */
function mockConn() {
  const calls: Array<{ m: string; a?: unknown }> = [];
  const conn: SectionPushCapable = {
    defineFrameSections: async (s) => { calls.push({ m: 'define', a: s }); return { defined: s.length, failures: [] }; },
    assignSections: async (a) => {
      calls.push({ m: 'assign', a });
      return { assigned: a.reduce((n, x) => n + x.frameNames.length, 0), total: a.reduce((n, x) => n + x.frameNames.length, 0), failures: [] };
    },
    setRebarBeam: async (b) => { calls.push({ m: 'rebar', a: b }); return { set: b.length, failures: [] }; },
    saveModelAs: async (p) => { calls.push({ m: 'save', a: p }); return { path: p }; },
    runAnalysis: async () => { calls.push({ m: 'run' }); return { ran: true }; },
    // The re-read after the run. Returns one station per frame so a test can tell that
    // the forces travelled, without pretending to model a real analysis.
    getStationForces: async (frames, combos) => {
      calls.push({ m: 'reimport', a: { frames, combos } });
      return Object.fromEntries(frames.map(f => [f, combos.map(c => ({
        combo: c, stations: [{ x: 0, V: 42, M: -420 }],
      }))]));
    },
  };
  return { conn, calls };
}

describe('buildSectionPushPlan', () => {
  it('keeps depth as T3 and width as T2 — the transposition that breaks every beam', () => {
    const plan = buildSectionPushPlan([prop({ depth: 32, width: 16 })], 'C:/m/rev2.EDB');
    expect(plan.define[0]).toMatchObject({ depth: 32, width: 16 });
  });

  it('converts to the model units rather than calling SetPresentUnits', () => {
    // eUnits 6 = kN_m: an app inch is 0.0254 m.
    const plan = buildSectionPushPlan([prop({ depth: 32, width: 16 })], 'C:/m/rev2.EDB', { eUnits: 6 });
    expect(plan.lengthFactor).toBeCloseTo(0.0254, 6);
    expect(plan.define[0].depth).toBeCloseTo(32 * 0.0254, 6);
    expect(plan.define[0].width).toBeCloseTo(16 * 0.0254, 6);
    // eUnits 5 = kN_mm.
    expect(lengthFactorFor(5)).toBeCloseTo(25.4, 6);
    // Unknown / unread enum falls back to inches, which is what the app stores.
    expect(lengthFactorFor(null)).toBe(1);
    expect(lengthFactorFor(-1)).toBe(1);
  });

  it('converts f′c too — 5000 psi is ~34.5 MPa in a kN·m model', () => {
    const plan = buildSectionPushPlan([prop({ fc: 5000 })], 'C:/m/rev2.EDB', { eUnits: 6 });
    // kN/m²: 5000 psi = 34.47 MPa = 34 474 kPa
    expect(plan.define[0].fc!).toBeCloseTo(34474, -2);
  });

  it('merges two groups that resized to the same property, keeping every frame', () => {
    const plan = buildSectionPushPlan([
      prop({ frameNames: ['F1', 'F2'] }),
      prop({ frameNames: ['F2', 'F3'] }),   // F2 shared — ETABS must not see it twice
    ], 'C:/m/rev2.EDB');
    expect(plan.define).toHaveLength(1);          // one definition, not two
    expect(plan.assign[0].frameNames).toEqual(['F1', 'F2', 'F3']);
    expect(plan.frameCount).toBe(3);
  });

  it('splits a face area across ETABS corner areas, keeping the FACE total', () => {
    const plan = buildSectionPushPlan([prop({
      rebar: { matLong: 'A615Gr60', matConfine: 'A615Gr60', coverTop: 2, coverBot: 2, topArea: 3.16, botArea: 2.37 },
    })], 'C:/m/rev2.EDB');
    const r = plan.rebar[0];
    expect(r.topLeftArea + r.topRightArea).toBeCloseTo(3.16, 6);
    expect(r.botLeftArea + r.botRightArea).toBeCloseTo(2.37, 6);
  });
});

describe('validateSectionPush', () => {
  it('demands a .EDB path, because File.Save writes where it is told', () => {
    expect(validateSectionPush([prop()], '')).toContain('Give the new model a file path.');
    expect(validateSectionPush([prop()], 'rev2')).toContain('The model path must end in .EDB.');
    expect(validateSectionPush([prop()], 'C:/m/rev2.EDB')).toEqual([]);
  });

  it('rejects one name used for two different sections', () => {
    const errs = validateSectionPush([prop(), prop({ depth: 28 })], 'C:/m/rev2.EDB');
    expect(errs.join(' ')).toMatch(/two different sections/);
  });

  it('rejects a property with no frames or a zero dimension', () => {
    expect(validateSectionPush([prop({ frameNames: [] })], 'C:/m/r.EDB').join(' ')).toMatch(/no frames/);
    expect(validateSectionPush([prop({ width: 0 })], 'C:/m/r.EDB').join(' ')).toMatch(/zero dimension/);
  });
});

describe('runSectionPush', () => {
  it('issues save → define → rebar → assign → run, in that order', async () => {
    // Save As FIRST. Defining and assigning both need an unlocked model, and unlocking
    // discards the analysis results — so editing before the save would clear the results
    // of the model the engineer has open, purely to produce a copy. `File.Save(path)`
    // switches ETABS to the new file, so everything after step 1 lands on the copy.
    const { conn, calls } = mockConn();
    const plan = buildSectionPushPlan([prop({
      rebar: { matLong: 'A615Gr60', matConfine: 'A615Gr60', coverTop: 2, coverBot: 2, topArea: 3.16, botArea: 2.37 },
    })], 'C:/m/rev2.EDB');
    const out = await runSectionPush(conn, plan);
    expect(calls.map(c => c.m)).toEqual(['save', 'define', 'rebar', 'assign', 'run']);
    expect(out).toMatchObject({ defined: 1, assigned: 2, saved: 'C:/m/rev2.EDB', ran: true, failures: [] });
  });

  it('never writes to the model before the copy exists', async () => {
    // The guarantee stated as a property rather than a fixed sequence: no call that
    // MODIFIES anything may precede the save.
    const { conn, calls } = mockConn();
    await runSectionPush(conn, buildSectionPushPlan([prop()], 'C:/m/rev2.EDB'));
    const saveAt = calls.findIndex(c => c.m === 'save');
    for (const m of ['define', 'rebar', 'assign']) {
      const i = calls.findIndex(c => c.m === m);
      if (i >= 0) expect(i, `${m} ran before the Save As`).toBeGreaterThan(saveAt);
    }
  });

  it('saves BEFORE running — ETABS refuses to analyse an unsaved model', async () => {
    const { conn, calls } = mockConn();
    await runSectionPush(conn, buildSectionPushPlan([prop()], 'C:/m/rev2.EDB'));
    expect(calls.findIndex(c => c.m === 'save')).toBeLessThan(calls.findIndex(c => c.m === 'run'));
  });

  it('skips the run when the caller asked not to', async () => {
    const { conn, calls } = mockConn();
    const plan = buildSectionPushPlan([prop()], 'C:/m/rev2.EDB', { runAnalysis: false });
    const out = await runSectionPush(conn, plan);
    expect(calls.map(c => c.m)).not.toContain('run');
    expect(out.ran).toBe(false);
  });

  it('collects per-frame failures instead of throwing them', async () => {
    const { conn } = mockConn();
    conn.assignSections = async () => ({ assigned: 39, total: 40, failures: ['F17 → B16X32: returned 1'] });
    const out = await runSectionPush(conn, buildSectionPushPlan([prop()], 'C:/m/rev2.EDB'));
    expect(out.assigned).toBe(39);
    expect(out.failures).toEqual(['F17 → B16X32: returned 1']);
    expect(summarizeSectionPush(out)).toMatch(/39\/2 frames \(1 failed\)/);
  });

  it('refuses a read-only connection rather than half-writing', async () => {
    expect(canPushSections({})).toBe(false);
    expect(canPushSections(mockConn().conn)).toBe(true);
    await expect(runSectionPush({}, buildSectionPushPlan([prop()], 'C:/m/r.EDB')))
      .rejects.toThrow(/cannot write sections/);
  });
});
