/**
 * The ACI 318 / imperial beam .SCO is validated against a REAL S-Concrete 2026 file
 * — Examples/SCRS/Level_3_B14X28_S12.SCO, which S-Concrete itself saved. That file
 * is the reference for this writer the same way scoReference.json is for the column
 * writer, so these tests compare against it rather than against our own opinion.
 *
 * The reference beam is the metric sample re-saved in imperial, which makes it
 * doubly useful: it pins the ACI/imperial field values AND confirms that the EN and
 * ACI 2026 files are one format with a unit/code switch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildAciBeamSco, aciBeamUlsRows, barIndexACI } from '../scoWriterACI';
import { buildGroupScoFiles } from '../scoBatch';
import type { Member } from '../../../types';

// The template IS the reference: templates/aciBeam.sco is a byte-for-byte copy of
// Examples/SCRS/Level_3_B14X28_S12.SCO. Read the copy under src/ rather than the
// Examples folder so the suite does not depend on sample files being present.
//
// Comparing our OUTPUT against the file we inject into is not circular: setParam
// throws on a missing field, but a loose pattern can still SPLIT one field into
// two or overwrite a neighbour, and the field-set and table-order checks below are
// what catch that (they are exactly how the old `fy` → `Freezefy` bug slipped in).
const SAMPLE = readFileSync(
  new URL('../templates/aciBeam.sco', import.meta.url), 'utf-8',
);

/** Read a `Key\t value` field. The key must START a field (line start or after a tab). */
function param(text: string, key: string): string | null {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp(`(?:^|\\t)${esc}\\t ?([^\\t\\r\\n]*)`, 'm'));
  return m ? m[1].trim() : null;
}
const num = (text: string, key: string): number => Number(param(text, key));

/** Every field NAME in the Parameters table (Table 60), which is where the writer
 *  does all its injection. Keys sit at even tab positions on each line. */
function paramKeys(text: string): Set<string> {
  const start = text.indexOf('@Table@60@');
  const end = text.indexOf('@EndTable@', start);
  const keys = new Set<string>();
  for (const line of text.slice(start, end).split(/\r?\n/).slice(1)) {
    const cells = line.split('\t');
    for (let i = 0; i < cells.length - 1; i += 2) if (cells[i].trim()) keys.add(cells[i].trim());
  }
  return keys;
}

/** Sectional Loads rows: c1=Nf c2=Tf c3=Vfz c4=Mfy c6=Vfy c7=Mfz, c12=Comment. */
function rowsOf(text: string) {
  const start = text.indexOf('@Table@16@');
  const end = text.indexOf('@EndTable@', start);
  return text.slice(start, end).split(/\r?\n/)
    .filter(l => /^\s*\d+\t/.test(l))
    .map(l => {
      const c = l.split('\t').map(s => s.trim());
      return { Nf: +c[1], Tf: +c[2], Vfz: +c[3], Mfy: +c[4], Vfy: +c[6], Mfz: +c[7], comment: c[12] };
    });
}

const IN = 1 / 25.4;
/** The reference beam, expressed the way the app would hold it (imperial). The
 *  numbers are the sample's own: a 500×600 web, 1500×125 flange, 40 mm cover. */
function referenceBeam(over: Partial<Member> = {}): Member {
  return {
    id: 'b1', label: 'Level_3_B14X28_S12', memberType: 'beam', span: 20,
    material: { fc: 5000, fy: 60000, fyt: 60000, Es: 29_000_000, lambdaConcrete: 1, Ec: 4_286_826 },
    section: {
      type: 'T_beam', b: 1500 * IN, h: 600 * IN, bw: 500 * IN, hf: 125 * IN,
      coverClear: 40 * IN, stirrupDia: 4,
    },
    rebar: {
      topBars: [{ numBars: 2, barSize: 8 }],
      botBars: [{ numBars: 2, barSize: 8 }],
      sideBars: [{ numBars: 2, barSize: 5 }],   // 2 PER FACE → NbmFace 4 in the sample
      ties: { barSize: 4, spacing: 200 * IN, legs: 2 },
    },
    loads: [],
    crackParams: { wLimitTop: 0.3, wLimitBot: 0.3, wLimitFace: 0.3, qpFactor: 0.6, kt: 0.4 },
    ...over,
  } as unknown as Member;
}

