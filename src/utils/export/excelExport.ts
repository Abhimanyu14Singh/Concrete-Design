import * as XLSX from 'xlsx';
import type { Project, Member } from '../../types';
import { runDesign } from '../../engines';
import { getBarArea } from '../concreteDesign';
import { grossArea } from '../../engines/column/sectionModel';

function worstOf(r: ReturnType<typeof runDesign>): number {
  return Math.max(r.DCR_flex_pos, r.DCR_flex_neg, r.DCR_shear, r.DCR_torsion,
    r.DCR_PM ?? 0, r.DCR_axial ?? 0);
}

function worstResult(member: Member, code?: string) {
  let worst = null as ReturnType<typeof runDesign> | null;
  for (const lc of member.loads) {
    const r = runDesign(member.section, member.material, member.rebar, lc, member.span ?? 20, code, member.crackParams);
    if (!worst || worstOf(r) > worstOf(worst)) worst = r;
  }
  return worst;
}

// ── Formula-cell helpers ──────────────────────────────────────────────────────
// A1 address from 0-based (col, row). Formula cells carry both `.f` (the live
// spreadsheet formula) and `.v` (a cached value so the number shows before the
// host app recalculates).
const addr = (c: number, r: number): string => XLSX.utils.encode_cell({ c, r });
function setNum(ws: XLSX.WorkSheet, c: number, r: number, v: number): void {
  ws[addr(c, r)] = { t: 'n', v };
}
function setStr(ws: XLSX.WorkSheet, c: number, r: number, v: string): void {
  ws[addr(c, r)] = { t: 's', v };
}
function setFormula(ws: XLSX.WorkSheet, c: number, r: number, f: string, cached: number): void {
  ws[addr(c, r)] = { t: 'n', f, v: cached };
}
function totalLongAst(m: Member): number {
  return [...m.rebar.topBars, ...m.rebar.botBars, ...(m.rebar.sideBars ?? [])]
    .reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0);
}

/**
 * Build a per-member worksheet whose axial / geometry design chain is LIVE
 * formulas (Ag, ρg, φPn,max and the per-load-case axial DCR all recompute when
 * an input cell is edited). The P-M, flexure, shear and torsion capacities come
 * from the strain-compatibility engine and are written as labelled values — they
 * cannot be expressed as a single spreadsheet formula.
 */
