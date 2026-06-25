import { formatBarLabel } from '../rebar';
import { PDFDocument, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Project, Member, DesignResults, LoadCase, DesignCode } from '../../types';
import { runDesign } from '../../engines';
import { designWallACI } from '../wallDesign';
import { getBarDiam, zoneShearDemands } from '../concreteDesign';
import { generateBreakdown, type CalcSection } from '../calcBreakdown';
import { generateBreakdownEC2 } from '../calcBreakdownEC2';
import { resolveCrack } from '../resolveCrack';
import { generateColumnBreakdown } from '../calcBreakdownColumn';
import { generateColumnBreakdownEC2 } from '../calcBreakdownColumnEC2';
import { generateWallBreakdown } from '../calcBreakdownWall';
import {
  OVERRIDE_KEY_LABEL, isOverridden, visibleWarnings, overrideEntries, effectiveStatus,
} from '../overrides';

/** What goes into the report and how it is scoped. */
export interface ReportOptions {
  /** Restrict to these member ids (in project order). Undefined = all members. */
  memberIds?: string[];
  /** Show only each member's governing load case (table + calcs) rather than all. */
  governingOnly: boolean;
  /** Include per-member shear & moment envelope diagrams (needs stationForces). */
  includeDiagrams: boolean;
  /** Include the step-by-step calculation breakdown with code clause references. */
  includeCalcs: boolean;
  /** Include the EC2 SLS crack-width line (only meaningful for EN1992-1-1). */
  includeCrack: boolean;
  /** Title-block job number, printed on the cover and page footers. */
  jobNumber?: string;
  /** Title-block revision tag (e.g. "A", "P1"). */
  revision?: string;
  /** Override project name on cover page. */
  reportName?: string;
  /** Override engineer name on cover page. */
  reportEngineer?: string;
  /** Override date on cover page. */
  reportDate?: string;
  /** Honor engineer overrides — suppress reviewed warnings, show review stamps,
   *  and green the overridden DCR bars. When false, raw results are shown.
   *  Optional; defaults to true via DEFAULT_REPORT_OPTIONS. */
  includeOverrides?: boolean;
}

export const DEFAULT_REPORT_OPTIONS: ReportOptions = {
  governingOnly: false,
  includeDiagrams: true,
  includeCalcs: true,
  includeCrack: true,
  includeOverrides: true,
};

/** Dimension/force/moment labels and value formatters keyed on unit system. */
interface UCtx {
  dimSfx: string;           // length suffix for section dims
  spanSfx: string;          // span suffix
  force: string;            // force unit label
  moment: string;           // moment unit label
  stressVal:    (psi: number) => string;
  stressBarVal: (psi: number) => string;
  // Converters from internal imperial storage to display value (number only)
  dim:    (inches: number)  => string;   // section length in" → "600" or "24.0"
  span:   (ft: number)      => string;   // span ft → "6.10" or "20.0"
  force_: (kips: number)    => string;   // force kips → "445.0" or "100.0"
  moment_:(kipft: number)   => string;   // moment kip-ft → "601.0" or "100.0"
}
function makeU(isEC2: boolean): UCtx {
  return isEC2 ? {
    dimSfx: ' mm',
    spanSfx: 'm',
    force: 'kN',
    moment: 'kN·m',
    stressVal:    (v) => `${(v * 0.00689476).toFixed(1)} MPa`,
    stressBarVal: (v) => `${(v * 0.00689476).toFixed(0)} MPa`,
    dim:    (v) => (v * 25.4).toFixed(0),
    span:   (v) => (v * 0.3048).toFixed(2),
    force_: (v) => (v * 4.44822).toFixed(1),
    moment_:(v) => (v * 1.35582).toFixed(1),
  } : {
    dimSfx: '"',
    spanSfx: 'ft',
    force: 'kips',
    moment: 'kip-ft',
    stressVal:    (v) => `${v}psi`,
    stressBarVal: (v) => `${(v / 1000).toFixed(0)}ksi`,
    dim:    (v) => v.toFixed(2),
    span:   (v) => v.toFixed(1),
    force_: (v) => v.toFixed(1),
    moment_:(v) => v.toFixed(1),
  };
}

// Project-level SLS quasi-permanent combo for the current report; set by
// buildReportBytes so the EC2 crack-width sheet + design results honour it
// (mirrors the module-level _resultCache lifecycle).
let _slsCombo: string | undefined;

function breakdownFor(m: Member, lc: LoadCase, code: DesignCode): CalcSection[] {
  const isWall = m.memberType === 'wall' && !!m.wallRebar;
  const isColumn = m.section.type === 'rectangular_column' || m.section.type === 'circular_column';
  const isEC2 = code === 'EN1992-1-1';
  if (isWall) return generateWallBreakdown(m.section, m.material, m.wallRebar!, lc);
  if (isColumn) {
    return isEC2
      ? generateColumnBreakdownEC2(m.section, m.material, m.rebar, lc)
      : generateColumnBreakdown(m.section, m.material, m.rebar, lc);
  }
  return isEC2
    ? generateBreakdownEC2(m.section, m.material, m.rebar, lc, m.span, resolveCrack(m, code, _slsCombo), _slsCombo)
    : generateBreakdown(
        m.section, m.material, m.rebar, lc, m.span,
        m.rebar.tieZones && m.stationForces?.length
          ? zoneShearDemands(m.stationForces, m.span ?? 20)
          : undefined,
      );
}

/**
 * DejaVu Sans is embedded as a Unicode TTF, so Greek letters, math symbols,
 * subscripts, and superscripts all render natively. This function only strips
 * C0/C1 control characters that are meaningless in a PDF text stream.
 */
export function winAnsiSafe(s: string): string {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '');
}

/**
 * Lazy-loaded DejaVu font bytes. The default loader fetches from /fonts/ (Vite
 * public dir — works in dev, Electron prod, and any HTTP host). Tests or Node
 * scripts can override this by calling setFontLoader() before generating PDFs.
 */
let _regularBytes: ArrayBuffer | null = null;
let _boldBytes: ArrayBuffer | null = null;
let _fontLoader: (() => Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }>) | null = null;

