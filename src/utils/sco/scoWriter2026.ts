/**
 * Shared machinery for S-Concrete **2026.0** beam .SCO files (Member Type 2).
 *
 * The 2026 format is one format with a unit/code switch, not two formats. A real
 * S-Concrete EN 1992 beam file and a real S-Concrete ACI 318 beam file carry the
 * SAME eight tables in the same order, the same `Bm *` field names, and the same
 * Sectional Loads layout. They differ in exactly three ways:
 *
 *   1. the header trio — `Codes` / `Units` / `Bar Type`
 *   2. the embedded bar table (European Ø vs US #-bars), which each template
 *      already carries, and which S-Concrete resolves BY INDEX
 *   3. the units every number is written in (mm/MPa/kN vs in/ksi/psi/kips)
 *
 * So this module holds the format mechanics and the field injection; the per-code
 * writers (`scoWriterEC2`, `scoWriterACI`) supply their own template, header trio,
 * number formatting and unit conversion. Nothing here knows what a millimetre is —
 * every value arrives already in the FILE's units.
 *
 * `Member Type 2` is the beam in this generation, for BOTH codes. (The legacy
 * Version-7 writer in `scoWriter.ts` assumed 1; see the note there.)
 */

// The samples are Windows-authored (CRLF). Preserve those line endings so the file
// still loads in S-Concrete — value matches must stop at \r as well as \t/\n.
export const EOL = '\r\n';

