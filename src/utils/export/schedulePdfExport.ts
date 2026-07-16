/**
 * Beam schedule + tagged plan PDF export.
 *
 * Generates a multi-page PDF containing:
 *  1. A cover page with project name and date.
 *  2. One or more "Schedule" table pages — per-group (compact) or per-beam (full).
 *  3. A "Tagged Plan" page per story with frames colour-coded by group and
 *     annotated with a tiny group-index number so the legend is unambiguous.
 *
 * Uses pdf-lib + DejaVu fonts (same infrastructure as pdfExport.ts).
 */
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Project, Member, MapFrame, DesignGroup, LoadCase, DesignCode } from '../../types';
import { formatBarLabel } from '../rebar';
import { barsStr, skinStr, stirrupZoneStr, continuousBars } from './scheduleData';
import { winAnsiSafe } from './pdfExport';
import { runDesign } from '../../engines';
import { analyzeGroupCurtailment, curtailmentNote } from '../curtailment';

// ── colour palette ─────────────────────────────────────────────────────────

const C = {
  navy:  rgb(0.04, 0.09, 0.24),
  blue:  rgb(0.11, 0.30, 0.85),
  green: rgb(0.06, 0.63, 0.41),
  amber: rgb(0.85, 0.52, 0.02),
  red:   rgb(0.84, 0.17, 0.17),
  light: rgb(0.96, 0.97, 0.99),
  mid:   rgb(0.56, 0.63, 0.72),
  dark:  rgb(0.20, 0.25, 0.33),
  white: rgb(1, 1, 1),
  // Group palette (mirrors groupColors.ts order)
  groups: [
    rgb(0.15, 0.39, 0.95), rgb(0.06, 0.63, 0.41), rgb(0.85, 0.47, 0.02),
    rgb(0.58, 0.20, 0.92), rgb(0.03, 0.57, 0.71), rgb(0.84, 0.17, 0.17),
    rgb(0.06, 0.49, 0.31), rgb(0.96, 0.28, 0.51), rgb(0.23, 0.51, 0.97),
    rgb(0.63, 0.35, 0.08),
  ],
};

// ── draw context ───────────────────────────────────────────────────────────

interface Ctx {
  page: ReturnType<PDFDocument['addPage']>;
  font: PDFFont;
  bold: PDFFont;
  w: number;
  h: number;
  margin: number;
}

function txt(
  ctx: Ctx, s: string, x: number, y: number,
  size = 9, color = C.dark, f?: PDFFont,
) {
  ctx.page.drawText(winAnsiSafe(String(s)), { x, y, size, color, font: f ?? ctx.font });
}

function fillRect(ctx: Ctx, x: number, y: number, w: number, h: number, fill = C.light) {
  ctx.page.drawRectangle({ x, y, width: w, height: h, color: fill, borderWidth: 0 });
}

function strokeRect(ctx: Ctx, x: number, y: number, w: number, h: number) {
  ctx.page.drawRectangle({ x, y, width: w, height: h, borderColor: C.mid, borderWidth: 0.4, color: undefined });
}

function hline(ctx: Ctx, x1: number, y: number, x2: number, thickness = 0.4, color = C.mid) {
  ctx.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
}

/** Largest font size ≤ base (down to min) at which `s` fits within `maxW` points —
 *  keeps long multi-layer bar strings from bleeding into the next column. */
function fitSize(font: PDFFont, s: string, maxW: number, base: number, min = 5): number {
  const str = winAnsiSafe(String(s));
  let size = base;
  while (size > min && font.widthOfTextAtSize(str, size) > maxW) size -= 0.25;
  return size;
}

// ── rebar formatting ───────────────────────────────────────────────────────

function rebarStr(bars: { numBars: number; barSize: number }[]): string {
  if (!bars.length) return '—';
  return bars.map(b => `${b.numBars}-${formatBarLabel(b.barSize)}`).join(' + ');
}