export function setFontLoader(fn: () => Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }>): void {
  _fontLoader = fn;
  _regularBytes = null;
  _boldBytes = null;
}

async function getFontBytes(): Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }> {
  if (_fontLoader) return _fontLoader();
  if (!_regularBytes || !_boldBytes) {
    // Use BASE_URL from Vite (defaults to './' in Electron builds); fall back to '/fonts/'
    const base = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) ?? './';
    const [r, b] = await Promise.all([
      fetch(`${base}fonts/DejaVuSans.ttf`).then(res => res.arrayBuffer()),
      fetch(`${base}fonts/DejaVuSans-Bold.ttf`).then(res => res.arrayBuffer()),
    ]);
    _regularBytes = r;
    _boldBytes = b;
  }
  return { regular: _regularBytes!, bold: _boldBytes! };
}

// Colour palette
const C = {
  navy:  rgb(0.04, 0.09, 0.24),
  blue:  rgb(0.11, 0.30, 0.85),
  green: rgb(0.06, 0.73, 0.51),
  amber: rgb(0.96, 0.62, 0.04),
  red:   rgb(0.94, 0.27, 0.27),
  light: rgb(0.96, 0.97, 0.99),
  mid:   rgb(0.56, 0.63, 0.72),
  dark:  rgb(0.20, 0.25, 0.33),
  white: rgb(1, 1, 1),
};

function dcrColor(dcr: number) {
  return dcr > 1 ? C.red : dcr > 0.9 ? C.amber : C.green;
}

function statusColor(status: string) {
  return status === 'NG' ? C.red : status === 'Warning' ? C.amber : C.green;
}

interface DrawCtx {
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  w: number;
  h: number;
  margin: number;
}

function text(ctx: DrawCtx, str: string, x: number, y: number, size = 9,
  color = C.dark, fontOverride?: PDFFont) {
  ctx.page.drawText(winAnsiSafe(String(str)), {
    x, y, size, color, font: fontOverride ?? ctx.font,
  });
}

function rect(ctx: DrawCtx, x: number, y: number, w: number, h: number, fill = C.light) {
  ctx.page.drawRectangle({ x, y, width: w, height: h, color: fill, borderWidth: 0 });
}

function line(ctx: DrawCtx, x1: number, y1: number, x2: number, y2: number, thickness = 0.5, color = C.mid) {
  ctx.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
}

function worstDCROf(r: DesignResults): number {
  return Math.max(r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion,
    r.DCR_PM ?? 0, r.DCR_axial ?? 0,
    r.DCR_shear_wall ?? 0, r.DCR_flex_wall ?? 0, r.DCR_sbzAsh ?? 0,
    r.DCR_crack ?? 0);
}

/** Routes walls to the wall engine (same branch as the results screen). */
const _resultCache = new Map<string, DesignResults>();
function memberResult(m: Member, lc: LoadCase, code?: string): DesignResults {
  const key = `${m.id}|${lc.id}|${code ?? ''}`;
  const hit = _resultCache.get(key);
  if (hit) return hit;
  const r = m.memberType === 'wall' && m.wallRebar
    ? designWallACI(m.section, m.material, m.wallRebar, lc)
    : runDesign(m.section, m.material, m.rebar, lc, m.span ?? 20, code, resolveCrack(m, code ?? '', _slsCombo));
  _resultCache.set(key, r);
  return r;
}

function worstResult(m: Member, code?: string): DesignResults | null {
  let worst: DesignResults | null = null;
  for (const lc of m.loads) {
    const r = memberResult(m, lc, code);
    if (!worst || worstDCROf(r) > worstDCROf(worst)) worst = r;
  }
  return worst;
}

function circle(ctx: DrawCtx, x: number, y: number, r: number, fill = C.dark) {
  ctx.page.drawCircle({ x, y, size: r, color: fill });
}

/**
 * Vector sketch of the member cross-section (bottom-left anchored box).
 * Ports the SectionView geometry: concrete outline, stirrup inset, bar
 * circles per layer; circular columns pool bars on a ring; walls draw a
 * plan view with SBZ end zones.
 */