function buildMemberSheet(m: Member, code: string): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  const isCircular = m.section.type === 'circular_column';
  const isColumn = isCircular || m.section.type === 'rectangular_column';
  const spiral = m.rebar.tieType === 'spiral';
  const b = m.section.b;
  const h = m.section.h ?? m.section.b;
  const D = m.section.diameter ?? m.section.b;
  const Ag = grossArea(isCircular, b, h, D);
  const Ast = totalLongAst(m);
  const rho = Ag > 0 ? Ast / Ag : 0;
  const phi = spiral ? 0.75 : 0.65;
  const alpha = spiral ? 0.85 : 0.80;
  const phiPnMax = (phi * alpha * (0.85 * m.material.fc * (Ag - Ast) + m.material.fy * Ast)) / 1000;

  let r = 0;
  setStr(ws, 0, r, `Member: ${m.id} — ${m.label}`); r += 1;
  setStr(ws, 0, r, 'Type'); setStr(ws, 1, r, m.memberType);
  setStr(ws, 2, r, 'Section'); setStr(ws, 3, r, m.section.type); r += 2;

  // ── INPUTS (edit to recompute the live cells) ──
  setStr(ws, 0, r, '— INPUTS (edit to recompute the live cells below) —'); r += 1;
  const rInput = r;                 // input value row
  setStr(ws, 0, r, isCircular ? 'D (in)' : 'b (in)'); setNum(ws, 1, r, isCircular ? D : b);
  setStr(ws, 2, r, 'h (in)'); setNum(ws, 3, r, h);
  setStr(ws, 4, r, "f'c (psi)"); setNum(ws, 5, r, m.material.fc); r += 1;
  const rInput2 = r;
  setStr(ws, 0, r, 'fy (psi)'); setNum(ws, 1, r, m.material.fy);
  setStr(ws, 2, r, 'Ast (in²)'); setNum(ws, 3, r, +Ast.toFixed(3));
  setStr(ws, 4, r, 'φc'); setNum(ws, 5, r, phi);
  setStr(ws, 6, r, 'α'); setNum(ws, 7, r, alpha); r += 2;

  // Input cell addresses for formulas.
  const bA = addr(1, rInput), hA = addr(3, rInput), fcA = addr(5, rInput);
  const fyA = addr(1, rInput2), astA = addr(3, rInput2), phiA = addr(5, rInput2), alphaA = addr(7, rInput2);

  // ── DERIVED (live formulas) ──
  setStr(ws, 0, r, '— DERIVED (live formulas) —'); r += 1;
  const rDer = r;
  setStr(ws, 0, r, 'Ag (in²)');
  setFormula(ws, 1, r, isCircular ? `PI()*${bA}^2/4` : `${bA}*${hA}`, Ag);
  const agA = addr(1, rDer);
  setStr(ws, 2, r, 'ρg');
  setFormula(ws, 3, r, `${astA}/${agA}`, rho);
  setStr(ws, 4, r, 'φPn,max (k)');
  setFormula(ws, 5, r, `${phiA}*${alphaA}*(0.85*${fcA}*(${agA}-${astA})+${fyA}*${astA})/1000`, phiPnMax);
  const phiPnA = addr(5, rDer);
  r += 2;

  // ── AXIAL CHECK (live): DCR = Pu / φPn,max ──
  if (isColumn) {
    setStr(ws, 0, r, 'AXIAL CHECK (live) — DCR_axial = Pu / φPn,max'); r += 1;
    setStr(ws, 0, r, 'Load Case'); setStr(ws, 1, r, 'Pu (k)');
    setStr(ws, 2, r, 'φPn,max (k)'); setStr(ws, 3, r, 'DCR axial'); r += 1;
    for (const lc of m.loads) {
      const row = r;
      setStr(ws, 0, row, lc.label);
      setNum(ws, 1, row, lc.Pu);
      setFormula(ws, 2, row, `${phiPnA}`, phiPnMax);
      setFormula(ws, 3, row, `${addr(1, row)}/${addr(2, row)}`, phiPnMax > 0 ? lc.Pu / phiPnMax : 0);
      r += 1;
    }
    r += 1;
  }

  // ── Engine-computed capacities (values) ──
  setStr(ws, 0, r, 'ENGINE-COMPUTED CAPACITIES (strain compatibility — values)'); r += 1;
  const headers = ['Load Case', 'Mu+ (k-ft)', 'Mu- (k-ft)', 'Vu (k)', 'Tu (k-ft)', 'Pu (k)',
    'Mux (k-ft)', 'Muy (k-ft)', 'φMn+ (k-ft)', 'φMn- (k-ft)', 'φVn (k)', 'φTn (k-ft)', 'φPn,max (k)',
    'DCR Flex+', 'DCR Flex-', 'DCR Shear', 'DCR Torsion', 'DCR P-M', 'As_req+ (in²)', 'Status', 'Warnings'];
  headers.forEach((hd, c) => setStr(ws, c, r, hd));
  r += 1;
  for (const lc of m.loads) {
    const res = runDesign(m.section, m.material, m.rebar, lc, m.span ?? 20, code, m.crackParams);
    const warns = res.warnings.map(w => `[${w.code}] ${w.message}`).join('; ');
    const vals: (string | number)[] = [
      lc.label, lc.Mu_pos, lc.Mu_neg, lc.Vu, lc.Tu, lc.Pu, lc.Mux ?? 0, lc.Muy ?? 0,
      +res.phi_Mn_pos.toFixed(2), +res.phi_Mn_neg.toFixed(2), +res.phi_Vn.toFixed(2), +res.phi_Tn.toFixed(2),
      res.phi_Pn_max !== undefined ? +res.phi_Pn_max.toFixed(1) : '—',
      +res.DCR_flex_pos.toFixed(3), +res.DCR_flex_neg.toFixed(3), +res.DCR_shear.toFixed(3),
      +res.DCR_torsion.toFixed(3), res.DCR_PM !== undefined ? +res.DCR_PM.toFixed(3) : '—',
      +res.As_req_pos.toFixed(3), res.status, warns,
    ];
    vals.forEach((v, c) => (typeof v === 'number' ? setNum(ws, c, r, v) : setStr(ws, c, r, v)));
    r += 1;
  }

  ws['!ref'] = XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: 20, r: Math.max(r, 1) } });
  ws['!cols'] = [16, 11, 11, 9, 11, 9, 11, 11, 10, 10, 10, 10, 11, 10, 10, 10, 11, 10, 12, 10, 50]
    .map(w => ({ wch: w }));
  return ws;
}

