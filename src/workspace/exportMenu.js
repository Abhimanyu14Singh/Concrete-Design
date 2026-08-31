import { track } from '../utils/usage.ts'
import { exportExcel, exportDcrList } from '../utils/export/excelExport.ts'
import { exportGroupScheduleExcel } from '../utils/export/groupScheduleExcel.ts'
import { buildSchedulePDF, buildDcrListPDF } from '../utils/export/schedulePdfExport.ts'

// The Export menu — the app's seven output formats, plus print.
//
// This is the old header dropdown brought across to the workspace shell, as DATA rather
// than as markup: the shell already has a menu (`Menu.jsx`, opened through `openMenu`),
// and reusing it means the export menu portals, positions and dismisses exactly like
// every other menu in the app. The old version was ~120 lines of hand-rolled absolute
// positioning with inline hover handlers repeated per item, which is also why it could
// render behind things at non-100% Display Scale.
//
// WHAT "COMPATIBLE WITH THIS APP" MEANT
//
//  · SCOPE. The old app exported `project` directly. This shell can be pointed at a
//    PUSHED model version, and it holds edited group cages that the project's own
//    `designGroups` may lag behind — so the caller passes the model as it is ON SCREEN
//    (see `exportProject` in WorkspaceView). Exporting the stored project instead would
//    silently produce a report of a model the user is not looking at.
//
//  · EMPTINESS. The old header always had members and groups; this shell opens on an
//    empty model and grouping is optional. A schedule of no groups is a cover page and
//    two empty tables, so those entries are disabled with a reason rather than
//    producing a document that looks broken.
//
//  · FAILURE. The three PDF builders are async and the old menu called them bare, so a
//    rejected build (the report embeds fonts over the network) was an unhandled
//    rejection and a click that did nothing. Every one is wrapped here and reports back.

/** Hand a built PDF to the browser as a download. */
function downloadPdf(bytes, name) {
  const blob = new Blob([bytes.buffer ?? bytes], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // Revoked on the next tick, not immediately: Chromium starts the download
  // asynchronously, and revoking in the same frame can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const slug = (s, fallback) => String(s || fallback).replace(/\s+/g, '_')

/**
 * Build the Export menu for the model currently on screen.
 *
 * @param project  the model AS DISPLAYED — see the note above about scope.
 * @param onOpenReport  opens the PDF Report dialog (scope + options live in there).
 * @param onNote  (message) => void, for progress and failure. PDFs take a moment and
 *                can fail; a menu item that silently does nothing is indistinguishable
 *                from one that is broken.
 */
export function exportMenuItems(project, { onOpenReport, onNote } = {}) {
  const members = project?.members ?? []
  const groups = project?.designGroups ?? []
  const note = m => { if (onNote) onNote(m) }

  const noMembers = members.length === 0
  const emptyWhy = 'Nothing to export — this model has no members yet.'
  const noGroups = groups.length === 0
  const groupWhy = 'No design groups yet — group some beams first, or use the beam schedule.'

  // Every export goes through `build` or `run`, so recording it here covers the whole
  // menu — including entries added later — and keeps the item definitions below free of
  // instrumentation. `label` is the app's own menu wording, never anything user-typed;
  // the model size travels with it because a PDF that fails at 900 members and succeeds
  // at 20 is a different bug from one that never works.
  const size = { members: members.length, groups: groups.length }

  /** Run an async builder, reporting progress and any failure. */
  const build = (label, fn) => async () => {
    note(`Building ${label}…`)
    const t0 = Date.now()
    try {
      await fn()
      track('export', { label, ok: true, ms: Date.now() - t0, ...size })
      note(null)
    } catch (e) {
      const message = (e && e.message) || String(e)
      track('export', { label, ok: false, ms: Date.now() - t0, error: message, ...size }, 'error')
      note(`${label} failed: ${message}`)
    }
  }
  /** Run a synchronous export, reporting any failure. */
  const run = (label, fn) => () => {
    const t0 = Date.now()
    try {
      fn()
      track('export', { label, ok: true, ms: Date.now() - t0, ...size })
      note(null)
    } catch (e) {
      const message = (e && e.message) || String(e)
      track('export', { label, ok: false, ms: Date.now() - t0, error: message, ...size }, 'error')
      note(`${label} failed: ${message}`)
    }
  }

  return [
    {
      label: 'PDF Report…',
      disabled: noMembers,
      title: noMembers ? emptyWhy : 'Full calculation report — choose scope, diagrams and calc sheets',
      on: () => onOpenReport && onOpenReport(),
    },
    { sep: true },
    {
      label: 'Excel Summary',
      disabled: noMembers,
      title: noMembers ? emptyWhy : 'Per-member sheets with a live formula chain, plus a project summary',
      on: run('Excel Summary', () => exportExcel(project)),
    },
    {
      label: 'Member DCR List (Spreadsheet)',
      disabled: noMembers,
      title: noMembers ? emptyWhy
        : 'One row per member: governing DCR + per-mode DCRs (flexure / shear / torsion / crack / P-M) and status',
      on: run('Member DCR List', () => exportDcrList(project)),
    },
    {
      label: 'Member DCR List (PDF)',
      disabled: noMembers,
      title: noMembers ? emptyWhy
        : "A few-page PDF of the same list — reviewed members read 'Reviewed', not NG",
      on: build('Member DCR List (PDF)', async () =>
        downloadPdf(await buildDcrListPDF(project), `${slug(project.name, 'dcr')}_DCR_schedule.pdf`)),
    },
    { sep: true },
    {
      label: 'Group Schedule PDF',
      disabled: noMembers || noGroups,
      title: noMembers ? emptyWhy : noGroups ? groupWhy
        : 'One row per design group, with the L/3 cages and a tagged plan per storey',
      on: build('Group Schedule PDF', async () =>
        downloadPdf(await buildSchedulePDF(project, { mode: 'group' }),
          `${slug(project.name, 'schedule')}_group_schedule.pdf`)),
    },
    {
      label: 'Group Schedule (Spreadsheet)',
      disabled: noMembers || noGroups,
      title: noMembers ? emptyWhy : noGroups ? groupWhy : 'The same group schedule as .xlsx',
      on: run('Group Schedule (Spreadsheet)', () => exportGroupScheduleExcel(project)),
    },
    {
      label: 'Beam Schedule PDF (full)',
      disabled: noMembers,
      title: noMembers ? emptyWhy : 'One row per beam — the verbose schedule, no grouping required',
      on: build('Beam Schedule PDF', async () =>
        downloadPdf(await buildSchedulePDF(project, { mode: 'beam' }),
          `${slug(project.name, 'schedule')}_beam_schedule.pdf`)),
    },
    { sep: true },
    {
      label: 'Print Preview',
      title: 'Print the panels as laid out — the toolbar, rail and panel chrome are hidden',
      on: () => window.print(),
    },
  ]
}
