import { formatBarLabel } from '../rebar';
import { PDFDocument, rgb, StandardFonts, type PDFPage, type PDFFont } from 'pdf-lib';
import type { Project, Member, DesignResults, LoadCase } from '../../types';
import { runDesign } from '../../engines';
import { designWallACI } from '../wallDesign';
import { getBarDiam } from '../concreteDesign';

/**
 * Standard Helvetica is WinAnsi-encoded; Greek letters and several math
 * symbols used in engine warnings/headers (φ, ≤, √, β, −, …) throw
 * "cannot encode" in pdf-lib. Every drawn string passes through here.
 */
const WINANSI_MAP: [RegExp, string][] = [
  [/φ/g, 'phi'], [/λ/g, 'lambda'], [/β/g, 'beta'], [/ρ/g, 'rho'],
  [/δ/g, 'delta'], [/θ/g, 'theta'], [/ε/g, 'eps'], [/α/g, 'alpha'],
  [/√/g, 'sqrt'], [/≤/g, '<='], [/≥/g, '>='], [/≈/g, '~'],
  [/−/g, '-'], [/[–—]/g, '-'], [/[′’]/g, "'"], [/[″“”]/g, '"'],
  [/₁/g, '1'], [/₂/g, '2'], [/ȳ/g, 'y'], [/✓/g, 'OK'], [/[⚠✗]/g, '!'],
  [/⁺/g, '+'], [/⁻/g, '-'], [/Σ/g, 'Sum'], [/Ø/g, 'dia '],
];
export function winAnsiSafe(s: string): string {
  let out = s;
  for (const [re, rep] of WINANSI_MAP) out = out.replace(re, rep);
  // Backstop: anything outside Latin-1 becomes '?'
  // eslint-disable-next-line no-control-regex
  return out.replace(/[^\x00-\xFF]/g, '?');
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
    r.DCR_shear_wall ?? 0, r.DCR_flex_wall ?? 0, r.DCR_sbzAsh ?? 0);
}

