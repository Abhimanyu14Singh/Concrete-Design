import { PDFDocument, rgb, StandardFonts, type PDFPage, type PDFFont } from 'pdf-lib';
import type { Project, Member, DesignResults } from '../../types';
import { designMember } from '../concreteDesign';

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
  ctx.page.drawText(String(str), {
    x, y, size, color, font: fontOverride ?? ctx.font,
  });
}

function rect(ctx: DrawCtx, x: number, y: number, w: number, h: number, fill = C.light) {
  ctx.page.drawRectangle({ x, y, width: w, height: h, color: fill, borderWidth: 0 });
}

function line(ctx: DrawCtx, x1: number, y1: number, x2: number, y2: number, thickness = 0.5, color = C.mid) {
  ctx.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color });
}

function worstResult(m: Member): DesignResults | null {
  let worst: DesignResults | null = null;
  for (const lc of m.loads) {
    const r = designMember(m.section, m.material, m.rebar, lc, m.span ?? 20);
    if (!worst || Math.max(r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion) >
                  Math.max(worst.DCR_flex_pos, worst.DCR_flex_neg, worst.DCR_shear, worst.DCR_torsion))
      worst = r;
  }
  return worst;
}

async function addPage(doc: PDFDocument, font: PDFFont, bold: PDFFont): Promise<DrawCtx> {
  const page = doc.addPage([612, 792]);
  return { page, font, bold, w: 612, h: 792, margin: 48 };
}

export async function exportPDF(project: Project): Promise<void> {
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
    const r = worstResult(m);
    if (!r) continue;
    if (row < margin + 20) { ctx = await addPage(doc, font, bold); row = ctx.h - margin; }
    const bg = project.members.indexOf(m) % 2 === 0 ? C.light : C.white;
    rect(ctx, margin, row - 2, w - 2 * margin, 14, bg);
    const sec = `${m.section.b}"×${m.section.h}"`;
    const vals = [m.id, m.label.slice(0, 12), m.memberType, sec,
      `${m.material.fc / 1000}k`,
      r.DCR_flex_pos.toFixed(2), r.DCR_flex_neg.toFixed(2),
      r.DCR_shear.toFixed(2), r.DCR_torsion.toFixed(2), r.status];
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

    // Section properties box
    rect(ctx, margin, y - 50, (w - 2 * margin) / 2 - 5, 52, C.light);
    text(ctx, 'Section & Material', margin + 6, y - 12, 8, C.dark, bold);
    const props = [
      [`b=${m.section.b}"`, `h=${m.section.h}"`, `cc=${m.section.coverClear}"`],
      [`f'c=${m.material.fc}psi`, `fy=${m.material.fy / 1000}ksi`, `fyt=${m.material.fyt / 1000}ksi`],
      [`λ=${m.material.lambdaConcrete}`, `Stirrup #${m.section.stirrupDia}`, `Span ${m.span}ft`],
    ];
    props.forEach((row2, ri) =>
      row2.forEach((v, ci) => text(ctx, v, margin + 8 + ci * 70, y - 24 - ri * 12, 8)));
    y -= 58;

    // Load case results table
    text(ctx, 'Design Results by Load Case', margin, y - 8, 10, C.dark, bold);
    y -= 20;
    const lcHdrs = ['Load Case', 'Mu+ (k-ft)', 'Mu- (k-ft)', 'Vu (k)', 'φMn+ (k-ft)', 'φMn- (k-ft)', 'φVn (k)', 'DCR Fl+', 'DCR Fl-', 'DCR V', 'Status'];
    const lcCols = [0, 72, 118, 164, 200, 252, 304, 352, 384, 416, 445];
    rect(ctx, margin, y - 4, w - 2 * margin, 14, C.navy);
    lcHdrs.forEach((hdr, i) => text(ctx, hdr, margin + lcCols[i], y - 1, 7, C.white, bold));
    y -= 16;

    for (const lc of m.loads) {
      const r = designMember(m.section, m.material, m.rebar, lc, m.span ?? 20);
      const bg = m.loads.indexOf(lc) % 2 === 0 ? C.light : C.white;
      rect(ctx, margin, y - 2, w - 2 * margin, 12, bg);
      const lcVals = [lc.label.slice(0, 12),
        lc.Mu_pos.toFixed(1), lc.Mu_neg.toFixed(1), lc.Vu.toFixed(1),
        r.phi_Mn_pos.toFixed(1), r.phi_Mn_neg.toFixed(1), r.phi_Vn.toFixed(1),
        r.DCR_flex_pos.toFixed(3), r.DCR_flex_neg.toFixed(3), r.DCR_shear.toFixed(3), r.status];
      lcVals.forEach((v, i) => {
        let clr = C.dark;
        if (i === 10) clr = statusColor(r.status);
        else if (i >= 7 && i <= 9) clr = dcrColor(parseFloat(v));
        text(ctx, v, margin + lcCols[i], y, 7, clr);
      });
      y -= 13;
    }
    y -= 8;

    // Warnings
    const allWarnings: { code: string; message: string; severity: string }[] = [];
    for (const lc of m.loads) {
      const r = designMember(m.section, m.material, m.rebar, lc, m.span ?? 20);
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