function drawSectionSketch(ctx: DrawCtx, m: Member, x: number, y: number, boxW: number, boxH: number, u: UCtx = makeU(false)): void {
  const s = m.section;
  const pad = 14;
  const innerW = boxW - 2 * pad, innerH = boxH - 2 * pad - 10; // 10pt for caption
  rect(ctx, x, y, boxW, boxH, C.light);
  text(ctx, 'Section', x + 6, y + boxH - 12, 8, C.dark, ctx.bold);

  if (s.type === 'circular_column') {
    const D = s.diameter ?? s.b;
    const scale = Math.min(innerW / D, innerH / D);
    const R = (D / 2) * scale;
    const cx = x + boxW / 2, cy = y + pad + innerH / 2;
    ctx.page.drawCircle({ x: cx, y: cy, size: R, borderColor: C.dark, borderWidth: 1, color: C.white });
    const stOff = (s.coverClear + getBarDiam(s.stirrupDia) / 2) * scale;
    ctx.page.drawCircle({ x: cx, y: cy, size: R - stOff, borderColor: C.blue, borderWidth: 0.8, color: undefined });
    const groups = [...m.rebar.topBars, ...m.rebar.botBars, ...(m.rebar.sideBars ?? [])].filter(g => g.numBars > 0);
    const n = groups.reduce((t, g) => t + g.numBars, 0);
    if (n > 0) {
      const rb = Math.max(1.5, (getBarDiam(groups[0].barSize) / 2) * scale);
      const ringR = R - stOff - rb - 1;
      for (let i = 0; i < n; i++) {
        const ang = (2 * Math.PI * i) / n - Math.PI / 2;
        circle(ctx, cx + ringR * Math.cos(ang), cy + ringR * Math.sin(ang), rb);
      }
    }
    text(ctx, `dia ${u.dim(D)}${u.dimSfx}`, cx - 14, y + 4, 7, C.mid);
    return;
  }

  if (s.type === 'shear_wall') {
    const lw = s.lw ?? s.b, tw = s.tw ?? s.h ?? 12;
    const scale = Math.min(innerW / lw, innerH / tw);
    const planW = lw * scale, planH = Math.max(8, tw * scale);
    const px = x + (boxW - planW) / 2, py = y + pad + (innerH - planH) / 2;
    ctx.page.drawRectangle({ x: px, y: py, width: planW, height: planH, borderColor: C.dark, borderWidth: 1, color: C.white });
    const wr = m.wallRebar;
    const sbzLen = 0.15 * lw * scale; // sketch-level approximation of lbe
    for (const ex of [px, px + planW - sbzLen]) {
      ctx.page.drawRectangle({ x: ex, y: py, width: sbzLen, height: planH, color: rgb(0.99, 0.93, 0.78) });
      ctx.page.drawRectangle({ x: ex, y: py, width: sbzLen, height: planH, borderColor: C.amber, borderWidth: 0.7, color: undefined });
      const nb = Math.max(2, Math.round((wr?.sbzNumBars ?? 8) / 2));
      for (let i = 0; i < nb; i++) {
        const bx = ex + sbzLen * (i + 0.5) / nb;
        circle(ctx, bx, py + planH * 0.25, 1.3);
        circle(ctx, bx, py + planH * 0.75, 1.3);
      }
    }
    if (wr) {
      const webX0 = px + sbzLen + 4, webX1 = px + planW - sbzLen - 4;
      const nWeb = Math.max(2, Math.floor((webX1 - webX0) / Math.max(4, wr.vertSpacing * scale)));
      const curtainYs = wr.numCurtains === 2 ? [py + planH * 0.25, py + planH * 0.75] : [py + planH * 0.5];
      for (const cyW of curtainYs)
        for (let i = 0; i <= nWeb; i++)
          circle(ctx, webX0 + (webX1 - webX0) * (i / nWeb), cyW, 1, C.mid);
    }
    text(ctx, `lw=${u.dim(lw)}${u.dimSfx}  tw=${u.dim(tw)}${u.dimSfx}  (plan, SBZ ends shaded)`, px, y + 4, 7, C.mid);
    return;
  }

  // Rectangular beam / column (T/L drawn as web rectangle for simplicity)
  const secW = s.type === 'T_beam' || s.type === 'L_beam' ? (s.bw ?? s.b) : s.b;
  const secH = s.h ?? 12;
  const scale = Math.min(innerW / secW, innerH / secH);
  const rw = secW * scale, rh = secH * scale;
  const rx = x + (boxW - rw) / 2, ry = y + pad + (innerH - rh) / 2;
  ctx.page.drawRectangle({ x: rx, y: ry, width: rw, height: rh, borderColor: C.dark, borderWidth: 1, color: C.white });
  const stOff = (s.coverClear + getBarDiam(s.stirrupDia) / 2) * scale;
  ctx.page.drawRectangle({ x: rx + stOff, y: ry + stOff, width: rw - 2 * stOff, height: rh - 2 * stOff, borderColor: C.blue, borderWidth: 0.8, color: undefined });
  // crosstie legs
  const legs = m.rebar.ties?.legs ?? 2;
  for (let i = 0; i < legs - 2; i++) {
    const lx = rx + stOff + (rw - 2 * stOff) * (i + 1) / (legs - 1);
    line(ctx, lx, ry + stOff, lx, ry + rh - stOff, 0.8, C.blue);
  }
  const sClear = (m.rebar.layerClearSpacing ?? 1.0) * scale;
  for (const [bars, isTop] of [[m.rebar.topBars, true], [m.rebar.botBars, false]] as const) {
    let inset = 0;
    for (const g of bars) {
      if (g.numBars <= 0) continue;
      const rb = Math.max(1.2, Math.min((getBarDiam(g.barSize) / 2) * scale, (rw - 2 * stOff) / (2 * g.numBars)));
      const by = isTop ? ry + rh - stOff - inset - rb : ry + stOff + inset + rb;
      const x0 = rx + stOff + rb, x1 = rx + rw - stOff - rb;
      for (let i = 0; i < g.numBars; i++) {
        const bx = g.numBars === 1 ? rx + rw / 2 : x0 + (x1 - x0) * (i / (g.numBars - 1));
        circle(ctx, bx, by, rb);
      }
      inset += getBarDiam(g.barSize) * scale + sClear;
    }
  }
  text(ctx, `b=${u.dim(secW)}${u.dimSfx}  h=${u.dim(secH)}${u.dimSfx}`, rx, y + 4, 7, C.mid);
}

/** Horizontal DCR bar with a marker at 1.0; track spans dcr 0–1.5. */
function drawDCRBar(ctx: DrawCtx, label: string, dcr: number, x: number, y: number, w: number, overridden = false): void {
  const trackW = w - 100;
  // An engineer-overridden check renders green regardless of its true DCR.
  const clr = overridden ? C.green : dcrColor(dcr);
  text(ctx, label, x, y, 8, C.dark);
  rect(ctx, x + 60, y - 1, trackW, 8, C.light);
  const fillW = Math.min(Math.max(dcr, 0), 1.5) / 1.5 * trackW;
  if (fillW > 0) rect(ctx, x + 60, y - 1, fillW, 8, clr);
  const oneX = x + 60 + (1.0 / 1.5) * trackW;
  line(ctx, oneX, y - 3, oneX, y + 9, 0.8, C.dark);
  text(ctx, overridden ? `${dcr.toFixed(2)} ✓` : dcr.toFixed(2), x + 60 + trackW + 6, y, 8, clr, ctx.bold);
}

async function addPage(doc: PDFDocument, font: PDFFont, bold: PDFFont): Promise<DrawCtx> {
  const page = doc.addPage([612, 792]);
  return { page, font, bold, w: 612, h: 792, margin: 48 };
}

/** Identify the governing (worst DCR) load case for a member. */
function governingLoad(m: Member, code?: string): LoadCase | null {
  let worst: { lc: LoadCase; dcr: number } | null = null;
  for (const lc of m.loads) {
    const dcr = worstDCROf(memberResult(m, lc, code));
    if (!worst || dcr > worst.dcr) worst = { lc, dcr };
  }
  return worst?.lc ?? null;
}

