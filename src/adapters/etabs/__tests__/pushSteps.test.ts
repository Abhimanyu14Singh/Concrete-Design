/**
 * The push, run one step at a time.
 *
 * A live push edits a shared model, writes a file, and can start an hour of analysis.
 * Split across five buttons, the thing that must hold is the ORDER — a frame cannot go
 * on a property that does not exist, and saving before assigning writes the old
 * assignments. These pin that, and pin that the stepped path and the one-click path
 * cannot drift, since they now walk the same list.
 */
import { describe, it, expect } from 'vitest';
import {
  SECTION_PUSH_STEPS, buildSectionPushPlan, emptyPushOutcome, runSectionPush,
} from '../pushSections';

const PROPS = [{
  name: 'B18X60-C5000', matProp: 'C5000', depth: 60, width: 18,
  frameNames: ['B1', 'B2', 'B3'],
}];

const plan = (opts: { runAnalysis?: boolean } = {}) =>
  buildSectionPushPlan(PROPS, 'C:/jobs/tower-v2.EDB', { eUnits: 4, runAnalysis: opts.runAnalysis ?? true });

/** A connection that records the order it was called in. */
function spy() {
  const calls: string[] = [];
  return {
    calls,
    conn: {
      defineFrameSections: async () => { calls.push('define'); return { defined: 1, failures: [] }; },
      setRebarBeam: async () => { calls.push('rebar'); return { set: 1, failures: [] }; },
      assignSections: async () => { calls.push('assign'); return { assigned: 3, total: 3, failures: [] }; },
      saveModelAs: async (p: string) => { calls.push(`save:${p}`); return { path: p }; },
      runAnalysis: async () => { calls.push('run'); return { ran: true }; },
      getStationForces: async (frames: string[], combos: string[]) => {
        calls.push('reimport');
        return Object.fromEntries(frames.map(f => [f, combos.map(c => ({
          combo: c, stations: [{ x: 0, V: 42, M: -420 }],
        }))]));
      },
    },
  };
}

describe('SECTION_PUSH_STEPS — the order is the contract', () => {
  it('SAVES THE COPY FIRST, before anything that unlocks the model', () => {
    // The one that matters. Defining or assigning needs an unlocked model, and
    // unlocking discards the analysis results — so doing either before the Save As
    // clears the engineer's own analysed session to build a copy. Save first and it is
    // the copy that gets unlocked.
    const ids = SECTION_PUSH_STEPS.map(s => s.id);
    expect(ids.indexOf('save')).toBe(0);
    for (const editing of ['define', 'rebar', 'assign'] as const) {
      expect(ids.indexOf(editing)).toBeGreaterThan(ids.indexOf('save'));
    }
  });

  it('defines before assigning, and re-imports LAST of all', () => {
    const ids = SECTION_PUSH_STEPS.map(s => s.id);
    expect(ids.indexOf('define')).toBeLessThan(ids.indexOf('assign'));
    // The re-import reads the results of the run, so it cannot precede it — and nothing
    // follows it, because the forces it brings back are the end of the round trip.
    expect(ids.indexOf('run')).toBeLessThan(ids.indexOf('reimport'));
    expect(ids.indexOf('reimport')).toBe(ids.length - 1);
  });

  it('issues Save As before any write call, on a real run', () => {
    // The list order is one thing; what the connection actually SEES is the guarantee.
    const { conn, calls } = spy();
    const p = plan();
    return runSectionPush(conn, p).then(() => {
      expect(calls[0]).toBe(`save:${p.savePath}`);
      expect(calls.slice(1)).toEqual(['define', 'assign', 'run']);
      // No combos in this plan, so there is nothing to re-import — see the suite below.
      expect(calls).not.toContain('reimport');
    });
  });

  it('running every applicable step by hand equals the one-click push', async () => {
    // The two paths must not drift; they walk the same list, and this is what says so.
    const a = spy(), b = spy();
    const p = plan();
    const out = emptyPushOutcome(p);
    for (const st of SECTION_PUSH_STEPS) {
      if (st.applies(p)) await st.run(a.conn, p, out);
    }
    await runSectionPush(b.conn, p);
    expect(a.calls).toEqual(b.calls);
  });

  it('folds each step’s result into the shared outcome', async () => {
    const { conn } = spy();
    const p = plan();
    const out = emptyPushOutcome(p);
    expect(out.frames).toBe(3);
    for (const st of SECTION_PUSH_STEPS) if (st.applies(p)) await st.run(conn, p, out);
    expect(out.defined).toBe(1);
    expect(out.assigned).toBe(3);
    expect(out.saved).toBe('C:/jobs/tower-v2.EDB');
    expect(out.ran).toBe(true);
  });
});

describe('steps with nothing to do are not offered', () => {
  it('drops the analysis step when the engineer unticked re-run', () => {
    const p = plan({ runAnalysis: false });
    expect(SECTION_PUSH_STEPS.find(s => s.id === 'run')!.applies(p)).toBe(false);
    // ...and the rest still apply, so unticking removes ONE button, not the push.
    expect(SECTION_PUSH_STEPS.filter(s => s.applies(p)).map(s => s.id)).toContain('save');
  });

  it('drops the rebar step when no cage travels with the sections', () => {
    const p = plan();
    expect(p.rebar).toHaveLength(0);
    expect(SECTION_PUSH_STEPS.find(s => s.id === 'rebar')!.applies(p)).toBe(false);
  });

  it('offers the rebar step when a cage IS attached', () => {
    const withCage = buildSectionPushPlan([{
      ...PROPS[0],
      rebar: {
        matLong: 'A615Gr60', matConfine: 'A615Gr60', coverTop: 2.5, coverBot: 2.5,
        topArea: 1.2, botArea: 2.4,
      },
    }], 'C:/jobs/tower-v2.EDB', { eUnits: 4 });
    expect(SECTION_PUSH_STEPS.find(s => s.id === 'rebar')!.applies(withCage)).toBe(true);
  });

  it('never skips the save — it is what makes the push durable', () => {
    for (const ra of [true, false]) {
      expect(SECTION_PUSH_STEPS.find(s => s.id === 'save')!.applies(plan({ runAnalysis: ra }))).toBe(true);
    }
  });
});