/** Build the full project workbook (pure — no file I/O, so it is unit-testable). */
export function buildProjectWorkbook(project: Project): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // ── Summary sheet ────────────────────────────────────────────────────────
  const summaryData: (string | number)[][] = [
    ['S-Concrete Design — Project Summary'],
    ['Project', project.name, '', 'Engineer', project.engineer],
    ['Code', project.code, '', 'Date', project.date],
    [],
    ['ID', 'Label', 'Type', 'Section', "f'c (psi)", 'fy (ksi)',
      'DCR Flex+', 'DCR Flex-', 'DCR Shear', 'DCR Torsion', 'DCR P-M', 'Status'],
  ];
  for (const m of project.members) {
    const r = worstResult(m, project.code);
    if (!r) continue;
    const sec = m.section.type === 'circular_column'
      ? `Ø${m.section.diameter ?? m.section.b}"`
      : `${m.section.b}"×${m.section.h}"`;
    summaryData.push([
      m.id, m.label, m.memberType, sec,
      m.material.fc, m.material.fy / 1000,
      +r.DCR_flex_pos.toFixed(3), +r.DCR_flex_neg.toFixed(3),
      +r.DCR_shear.toFixed(3), +r.DCR_torsion.toFixed(3),
      r.DCR_PM !== undefined ? +r.DCR_PM.toFixed(3) : '—',
      r.status,
    ]);
  }
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
  wsSummary['!cols'] = [8, 20, 10, 12, 10, 8, 10, 10, 10, 10, 8].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

  // ── Per-member sheets (axial/geometry chain as live formulas) ────────────
  for (const m of project.members) {
    const ws = buildMemberSheet(m, project.code);
    const safeId = m.id.replace(/[:\\/?*[\]]/g, '_');
    XLSX.utils.book_append_sheet(wb, ws, safeId.slice(0, 31));
  }
  return wb;
}

export function exportExcel(project: Project): void {
  const wb = buildProjectWorkbook(project);
  XLSX.writeFile(wb, `${project.name.replace(/\s+/g, '_')}_Results.xlsx`);
}

/** Governing DCR across every checked mode, INCLUDING crack width (worstOf omits it). */
function govDcrOf(r: ReturnType<typeof runDesign>): number {
  return Math.max(worstOf(r), r.DCR_crack ?? 0);
}

/**
 * Compact, single-sheet "DCR list" workbook: one row per member with its governing
 * DCR and the per-mode DCRs — no per-member calc sheets, no schedule. Pure (no I/O)
 * so it is unit-testable.
 */
export function buildDcrListWorkbook(project: Project): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  // member id → group label (a beam shared by several groups shows the last one).
  const groupOf = new Map<string, string>();
  for (const g of project.designGroups ?? [])
    for (const id of g.memberIds) groupOf.set(id, g.label);

  const data: (string | number)[][] = [
    ['S-Concrete Design — Member DCR List'],
    ['Project', project.name, '', 'Code', project.code, '', 'Date', project.date],
    [],
    ['ID', 'Label', 'Type', 'Group', 'Section', 'Gov. DCR',
      'DCR Flex+', 'DCR Flex-', 'DCR Shear', 'DCR Torsion', 'DCR Crack', 'DCR P-M', 'Status'],
  ];
  for (const m of project.members) {
    const r = worstResult(m, project.code);
    if (!r) continue;
    const sec = m.section.type === 'circular_column'
      ? `Ø${m.section.diameter ?? m.section.b}"`
      : `${m.section.b}"×${m.section.h}"`;
    data.push([
      m.id, m.label, m.memberType, groupOf.get(m.id) ?? '—', sec,
      +govDcrOf(r).toFixed(2),
      +r.DCR_flex_pos.toFixed(2), +r.DCR_flex_neg.toFixed(2),
      +r.DCR_shear.toFixed(2), +r.DCR_torsion.toFixed(2),
      +(r.DCR_crack ?? 0).toFixed(2),
      r.DCR_PM !== undefined ? +r.DCR_PM.toFixed(2) : '—',
      r.status,
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [8, 22, 8, 16, 12, 9, 9, 9, 9, 10, 9, 8, 10].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'DCR List');
  return wb;
}

export function exportDcrList(project: Project): void {
  const wb = buildDcrListWorkbook(project);
  XLSX.writeFile(wb, `${project.name.replace(/\s+/g, '_')}_DCR_List.xlsx`);
}