/** Truncate a string to fit maxW points, appending "..." if clipped. */
function clipText(font: PDFFont, str: string, size: number, maxW: number): string {
  const safe = winAnsiSafe(str);
  if (font.widthOfTextAtSize(safe, size) <= maxW) return safe;
  const ell = '...';
  const ellW = font.widthOfTextAtSize(ell, size);
  let out = '';
  for (const ch of safe) {
    if (font.widthOfTextAtSize(out + ch, size) + ellW > maxW) break;
    out += ch;
  }
  return out + ell;
}

/** Greedy word-wrap to a pixel width for a given font/size. */
function wrapText(font: PDFFont, size: number, str: string, maxW: number): string[] {
  const safe = winAnsiSafe(String(str));
  if (!safe) return [''];
  const words = safe.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) <= maxW || !cur) cur = test;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

interface EnvPoint { x: number; Vmax: number; Vmin: number; Mmax: number; Mmin: number }

/** Envelope of imported combos at each station (ported from ForceDiagram). */
function buildEnvelope(m: Member): EnvPoint[] {
  const forces = m.stationForces ?? [];
  const xs = new Set<number>();
  for (const cf of forces) for (const st of cf.stations) xs.add(st.x);
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.map(x => {
    let Vmax = -Infinity, Vmin = Infinity, Mmax = -Infinity, Mmin = Infinity;
    for (const cf of forces) {
      const sta = cf.stations;
      let v: number | null = null, mm: number | null = null;
      for (let i = 0; i < sta.length; i++) {
        if (sta[i].x === x) { v = sta[i].V; mm = sta[i].M; break; }
        if (i > 0 && sta[i - 1].x < x && x < sta[i].x) {
          const t = (x - sta[i - 1].x) / (sta[i].x - sta[i - 1].x);
          v = sta[i - 1].V + t * (sta[i].V - sta[i - 1].V);
          mm = sta[i - 1].M + t * (sta[i].M - sta[i - 1].M);
          break;
        }
      }
      if (v == null || mm == null) continue;
      Vmax = Math.max(Vmax, v); Vmin = Math.min(Vmin, v);
      Mmax = Math.max(Mmax, mm); Mmin = Math.min(Mmin, mm);
    }
    return { x: +x.toFixed(2), Vmax, Vmin, Mmax, Mmin };
  });
}

/** One labelled XY plot: filled envelope band + dashed capacity limits. */
function drawEnvelopeChart(
  ctx: DrawCtx, title: string, pts: EnvPoint[], getMax: (p: EnvPoint) => number,
  getMin: (p: EnvPoint) => number, capPos: number | null, capNeg: number | null,
  capLabel: string, x: number, y: number, plotW: number, plotH: number,
  band: ReturnType<typeof rgb>, stroke: ReturnType<typeof rgb>,
): void {
  text(ctx, title, x, y + plotH + 4, 8, C.dark, ctx.bold);
  const span = pts[pts.length - 1].x - pts[0].x || 1;
  const lo = Math.min(0, ...pts.map(getMin), capNeg ?? 0);
  const hi = Math.max(0, ...pts.map(getMax), capPos ?? 0);
  const range = hi - lo || 1;
  const px = (v: number) => x + ((v - pts[0].x) / span) * plotW;
  const py = (v: number) => y + ((v - lo) / range) * plotH;
  rect(ctx, x, y, plotW, plotH, C.light);
  // zero axis
  const y0 = py(0);
  line(ctx, x, y0, x + plotW, y0, 0.6, C.mid);
  // envelope band as stacked vertical fills + max/min polylines
  for (let i = 1; i < pts.length; i++) {
    const ax = px(pts[i - 1].x), bx = px(pts[i].x);
    // max polyline
    line(ctx, ax, py(getMax(pts[i - 1])), bx, py(getMax(pts[i])), 1, stroke);
    line(ctx, ax, py(getMin(pts[i - 1])), bx, py(getMin(pts[i])), 1, stroke);
    // light fill columns between min and max
    const colTop = py(Math.max(getMax(pts[i - 1]), getMax(pts[i])));
    const colBot = py(Math.min(getMin(pts[i - 1]), getMin(pts[i])));
    if (colTop - colBot > 0) rect(ctx, ax, colBot, bx - ax, colTop - colBot, band);
  }
  // redraw polylines on top of fill
  for (let i = 1; i < pts.length; i++) {
    const ax = px(pts[i - 1].x), bx = px(pts[i].x);
    line(ctx, ax, py(getMax(pts[i - 1])), bx, py(getMax(pts[i])), 1, stroke);
    line(ctx, ax, py(getMin(pts[i - 1])), bx, py(getMin(pts[i])), 1, stroke);
  }
  if (capPos != null) {
    line(ctx, x, py(capPos), x + plotW, py(capPos), 0.8, C.green);
    text(ctx, `${capLabel}+`, x + plotW - 34, py(capPos) + 2, 6, C.green);
  }
  if (capNeg != null) {
    line(ctx, x, py(capNeg), x + plotW, py(capNeg), 0.8, C.red);
    text(ctx, `${capLabel}-`, x + plotW - 34, py(capNeg) - 7, 6, C.red);
  }
  text(ctx, hi.toFixed(0), x - 2, y + plotH - 4, 6, C.mid);
  text(ctx, lo.toFixed(0), x - 2, y, 6, C.mid);
}

