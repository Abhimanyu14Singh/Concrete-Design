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
  barsStr, skinStr, stirrupZoneStr, scheduleSectionLabel, groupNoteText, continuousBars,
} from './scheduleData';
import { analyzeGroupCurtailment } from '../curtailment';

export function buildGroupScheduleWorkbook(project: Project): XLSX.WorkBook {
  const isEC2 = project.code === 'EN1992-1-1';
  const memberById = new Map(project.members.map(m => [m.id, m]));
  const groups = project.designGroups ?? [];

  const header = [
    '#', 'Group', 'Section (b×h)', 'Beams',
    'Top — Mark End', 'Top — Middle', 'Top — Opp. End',
    'Bottom — Mark End', 'Bottom — Middle', 'Bottom — Opp. End',
    'Skin (n-size@spacing)',
    'Stirrup — Mark End', 'Stirrup — Middle', 'Stirrup — Opp. End',
    'Notes',
  ];
  const data: (string | number)[][] = [
    [`Group Reinforcement Schedule — ${project.name ?? ''}`],
    [`Code: ${project.code}    Date: ${project.date ?? '—'}`],
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
    // Per-region cages, connected to the group's explicit curtailment cages (the
    // same ones the section card / eye pop-out / moment diagram use). Top: mark
    // cage runs through unless a reduced middle-third / opposite-end cage is set.
    // Bottom: full mid-span, curtailed toward the supports to the explicit
    // end-third cage when set, else the auto ~continuous cage.
    const cu = beams.length ? analyzeGroupCurtailment(beams, rebar, project.code) : null;
    const topMark = barsStr(rebar.topBars);
    const topMid = g.midThirdTopBars?.length ? barsStr(g.midThirdTopBars) : topMark;
    const topOpp = g.oppositeTopBars?.length ? barsStr(g.oppositeTopBars) : topMark;
    const botMid = barsStr(rebar.botBars);
    const botEnd = g.endThirdBotBars?.length
      ? barsStr(g.endThirdBotBars)
      : (cu?.bot ? continuousBars(rebar, 'bot', cu.bot) : botMid);
    data.push([
      idx, g.label, scheduleSectionLabel(rep, isEC2), beams.length,
      topMark, topMid, topOpp,
      botEnd, botMid, botEnd,
      skinStr(rebar.sideBars, isEC2),
      stirrupZoneStr(rebar, 0, isEC2), stirrupZoneStr(rebar, 1, isEC2), stirrupZoneStr(rebar, 2, isEC2),
      groupNoteText(g, beams, rebar, project.code) || '—',
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [4, 24, 12, 6, 15, 15, 15, 15, 15, 15, 20, 15, 15, 15, 52].map(w => ({ wch: w }));
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
