/**
 * The clean re-run DELETES files from a folder the user chose, so which files it
 * selects is pinned here against a real temp directory rather than a mock — the
 * failure mode being guarded is "it removed something that wasn't ours".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cleanScoFolder } = require('../../../../electron/sconcreteBridge.cjs') as {
  cleanScoFolder: (dir: string) => { removed: string[]; failed: string[]; kept: number };
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sco-clean-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const put = (name: string) => writeFileSync(join(dir, name), 'x');
const survivors = () => readdirSync(dir).sort();

describe('cleanScoFolder — what a clean re-run removes', () => {
  it('removes the .SCO, .SCRS and Report_*.pdf a run produced', () => {
    put('B1.SCO');
    put('Perimeter_S4.SCO');
    put('SConcreteResults.SCRS');
    put('Report_20260817_154500.pdf');

    const out = cleanScoFolder(dir);

    expect(out.removed.sort()).toEqual(
      ['B1.SCO', 'Perimeter_S4.SCO', 'Report_20260817_154500.pdf', 'SConcreteResults.SCRS'],
    );
    expect(out.failed).toEqual([]);
    expect(survivors()).toEqual([]);
  });

  it('matches the extensions case-insensitively (S-Concrete writes both cases)', () => {
    put('a.sco'); put('B.Sco'); put('c.SCRS'); put('d.scrs');
    cleanScoFolder(dir);
    expect(survivors()).toEqual([]);
  });

  it('LEAVES anything the workflow does not own', () => {
    // The output folder is the user's. A PDF they put there, notes, a spreadsheet,
    // or a nested folder must all survive — only run artefacts go.
    put('B1.SCO');
    put('site-notes.txt');
    put('Beam schedule.xlsx');
    put('MyDrawing.pdf');            // not Report_<timestamp>.pdf
    put('Report_final.pdf');         // close, but not the sidecar's naming
    put('scores.csv');               // "sco" is a substring, not the extension
    mkdirSync(join(dir, 'archive'));
    writeFileSync(join(dir, 'archive', 'old.SCO'), 'x');   // subfolder — untouched

    const out = cleanScoFolder(dir);

    expect(out.removed).toEqual(['B1.SCO']);
    expect(out.kept).toBe(6);        // 5 files + the subfolder
    expect(survivors()).toEqual(
      ['Beam schedule.xlsx', 'MyDrawing.pdf', 'Report_final.pdf', 'archive', 'scores.csv', 'site-notes.txt'],
    );
    expect(existsSync(join(dir, 'archive', 'old.SCO'))).toBe(true);
  });

  it('is a no-op on an empty or missing folder', () => {
    expect(cleanScoFolder(dir)).toMatchObject({ removed: [], failed: [] });
    expect(cleanScoFolder(join(dir, 'does-not-exist'))).toMatchObject({ removed: [], failed: [], kept: 0 });
  });

  it('requires an output folder rather than defaulting to somewhere', () => {
    expect(() => cleanScoFolder('')).toThrow(/outDir is required/);
  });
});