/** Draws shear + moment envelope diagrams; returns the height consumed. */
function drawForceDiagrams(ctx: DrawCtx, m: Member, result: DesignResults, x: number, y: number, fullW: number, u: UCtx = makeU(false)): number {
  const rawPts = buildEnvelope(m);
  if (rawPts.length < 2) return 0;
  const plotW = fullW - 30;
  const plotH = 56;
  // buildEnvelope returns imperial (kips, kip-ft, ft); convert to display units for plots.
  const isEC2 = u.force === 'kN';
  const vFac  = isEC2 ? 4.44822  : 1;  // kips → kN
  const mFac  = isEC2 ? 1.35582  : 1;  // kip-ft → kN·m
  const xFac  = isEC2 ? 0.3048   : 1;  // ft → m
  const pts = rawPts.map(p => ({
    x: p.x * xFac, Vmax: p.Vmax * vFac, Vmin: p.Vmin * vFac,
    Mmax: p.Mmax * mFac, Mmin: p.Mmin * mFac,
  }));
  drawEnvelopeChart(ctx, `Shear envelope V (${u.force})`, pts, p => p.Vmax, p => p.Vmin,
    result.phi_Vn * vFac, -result.phi_Vn * vFac, 'phiVn', x + 24, y - plotH, plotW, plotH,
    rgb(0.99, 0.90, 0.55), C.amber);
  drawEnvelopeChart(ctx, `Moment envelope M (${u.moment})`, pts, p => p.Mmax, p => p.Mmin,
    result.phi_Mn_pos * mFac, -result.phi_Mn_neg * mFac, 'phiMn', x + 24, y - plotH * 2 - 28, plotW, plotH,
    rgb(0.75, 0.85, 0.99), C.blue);
  return plotH * 2 + 40;
}

/**
 * Renders calc-breakdown sections as paginated tables.
 * Columns: Ref | Description | Equation | Substitution | Result.
 * Returns the ctx/y after drawing (may have added pages).
 */
async function drawCalcSections(
  doc: PDFDocument, font: PDFFont, bold: PDFFont, ctx: DrawCtx,
  sections: CalcSection[], yStart: number,
): Promise<{ ctx: DrawCtx; y: number }> {
  const { w, margin } = ctx;
  const usable = w - 2 * margin;
  // column x-offsets and widths
  const cw = { ref: 46, label: 140, eq: 132, sub: 110, res: usable - 46 - 140 - 132 - 110 };
  const cx = {
    ref: 0, label: cw.ref, eq: cw.ref + cw.label,
    sub: cw.ref + cw.label + cw.eq, res: cw.ref + cw.label + cw.eq + cw.sub,
  };
  let y = yStart;

  for (const sec of sections) {
    if (y - 28 < margin + 16) { ctx = await addPage(doc, font, bold); y = ctx.h - margin; }
    // section title bar
    rect(ctx, margin, y - 14, usable, 16, C.dark);
    text(ctx, sec.title, margin + 6, y - 11, 9, C.white, bold);
    y -= 18;
    // header row
    rect(ctx, margin, y - 12, usable, 13, C.light);
    (['Ref', 'Description', 'Equation', 'Substitution', 'Result'] as const).forEach((hd, i) => {
      const ox = [cx.ref, cx.label, cx.eq, cx.sub, cx.res][i];
      text(ctx, hd, margin + ox + 2, y - 9, 7, C.mid, bold);
    });
    y -= 15;
    for (const step of sec.steps) {
      const labelLines = wrapText(font, 7, `${step.label}${step.note ? '  (' + step.note + ')' : ''}`, cw.label - 4);
      const eqLines = wrapText(font, 7, step.equation, cw.eq - 4);
      const subLines = wrapText(font, 7, step.substitution, cw.sub - 4);
      const rowLines = Math.max(1, labelLines.length, eqLines.length, subLines.length);
      const rowH = rowLines * 9 + 4;
      if (y - rowH < margin + 16) { ctx = await addPage(doc, font, bold); y = ctx.h - margin; }
      const ng = step.result.includes('✗');
      const ok = step.result.includes('✓') && step.result.includes('DCR');
      rect(ctx, margin, y - rowH + 4, usable, rowH, ng ? rgb(0.99, 0.95, 0.95) : ok ? rgb(0.95, 0.99, 0.96) : C.white);
      text(ctx, step.ref.replace(/^ACI\s+318-\d+\s*/i, ''), margin + cx.ref + 2, y - 5, 7, C.blue);
      labelLines.forEach((ln, i) => text(ctx, ln, margin + cx.label + 2, y - 5 - i * 9, 7, C.dark));
      eqLines.forEach((ln, i) => text(ctx, ln, margin + cx.eq + 2, y - 5 - i * 9, 7, rgb(0.49, 0.23, 0.93)));
      subLines.forEach((ln, i) => text(ctx, ln, margin + cx.sub + 2, y - 5 - i * 9, 7, C.mid));
      text(ctx, winAnsiSafe(step.result), margin + cx.res + 2, y - 5, 7,
        ng ? C.red : ok ? C.green : C.dark, bold);
      y -= rowH;
    }
    y -= 8;
  }
  return { ctx, y };
}

/**
 * Build the report PDF and return its bytes (used by both the preview pane and
 * the download path). Honors ReportOptions for scope and content.
 */