/** Routes walls to the wall engine (same branch as the results screen). */
const _resultCache = new Map<string, DesignResults>();
function memberResult(m: Member, lc: LoadCase, code?: string): DesignResults {
  const key = `${m.id}|${lc.id}`;
  const hit = _resultCache.get(key);
  if (hit) return hit;
  const r = m.memberType === 'wall' && m.wallRebar
    ? designWallACI(m.section, m.material, m.wallRebar, lc)
    : runDesign(m.section, m.material, m.rebar, lc, m.span ?? 20, code, m.crackParams);
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
function drawSectionSketch(ctx: DrawCtx, m: Member, x: number, y: number, boxW: number, boxH: number): void {
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
    text(ctx, `dia ${D}"`, cx - 14, y + 4, 7, C.mid);
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
    text(ctx, `lw=${lw}"  tw=${tw}"  (plan, SBZ ends shaded)`, px, y + 4, 7, C.mid);
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
  text(ctx, `b=${secW}"  h=${secH}"`, rx, y + 4, 7, C.mid);
}

/** Horizontal DCR bar with a marker at 1.0; track spans dcr 0–1.5. */
function drawDCRBar(ctx: DrawCtx, label: string, dcr: number, x: number, y: number, w: number): void {
  const trackW = w - 100;
  text(ctx, label, x, y, 8, C.dark);
  rect(ctx, x + 60, y - 1, trackW, 8, C.light);
  const fillW = Math.min(Math.max(dcr, 0), 1.5) / 1.5 * trackW;
  if (fillW > 0) rect(ctx, x + 60, y - 1, fillW, 8, dcrColor(dcr));
  const oneX = x + 60 + (1.0 / 1.5) * trackW;
  line(ctx, oneX, y - 3, oneX, y + 9, 0.8, C.dark);
  text(ctx, dcr.toFixed(2), x + 60 + trackW + 6, y, 8, dcrColor(dcr), ctx.bold);
}

async function addPage(doc: PDFDocument, font: PDFFont, bold: PDFFont): Promise<DrawCtx> {
  const page = doc.addPage([612, 792]);
  return { page, font, bold, w: 612, h: 792, margin: 48 };
}

export async function exportPDF(project: Project): Promise<void> {
  _resultCache.clear();
  const doc   = await PDFDocument.create();
  const font  = await doc.embedFont(StandardFonts.Helvetica);
  const bold  = await doc.embedFont(StandardFonts.HelveticaBold);

  // ── Cover page ────────────────────────────────────────────────────────────
  let ctx = await addPage(doc, font, bold);
  const { w, h, margin } = ctx;

  rect(ctx, 0, h - 100, w, 100, C.navy);
  text(ctx, 'S-Concrete Design', margin, h - 44, 24, C.white, bold);
  text(ctx, 'ACI 318-19  Reinforced Concrete Design Report', margin, h - 66, 11, C.mid);

  text(ctx, 'Project', margin, h - 130, 9, C.mid);
  text(ctx, project.name, margin, h - 145, 14, C.dark, bold);
  text(ctx, 'Engineer', margin + 300, h - 130, 9, C.mid);
  text(ctx, project.engineer, margin + 300, h - 145, 12, C.dark);
  text(ctx, 'Date', margin, h - 168, 9, C.mid);
  text(ctx, project.date, margin, h - 181, 10, C.dark);
  text(ctx, 'Design Code', margin + 300, h - 168, 9, C.mid);
  text(ctx, project.code, margin + 300, h - 181, 10, C.dark);

  line(ctx, margin, h - 200, w - margin, h - 200);

  // Member summary table
  text(ctx, 'Member Summary', margin, h - 220, 11, C.dark, bold);
  const cols = [0, 28, 120, 170, 240, 290, 340, 390, 440, 490];
  const hdrs = ['ID', 'Label', 'Type', 'Section', "f'c", 'Flex+', 'Flex-', 'Shear', 'Tors.', 'Status'];
  rect(ctx, margin, h - 246, w - 2 * margin, 16, C.navy);
  hdrs.forEach((hdr, i) => text(ctx, hdr, margin + cols[i], h - 243, 8, C.white, bold));

  let row = h - 260;
  for (const m of project.members) {
    const r = worstResult(m, project.code);
    if (!r) continue;
    if (row < margin + 20) { ctx = await addPage(doc, font, bold); row = ctx.h - margin; }
    const bg = project.members.indexOf(m) % 2 === 0 ? C.light : C.white;
    rect(ctx, margin, row - 2, w - 2 * margin, 14, bg);
    const sec = m.section.type === 'circular_column'
      ? `Ø${m.section.diameter ?? m.section.b}"`
      : `${m.section.b}"×${m.section.h}"`;
    const wall = m.memberType === 'wall' && !!m.wallRebar;
    const vals = [m.id, m.label.slice(0, 12), m.memberType, sec,
      `${m.material.fc / 1000}k`,
      (wall ? (r.DCR_flex_wall ?? 0) : r.DCR_flex_pos).toFixed(2),
      wall ? '-' : r.DCR_flex_neg.toFixed(2),
      (wall ? (r.DCR_shear_wall ?? 0) : r.DCR_shear).toFixed(2),
      wall ? '-' : r.DCR_torsion.toFixed(2), r.status];
    vals.forEach((v, i) => {
      let clr = C.dark;
      if (i === 9) clr = statusColor(r.status);
      else if (i >= 5 && i <= 8) clr = dcrColor(parseFloat(v));
      text(ctx, v, margin + cols[i], row, 8, clr);
    });
    row -= 14;
  }

  // ── Per-member pages ─────────────────────────────────────────────────────
  for (const m of project.members) {
    ctx = await addPage(doc, font, bold);
    let y = ctx.h - margin;

    // Member header
    rect(ctx, margin, y - 34, w - 2 * margin, 38, C.navy);
    text(ctx, `${m.id} — ${m.label}`, margin + 8, y - 14, 13, C.white, bold);
    const secStr = `${m.section.b}"×${m.section.h}"`;
    text(ctx, `${m.section.type.replace(/_/g, ' ')}  ${secStr}  f'c=${m.material.fc}psi  fy=${m.material.fy / 1000}ksi  span=${m.span}ft`,
      margin + 8, y - 28, 8, C.mid);
    y -= 50;

    // Section properties box (left) + section sketch (right)
    const halfW = (w - 2 * margin) / 2 - 5;
    rect(ctx, margin, y - 50, halfW, 52, C.light);
    text(ctx, 'Section & Material', margin + 6, y - 12, 8, C.dark, bold);
    const props = [
      [`b=${m.section.b}"`, `h=${m.section.h}"`, `cc=${m.section.coverClear}"`],
      [`f'c=${m.material.fc}psi`, `fy=${m.material.fy / 1000}ksi`, `fyt=${m.material.fyt / 1000}ksi`],
      [`λ=${m.material.lambdaConcrete}`, `Stirrup ${formatBarLabel(m.section.stirrupDia)}`, `Span ${m.span}ft`],
    ];
    props.forEach((row2, ri) =>
      row2.forEach((v, ci) => text(ctx, v, margin + 8 + ci * 70, y - 24 - ri * 12, 8)));
    drawSectionSketch(ctx, m, margin + halfW + 10, y - 118, halfW, 120);
    y -= 126;

    // Load case results table
    text(ctx, 'Design Results by Load Case', margin, y - 8, 10, C.dark, bold);
    y -= 20;
    const isWall = m.memberType === 'wall' && !!m.wallRebar;
    const lcHdrs = isWall
      ? ['Load Case', 'Mu (k-ft)', 'Vu (k)', 'Pu (k)', 'φMn (k-ft)', 'φVn (k)', 'DCR P-M', 'DCR V', 'DCR Ash', 'SBZ', 'Status']
      : ['Load Case', 'Mu+ (k-ft)', 'Mu- (k-ft)', 'Vu (k)', 'φMn+ (k-ft)', 'φMn- (k-ft)', 'φVn (k)', 'DCR Fl+', 'DCR Fl-', 'DCR V', 'Status'];
    const lcCols = [0, 72, 118, 164, 200, 252, 304, 352, 384, 416, 445];
    rect(ctx, margin, y - 4, w - 2 * margin, 14, C.navy);
    lcHdrs.forEach((hdr, i) => text(ctx, hdr, margin + lcCols[i], y - 1, 7, C.white, bold));
    y -= 16;

    for (const lc of m.loads) {
      const r = memberResult(m, lc, project.code);
      const bg = m.loads.indexOf(lc) % 2 === 0 ? C.light : C.white;
      rect(ctx, margin, y - 2, w - 2 * margin, 12, bg);
      const lcVals = isWall
        ? [lc.label.slice(0, 12),
            Math.max(lc.Mu_pos, lc.Mu_neg).toFixed(1), lc.Vu.toFixed(1), lc.Pu.toFixed(1),
            (r.phi_Mn_wall ?? 0).toFixed(1), (r.phi_Vn_wall ?? 0).toFixed(1),
            (r.DCR_flex_wall ?? 0).toFixed(3), (r.DCR_shear_wall ?? 0).toFixed(3),
            (r.DCR_sbzAsh ?? 0).toFixed(3), r.sbzRequired ? 'Yes' : 'No', r.status]
        : [lc.label.slice(0, 12),
            lc.Mu_pos.toFixed(1), lc.Mu_neg.toFixed(1), lc.Vu.toFixed(1),
            r.phi_Mn_pos.toFixed(1), r.phi_Mn_neg.toFixed(1), r.phi_Vn.toFixed(1),
            r.DCR_flex_pos.toFixed(3), r.DCR_flex_neg.toFixed(3), r.DCR_shear.toFixed(3), r.status];
      lcVals.forEach((v, i) => {
        let clr = C.dark;
        if (i === 10) clr = statusColor(r.status);
        else if (i >= (isWall ? 6 : 7) && i <= (isWall ? 8 : 9)) clr = dcrColor(parseFloat(v));
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
        ? [['P-M', worst.DCR_PM ?? 0], ['Shear', worst.DCR_shear]]
        : [['Flexure +', worst.DCR_flex_pos], ['Flexure -', worst.DCR_flex_neg],
           ['Shear', worst.DCR_shear], ['Torsion', worst.DCR_torsion]];
      for (const [lbl, dcr] of dcrRows) {
        drawDCRBar(ctx, lbl, dcr, margin, y, barW);
        y -= 14;
      }
      if (isWall) {
        text(ctx, `rho_l=${(worst.rhoL ?? 0).toFixed(4)}  rho_t=${(worst.rhoT ?? 0).toFixed(4)}  SBZ ${worst.sbzRequired ? `required, lbe=${(worst.sbzLength ?? 0).toFixed(1)}"` : 'not required'}`,
          margin, y - 2, 8, C.mid);
        y -= 14;
      }
      y -= 6;
    }

    // Warnings
    const allWarnings: { code: string; message: string; severity: string }[] = [];
    for (const lc of m.loads) {
      const r = memberResult(m, lc, project.code);
      for (const w of r.warnings)
        if (!allWarnings.find(x => x.message === w.message))
          allWarnings.push(w);
    }

    if (allWarnings.length > 0) {
      text(ctx, 'Code Warnings', margin, y - 8, 10, C.dark, bold);
      y -= 20;
      for (const w of allWarnings) {
        if (y < margin + 20) { ctx = await addPage(doc, font, bold); y = ctx.h - margin; }
        const clr = w.severity === 'error' ? C.red : C.amber;
        text(ctx, `[${w.code}]`, margin, y, 8, clr, bold);
        text(ctx, w.message, margin + 80, y, 8, C.dark);
        y -= 13;
      }
    }
  }

  // Footer on all pages
  const pages = doc.getPages();
  pages.forEach((pg: PDFPage, i: number) => {
    pg.drawText(`S-Concrete Design  |  ${project.code}  |  Page ${i + 1} of ${pages.length}`, {
      x: 48, y: 24, size: 7, color: C.mid, font,
    });
  });

  const pdfBytes = await doc.save();
  const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${project.name.replace(/\s+/g, '_')}_Report.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}