describe('a step that fails does not silently pass', () => {
  it('propagates a transport failure to the caller', async () => {
    const conn = {
      defineFrameSections: async () => { throw new Error('ETABS busy'); },
      assignSections: async () => ({ assigned: 0, total: 3, failures: [] }),
      saveModelAs: async (p: string) => ({ path: p }),
      runAnalysis: async () => ({ ran: true }),
    };
    const p = plan();
    const step = SECTION_PUSH_STEPS.find(s => s.id === 'define')!;
    await expect(step.run(conn, p, emptyPushOutcome(p))).rejects.toThrow(/ETABS busy/);
  });

  it('reports per-item failures in the outcome rather than throwing', async () => {
    // A define that skipped two properties is a PARTIAL success — the button has to be
    // able to say "done, with 2 failures" rather than either lying or blowing up.
    const conn = {
      defineFrameSections: async () => ({ defined: 1, failures: ['B12X24 exists', 'B14X28 locked'] }),
      assignSections: async () => ({ assigned: 3, total: 3, failures: [] }),
      saveModelAs: async (p: string) => ({ path: p }),
      runAnalysis: async () => ({ ran: true }),
    };
    const p = plan();
    const out = emptyPushOutcome(p);
    await SECTION_PUSH_STEPS.find(s => s.id === 'define')!.run(conn, p, out);
    expect(out.defined).toBe(1);
    expect(out.failures).toHaveLength(2);
  });
});

describe('every step can describe itself', () => {
  it('has a label and a detail that names real numbers from the plan', () => {
    const p = plan();
    for (const st of SECTION_PUSH_STEPS) {
      expect(st.label.length).toBeGreaterThan(0);
      expect(st.detail(p).length).toBeGreaterThan(0);
    }
    expect(SECTION_PUSH_STEPS.find(s => s.id === 'assign')!.detail(p)).toContain('3');
    expect(SECTION_PUSH_STEPS.find(s => s.id === 'save')!.detail(p)).toContain('tower-v2.EDB');
  });
});

/**
 * The re-import — the step that closes the loop.
 *
 * Resizing changes stiffness, and stiffness redistributes force: the beam you just made
 * deeper attracts MORE moment. Without reading the re-analysed forces back, the app goes
 * on checking the new sections against the demand from before they were new, which
 * flatters exactly the members that were enlarged. So the thing to pin is that it reads
 * the SAME combos the model was imported under — a design compared against a different
 * load case is not a comparison.
 */
describe('re-import after the run', () => {
  const withCombos = (combos: string[]) =>
    buildSectionPushPlan(PROPS, 'C:/jobs/tower-v2.EDB', { eUnits: 4, runAnalysis: true, combos });

  it('reads back exactly the combos it was given, and every pushed frame', async () => {
    const { conn } = spy();
    const p = withCombos(['1.2D+1.6L', '1.2D+1.0L+1.0E']);
    const out = emptyPushOutcome(p);
    await SECTION_PUSH_STEPS.find(s => s.id === 'reimport')!.run(conn, p, out);
    expect(Object.keys(out.forces!).sort()).toEqual(['B1', 'B2', 'B3']);
    expect(out.forces!.B1.map(c => c.combo)).toEqual(['1.2D+1.6L', '1.2D+1.0L+1.0E']);
  });

  it('runs after the analysis, never before it', async () => {
    const { conn, calls } = spy();
    await runSectionPush(conn, withCombos(['ENV']));
    expect(calls.indexOf('run')).toBeLessThan(calls.indexOf('reimport'));
  });

  it('is skipped when the analysis was skipped — there is nothing new to read', () => {
    const p = buildSectionPushPlan(PROPS, 'C:/j/x.EDB', { eUnits: 4, runAnalysis: false, combos: ['ENV'] });
    expect(SECTION_PUSH_STEPS.find(s => s.id === 'reimport')!.applies(p)).toBe(false);
  });

  it('is skipped when no combo set is known', () => {
    // A button that reads zero combos and reports success would be worse than no button.
    expect(SECTION_PUSH_STEPS.find(s => s.id === 'reimport')!.applies(withCombos([]))).toBe(false);
  });

  it('de-duplicates frames that two properties share', async () => {
    const { conn } = spy();
    const p = buildSectionPushPlan([
      { ...PROPS[0], name: 'A', frameNames: ['B1', 'B2'] },
      { ...PROPS[0], name: 'B', frameNames: ['B2', 'B3'] },
    ], 'C:/j/x.EDB', { eUnits: 4, runAnalysis: true, combos: ['ENV'] });
    const out = emptyPushOutcome(p);
    await SECTION_PUSH_STEPS.find(s => s.id === 'reimport')!.run(conn, p, out);
    expect(Object.keys(out.forces!).sort()).toEqual(['B1', 'B2', 'B3']);
  });
});