/** Round to 3 decimals. */
export const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Fixed-precision number with trailing zeros trimmed — "14", "11.811", "0.0118". */
export function trimNum(x: number, dp: number): string {
  if (!Number.isFinite(x)) return '0';
  const s = x.toFixed(dp).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** Number formatting matching the samples: ≤3 decimals, positives get a leading
 *  space, the minus sign of a negative takes that slot. */
export const sp = (x: number): string => (x < 0 ? '' : ' ') + String(r3(x));

/**
 * Replace every `Key\t value` occurrence in a template with a new value.
 *
 * The key must start a FIELD — i.e. sit at the start of a line or straight after a
 * tab. Without that anchor the pattern also matches the tail of longer field names,
 * silently rewriting neighbours: `fy` hits `Freezefy`, `fcu` hits `Freezefcu`
 * (turning booleans into stresses) and `Es` hits `FRPEs`. Everything the writers
 * set is a whole field, so anchoring costs nothing and stops the collateral damage.
 */
export function setParam(text: string, key: string, value: string | number): string {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\t)(${esc}\\t) ?[^\\t\\r\\n]*`, 'gm');
  if (!re.test(text)) throw new Error(`S-Concrete 2026 template missing field: ${key}`);
  re.lastIndex = 0; // `test` on a /g/ regex advances lastIndex — rewind before replacing
  return text.replace(re, `$1$2 ${value}`);
}

export const SO_HEADER =
  'LC\tNf\tTf\tVfz\tMfy\tCmy\tVfy\tMfz\tCmz\tPdistr\tCheckLC\tLoad Type\tComment\tAutoGen\tSustFactor\tServLdFactor';

export interface RowOpts { vfy?: number; mfz?: number; sust?: number; comment?: string }

/**
 * One Sectional Loads row (Table 16), in the file's own force units.
 *
 * The columns pair up: (Vfz, Mfy) and (Vfy, Mfz) — each shear with the moment it
 * accompanies. A beam's major-axis moment is Mfy, so its shear belongs in Vfz;
 * Vfy/Mfz are the minor-axis pair and stay 0.
 */
export function loadRow2026(i: number, nf: number, tf: number, vfz: number, mfy: number, opts: RowOpts = {}): string {
  const { vfy = 0, mfz = 0, sust = 1, comment = '--' } = opts;
  return ` ${i}\t${sp(nf)}\t${sp(tf)}\t${sp(vfz)}\t${sp(mfy)}\t 1\t${sp(vfy)}\t${sp(mfz)}\t 1\t 0\t1\t 1\t${comment}\t0\t ${sp(sust).trimStart()}\t 1`;
}

/** Swap the Sectional Loads table body for `rows`. Works on an empty table too —
 *  S-Concrete saves the template with no rows at all. */
export function replaceSectionalLoads(text: string, rows: string[]): string {
  const tag = `@Object@S-CONCRETE Sectional Loads@${EOL}@Table@16@${EOL}`;
  const start = text.indexOf(tag);
  if (start < 0) throw new Error('S-Concrete 2026 template missing the Sectional Loads table');
  const bodyStart = start + tag.length;
  const end = text.indexOf('@EndTable@', bodyStart);
  return text.slice(0, bodyStart) + SO_HEADER + EOL + rows.join(EOL) + EOL + text.slice(end);
}

/**
 * Distribute `total` bars of one face across S-Concrete's up-to-5 stacked layers
 * (NT/NB(1,j)), filling `perLayer` bars per row — so a face wider than one layer
 * holds is emitted as real layers instead of one impossibly-crowded row. Any
 * remainder beyond 5 layers folds into the last row (a degenerate case S-Concrete
 * will flag).
 */
export function splitLayers(total: number, perLayer: number, maxLayers = 5): number[] {
  if (total <= 0) return [0];
  const n = Math.max(1, perLayer);
  const layers: number[] = [];
  let rem = total;
  while (rem > 0 && layers.length < maxLayers) {
    const c = Math.min(rem, n);
    layers.push(c);
    rem -= c;
  }
  if (rem > 0) layers[layers.length - 1] += rem;
  return layers;
}

/**
 * A 2026 beam, with every value ALREADY in the target file's units. The writer does
 * no conversion — `scoWriterEC2` hands it mm/MPa, `scoWriterACI` hands it in/ksi/psi.
 */
export interface Beam2026Params {
  memberName: string;
  /** Header trio. Member Type is always 2 (beam) and is not negotiable. */
  codes: number; units: number; barType: number;
  /** Format a section dimension / cover / spacing. EC2 rounds to whole mm; ACI
   *  keeps decimals, because a 14" web is not a round number of anything. */
  fmtDim: (x: number) => string | number;
  /** Format a material value or crack-width limit (finer precision than fmtDim). */
  fmtVal: (x: number) => string | number;

  web: number; depth: number; flangeWidth: number; flangeThk: number; ignoreFlange: boolean;
  /** Governing cover, and the fallback for the three per-face covers. */
  cover: number;
  coverTop?: number; coverBottom?: number; coverSide?: number;

  fy: number; fcu: number; es: number;
  /** Concrete moduli. Omitted ⇒ the template's own values stand. */
  ec?: number; gc?: number;

  topLayers: number[]; topBarIdx: number;   // bars per stacked layer, top face
  botLayers: number[]; botBarIdx: number;   // bars per stacked layer, bottom face
  /** Skin bars PER FACE (the app's beam convention). Doubled into `Bm NbmFace`,
   *  which counts both faces. */
  faceCount: number; faceBarIdx: number;

  stirrupBarIdx: number; stirrupSpacing: number; stirrupLegs: number;

  crackWidthLimit: number;
  /** Emit the direct crack-width (SLS) check — `Bm CheckCracks` / `CheckCracksF`. */
  checkCracks: boolean;

  rows: string[]; // pre-built Sectional Loads rows
}

/** Inject a beam into a real S-Concrete 2026 template. */
export function buildBeamSco2026(template: string, p: Beam2026Params): string {
  let t = template;
  const dim = p.fmtDim;
  const val = p.fmtVal;

  // Header (Identifiers + Parameters tables both carry these).
  t = setParam(t, 'Codes', p.codes);
  t = setParam(t, 'Units', p.units);
  t = setParam(t, 'Bar Type', p.barType);
  t = setParam(t, 'Member Type', 2);
  t = setParam(t, 'Member Name', p.memberName);

  // Section
  t = setParam(t, 'Bm b', dim(p.web));
  t = setParam(t, 'Bm h', dim(p.depth));
  t = setParam(t, 'Bm bf', dim(p.flangeWidth));
  t = setParam(t, 'Bm hf', dim(p.flangeThk));
  t = setParam(t, 'Bm IgnoreFlange', p.ignoreFlange ? 1 : 0);
  const cTop = p.coverTop ?? p.cover;
  const cBot = p.coverBottom ?? p.cover;
  t = setParam(t, 'Bm Top', dim(cTop));
  t = setParam(t, 'Bm Bottom', dim(cBot));
  t = setParam(t, 'Bm Side', dim(p.coverSide ?? p.cover));

  // Materials
  t = setParam(t, 'fy', val(p.fy));
  t = setParam(t, 'fy2', val(p.fy));
  t = setParam(t, 'fy3', val(p.fy));
  t = setParam(t, 'fcu', val(p.fcu));
  t = setParam(t, 'Es', val(p.es));
  if (p.ec) t = setParam(t, 'Ec', val(p.ec));
  if (p.gc) t = setParam(t, 'Gc', val(p.gc));

  // Longitudinal bars — distribute each face across the stacked layers NT/NB(1,j)
  // (j = 1..5), so a face that needs two rows is emitted with real layers instead
  // of one crowded row. Curtain 2 (N(2,j)) is unused; every populated layer takes
  // the same bar size (SameDTop/SameDBot = 1 in both templates).
  const writeFace = (t0: string, N: 'NT' | 'NB', D: 'DT' | 'DB', layers: number[], barIdx: number): string => {
    let tt = t0;
    for (let j = 1; j <= 5; j++) {
      tt = setParam(tt, `Bm ${N}(1,${j})`, layers[j - 1] ?? 0);
      tt = setParam(tt, `Bm ${N}(2,${j})`, 0);
      tt = setParam(tt, `Bm ${D}(1,${j})`, barIdx);
      // Curtain 2 carries no bars, but leaving its bar size at the template's
      // value keeps a stale diameter in the file; match curtain 1.
      tt = setParam(tt, `Bm ${D}(2,${j})`, barIdx);
    }
    return tt;
  };
  t = writeFace(t, 'NT', 'DT', p.topLayers, p.topBarIdx);
  t = writeFace(t, 'NB', 'DB', p.botLayers, p.botBarIdx);

  // Side / skin face bars. ApplyFace drives whether S-Concrete DESIGNS/imposes face
  // (skin) steel; both templates ship it ON, so without honouring the cage a beam
  // that carries no side bars gets S-Concrete-invented ones.
  //
  // NbmFace counts BOTH faces, while the app's `sideBars.numBars` is per face (the
  // beam convention). Two independent real samples agree: the EN sample's 8 bars
  // (SbmFace 180 / ZbmFace 330, h 1200) and the ACI sample's 4 bars (SbmFace 7.087
  // / ZbmFace 8.268, h 23.622) each satisfy 2·Z + (n−1)·S = h only for n = NbmFace/2
  // per face. Passing the per-face count straight through halved the skin steel.
  const nPerFace = Math.max(0, Math.round(p.faceCount));
  t = setParam(t, 'Bm ApplyFace', nPerFace > 0 ? 1 : 0);
  t = setParam(t, 'Bm NbmFace', nPerFace * 2);
  t = setParam(t, 'Bm DbmFace', p.faceBarIdx);
  // Skin-bar geometry: spread the face bars evenly over the clear depth between the
  // top and bottom steel. Left at the template's fixed values they described the
  // SAMPLE beam's depth no matter what section was being written.
  if (nPerFace > 0) {
    const clear = Math.max(0, p.depth - cTop - cBot);
    const sFace = clear / (nPerFace + 1);
    t = setParam(t, 'Bm SbmFace', dim(sFace));
    t = setParam(t, 'Bm ZbmFace', dim((p.depth - (nPerFace - 1) * sFace) / 2));
  }

  // Stirrups
  t = setParam(t, 'Bm Dstir', p.stirrupBarIdx);
  t = setParam(t, 'Bm Sstir', dim(p.stirrupSpacing));
  t = setParam(t, 'Bm NlegsZ', p.stirrupLegs);
  t = setParam(t, 'Bm NlegsY', p.stirrupLegs);

  // Crack width. CheckCracks and CheckCracksF are the direct crack-width checks:
  // off in a ULS-only file, on in the SLS/crack file. CheckCracksF is a separate
  // template token, so setParam targets it independently. (`Bm CheckBarS` — the
  // deemed-to-satisfy bar-spacing check, which is what ACI 318 §24.3 actually is —
  // is intentionally left at the template default.)
  t = setParam(t, 'Bm CheckCracks', p.checkCracks ? 1 : 0);
  t = setParam(t, 'Bm CheckCracksF', p.checkCracks ? 1 : 0);
  t = setParam(t, 'Bm CrkWdthLmt', val(p.crackWidthLimit));

  // Forces
  t = replaceSectionalLoads(t, p.rows);
  return t;
}
