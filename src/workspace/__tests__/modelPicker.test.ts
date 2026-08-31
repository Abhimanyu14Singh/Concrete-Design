/**
 * Which models the picker offers.
 *
 * The job is two models: the one you opened, and the one you pushed to. A push freezes
 * the working model, so straight afterwards "Working model" and the new revision are the
 * same thing under two names — and listing both turned a two-model job into a
 * three-entry picker with a duplicate in it.
 *
 * `modelSignatureOf` is what decides. These pin the two ways it can be wrong: calling a
 * genuinely changed model unchanged (which hides the working model and loses edits from
 * the picker), and calling an identical one changed (which puts the duplicate back).
 */
import { describe, it, expect } from 'vitest';
import { modelSignatureOf } from '../design.js';

const member = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  section: { b: 18, h: 60 },
  rebar: {
    topBars: [{ numBars: 4, barSize: 9 }],
    botBars: [{ numBars: 4, barSize: 9 }],
    ties: { barSize: 4, spacing: 6, legs: 2 },
  },
  loads: [{ id: 'l1', label: 'ENV', Mu_pos: 400, Mu_neg: -300, Vu: 90, Tu: 0, Pu: 0 }],
  ...over,
});

describe('modelSignatureOf — same model, same fingerprint', () => {
  it('matches for two structurally identical models', () => {
    expect(modelSignatureOf([member()])).toBe(modelSignatureOf([member()]));
  });

  it('ignores fields that do not distinguish a revision', () => {
    // A label or a review note is not a new model, and treating it as one would put a
    // duplicate entry in the picker for a typo.
    expect(modelSignatureOf([member({ label: 'B1' })]))
      .toBe(modelSignatureOf([member({ label: 'RENAMED' })]));
  });
});

describe('modelSignatureOf — the three things that DO make a new revision', () => {
  it('sections', () => {
    expect(modelSignatureOf([member({ section: { b: 24, h: 72 } })]))
      .not.toBe(modelSignatureOf([member()]));
  });

  it('cages', () => {
    const heavier = member({
      rebar: {
        topBars: [{ numBars: 4, barSize: 9 }],
        botBars: [{ numBars: 6, barSize: 11 }],
        ties: { barSize: 4, spacing: 6, legs: 2 },
      },
    });
    expect(modelSignatureOf([heavier])).not.toBe(modelSignatureOf([member()]));
  });

  it('links', () => {
    const tighter = member({
      rebar: { ...member().rebar, ties: { barSize: 5, spacing: 4, legs: 4 } },
    });
    expect(modelSignatureOf([tighter])).not.toBe(modelSignatureOf([member()]));
  });

  it('DEMAND — the case a row count would miss', () => {
    // This is the one that matters after a re-analysis: the re-import replaces every
    // load row with a new value and keeps the count identical. A signature that counted
    // rows would call the re-designed model unchanged and hide it from the picker.
    const reanalysed = member({
      loads: [{ id: 'l1', label: 'ENV', Mu_pos: 620, Mu_neg: -455, Vu: 130, Tu: 0, Pu: 0 }],
    });
    expect(reanalysed.loads).toHaveLength(member().loads.length);
    expect(modelSignatureOf([reanalysed])).not.toBe(modelSignatureOf([member()]));
  });
});

describe('modelSignatureOf — edges', () => {
  it('a member gained or lost', () => {
    expect(modelSignatureOf([member(), member({ id: 'm2' })]))
      .not.toBe(modelSignatureOf([member()]));
  });

  it('survives members with nothing on them', () => {
    expect(() => modelSignatureOf([{ id: 'x' }])).not.toThrow();
    expect(modelSignatureOf([])).toBe('');
    expect(modelSignatureOf(null)).toBe('');
    expect(modelSignatureOf(undefined)).toBe('');
  });

  it('is order-sensitive only in the way member order is', () => {
    // Two models with the same members in a different order are the same model to an
    // engineer, but the picker never reorders — so this documents the behaviour rather
    // than asserting a requirement.
    const a = modelSignatureOf([member(), member({ id: 'm2' })]);
    const b = modelSignatureOf([member({ id: 'm2' }), member()]);
    expect(a).not.toBe(b);
  });
});