export async function buildReportBytes(
  project: Project, options: ReportOptions = DEFAULT_REPORT_OPTIONS,
): Promise<Uint8Array> {
  _resultCache.clear();
  _slsCombo = project.slsCombo;
  const opts = { ...DEFAULT_REPORT_OPTIONS, ...options };
  const members = opts.memberIds
    ? project.members.filter(m => opts.memberIds!.includes(m.id))
    : project.members;
  const code = project.code as DesignCode;
  const isEC2 = project.code === 'EN1992-1-1';
  const u = makeU(isEC2);
  const reportName     = opts.reportName     ?? project.name;
  const reportEngineer = opts.reportEngineer ?? project.engineer;
  const reportDate     = opts.reportDate     ?? project.date;

  const doc   = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const { regular: rb, bold: bb } = await getFontBytes();
  const font  = await doc.embedFont(rb);
  const bold  = await doc.embedFont(bb);

  // ── Cover page ────────────────────────────────────────────────────────────
  let ctx = await addPage(doc, font, bold);
  const { w, h, margin } = ctx;

  rect(ctx, 0, h - 100, w, 100, C.navy);
  text(ctx, 'S-Concrete Design', margin, h - 44, 24, C.white, bold);
  text(ctx, `${project.code}  Reinforced Concrete Design Report`, margin, h - 66, 11, C.mid);

  text(ctx, 'Project', margin, h - 130, 9, C.mid);
  text(ctx, reportName, margin, h - 145, 14, C.dark, bold);
  text(ctx, 'Engineer', margin + 300, h - 130, 9, C.mid);
  text(ctx, reportEngineer, margin + 300, h - 145, 12, C.dark);
  text(ctx, 'Date', margin, h - 168, 9, C.mid);
  text(ctx, reportDate, margin, h - 181, 10, C.dark);
  text(ctx, 'Design Code', margin + 300, h - 168, 9, C.mid);
  text(ctx, project.code, margin + 300, h - 181, 10, C.dark);
  // Title-block job number / revision
  if (opts.jobNumber) { text(ctx, 'Job No.', margin, h - 192, 9, C.mid); text(ctx, opts.jobNumber, margin + 60, h - 192, 9, C.dark, bold); }
  if (opts.revision)  { text(ctx, 'Revision', margin + 300, h - 192, 9, C.mid); text(ctx, opts.revision, margin + 360, h - 192, 9, C.dark, bold); }

  line(ctx, margin, h - 208, w - margin, h - 208);

  // Member summary table
  // cols: Label(0) Type(120) Section(178) f'c(258) Flex+(302) Flex-(344) Shear(386) Tors(428) Status(470)
  text(ctx, 'Member Summary', margin, h - 228, 11, C.dark, bold);
  const cols = [0, 120, 178, 258, 302, 344, 386, 428, 470];
  const hdrs = ['Label', 'Type', 'Section', "f'c", 'Flex+', 'Flex-', 'Shear', 'Tors.', 'Status'];
  rect(ctx, margin, h - 254, w - 2 * margin, 16, C.navy);
  hdrs.forEach((hdr, i) => text(ctx, hdr, margin + cols[i], h - 251, 8, C.white, bold));

  let row = h - 268;
  for (const m of members) {
    const r = worstResult(m, project.code);
    if (!r) continue;
    const summaryStatus = opts.includeOverrides ? effectiveStatus(r, m.overrides) : r.status;
    if (row < margin + 20) { ctx = await addPage(doc, font, bold); row = ctx.h - margin; }
    const bg = members.indexOf(m) % 2 === 0 ? C.light : C.white;
    rect(ctx, margin, row - 2, w - 2 * margin, 14, bg);
    const sec = m.section.type === 'circular_column'
      ? `dia${u.dim(m.section.diameter ?? m.section.b)}${u.dimSfx}`
      : `${u.dim(m.section.b)}${u.dimSfx}x${u.dim(m.section.h)}${u.dimSfx}`;
    const wall = m.memberType === 'wall' && !!m.wallRebar;
    const fcLabel = isEC2 ? `${(m.material.fc * 0.00689476).toFixed(0)}MPa` : `${(m.material.fc / 1000).toFixed(0)}ksi`;
    const dp2 = (n: number) => n.toFixed(2);
    const vals = [clipText(font, m.label, 8, 116), m.memberType, clipText(font, sec, 8, 76),
      fcLabel,
      dp2(wall ? (r.DCR_flex_wall ?? 0) : r.DCR_flex_pos),
      wall ? '-' : dp2(r.DCR_flex_neg),
      dp2(wall ? (r.DCR_shear_wall ?? 0) : r.DCR_shear),
      wall ? '-' : dp2(r.DCR_torsion), summaryStatus];
    vals.forEach((v, i) => {
      let clr = C.dark;
      if (i === 8) clr = statusColor(summaryStatus);
      else if (i >= 4 && i <= 7) clr = dcrColor(parseFloat(v));
      text(ctx, v, margin + cols[i], row, 8, clr);
    });
    row -= 14;
  }

  // ── Per-member pages ─────────────────────────────────────────────────────
  for (const m of members) {
    ctx = await addPage(doc, font, bold);
    let y = ctx.h - margin;
    const govLc = governingLoad(m, code);
    const lcsToShow = opts.governingOnly && govLc ? [govLc] : m.loads;

    // Member header
    rect(ctx, margin, y - 34, w - 2 * margin, 38, C.navy);
    text(ctx, `${m.id} — ${m.label}`, margin + 8, y - 14, 13, C.white, bold);
    const secStr = m.section.type === 'circular_column'
      ? `dia${u.dim(m.section.diameter ?? m.section.b)}${u.dimSfx}`
      : `${u.dim(m.section.b)}${u.dimSfx}×${u.dim(m.section.h)}${u.dimSfx}`;
    text(ctx, `${m.section.type.replace(/_/g, ' ')}  ${secStr}  f'c=${u.stressVal(m.material.fc)}  fy=${u.stressBarVal(m.material.fy)}  span=${m.span != null ? u.span(m.span) + u.spanSfx : '-'}`,
      margin + 8, y - 28, 8, C.mid);
    y -= 50;

    // Section properties box (left) + section sketch (right)
    const halfW = (w - 2 * margin) / 2 - 5;
    rect(ctx, margin, y - 50, halfW, 52, C.light);
    text(ctx, 'Section & Material', margin + 6, y - 12, 8, C.dark, bold);
    const props = [
      [`b=${u.dim(m.section.b)}${u.dimSfx}`, `h=${u.dim(m.section.h)}${u.dimSfx}`, `cc=${u.dim(m.section.coverClear)}${u.dimSfx}`],
      [`f'c=${u.stressVal(m.material.fc)}`, `fy=${u.stressBarVal(m.material.fy)}`, `fyt=${u.stressBarVal(m.material.fyt)}`],
      [`lambda=${m.material.lambdaConcrete}`, `Stirrup ${formatBarLabel(m.section.stirrupDia)}`, `Span ${m.span != null ? u.span(m.span) + u.spanSfx : '-'}`],
    ];
    props.forEach((row2, ri) =>
      row2.forEach((v, ci) => text(ctx, v, margin + 8 + ci * 70, y - 24 - ri * 12, 8)));
    drawSectionSketch(ctx, m, margin + halfW + 10, y - 118, halfW, 120, u);
    y -= 126;

    // Load case results table
    text(ctx, 'Design Results by Load Case', margin, y - 8, 10, C.dark, bold);
    y -= 20;
    const isWall = m.memberType === 'wall' && !!m.wallRebar;
    const isBeam = m.memberType === 'beam';
    const M = u.moment, F = u.force;
    // Beam gets an extra DCR Torsion column; wall and column share a simpler layout.
    const lcHdrs = isWall
      ? ['Load Case', `Mu (${M})`, `Vu (${F})`, `Pu (${F})`, `phiMn (${M})`, `phiVn (${F})`, 'DCR P-M', 'DCR V', 'DCR Ash', 'SBZ', 'Status']
      : isBeam
      ? ['Load Case', `Mu+ (${M})`, `Mu- (${M})`, `Vu (${F})`, `phiMn+ (${M})`, `phiMn- (${M})`, `phiVn (${F})`, 'DCR Fl+', 'DCR Fl-', 'DCR V', 'DCR Tor.', 'Status']
      : ['Load Case', `Mu+ (${M})`, `Mu- (${M})`, `Vu (${F})`, `phiMn+ (${M})`, `phiMn- (${M})`, `phiVn (${F})`, 'DCR Fl+', 'DCR Fl-', 'DCR V', 'Status'];
    const lcCols = isWall
      ? [0, 72, 118, 164, 200, 252, 304, 352, 384, 416, 445]
      : isBeam
      ? [0, 68, 112, 156, 196, 243, 290, 334, 366, 398, 428, 458]
      : [0, 72, 118, 164, 200, 252, 304, 352, 384, 416, 445];
    rect(ctx, margin, y - 4, w - 2 * margin, 14, C.navy);
    lcHdrs.forEach((hdr, i) => text(ctx, hdr, margin + lcCols[i], y - 1, 7, C.white, bold));
    y -= 16;

    for (const lc of lcsToShow) {
      const r = memberResult(m, lc, project.code);
      const dispStatus = opts.includeOverrides ? effectiveStatus(r, m.overrides) : r.status;
      const bg = lcsToShow.indexOf(lc) % 2 === 0 ? C.light : C.white;
      rect(ctx, margin, y - 2, w - 2 * margin, 12, bg);
      const lcLabel = clipText(font, lc.label, 7, lcCols[1] - 4);
      const lcVals = isWall
        ? [lcLabel,
            u.moment_(Math.max(lc.Mu_pos, lc.Mu_neg)), u.force_(lc.Vu), u.force_(lc.Pu),
            u.moment_(r.phi_Mn_wall ?? 0), u.force_(r.phi_Vn_wall ?? 0),
            (r.DCR_flex_wall ?? 0).toFixed(2), (r.DCR_shear_wall ?? 0).toFixed(2),
            (r.DCR_sbzAsh ?? 0).toFixed(2), r.sbzRequired ? 'Yes' : 'No', dispStatus]
        : isBeam
        ? [lcLabel,
            u.moment_(lc.Mu_pos), u.moment_(lc.Mu_neg), u.force_(lc.Vu),
            u.moment_(r.phi_Mn_pos), u.moment_(r.phi_Mn_neg), u.force_(r.phi_Vn),
            r.DCR_flex_pos.toFixed(2), r.DCR_flex_neg.toFixed(2), r.DCR_shear.toFixed(2),
            r.DCR_torsion.toFixed(2), dispStatus]
        : [lcLabel,
            u.moment_(lc.Mu_pos), u.moment_(lc.Mu_neg), u.force_(lc.Vu),
            u.moment_(r.phi_Mn_pos), u.moment_(r.phi_Mn_neg), u.force_(r.phi_Vn),
            r.DCR_flex_pos.toFixed(2), r.DCR_flex_neg.toFixed(2), r.DCR_shear.toFixed(2), dispStatus];
      const statusIdx = lcVals.length - 1;
      const dcrStart = isWall ? 6 : 7;
      const dcrEnd   = isWall ? 8 : isBeam ? 10 : 9;
      lcVals.forEach((v, i) => {
        let clr = C.dark;
        if (i === statusIdx) clr = statusColor(dispStatus);
        else if (i >= dcrStart && i <= dcrEnd) clr = dcrColor(parseFloat(v));
        text(ctx, v, margin + lcCols[i], y, 7, clr);
      });
      y -= 13;
    }
    y -= 8;

    // DCR summary bars (worst across load cases)
    const worst = worstResult(m, project.code);
    if (worst) {
      text(ctx, 'DCR Summary (governing)', margin, y - 8, 10, C.dark, bold);
      y -= 22;
      const barW = (w - 2 * margin) * 0.7;
      const dcrRows: [string, number][] = isWall
        ? [['P-M', worst.DCR_flex_wall ?? 0], ['Shear', worst.DCR_shear_wall ?? 0], ['SBZ Ash', worst.DCR_sbzAsh ?? 0]]
        : m.memberType === 'column'
        ? [['P-M', worst.DCR_PM ?? 0], ['Shear', worst.DCR_shear], ['Torsion', worst.DCR_torsion]]
        : [['Flexure +', worst.DCR_flex_pos], ['Flexure -', worst.DCR_flex_neg],
           ['Shear', worst.DCR_shear], ['Torsion', worst.DCR_torsion],
           ...(worst.DCR_crack != null && worst.DCR_crack > 0
             ? [['Crack (SLS)', worst.DCR_crack] as [string, number]] : [])];
      const ovr = opts.includeOverrides ? m.overrides : undefined;
      const BAR_LABEL_KEY: Record<string, Parameters<typeof isOverridden>[1]> = {
        'Flexure +': 'DCR_flex_pos', 'Flexure -': 'DCR_flex_neg',
        'Shear': 'DCR_shear', 'Torsion': 'DCR_torsion',
        'Crack (SLS)': 'DCR_crack', 'P-M': 'DCR_PM',
      };
      for (const [lbl, dcr] of dcrRows) {
        const key = BAR_LABEL_KEY[lbl];
        drawDCRBar(ctx, lbl, dcr, margin, y, barW, key ? isOverridden(ovr, key) : false);
        y -= 14;
      }
      if (isWall) {
        // sbzLength is stored in inches internally; convert to display units
        const sbzLenStr = worst.sbzLength != null
          ? `lbe=${u.dim(worst.sbzLength)}${u.dimSfx}` : '';
        text(ctx, `rho_l=${((worst.rhoL ?? 0) * 100).toFixed(2)}%  rho_t=${((worst.rhoT ?? 0) * 100).toFixed(2)}%  SBZ ${worst.sbzRequired ? `required, ${sbzLenStr}` : 'not required'}`,
          margin, y - 2, 8, C.mid);
        y -= 14;
      }
      // EC2 SLS crack-width check (wk vs limit)
      if (opts.includeCrack && isEC2 && (worst.wk_bot != null || worst.wk_top != null)) {
        // Use the face that governs and its corresponding limit.
        const wk_bot = worst.wk_bot ?? 0;
        const wk_top = worst.wk_top ?? 0;
        const botGoverns = wk_bot >= wk_top;
        const wk = botGoverns ? wk_bot : wk_top;
        const wLim = botGoverns
          ? (m.crackParams?.wLimitBot ?? 0.3)
          : (m.crackParams?.wLimitTop ?? 0.3);
        const crackOverridden = opts.includeOverrides && isOverridden(m.overrides, 'DCR_crack');
        const okCrack = wk <= wLim || crackOverridden;
        const crackTag = wk <= wLim ? '(OK)' : crackOverridden ? '(reviewed)' : '(EXCEEDS)';
        text(ctx, `Crack width wk = ${wk.toFixed(3)} mm  /  limit ${wLim.toFixed(2)} mm  ${crackTag}  [EC2 §7.3.4]`,
          margin, y - 2, 8, okCrack ? C.green : C.red, bold);
        y -= 14;
      }
      y -= 6;
    }

    // Shear & moment envelope diagrams (beams with imported station forces)
    if (opts.includeDiagrams && worst && m.memberType === 'beam' && (m.stationForces?.length ?? 0) > 1) {
      if (y < margin + 170) { ctx = await addPage(doc, font, bold); y = ctx.h - margin; }
      text(ctx, 'Force Envelopes (imported combos)', margin, y - 8, 10, C.dark, bold);
      y -= 22;
      const consumed = drawForceDiagrams(ctx, m, worst, margin, y, w - 2 * margin, u);
      y -= consumed + 6;
    }

    // Engineer review stamps — printed before warnings so accepted checks are
    // clearly attributed. Honored only when opts.includeOverrides is true.
    const overrides = opts.includeOverrides ? m.overrides : undefined;
    const reviews = overrideEntries(overrides);
    if (reviews.length > 0) {
      if (y < margin + 40) { ctx = await addPage(doc, font, bold); y = ctx.h - margin; }
      text(ctx, 'Engineer Review', margin, y - 8, 10, C.green, bold);
      y -= 18;
      for (const [key, ov] of reviews) {
        if (y < margin + 28) { ctx = await addPage(doc, font, bold); y = ctx.h - margin; }
        const line1 = `[OK] Member reviewed & accepted by engineer`;
        text(ctx, line1, margin, y, 8, C.green, bold);
        y -= 12;
        if (ov.note) {
          text(ctx, `Note: ${ov.note}`, margin + 12, y, 8, C.dark);
          y -= 12;
        }
      }
      y -= 4;
    }

    // Warnings — suppress those covered by an engineer override.
    const allWarnings: { code: string; message: string; severity: string }[] = [];
    for (const lc of m.loads) {
      const r = memberResult(m, lc, project.code);
      for (const w of r.warnings)
        if (!allWarnings.find(x => x.message === w.message))
          allWarnings.push(w);
    }
    const shownWarnings = opts.includeOverrides
      ? visibleWarnings(allWarnings as { code: string; message: string; severity: 'error' | 'warning' }[], overrides)
      : allWarnings;

    if (shownWarnings.length > 0) {
      if (y < margin + 40) { ctx = await addPage(doc, font, bold); y = ctx.h - margin; }
      text(ctx, 'Code Warnings', margin, y - 8, 10, C.dark, bold);
      y -= 20;
      for (const w of shownWarnings) {
        if (y < margin + 20) { ctx = await addPage(doc, font, bold); y = ctx.h - margin; }
        const clr = w.severity === 'error' ? C.red : C.amber;
        text(ctx, `[${w.code}]`, margin, y, 8, clr, bold);
        text(ctx, w.message, margin + 80, y, 8, C.dark);
        y -= 13;
      }
    }

    // Step-by-step calculation breakdown (governing load case)
    if (opts.includeCalcs && govLc) {
      if (y < margin + 60) { ctx = await addPage(doc, font, bold); y = ctx.h - margin; }
      text(ctx, `Calculation Breakdown — governing case: ${govLc.label}`, margin, y - 8, 10, C.dark, bold);
      y -= 22;
      const calcSections = breakdownFor(m, govLc, code);
      const res = await drawCalcSections(doc, font, bold, ctx, calcSections, y);
      ctx = res.ctx; y = res.y;
    }
  }

  // Footer on all pages — title block with job no. / revision
  const pages = doc.getPages();
  const jobRev = [opts.jobNumber && `Job ${opts.jobNumber}`, opts.revision && `Rev ${opts.revision}`]
    .filter(Boolean).join('  |  ');
  pages.forEach((pg: PDFPage, i: number) => {
    const footer = `S-Concrete Design  |  ${project.code}${jobRev ? '  |  ' + jobRev : ''}  |  Sheet ${i + 1} of ${pages.length}`;
    pg.drawText(winAnsiSafe(footer), { x: 48, y: 24, size: 7, color: C.mid, font });
  });

  return await doc.save();
}

/** Build the report and trigger a browser download (back-compatible entry point). */
export async function exportPDF(project: Project, options?: ReportOptions): Promise<void> {
  const pdfBytes = await buildReportBytes(project, options);
  const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${project.name.replace(/\s+/g, '_')}_Report.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}
