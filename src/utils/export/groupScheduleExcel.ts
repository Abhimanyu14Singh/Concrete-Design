/**
 * Group reinforcement schedule as an .xlsx workbook — the spreadsheet twin of the
 * schedule PDF. One row per design group, top steel split into its three L/3
 * regions and stirrups into their three zones, skin bars with spacing, and a
 * notes column carrying the pinned curtailment bar counts. Pure builder +
 * download wrapper, mirroring excelExport.ts.
 */
import * as XLSX from 'xlsx';
import type { Project, Member } from '../../types';
import {
  barsStr, skinStr, stirrupZoneStr, scheduleSectionLabel, groupMaxDCR, groupNoteText,
} from './scheduleData';

export function buildGroupScheduleWorkbook(project: Project): XLSX.WorkBook {
  const isEC2 = project.code === 'EN1992-1-1';
  const memberById = new Map(project.members.map(m => [m.id, m]));
  const groups = project.designGroups ?? [];

  const header = [
    '#', 'Group', 'Section (b×h)', 'Beams',
    'Top — Mark End', 'Top — Middle', 'Top — Opp. End',
    'Bottom', 'Skin (n-size@spacing)',
    'Stirrup — Mark End', 'Stirrup — Middle', 'Stirrup — Opp. End',
    'Notes', 'Max DCR',
  ];
  const data: (string | number)[][] = [
    [`Group Reinforcement Schedule — ${project.name ?? ''}`],
    [`Code: ${project.code}    Engineer: ${project.engineer ?? '—'}    Date: ${project.date ?? '—'}`],
    [],
    header,
  ];

  let idx = 0;
  for (const g of groups) {
    const gm = g.memberIds.map(id => memberById.get(id)).filter((m): m is Member => !!m);
    const beams = gm.filter(m => m.memberType === 'beam' || !m.memberType);
    const rep = beams[0] ?? gm[0];
    const rebar = g.rebar ?? rep?.rebar;
    if (!rebar) continue;
    idx += 1;
    data.push([
      idx, g.label, scheduleSectionLabel(rep, isEC2), beams.length,
      barsStr(rebar.topBars), barsStr(g.midThirdTopBars), barsStr(g.oppositeTopBars),
      barsStr(rebar.botBars), skinStr(rebar.sideBars, isEC2),
      stirrupZoneStr(rebar, 0, isEC2), stirrupZoneStr(rebar, 1, isEC2), stirrupZoneStr(rebar, 2, isEC2),
      groupNoteText(g, beams, rebar, project.code) || '—',
      +groupMaxDCR(beams, project.code).toFixed(2),
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [4, 24, 12, 6, 15, 15, 15, 15, 20, 15, 15, 15, 52, 8].map(w => ({ wch: w }));
  // Merge the two title rows across the table width.
  ws['!merges'] = [
    { s: { c: 0, r: 0 }, e: { c: header.length - 1, r: 0 } },
    { s: { c: 0, r: 1 }, e: { c: header.length - 1, r: 1 } },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Group Schedule');
  return wb;
}

export function exportGroupScheduleExcel(project: Project): void {
  const wb = buildGroupScheduleWorkbook(project);
  XLSX.writeFile(wb, `${(project.name ?? 'schedule').replace(/\s+/g, '_')}_group_schedule.xlsx`);
}
