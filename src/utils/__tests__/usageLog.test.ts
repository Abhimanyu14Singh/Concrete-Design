/**
 * Redaction tests for the main-process usage log (`electron/usageLog.cjs`).
 *
 * This file is the privacy guarantee in executable form. Everything the app tells other
 * people about itself passes through `scrub` and `sanitize`, and the promise made on the
 * Diagnostics page — no paths, no names, no addresses — is only as true as these cases.
 * A regression here does not break the app; it leaks a client's job name into a file
 * someone then e-mails, which is strictly worse than a crash.
 *
 * Loaded through `createRequire` because the module is CommonJS and lives outside `src`.
 * It touches `electron` only lazily inside functions, so requiring it here is safe.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import os from 'node:os';

const req = createRequire(import.meta.url);
const usageLog = req('../../../electron/usageLog.cjs') as {
  scrub: (s: unknown) => unknown;
  sanitize: (v: unknown, depth?: number) => unknown;
  pathShape: (p: unknown) => { scope: string; ext: string | null; depth: number } | null;
  shortStack: (e: unknown, frames?: number) => string | null;
  outcomeOf: (r: unknown) => { ok: boolean; err?: string; canceled?: boolean };
  stampOf: (at: unknown) => number;
};
const { scrub, sanitize, pathShape, shortStack, outcomeOf, stampOf } = usageLog;

const HOME = os.homedir();

describe('scrub — paths', () => {
  it('strips a drive path down to its extension', () => {
    expect(scrub('Cannot read C:\\Jobs\\Acme Tower\\Phase 2\\model.edb'))
      .toBe('Cannot read <path.edb>');
  });

  // Spaces are where redaction usually fails, and where the leak is worst: the client's
  // name is normally the directory with a space in it.
  it('strips a path whose directories contain spaces', () => {
    expect(scrub('open C:\\Program Files\\S-Concrete\\bin\\run.exe'))
      .toBe('open <path.exe>');
  });

  it('strips a path whose FILENAME contains spaces', () => {
    expect(scrub('wrote C:\\out\\Acme Tower level 3.sco')).toBe('wrote <path.sco>');
  });

  it('does not swallow the sentence that follows a path', () => {
    expect(scrub('Cannot open C:\\a\\b.edb because the file is locked'))
      .toBe('Cannot open <path.edb> because the file is locked');
  });

  it('leaves a full stop after a path outside the redaction', () => {
    expect(scrub('Missing C:\\a\\b.scrs.')).toBe('Missing <path.scrs>.');
  });

  it('strips a forward-slash drive path (how stacks and URLs spell it)', () => {
    expect(scrub('at C:/Projects/Confidential/bundle.js')).toBe('at <path.js>');
  });

  it('strips a UNC path — a share name identifies an office as well as a path does', () => {
    expect(scrub('Failed to open \\\\fileserver\\structures\\job1234\\out.SCO'))
      .toBe('Failed to open <unc.sco>');
  });

  it('strips the user home directory, which carries the user name', () => {
    const out = scrub(`${HOME}\\Documents\\S-Concrete Batches\\run.scrs`) as string;
    expect(out).toBe('<home.scrs>');
    expect(out).not.toContain(os.userInfo().username);
  });

  it('strips every path in a message, not just the first', () => {
    expect(scrub('copy C:\\a\\b.sco to D:\\c\\d.scrs')).toBe('copy <path.sco> to <path.scrs>');
  });

  it('keeps a path that has no extension identifiable as a path', () => {
    expect(scrub('output folder C:\\Users\\Public\\batches')).toBe('output folder <path>');
  });

  it('leaves ordinary prose alone', () => {
    const msg = 'No beams match the current filter.';
    expect(scrub(msg)).toBe(msg);
  });

  it('does not mangle a bare drive letter or a colon in prose', () => {
    expect(scrub('Ratio 3:1 on drive C:')).toBe('Ratio 3:1 on drive C:');
  });
});

describe('scrub — other identifiers', () => {
  it('strips e-mail addresses', () => {
    expect(scrub('licence held by jane.doe@engineers.co.uk')).toBe('licence held by <email>');
  });

  it('passes non-strings through untouched', () => {
    expect(scrub(42)).toBe(42);
    expect(scrub(null)).toBe(null);
    expect(scrub(undefined)).toBe(undefined);
  });
});

describe('sanitize', () => {
  it('scrubs strings nested inside objects and arrays', () => {
    const out = sanitize({ err: 'open C:\\Jobs\\Acme\\m.edb', list: ['D:\\x\\y.sco'] }) as
      { err: string; list: string[] };
    expect(out.err).toBe('open <path.edb>');
    expect(out.list[0]).toBe('<path.sco>');
  });

  it('caps a long string rather than letting one prop dominate the file', () => {
    const out = sanitize('x'.repeat(5000)) as string;
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out.endsWith('\u2026')).toBe(true);
  });

  it('caps array width and says how much it dropped', () => {
    const out = sanitize(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
    expect(out.length).toBe(33);              // 32 kept + the marker
    expect(out[32]).toBe('<+68 more>');
  });

  it('caps object width', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i++) wide[`k${i}`] = i;
    const out = sanitize(wide) as Record<string, unknown>;
    expect(Object.keys(out).length).toBeLessThanOrEqual(33);
    expect(out._truncated).toBe(true);
  });

  it('stops at a depth limit, so a whole project object cannot be smuggled through', () => {
    const deep = { a: { b: { c: { d: { e: 'buried' } } } } };
    expect(JSON.stringify(sanitize(deep))).toContain('<deep>');
    expect(JSON.stringify(sanitize(deep))).not.toContain('buried');
  });

  it('keeps numbers and booleans, and makes non-finite numbers readable', () => {
    expect(sanitize({ n: 312, ok: true, bad: NaN, inf: Infinity }))
      .toEqual({ n: 312, ok: true, bad: 'NaN', inf: 'Infinity' });
  });

  it('never emits a function or a symbol verbatim', () => {
    const out = sanitize({ fn: () => 'secret' }) as Record<string, string>;
    expect(out.fn).toBe('<function>');
  });
});

describe('pathShape', () => {
  it('classifies where a path lives without saying where it is', () => {
    expect(pathShape('C:\\Program Files\\S-Concrete\\bin\\app.exe'))
      .toMatchObject({ scope: 'programfiles', ext: '.exe' });
    expect(pathShape('\\\\server\\share\\out')).toMatchObject({ scope: 'unc' });
    expect(pathShape('D:\\batches\\x.sco')).toMatchObject({ scope: 'drive', ext: '.sco' });
    expect(pathShape(`${HOME}\\Documents\\a.scdb`)).toMatchObject({ scope: 'home', ext: '.scdb' });
  });

  it('reports depth, which is all the structure that is kept', () => {
    expect(pathShape('C:\\a\\b\\c\\d.txt')?.depth).toBe(5);
  });

  it('returns null for a non-path', () => {
    expect(pathShape('')).toBeNull();
    expect(pathShape(undefined)).toBeNull();
  });
});

describe('shortStack', () => {
  it('keeps the first frames and scrubs the paths in them', () => {
    const err = new Error('boom');
    err.stack = ['Error: boom', '  at a (C:\\app\\x.js:1:1)', '  at b (C:\\app\\y.js:2:2)',
      '  at c', '  at d', '  at e', '  at f', '  at g'].join('\n');
    const out = shortStack(err, 3)!;
    expect(out.split('\n')).toHaveLength(3);
    expect(out).not.toContain('C:\\app');
    expect(out).toContain('<path.js>');
  });

  it('returns null when there is no stack', () => {
    expect(shortStack({})).toBeNull();
  });
});

describe('stampOf', () => {
  it('honours a renderer-supplied timestamp, so batching does not flatten the timeline', () => {
    const at = Date.now() - 4000;
    expect(stampOf(at)).toBe(at);
  });

  it('falls back to now when the timestamp is missing or not a number', () => {
    const before = Date.now();
    expect(stampOf(undefined)).toBeGreaterThanOrEqual(before);
    expect(stampOf('nope')).toBeGreaterThanOrEqual(before);
    expect(stampOf(NaN)).toBeGreaterThanOrEqual(before);
  });

  it('rejects a wildly implausible timestamp — a corrected clock, mostly', () => {
    const before = Date.now();
    expect(stampOf(0)).toBeGreaterThanOrEqual(before);                 // 1970
    expect(stampOf(Date.now() + 5 * 86400000)).toBeGreaterThanOrEqual(before);
  });
});

describe('outcomeOf', () => {
  // main.cjs handlers report failure by RETURNING a shape rather than throwing, so the
  // IPC instrumentation has to read all three conventions used across the file.
  it('reads the { error } convention', () => {
    expect(outcomeOf({ error: 'nope' })).toMatchObject({ ok: false, err: 'nope' });
  });

  it('reads { success: false } and keeps a cancel distinct from a failure', () => {
    expect(outcomeOf({ success: false, canceled: true })).toEqual({ ok: false, canceled: true });
    expect(outcomeOf({ success: false })).toEqual({ ok: false, canceled: false });
  });

  it('reads { ok: false }', () => {
    expect(outcomeOf({ ok: false })).toMatchObject({ ok: false });
  });

  it('treats a success shape, a bare value and undefined as ok', () => {
    expect(outcomeOf({ success: true, filePath: 'x' })).toEqual({ ok: true });
    expect(outcomeOf(undefined)).toEqual({ ok: true });
    expect(outcomeOf([1, 2, 3])).toEqual({ ok: true });
  });

  it('scrubs a path out of a returned error message', () => {
    expect(outcomeOf({ error: 'Path does not exist: C:\\Jobs\\Acme\\out' }))
      .toMatchObject({ ok: false, err: 'Path does not exist: <path>' });
  });
});
