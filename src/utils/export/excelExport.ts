import * as XLSX from 'xlsx';
import type { Project, Member } from '../../types';
import { runDesign } from '../../engines';

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

export function exportExcel(project: Project): void {
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

  // ── Per-member sheets ────────────────────────────────────────────────────
  for (const m of project.members) {
    const rows: (string | number)[][] = [
      [`Member: ${m.id} — ${m.label}`],
      ['Type', m.memberType, 'Section Type', m.section.type],
      ['f\'c (psi)', m.material.fc, 'fy (ksi)', m.material.fy / 1000, 'fyt (ksi)', m.material.fyt / 1000],
      ['Width b (in)', m.section.b, 'Depth h (in)', m.section.h ?? 0,
        'Clear Cover (in)', m.section.coverClear],
      [],
      ['LOAD CASE RESULTS'],
      ['Load Case', 'Mu+ (k-ft)', 'Mu- (k-ft)', 'Vu (k)', 'Tu (k-ft)', 'Pu (k)',
        'Mux (k-ft)', 'Muy (k-ft)',
        'φMn+ (k-ft)', 'φMn- (k-ft)', 'φVn (k)', 'φTn (k-ft)', 'φPn,max (k)',
        'DCR Flex+', 'DCR Flex-', 'DCR Shear', 'DCR Torsion', 'DCR P-M',
        'As_req+ (in²)', 'As_min (in²)', 'As_max (in²)', 'Av_req (in²/in)', 'Status', 'Warnings'],
    ];
    for (const lc of m.loads) {
      const r = runDesign(m.section, m.material, m.rebar, lc, m.span ?? 20, project.code, m.crackParams);
      const warns = r.warnings.map(w => `[${w.code}] ${w.message}`).join('; ');
      rows.push([
        lc.label,
        lc.Mu_pos, lc.Mu_neg, lc.Vu, lc.Tu, lc.Pu,
        lc.Mux ?? 0, lc.Muy ?? 0,
        +r.phi_Mn_pos.toFixed(2), +r.phi_Mn_neg.toFixed(2),
        +r.phi_Vn.toFixed(2), +r.phi_Tn.toFixed(2),
        r.phi_Pn_max !== undefined ? +r.phi_Pn_max.toFixed(1) : '—',
        +r.DCR_flex_pos.toFixed(3), +r.DCR_flex_neg.toFixed(3),
        +r.DCR_shear.toFixed(3), +r.DCR_torsion.toFixed(3),
        r.DCR_PM !== undefined ? +r.DCR_PM.toFixed(3) : '—',
        +r.As_req_pos.toFixed(3), +r.As_min.toFixed(3), +r.As_max.toFixed(3),
        +r.Av_req.toFixed(5),
        r.status, warns,
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [14, 10, 10, 8, 10, 8, 10, 10, 8, 10, 10, 10, 10, 10, 12, 10, 10, 12, 8, 50]
      .map(w => ({ wch: w }));
    const safeId = m.id.replace(/[:\\/?*[\]]/g, '_');
    XLSX.utils.book_append_sheet(wb, ws, safeId.slice(0, 31));
  }

  XLSX.writeFile(wb, `${project.name.replace(/\s+/g, '_')}_Results.xlsx`);
}