describe('the reference file is what we think it is', () => {
  it('is an ACI 318, imperial, 2026.0 BEAM saved by S-Concrete', () => {
    expect(param(SAMPLE, 'Version')).toBe('2026.0');
    expect(param(SAMPLE, 'Codes')).toBe('18');        // ACI 318
    expect(param(SAMPLE, 'Units')).toBe('0');         // imperial
    expect(param(SAMPLE, 'Bar Type')).toBe('2');      // US #-bars
    expect(param(SAMPLE, 'Member Type')).toBe('2');   // beam — NOT 1
  });

  it('writes lengths in inches, fy/Ec/Es in ksi and f\'c in psi', () => {
    expect(num(SAMPLE, 'Bm b')).toBeCloseTo(500 * IN, 4);       // 19.68504 in
    expect(num(SAMPLE, 'Bm h')).toBeCloseTo(600 * IN, 4);
    expect(num(SAMPLE, 'LuYY')).toBeCloseTo(3000 * IN, 3);
    expect(num(SAMPLE, 'fy')).toBe(60);                          // ksi
    expect(num(SAMPLE, 'Es')).toBe(29000);                       // ksi
    expect(num(SAMPLE, 'Ec')).toBeCloseTo(4286.826, 3);          // ksi
    expect(num(SAMPLE, 'fcu')).toBe(5000);                       // psi
    expect(num(SAMPLE, 'Bm CrkWdthLmt')).toBeCloseTo(0.3 * IN, 6); // 0.3 mm in inches
  });

  it('counts NbmFace across BOTH faces (2·Z + (n−1)·S = h closes only for n/2)', () => {
    const n = num(SAMPLE, 'Bm NbmFace') / 2;                     // 4 → 2 per face
    const S = num(SAMPLE, 'Bm SbmFace');
    const Z = num(SAMPLE, 'Bm ZbmFace');
    expect(2 * Z + (n - 1) * S).toBeCloseTo(num(SAMPLE, 'Bm h'), 4);
  });
});

describe('buildAciBeamSco — structural parity with the reference', () => {
  const t = buildAciBeamSco(referenceBeam());

  it('emits the same header S-Concrete does', () => {
    expect(param(t, 'Version')).toBe('2026.0');
    expect(param(t, 'Codes')).toBe('18');
    expect(param(t, 'Units')).toBe('0');
    expect(param(t, 'Bar Type')).toBe('2');
    expect(param(t, 'Member Type')).toBe('2');
  });

  it('carries every table the reference has, in the same order', () => {
    const objects = (s: string) => (s.match(/@Object@S-CONCRETE [^@]*@/g) ?? []);
    expect(objects(t)).toEqual(objects(SAMPLE));
  });

  it('neither drops nor invents a Parameters field', () => {
    // The writer only ever REPLACES values in the template, so the field set must
    // be identical — a mismatch means a setParam wrote a key that is not a field.
    expect([...paramKeys(t)].sort()).toEqual([...paramKeys(SAMPLE)].sort());
  });

  it('keeps CRLF line endings (the file will not load otherwise)', () => {
    expect(t.includes('\r\n')).toBe(true);
    expect(/[^\r]\n/.test(t)).toBe(false);   // no bare LF anywhere
  });
});

describe('buildAciBeamSco — the app\'s beam reaches the file', () => {
  const t = buildAciBeamSco(referenceBeam());

  it('reproduces the reference section, in inches and at full precision', () => {
    expect(num(t, 'Bm b')).toBeCloseTo(num(SAMPLE, 'Bm b'), 4);       // web 500 mm
    expect(num(t, 'Bm h')).toBeCloseTo(num(SAMPLE, 'Bm h'), 4);
    expect(num(t, 'Bm bf')).toBeCloseTo(num(SAMPLE, 'Bm bf'), 4);     // flange 1500 mm
    expect(num(t, 'Bm hf')).toBeCloseTo(num(SAMPLE, 'Bm hf'), 4);
    expect(param(t, 'Bm IgnoreFlange')).toBe('0');                     // T-beam
    expect(num(t, 'Bm Top')).toBeCloseTo(num(SAMPLE, 'Bm Top'), 4);
  });

  it('reproduces the reference materials in the file\'s own units', () => {
    expect(num(t, 'fy')).toBe(60);         // ksi
    expect(num(t, 'fcu')).toBe(5000);      // psi
    expect(num(t, 'Es')).toBe(29000);      // ksi
    expect(num(t, 'Ec')).toBeCloseTo(4286.826, 3);
    expect(num(t, 'Bm CrkWdthLmt')).toBeCloseTo(0.3 * IN, 5);
  });

  it('reproduces the reference cage and links', () => {
    expect(param(t, 'Bm NT(1,1)')).toBe('2');
    expect(param(t, 'Bm NB(1,1)')).toBe('2');
    expect(param(t, 'Bm DT(1,1)')).toBe('7');   // #8 → US bar-table index 7
    expect(param(t, 'Bm DB(1,1)')).toBe('7');
    expect(param(t, 'Bm Dstir')).toBe('3');     // #4 → index 3
    expect(num(t, 'Bm Sstir')).toBeCloseTo(num(SAMPLE, 'Bm Sstir'), 4);
    expect(param(t, 'Bm NlegsZ')).toBe('2');
    expect(param(t, 'Bm NlegsY')).toBe('2');
  });

  it('doubles the per-face skin count and closes the same geometry identity', () => {
    expect(param(t, 'Bm NbmFace')).toBe(param(SAMPLE, 'Bm NbmFace'));   // 4
    expect(param(t, 'Bm DbmFace')).toBe('4');                            // #5 → index 4
    const n = num(t, 'Bm NbmFace') / 2;
    expect(2 * num(t, 'Bm ZbmFace') + (n - 1) * num(t, 'Bm SbmFace')).toBeCloseTo(num(t, 'Bm h'), 3);
  });

  it('turns face steel off when the cage carries none', () => {
    const bare = buildAciBeamSco(referenceBeam({ rebar: { ...referenceBeam().rebar, sideBars: [] } } as Partial<Member>));
    expect(param(bare, 'Bm ApplyFace')).toBe('0');
    expect(param(bare, 'Bm NbmFace')).toBe('0');
  });

  it('names the member', () => {
    expect(param(t, 'Member Name')).toBe('Level_3_B14X28_S12');
  });
});