function stirrupStr(
  rebar: { ties?: { barSize: number; spacing: number; legs: number }; tieZones?: { spacing: number }[] },
  isEC2: boolean,
): string {
  const t = rebar.ties;
  if (!t) return '—';
  const bar = formatBarLabel(t.barSize);
  const conv = isEC2 ? (v: number) => (v * 25.4).toFixed(0) : (v: number) => v.toFixed(1);
  const sfx = isEC2 ? ' mm' : ' in';
  if (rebar.tieZones) {
    return `${bar} @ ${rebar.tieZones.map(z => conv(z.spacing)).join('/')}${sfx}`;
  }
  return `${bar} @ ${conv(t.spacing)}${sfx}`;
}

function sectionLabel(m: Member, isEC2: boolean): string {
  const s = m.section;
  if (isEC2) return `${(s.b * 25.4).toFixed(0)}×${(s.h * 25.4).toFixed(0)}`;
  return `${s.b.toFixed(2)}"×${s.h.toFixed(2)}"`;
}

// ── DCR computation ────────────────────────────────────────────────────────

function computeMaxDCR(m: Member, code: string): number {
  // Use pre-computed results if available
  let best = 0;
  for (const r of m.results ?? []) {
    const d = Math.max(
      r.DCR_flex_pos ?? 0, r.DCR_flex_neg ?? 0,
      r.DCR_shear ?? 0, r.DCR_torsion ?? 0,
      r.DCR_crack ?? 0,
    );
    if (d > best) best = d;
  }
  if (best > 0) return best;

  // Run design inline if no cached results
  for (const lc of m.loads) {
    const r = runDesign(m.section, m.material, m.rebar, lc, m.span ?? 20, code, m.crackParams);
    const d = Math.max(r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion, r.DCR_crack ?? 0);
    if (d > best) best = d;
  }
  return best;
}

// ── L/3 curtailment notes ────────────────────────────────────────────────────

export interface CurtailNote { group: string; note: string; red: boolean; }

/** Collect the curtailment notes the user pinned (per-face) on each group, with
 *  percentages recomputed against the group's current cage + station forces. */
export function buildCurtailmentNotes(
  groups: DesignGroup[],
  memberById: Map<string, Member>,
  code: DesignCode,
): CurtailNote[] {
  const out: CurtailNote[] = [];
  for (const g of groups) {
    if (!g.curtailmentNotes?.top && !g.curtailmentNotes?.bot) continue;
    const gm = g.memberIds.map(id => memberById.get(id)).filter((m): m is Member => !!m);
    const rebar = g.rebar ?? gm[0]?.rebar;
    if (!rebar) continue;
    const cu = analyzeGroupCurtailment(gm, rebar, code);
    if (g.curtailmentNotes?.top && cu.top) out.push({ group: g.label, note: `${curtailmentNote(cu.top)} Keep ${continuousBars(rebar, 'top', cu.top)} continuous.`, red: cu.top.flag === 'red' });
    if (g.curtailmentNotes?.bot && cu.bot) out.push({ group: g.label, note: `${curtailmentNote(cu.bot)} Keep ${continuousBars(rebar, 'bot', cu.bot)} continuous.`, red: cu.bot.flag === 'red' });
  }
  return out;
}

function drawNotesPage(
  doc: PDFDocument, fontReg: PDFFont, fontBold: PDFFont,
  notes: CurtailNote[], projectName: string, pageNum: number,
): number {
  const ctx = addPage(doc, fontReg, fontBold);
  drawPageFrame(ctx, 'Schedule Notes', projectName, pageNum);
  const { margin } = ctx;
  let y = 595 - 60;
  txt(ctx, 'L/3 Bar-Curtailment Notes', margin, y, 12, C.navy, fontBold);
  y -= 16;
  txt(ctx, 'Percentage of each face required through the third-points; the balance may be curtailed (respect development + code minimum).', margin, y, 8, C.mid);
  y -= 20;
  for (const n of notes) {
    if (y < 40) { break; }
    const col = n.red ? C.red : rgb(0.49, 0.29, 0.86); // purple for curtailment opportunities
    fillRect(ctx, margin, y - 1, 8, 8, col); // red = keep >50% continuous · purple = curtailment opportunity
    txt(ctx, winAnsiSafe(n.group), margin + 14, y, 8.5, C.dark, fontBold);
    txt(ctx, winAnsiSafe(n.note), margin + 14, y - 11, 8, C.dark);
    y -= 26;
  }
  return pageNum + 1;
}

