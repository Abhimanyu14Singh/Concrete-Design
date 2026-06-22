/**
 * Beam schedule + tagged plan PDF export.
 *
 * Generates a multi-page PDF containing:
 *  1. A cover page with project name and date.
 *  2. One or more "Beam Schedule" table pages listing each beam's rebar.
 *  3. A "Tagged Plan" page per story, with frames drawn in plan view and labelled.
 *
 * Uses pdf-lib + DejaVu fonts (same infrastructure as pdfExport.ts).
 */
import { PDFDocument, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Project, Member, MapFrame, DesignGroup } from '../../types';
import { formatBarLabel } from '../rebar';
import { winAnsiSafe, setFontLoader } from './pdfExport';
export { setFontLoader };   // re-export so callers can override for tests

// ── helpers shared with pdfExport ──────────────────────────────────────────

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
  // Group palette (matches groupColors.ts)
  groups: [
    rgb(0.15, 0.39, 0.95),
    rgb(0.06, 0.63, 0.41),
    rgb(0.85, 0.47, 0.02),
    rgb(0.58, 0.20, 0.92),
    rgb(0.03, 0.57, 0.71),
    rgb(0.84, 0.17, 0.17),
    rgb(0.06, 0.49, 0.31),
    rgb(0.96, 0.28, 0.51),
    rgb(0.23, 0.51, 0.97),
    rgb(0.63, 0.35, 0.08),
  ],
};

