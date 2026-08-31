/**
 * The Export menu — the old header dropdown, brought across as data.
 *
 * What is worth pinning is not that the labels exist but that the menu is HONEST about
 * what it can do with the model it is given: the old header always had members and
 * groups, this shell opens on an empty model and grouping is optional.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { exportMenuItems } from '../exportMenu.js';
import type { Project } from '../../types';

vi.mock('../../utils/export/excelExport.ts', () => ({ exportExcel: vi.fn(), exportDcrList: vi.fn() }));
vi.mock('../../utils/export/groupScheduleExcel.ts', () => ({ exportGroupScheduleExcel: vi.fn() }));
vi.mock('../../utils/export/schedulePdfExport.ts', () => ({
  buildSchedulePDF: vi.fn(async () => new Uint8Array([1])),
  buildDcrListPDF: vi.fn(async () => new Uint8Array([1])),
}));

// The download path touches the DOM (an <a download> click) and object URLs. The suite
// runs on the `node` environment, so the few globals it needs are stubbed rather than
// pulling in jsdom for one assertion.
beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: () => ({ href: '', download: '', click: () => {} }) };
  (globalThis.URL as unknown as Record<string, unknown>).createObjectURL = () => 'blob:x';
  (globalThis.URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
});

const project = (members: number, groups: number) => ({
  id: 'p', name: 'Job 1', code: 'ACI318-19', date: '2026-01-01',
  members: Array.from({ length: members }, (_, i) => ({ id: `B${i}` })),
  designGroups: Array.from({ length: groups }, (_, i) => ({ id: `g${i}`, label: `G${i}`, memberIds: [] })),
} as unknown as Project);

const labels = (p: Project) => exportMenuItems(p, {}).filter(i => !i.sep).map(i => i.label);
const item = (p: Project, re: RegExp) => exportMenuItems(p, {}).find(i => i.label && re.test(i.label))!;

describe('the menu carries every format the old header had', () => {
  it('offers all eight entries', () => {
    expect(labels(project(3, 2))).toEqual([
      'PDF Report…',
      'Excel Summary',
      'Member DCR List (Spreadsheet)',
      'Member DCR List (PDF)',
      'Group Schedule PDF',
      'Group Schedule (Spreadsheet)',
      'Beam Schedule PDF (full)',
      'Print Preview',
    ]);
  });

  it('groups them with separators rather than one flat list', () => {
    expect(exportMenuItems(project(3, 2), {}).filter(i => i.sep).length).toBe(3);
  });
});

describe('it is honest about what the current model supports', () => {
  it('an empty model disables everything except printing', () => {
    const enabled = exportMenuItems(project(0, 0), {}).filter(i => !i.sep && !i.disabled).map(i => i.label);
    expect(enabled).toEqual(['Print Preview']);
  });

  it('with members but NO groups, only the group schedules are disabled', () => {
    const p = project(3, 0);
    expect(item(p, /^Group Schedule PDF/).disabled).toBe(true);
    expect(item(p, /^Group Schedule \(Spreadsheet\)/).disabled).toBe(true);
    // A beam schedule needs no grouping — it is the answer when there are no groups.
    expect(item(p, /^Beam Schedule PDF/).disabled).toBeFalsy();
    expect(item(p, /^Excel Summary/).disabled).toBeFalsy();
  });

  it('a disabled entry says WHY, so it is not just greyed out', () => {
    expect(item(project(3, 0), /^Group Schedule PDF/).title).toMatch(/no design groups/i);
    expect(item(project(0, 0), /^Excel Summary/).title).toMatch(/no members/i);
  });

  it('everything is enabled once there are members and groups', () => {
    expect(exportMenuItems(project(3, 2), {}).filter(i => !i.sep && i.disabled)).toEqual([]);
  });
});

describe('failures are reported, not swallowed', () => {
  it('a rejected PDF build reports instead of becoming an unhandled rejection', async () => {
    const mod = await import('../../utils/export/schedulePdfExport.ts');
    (mod.buildSchedulePDF as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('font fetch failed'));
    const notes: (string | null)[] = [];
    const items = exportMenuItems(project(2, 1), { onNote: n => notes.push(n) });
    await items.find(i => i.label === 'Group Schedule PDF')!.on();
    expect(notes[0]).toMatch(/Building/);
    expect(notes[notes.length - 1]).toMatch(/failed: font fetch failed/);
  });

  it('a successful build clears the note', async () => {
    const notes: (string | null)[] = [];
    const items = exportMenuItems(project(2, 1), { onNote: n => notes.push(n) });
    await items.find(i => i.label === 'Member DCR List (PDF)')!.on();
    expect(notes[notes.length - 1]).toBe(null);
  });

  it('PDF Report… delegates to the dialog rather than exporting directly', () => {
    const onOpenReport = vi.fn();
    exportMenuItems(project(2, 1), { onOpenReport }).find(i => i.label === 'PDF Report…')!.on();
    expect(onOpenReport).toHaveBeenCalledOnce();
  });
});