// ── font loading ───────────────────────────────────────────────────────────

let _regularBytes: ArrayBuffer | null = null;
let _boldBytes: ArrayBuffer | null = null;
let _fontLoader: (() => Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }>) | null = null;

/** Override font loading (e.g. for Node tests that read from the filesystem). */
export function setFontLoader(fn: () => Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }>): void {
  _fontLoader = fn;
  _regularBytes = null;
  _boldBytes = null;
}

async function getFontBytes(): Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }> {
  if (_fontLoader) return _fontLoader();
  if (!_regularBytes || !_boldBytes) {
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

// ── page factory ───────────────────────────────────────────────────────────

function addPage(doc: PDFDocument, font: PDFFont, bold: PDFFont, margin = 36): Ctx {
  const page = doc.addPage([842, 595]); // A4 landscape
  const { width: w, height: h } = page.getSize();
  return { page, font, bold, w, h, margin };
}

function drawPageFrame(ctx: Ctx, pageTitle: string, projectName: string, pageNum: number) {
  const { w, h, margin } = ctx;
  fillRect(ctx, 0, h - 28, w, 28, C.navy);
  txt(ctx, 'S-Dashboard — Beam Schedule', margin, h - 19, 9, C.white, ctx.bold);
  txt(ctx, pageTitle, w / 2 - 60, h - 19, 9, C.white);
  txt(ctx, projectName, w - margin - 140, h - 19, 8, C.mid);
  fillRect(ctx, 0, 0, w, 16, C.navy);
  txt(ctx, `Page ${pageNum}`, w - margin - 30, 4, 8, C.mid);
}

// ── GROUP schedule (compact — one row per design group) ────────────────────

// Group schedule columns. Top bars, bottom bars and stirrups are each split into
// their three L/3 regions (mark end / middle / opposite end) under a spanning
// super-header via `group`. Top is full at the supports & curtailed mid-span;
// bottom is full at mid-span & curtailed toward the supports.
type GrpGroup = 'top' | 'bottom' | 'stirrups';
const GRP_COL_DEFS: { key: string; header: string; w: number; group?: GrpGroup }[] = [
  { key: 'idx',      header: '#',              w: 20  },
  { key: 'label',    header: 'Group',          w: 100 },
  { key: 'section',  header: 'Section (b×h)',  w: 62  },
  { key: 'count',    header: 'Beams',          w: 30  },
  { key: 'topMark',  header: 'Mark End',       w: 58, group: 'top' },
  { key: 'topMid',   header: 'Middle',         w: 58, group: 'top' },
  { key: 'topOpp',   header: 'Opp. End',       w: 58, group: 'top' },
  { key: 'botMark',  header: 'Mark End',       w: 58, group: 'bottom' },
  { key: 'botMid',   header: 'Middle',         w: 58, group: 'bottom' },
  { key: 'botOpp',   header: 'Opp. End',       w: 58, group: 'bottom' },
  { key: 'skin',     header: 'Skin (n-size@sp)', w: 66 },
  { key: 'stirMark', header: 'Mark End',       w: 52, group: 'stirrups' },
  { key: 'stirMid',  header: 'Middle',         w: 52, group: 'stirrups' },
  { key: 'stirOpp',  header: 'Opp. End',       w: 52, group: 'stirrups' },
];
// Spanning super-headers over the grouped sub-columns.
const GRP_SUPERHEADERS: Record<GrpGroup, string> = {
  top: 'Top bars',
  bottom: 'Bottom bars',
  stirrups: 'Stirrups (size-spacing-legs)',
};
const TABLE_MARGIN_LEFT = 36;
const ROW_H = 17;
const HEADER_H = 22;      // single-band header (beam schedule)
const GRP_HEADER_H = 30;  // two-band header (group schedule)

interface GroupSchedRow {
  idx: string;
  label: string;
  section: string;
  count: string;
  topMark: string;
  topMid: string;
  topOpp: string;
  botMark: string;
  botMid: string;
  botOpp: string;
  skin: string;
  stirMark: string;
  stirMid: string;
  stirOpp: string;
  groupIdx: number; // for colour swatch
}

function buildGroupRows(
  groups: DesignGroup[],
  memberById: Map<string, Member>,
  isEC2: boolean,
  code: string,
): GroupSchedRow[] {
  return groups.map((g, i) => {
    const groupMembers = g.memberIds
      .map(id => memberById.get(id))
      .filter((m): m is Member => !!m);

    const repMember = groupMembers[0];
    const rebar = g.rebar ?? repMember?.rebar;

    // Top bars split into the three L/3 regions: mark end (governing-end cage),
    // middle third (user curtailment cage), and opposite end.
    const topMark  = rebar ? barsStr(rebar.topBars) : '—';
    const topMid   = barsStr(g.midThirdTopBars);
    const topOpp   = barsStr(g.oppositeTopBars);
    // Bottom bars split the same way: full through mid-span, curtailed to the
    // continuous cage toward the supports (mark / opposite end).
    const beams = groupMembers.filter(m => m.memberType === 'beam' || !m.memberType);
    const cu = rebar && beams.length ? analyzeGroupCurtailment(beams, rebar, code as DesignCode) : undefined;
    const botMid  = rebar ? barsStr(rebar.botBars) : '—';
    const botEnd  = rebar ? (cu?.bot ? continuousBars(rebar, 'bot', cu.bot) : barsStr(rebar.botBars)) : '—';
    const skin     = rebar ? skinStr(rebar.sideBars, isEC2) : '—';
    // Stirrups split into the three zones (end / middle / end).
    const stirMark = rebar ? stirrupZoneStr(rebar, 0, isEC2) : '—';
    const stirMid  = rebar ? stirrupZoneStr(rebar, 1, isEC2) : '—';
    const stirOpp  = rebar ? stirrupZoneStr(rebar, 2, isEC2) : '—';
    const section  = repMember ? sectionLabel(repMember, isEC2) : '—';

    return {
      idx: String(i + 1),
      label: g.label,
      section,
      count: String(groupMembers.length),
      topMark, topMid, topOpp,
      botMark: botEnd, botMid, botOpp: botEnd,
      skin, stirMark, stirMid, stirOpp,
      groupIdx: i,
    };
  });
}

function drawGroupTableHeader(ctx: Ctx, x0: number, y: number) {
  const totalW = GRP_COL_DEFS.reduce((s, c) => s + c.w, 0);
  fillRect(ctx, x0, y, totalW, GRP_HEADER_H, C.navy);
  const bandY = y + GRP_HEADER_H - 13; // divider between super-header band and sub-headers

  // Collect each super-group's horizontal span.
  const spans: Partial<Record<GrpGroup, { x0: number; w: number }>> = {};
  {
    let x = x0;
    for (const col of GRP_COL_DEFS) {
      if (col.group) {
        const s = spans[col.group] ?? (spans[col.group] = { x0: x, w: 0 });
        s.w += col.w;
      }
      x += col.w;
    }
  }
  // Super-headers, centred over their span in the top band.
  for (const key of ['top', 'bottom', 'stirrups'] as const) {
    const s = spans[key];
    if (!s) continue;
    const label = winAnsiSafe(GRP_SUPERHEADERS[key]);
    const tw = ctx.bold.widthOfTextAtSize(label, 7);
    txt(ctx, GRP_SUPERHEADERS[key], s.x0 + Math.max(2, (s.w - tw) / 2), y + GRP_HEADER_H - 10, 7, C.white, ctx.bold);
    hline(ctx, s.x0, bandY, s.x0 + s.w, 0.5, C.mid);
  }
  // Column headers: grouped ones sit in the lower band; the rest span both bands.
  {
    let x = x0;
    for (const col of GRP_COL_DEFS) {
      if (col.group) txt(ctx, col.header, x + 3, y + 5, 6.8, C.white, ctx.bold);
      else           txt(ctx, col.header, x + 3, y + GRP_HEADER_H / 2 - 3, 7.2, C.white, ctx.bold);
      x += col.w;
    }
  }
  // Vertical separators: full-height at group boundaries, lower-band only within a group.
  {
    let x = x0;
    for (let i = 0; i < GRP_COL_DEFS.length - 1; i++) {
      x += GRP_COL_DEFS[i].w;
      const sameGroup = GRP_COL_DEFS[i].group && GRP_COL_DEFS[i].group === GRP_COL_DEFS[i + 1].group;
      ctx.page.drawLine({ start: { x, y }, end: { x, y: sameGroup ? bandY : y + GRP_HEADER_H }, thickness: 0.3, color: C.mid });
    }
  }
}

function drawGroupRow(ctx: Ctx, row: GroupSchedRow, x0: number, y: number, shade: boolean) {
  const totalW = GRP_COL_DEFS.reduce((s, c) => s + c.w, 0);
  if (shade) fillRect(ctx, x0, y, totalW, ROW_H, C.light);

  const cells = [
    row.idx, row.label, row.section, row.count,
    row.topMark, row.topMid, row.topOpp,
    row.botMark, row.botMid, row.botOpp,
    row.skin, row.stirMark, row.stirMid, row.stirOpp,
  ];
  let x = x0;

  GRP_COL_DEFS.forEach((col, i) => {
    if (i === 0) {
      // Colour swatch for group index
      const gCol = C.groups[row.groupIdx % C.groups.length];
      fillRect(ctx, x + 3, y + 4, 10, 9, gCol);
      x += col.w;
      return;
    }
    const f = i === 1 ? ctx.bold : ctx.font;
    // Shrink to fit the column so long multi-layer strings never bleed across.
    const size = fitSize(f, cells[i], col.w - 6, i >= 4 ? 7 : 8);
    txt(ctx, cells[i], x + 3, y + 5, size, C.dark, f);
    x += col.w;
  });
  hline(ctx, x0, y, x0 + totalW);
}

// ── BEAM schedule (full — one row per beam) ────────────────────────────────

const BEAM_COL_DEFS = [
  { key: 'label',    header: 'Beam',              w: 90  },
  { key: 'story',    header: 'Story',             w: 50  },
  { key: 'section',  header: 'Section (b×h)',     w: 75  },
  { key: 'span',     header: 'Span',              w: 45  },
  { key: 'top',      header: 'Top bars',          w: 120 },
  { key: 'bot',      header: 'Bottom bars',       w: 120 },
  { key: 'skin',     header: 'Skin bars',         w: 80  },
  { key: 'stirrups', header: 'Stirrups (z1/z2/z3)', w: 145 },
  { key: 'dcr',      header: 'Max DCR',           w: 50  },
];

interface BeamSchedRow {
  label: string; story: string; section: string; span: string;
  top: string; bot: string; skin: string; stirrups: string;
  dcr: string; dcrVal: number;
}

function buildBeamRows(members: Member[], isEC2: boolean, code: string): BeamSchedRow[] {
  return members
    .filter(m => m.memberType === 'beam' || !m.memberType)
    .sort((a, b) => {
      const sa = a.etabs?.story ?? '', sb = b.etabs?.story ?? '';
      if (sa !== sb) return sa.localeCompare(sb);
      return (a.label ?? '').localeCompare(b.label ?? '');
    })
    .map(m => {
      const span = isEC2
        ? `${((m.span ?? 0) * 0.3048).toFixed(2)} m`
        : `${(m.span ?? 0).toFixed(1)} ft`;
      const maxDCR = computeMaxDCR(m, code);
      return {
        label: m.etabs?.frameName ?? m.label,
        story: m.etabs?.story ?? '—',
        section: sectionLabel(m, isEC2),
        span,
        top: rebarStr(m.rebar.topBars),
        bot: rebarStr(m.rebar.botBars),
        skin: rebarStr(m.rebar.sideBars ?? []),
        stirrups: stirrupStr(m.rebar, isEC2),
        dcr: maxDCR > 0 ? maxDCR.toFixed(2) : '—',
        dcrVal: maxDCR,
      };
    });
}

function drawBeamTableHeader(ctx: Ctx, x0: number, y: number) {
  const totalW = BEAM_COL_DEFS.reduce((s, c) => s + c.w, 0);
  fillRect(ctx, x0, y, totalW, HEADER_H, C.navy);
  let x = x0;
  for (const col of BEAM_COL_DEFS) {
    txt(ctx, col.header, x + 3, y + 7, 7.5, C.white, ctx.bold);
    x += col.w;
  }
}

function drawBeamRow(ctx: Ctx, row: BeamSchedRow, x0: number, y: number, shade: boolean) {
  const totalW = BEAM_COL_DEFS.reduce((s, c) => s + c.w, 0);
  if (shade) fillRect(ctx, x0, y, totalW, ROW_H, C.light);
  const cells = [row.label, row.story, row.section, row.span, row.top, row.bot, row.skin, row.stirrups, row.dcr];
  let x = x0;
  BEAM_COL_DEFS.forEach((col, i) => {
    const cellColor = i === 8 && row.dcrVal > 0
      ? row.dcrVal > 1 ? C.red : row.dcrVal > 0.9 ? C.amber : C.green
      : C.dark;
    const f = i === 0 ? ctx.bold : ctx.font;
    txt(ctx, cells[i], x + 3, y + 5, fitSize(f, cells[i], col.w - 6, 8), cellColor, f);
    x += col.w;
  });
  hline(ctx, x0, y, x0 + totalW);
}

function drawScheduleTable(
  doc: PDFDocument, fontReg: PDFFont, fontBold: PDFFont,
  rows: GroupSchedRow[] | BeamSchedRow[],
  isGroup: boolean,
  projectName: string,
  startPageNum: number,
): number {
  const colDefs = isGroup ? GRP_COL_DEFS : BEAM_COL_DEFS;
  const headerH = isGroup ? GRP_HEADER_H : HEADER_H;
  const tableW = colDefs.reduce((s, c) => s + c.w, 0);
  const topY = 595 - 44;
  const rowsPerPage = Math.floor((topY - 24 - headerH) / ROW_H);
  let pageNum = startPageNum;

  for (let start = 0; start < rows.length; start += rowsPerPage) {
    const ctx = addPage(doc, fontReg, fontBold);
    drawPageFrame(ctx, isGroup ? 'Group Schedule' : 'Beam Schedule', projectName, pageNum++);

    if (isGroup) {
      drawGroupTableHeader(ctx, TABLE_MARGIN_LEFT, topY - headerH);
    } else {
      drawBeamTableHeader(ctx, TABLE_MARGIN_LEFT, topY - headerH);
    }

    let y = topY - headerH - ROW_H;
    const chunk = rows.slice(start, start + rowsPerPage);
    chunk.forEach((row, i) => {
      if (isGroup) drawGroupRow(ctx, row as GroupSchedRow, TABLE_MARGIN_LEFT, y, i % 2 === 0);
      else drawBeamRow(ctx, row as BeamSchedRow, TABLE_MARGIN_LEFT, y, i % 2 === 0);
      y -= ROW_H;
    });

    strokeRect(ctx, TABLE_MARGIN_LEFT, y, tableW, topY - y - headerH);

    // Column dividers (body only — header draws its own)
    let cx = TABLE_MARGIN_LEFT;
    for (const col of colDefs.slice(0, -1)) {
      cx += col.w;
      ctx.page.drawLine({
        start: { x: cx, y: topY - headerH },
        end:   { x: cx, y: y + ROW_H },
        thickness: 0.3, color: C.mid,
      });
    }
  }
  return pageNum;
}

// ── plan view ──────────────────────────────────────────────────────────────

function buildTransform(frames: MapFrame[], x0: number, y0: number, canW: number, canH: number) {
  if (!frames.length) return { scale: 1, ox: x0, oy: y0 };
  const xs = frames.flatMap(f => [f.pt1.x, f.pt2.x]);
  const ys = frames.flatMap(f => [f.pt1.y, f.pt2.y]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
  const pad = 30;
  const scale = Math.min((canW - 2 * pad) / rangeX, (canH - 2 * pad) / rangeY);
  const ox = x0 + pad + ((canW - 2 * pad) - rangeX * scale) / 2 - minX * scale;
  const oy = y0 + pad + ((canH - 2 * pad) - rangeY * scale) / 2 - minY * scale;
  return { scale, ox, oy };
}

function drawPlanPage(
  ctx: Ctx,
  frames: MapFrame[],
  storyName: string,
  memberById: Map<string, Member>,
  groups: DesignGroup[],
  projectName: string,
  pageNum: number,
) {
  const { w, h, margin } = ctx;
  drawPageFrame(ctx, `Plan — ${storyName}`, projectName, pageNum);

  const LEGEND_W = 185;
  const canX = margin, canY = 22, canW = w - margin - LEGEND_W - 8, canH = h - 54;
  strokeRect(ctx, canX, canY, canW, canH);

  const { scale, ox, oy } = buildTransform(frames, canX, canY, canW, canH);

  // Build group-index lookup: memberId → group index
  const memberGroupIdx = new Map<string, number>();
  groups.forEach((g, gi) => g.memberIds.forEach(id => memberGroupIdx.set(id, gi)));

  for (const f of frames) {
    const x1 = ox + f.pt1.x * scale, y1 = oy + f.pt1.y * scale;
    const x2 = ox + f.pt2.x * scale, y2 = oy + f.pt2.y * scale;

    const member = memberById.get(f.memberId ?? '') ?? memberById.get(f.frameName);
    const gi = member ? (memberGroupIdx.get(member.id) ?? -1) : -1;
    const col = gi >= 0 ? C.groups[gi % C.groups.length] : C.mid;

    ctx.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 2, color: col });

    // Tiny group-index number at beam midpoint — no background, just small coloured text
    if (gi >= 0) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const label = String(gi + 1);
      // White knockout behind number for contrast (only 1px padding)
      const lw = label.length * 3.5;
      ctx.page.drawRectangle({ x: mx - lw / 2 - 0.5, y: my - 0.5, width: lw + 1, height: 6, color: C.white, borderWidth: 0 });
      txt(ctx, label, mx - lw / 2, my + 0.5, 5, col, ctx.bold);
    }
  }

  // ── Legend ────────────────────────────────────────────────────────────────
  const lx = w - LEGEND_W - 4;
  const legendTop = h - 48;

  txt(ctx, 'Design Groups', lx, legendTop, 8, C.dark, ctx.bold);

  const maxLegendRows = Math.floor((legendTop - 26) / 13);
  const visibleGroups = groups.slice(0, maxLegendRows);

  visibleGroups.forEach((g, i) => {
    const gy = legendTop - 14 - i * 13;
    const col = C.groups[i % C.groups.length];
    // Index number
    const idxStr = String(i + 1);
    txt(ctx, idxStr, lx, gy + 1, 7, col, ctx.bold);
    // Colour swatch
    fillRect(ctx, lx + 10, gy + 1, 12, 9, col);
    // Group label — truncate to fit
    const maxChars = 22;
    const labelText = g.label.length > maxChars ? g.label.slice(0, maxChars) + '…' : g.label;
    txt(ctx, labelText, lx + 25, gy + 2, 7, C.dark);
    txt(ctx, `(${g.memberIds.length})`, lx + 25 + labelText.length * 4.2, gy + 2, 6.5, C.mid);
  });

  if (groups.length > maxLegendRows) {
    txt(ctx, `+ ${groups.length - maxLegendRows} more…`, lx, legendTop - 14 - maxLegendRows * 13, 6.5, C.mid);
  }
  if (!groups.length) {
    txt(ctx, 'No groups — all beams in blue', lx, legendTop - 20, 7, C.mid);
  }
}