interface Ctx {
  page: PDFPage;
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

// ── rebar formatting ───────────────────────────────────────────────────────

function rebarStr(bars: { numBars: number; barSize: number }[]): string {
  if (!bars.length) return '—';
  return bars.map(b => `${b.numBars}-${formatBarLabel(b.barSize)}`).join(' + ');
}

function stirrupStr(m: Member, isEC2: boolean): string {
  const t = m.rebar.ties;
  if (!t) return '—';
  const bar = formatBarLabel(t.barSize);
  const sfx = isEC2 ? ' mm' : ' in';
  const conv = isEC2 ? (v: number) => (v * 25.4).toFixed(0) : (v: number) => v.toFixed(1);
  if (m.rebar.tieZones) {
    return `${bar} @ ${m.rebar.tieZones.map(z => conv(z.spacing)).join('/')}${sfx}`;
  }
  return `${bar} @ ${conv(t.spacing)}${sfx}`;
}

function sectionLabel(m: Member, isEC2: boolean): string {
  const s = m.section;
  if (isEC2) {
    return `${(s.b * 25.4).toFixed(0)}×${(s.h * 25.4).toFixed(0)}`;
  }
  return `${s.b.toFixed(2)}"×${s.h.toFixed(2)}"`;
}

// ── font loading (same deferred cache as pdfExport) ────────────────────────

let _regularBytes: ArrayBuffer | null = null;
let _boldBytes: ArrayBuffer | null = null;

async function getFontBytes(): Promise<{ regular: ArrayBuffer; bold: ArrayBuffer }> {
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

/** Thin header/footer bar on every content page. */
function drawPageFrame(ctx: Ctx, pageTitle: string, projectName: string, pageNum: number) {
  const { w, h, margin } = ctx;
  fillRect(ctx, 0, h - 28, w, 28, C.navy);
  txt(ctx, 'S-Dashboard — Beam Schedule', margin, h - 19, 9, C.white, ctx.bold);
  txt(ctx, pageTitle, w / 2 - 60, h - 19, 9, C.white);
  txt(ctx, projectName, w - margin - 140, h - 19, 8, C.mid);
  fillRect(ctx, 0, 0, w, 16, C.navy);
  txt(ctx, `Page ${pageNum}`, w - margin - 30, 4, 8, C.mid);
}

// ── schedule table ─────────────────────────────────────────────────────────

const COL_DEFS = [
  { key: 'label',    header: 'Beam',              w: 90 },
  { key: 'story',    header: 'Story',             w: 50 },
  { key: 'section',  header: 'Section (b×h)',     w: 75 },
  { key: 'span',     header: 'Span',              w: 45 },
  { key: 'top',      header: 'Top bars',          w: 120 },
  { key: 'bot',      header: 'Bottom bars',       w: 120 },
  { key: 'skin',     header: 'Skin bars',         w: 80 },
  { key: 'stirrups', header: 'Stirrups (z1/z2/z3)',w: 145 },
  { key: 'dcr',      header: 'Max DCR',           w: 50 },
];
const TABLE_MARGIN_LEFT = 36;
const ROW_H = 16;
const HEADER_H = 20;

interface SchedRow {
  label: string;
  story: string;
  section: string;
  span: string;
  top: string;
  bot: string;
  skin: string;
  stirrups: string;
  dcr: string;
  dcrVal: number;
}

function buildRows(members: Member[], isEC2: boolean): SchedRow[] {
  return members
    .filter(m => m.memberType === 'beam' || !m.memberType)
    .sort((a, b) => {
      const sa = a.etabs?.story ?? '';
      const sb = b.etabs?.story ?? '';
      if (sa !== sb) return sa.localeCompare(sb);
      return (a.label ?? '').localeCompare(b.label ?? '');
    })
    .map(m => {
      const span = isEC2
        ? `${((m.span ?? 0) * 0.3048).toFixed(2)} m`
        : `${(m.span ?? 0).toFixed(1)} ft`;

      let maxDCR = 0;
      for (const r of m.results ?? []) {
        const d = Math.max(
          r.DCR_flex_pos ?? 0, r.DCR_flex_neg ?? 0,
          r.DCR_shear ?? 0, r.DCR_torsion ?? 0,
          r.DCR_crack ?? 0,
        );
        if (d > maxDCR) maxDCR = d;
      }

      return {
        label: m.etabs?.frameName ?? m.label,
        story: m.etabs?.story ?? '—',
        section: sectionLabel(m, isEC2),
        span,
        top: rebarStr(m.rebar.topBars),
        bot: rebarStr(m.rebar.botBars),
        skin: rebarStr(m.rebar.sideBars ?? []),
        stirrups: stirrupStr(m, isEC2),
        dcr: maxDCR > 0 ? maxDCR.toFixed(2) : '—',
        dcrVal: maxDCR,
      };
    });
}

function drawScheduleTableHeader(ctx: Ctx, x0: number, y: number) {
  fillRect(ctx, x0, y, COL_DEFS.reduce((s, c) => s + c.w, 0), HEADER_H, C.navy);
  let x = x0;
  for (const col of COL_DEFS) {
    txt(ctx, col.header, x + 3, y + 6, 7.5, C.white, ctx.bold);
    x += col.w;
  }
}

function drawScheduleRow(ctx: Ctx, row: SchedRow, x0: number, y: number, shade: boolean) {
  const totalW = COL_DEFS.reduce((s, c) => s + c.w, 0);
  if (shade) fillRect(ctx, x0, y, totalW, ROW_H, C.light);

  let x = x0;
  const cells: string[] = [row.label, row.story, row.section, row.span, row.top, row.bot, row.skin, row.stirrups, row.dcr];
  COL_DEFS.forEach((col, i) => {
    const cellColor = i === 8 && row.dcrVal > 0
      ? row.dcrVal > 1 ? C.red : row.dcrVal > 0.9 ? C.amber : C.green
      : C.dark;
    txt(ctx, cells[i], x + 3, y + 4, 8, cellColor, i === 0 ? ctx.bold : ctx.font);
    x += col.w;
  });
  hline(ctx, x0, y, x0 + totalW);
}

// ── plan view page ─────────────────────────────────────────────────────────

/** Normalize frame coordinates to fit the canvas area. */
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

function groupColorForMember(memberId: string, groups: DesignGroup[]): ReturnType<typeof rgb> | null {
  const idx = groups.findIndex(g => g.memberIds.includes(memberId));
  if (idx < 0) return null;
  return C.groups[idx % C.groups.length];
}

function drawPlanPage(
  ctx: Ctx,
  frames: MapFrame[],
  storyName: string,
  memberById: Map<string, Member>,
  groups: DesignGroup[],
  projectName: string,
  pageNum: number,
  labelMode: 'frameName' | 'group',
) {
  const { w, h, margin } = ctx;
  drawPageFrame(ctx, `Plan — ${storyName}`, projectName, pageNum);

  const canX = margin, canY = 20, canW = w - margin - 200, canH = h - 52;
  strokeRect(ctx, canX, canY, canW, canH);

  const { scale, ox, oy } = buildTransform(frames, canX, canY, canW, canH);

  for (const f of frames) {
    const x1 = ox + f.pt1.x * scale, y1 = oy + f.pt1.y * scale;
    const x2 = ox + f.pt2.x * scale, y2 = oy + f.pt2.y * scale;

    const member = memberById.get(f.memberId ?? f.frameName);
    const col = member ? (groupColorForMember(member.id, groups) ?? C.blue) : C.mid;

    ctx.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 2.5, color: col });

    // Label at midpoint
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const labelText = labelMode === 'group' && member
      ? (groups.find(g => g.memberIds.includes(member.id))?.label ?? f.frameName)
      : f.frameName;

    // Small white box behind text for readability
    const tlen = labelText.length * 4.5;
    fillRect(ctx, mx - tlen / 2 - 1, my - 1, tlen + 2, 9, C.white);
    txt(ctx, labelText, mx - tlen / 2, my + 1, 6.5, C.dark);
  }