describe('aciBeamUlsRows — forces, imperial, both faces', () => {
  it('maps Pu→Nf, Tu→Tf, Vu→Vfz and the moment→Mfy, hogging on its own sign', () => {
    const m = referenceBeam({
      loads: [{ id: 'L1', label: '1.2D+1.6L', Mu_pos: 180, Mu_neg: -90, Vu: 45, Tu: 8, Pu: 3 }],
    } as Partial<Member>);
    const rows = rowsOf(buildAciBeamSco(m));
    expect(rows).toHaveLength(2);
    // Pu = +3 kips COMPRESSION leaves as Nf = −3: S-Concrete is compression-negative.
    expect(rows[0]).toMatchObject({ Nf: -3, Tf: 8, Vfz: 45, Mfy: 180, Vfy: 0, Mfz: 0 });
    expect(rows[1]).toMatchObject({ Nf: -3, Tf: 8, Vfz: 45, Mfy: -90, Vfy: 0, Mfz: 0 });
    expect(rows[0].comment).toContain('1.2D+1.6L');
  });

  it('a beam with no loads still produces one valid all-zero row', () => {
    const rows = rowsOf(buildAciBeamSco(referenceBeam()));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Nf: 0, Tf: 0, Vfz: 0, Mfy: 0 });
    for (const v of [rows[0].Nf, rows[0].Vfz, rows[0].Mfy]) expect(Number.isNaN(v)).toBe(false);
  });

  it('numbers rows consecutively across load cases', () => {
    const m = referenceBeam({
      loads: [
        { id: 'a', label: 'A', Mu_pos: 10, Mu_neg: -5, Vu: 1, Tu: 0, Pu: 0 },
        { id: 'b', label: 'B', Mu_pos: 20, Mu_neg: 0, Vu: 2, Tu: 0, Pu: 0 },
      ],
    } as Partial<Member>);
    expect(aciBeamUlsRows(m, 1).map(r => r.split('\t')[0].trim())).toEqual(['1', '2', '3']);
  });
});

describe('barIndexACI', () => {
  it('maps US bars to the index the file\'s embedded bar table uses', () => {
    // Table 4 in the reference: index 3 = No 4, 7 = No 8, 8 = No 9, 9 = No 10.
    expect(barIndexACI(4)).toBe(3);
    expect(barIndexACI(8)).toBe(7);
    expect(barIndexACI(9)).toBe(8);
    expect(barIndexACI(10)).toBe(9);
  });
  it('falls back to #8 for a metric size, which an ACI project should not have', () => {
    expect(barIndexACI(-20)).toBe(7);
  });
});

describe('the ACI batch path routes through this writer', () => {
  it('buildGroupScoFiles emits the 2026 ACI file, not the legacy Version 7 one', () => {
    const m = referenceBeam({
      loads: [{ id: 'L1', label: 'C1', Mu_pos: 100, Mu_neg: 0, Vu: 20, Tu: 0, Pu: 0 }],
    } as Partial<Member>);
    const [f] = buildGroupScoFiles([m], 'ACI318-19');
    expect(f.text.includes('Version\t2026.0')).toBe(true);
    expect(f.text.includes('Version\t 7')).toBe(false);
    expect(param(f.text, 'Member Type')).toBe('2');
  });
});