// ── main export entry point ────────────────────────────────────────────────

export interface ScheduleExportOptions {
  /**
   * 'group' (default) = one row per design group (compact, recommended).
   * 'beam'            = one row per beam (verbose, full list).
   */
  mode?: 'group' | 'beam';
  /** Restrict to a specific story on the plan pages. */
  story?: string;
  /** Restrict to a subset of member ids. */
  memberIds?: string[];
}

export async function buildSchedulePDF(
  project: Project,
  options: ScheduleExportOptions = {},
): Promise<Uint8Array> {
  const { regular, bold } = await getFontBytes();

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontReg = await doc.embedFont(regular);
  const fontBold = await doc.embedFont(bold);

  const isEC2  = project.code === 'EN1992-1-1';
  const code   = project.code ?? 'ACI318-19';
  const projectName = winAnsiSafe(project.name ?? 'Unnamed Project');
  const mode   = options.mode ?? 'group';

  // Filter members to beams only
  const members = (project.members ?? []).filter(m => {
    if (options.memberIds && !options.memberIds.includes(m.id)) return false;
    return !m.memberType || m.memberType === 'beam';
  });

  const memberById = new Map(members.map(m => [m.id, m]));
  for (const m of members) {
    if (m.etabs?.frameName) memberById.set(m.etabs.frameName, m);
  }

  const groups = project.designGroups ?? [];

  // ── Cover page ─────────────────────────────────────────────────────────────
  {
    const cover = doc.addPage([842, 595]);
    const { width: w, height: h } = cover.getSize();
    cover.drawRectangle({ x: 0, y: 0, width: w, height: h, color: C.navy });
    cover.drawRectangle({ x: 40, y: 120, width: w - 80, height: 3, color: C.blue });
    cover.drawText('S-Dashboard', { x: 44, y: h - 80, size: 18, color: C.mid, font: fontBold });
    const subtitle = mode === 'group' ? 'Group Schedule & Tagged Plan' : 'Beam Schedule & Tagged Plan';
    cover.drawText(subtitle, { x: 44, y: h - 110, size: 28, color: C.white, font: fontBold });
    cover.drawText(winAnsiSafe(projectName), { x: 44, y: h - 148, size: 14, color: C.mid, font: fontReg });
    const today = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
    cover.drawText(today, { x: 44, y: 100, size: 10, color: C.mid, font: fontReg });
    const info = mode === 'group'
      ? `${groups.length} design groups · ${members.length} beams`
      : `${members.length} beams`;
    cover.drawText(info, { x: 44, y: 82, size: 10, color: C.mid, font: fontReg });
  }

  // ── Schedule table pages ───────────────────────────────────────────────────
  let pageNum = 2;
  if (mode === 'group') {
    const rows = buildGroupRows(groups, memberById, isEC2, code);
    pageNum = drawScheduleTable(doc, fontReg, fontBold, rows, true, projectName, pageNum);
  } else {
    const rows = buildBeamRows(members, isEC2, code);
    pageNum = drawScheduleTable(doc, fontReg, fontBold, rows, false, projectName, pageNum);
  }

  // ── L/3 curtailment notes (only the faces the user pinned) ──────────────────
  const curtailNotes = buildCurtailmentNotes(groups, memberById, code as DesignCode);
  if (curtailNotes.length) {
    pageNum = drawNotesPage(doc, fontReg, fontBold, curtailNotes, projectName, pageNum);
  }

  // ── Plan pages ─────────────────────────────────────────────────────────────
  const frames = project.modelMap?.frames ?? [];
  const stories = options.story
    ? [options.story]
    : [...new Set(frames.map(f => f.story))].sort();

  for (const story of stories) {
    const storyFrames = frames.filter(f =>
      f.story === story &&
      members.some(m => m.id === f.memberId || m.etabs?.frameName === f.frameName),
    );
    if (!storyFrames.length) continue;

    const ctx = addPage(doc, fontReg, fontBold);
    drawPlanPage(ctx, storyFrames, story, memberById, groups, projectName, pageNum++);
  }

  return doc.save();
}