  // Legend (right side)
  const lx = w - 190, ly = h - 52;
  txt(ctx, 'Design Groups', lx, ly - 14, 8, C.dark, ctx.bold);
  groups.forEach((g, i) => {
    const gy = ly - 30 - i * 14;
    if (gy < 24) return; // clip
    const col = C.groups[i % C.groups.length];
    fillRect(ctx, lx, gy, 18, 8, col);
    txt(ctx, g.label, lx + 22, gy + 1, 7.5, C.dark);
    const memberCount = g.memberIds.length;
    txt(ctx, `(${memberCount})`, lx + 22 + g.label.length * 4.5, gy + 1, 7, C.mid);
  });
  if (!groups.length) {
    txt(ctx, 'No groups defined', lx, ly - 30, 7.5, C.mid);
    txt(ctx, '(all beams shown in blue)', lx, ly - 44, 7, C.mid);
  }
}

// ── main export entry point ───────────────────────────────────────────────

export interface ScheduleExportOptions {
  /** Label mode for the plan: show frame name or group label. */
  planLabel?: 'frameName' | 'group';
  /** Restrict to specific story (undefined = all stories, one plan page per story). */
  story?: string;
  /** Restrict to a specific subset of members. */
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

  const isEC2 = project.code === 'EN1992-1-1';
  const projectName = winAnsiSafe(project.name ?? 'Unnamed Project');

  // Filter members
  const members = (project.members ?? []).filter(m => {
    if (options.memberIds && !options.memberIds.includes(m.id)) return false;
    if (m.memberType && m.memberType !== 'beam') return false;
    return true;
  });

  const memberById = new Map(members.map(m => [m.id, m]));
  // Also index by frameName for map frame lookup
  for (const m of members) {
    if (m.etabs?.frameName) memberById.set(m.etabs.frameName, m);
  }

  // ── Cover page ────────────────────────────────────────────────────────────
  {
    const cover = doc.addPage([842, 595]);
    const { width: w, height: h } = cover.getSize();
    cover.drawRectangle({ x: 0, y: 0, width: w, height: h, color: C.navy });
    cover.drawRectangle({ x: 40, y: 120, width: w - 80, height: 3, color: C.blue });
    cover.drawText('S-Dashboard', { x: 44, y: h - 80, size: 18, color: C.mid, font: fontBold });
    cover.drawText('Beam Schedule & Tagged Plan', { x: 44, y: h - 110, size: 28, color: C.white, font: fontBold });
    cover.drawText(winAnsiSafe(projectName), { x: 44, y: h - 148, size: 14, color: C.mid, font: fontReg });
    const today = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
    cover.drawText(today, { x: 44, y: 100, size: 10, color: C.mid, font: fontReg });
    cover.drawText(`${members.length} beams`, { x: 44, y: 82, size: 10, color: C.mid, font: fontReg });
  }

  // ── Schedule table pages ───────────────────────────────────────────────────
  const rows = buildRows(members, isEC2);
  const tableW = COL_DEFS.reduce((s, c) => s + c.w, 0);
  const pageH = 595;
  const topY = pageH - 44;  // below page header
  const bodyH = topY - 24;  // above page footer
  const rowsPerPage = Math.floor((bodyH - HEADER_H) / ROW_H);

  let pageNum = 2;
  for (let start = 0; start < rows.length; start += rowsPerPage) {
    const ctx = addPage(doc, fontReg, fontBold);
    drawPageFrame(ctx, 'Beam Schedule', projectName, pageNum++);

    // Column header
    drawScheduleTableHeader(ctx, TABLE_MARGIN_LEFT, topY - HEADER_H);

    // Rows
    let y = topY - HEADER_H - ROW_H;
    const chunk = rows.slice(start, start + rowsPerPage);
    chunk.forEach((row, i) => {
      drawScheduleRow(ctx, row, TABLE_MARGIN_LEFT, y, i % 2 === 0);
      y -= ROW_H;
    });

    // Outer border
    strokeRect({ ...ctx, page: ctx.page }, TABLE_MARGIN_LEFT, y, tableW, topY - y - HEADER_H - ROW_H + ROW_H);

    // Column dividers
    let cx = TABLE_MARGIN_LEFT;
    for (const col of COL_DEFS.slice(0, -1)) {
      cx += col.w;
      ctx.page.drawLine({
        start: { x: cx, y: topY - HEADER_H },
        end:   { x: cx, y: y + ROW_H },
        thickness: 0.3, color: C.mid,
      });
    }
  }

  // ── Plan pages ────────────────────────────────────────────────────────────
  const frames = project.modelMap?.frames ?? [];
  const stories = options.story
    ? [options.story]
    : [...new Set(frames.map(f => f.story))].sort();

  const groups = project.designGroups ?? [];
  const labelMode = options.planLabel ?? 'frameName';

  for (const story of stories) {
    const storyFrames = frames.filter(f =>
      f.story === story && members.some(m =>
        m.id === f.memberId || m.etabs?.frameName === f.frameName,
      ),
    );
    if (!storyFrames.length) continue;

    const ctx = addPage(doc, fontReg, fontBold);
    drawPlanPage(ctx, storyFrames, story, memberById, groups, projectName, pageNum++, labelMode);
  }

  return doc.save();
}
