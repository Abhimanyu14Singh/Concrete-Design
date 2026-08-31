import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  getPerf, getPerfServerSnapshot, perfReport, subscribePerf,
} from '../utils/perfProbe'
import {
  captureGlobalErrors, clearActivityLog, getActivity, getActivityLog,
  getActivityLogServerSnapshot, getActivityServerSnapshot, subscribeActivity, toggleActivity,
} from '../utils/activity'
import { Z } from '../theme'

// The last line of the shell: a hairline progress bar, a counter, a pause switch, and a
// ⋯ button holding the run log.
//
// It is 22px and it never moves. A status bar that appears only while something runs
// makes the whole layout jump at the exact moment the user is watching a number change,
// so the strip is always there and its CONTENTS change — the app's own rule that a row
// which cannot hold still should not be a row at all.
//
// ── WHY THERE IS NO LABEL BESIDE THE BAR ─────────────────────────────────────────
//
// There used to be one, and it was the widest thing in the strip. The notes these tasks
// end with are sentences — "Suggested 7/11 groups · torsion ≤ 0.42 on every cage applied
// · 2 need a BIGGER SECTION (L2 Spandrels, Transfer) — combined shear + torsion is over
// the cross-section limit there" — and a 22px strip is the worst place in the app to
// read one. It was also the only place: the next task overwrote it, so an outcome worth
// acting on survived only until something else started.
//
// So the strip now shows PROGRESS and the log shows WHAT HAPPENED. The bar is a bar
// again, and the sentence is somewhere it can be read, kept, and scrolled back through.
//
// The ⋯ carries a red dot when the log holds an error, because removing the text removed
// the only place a failure announced itself. A log nobody is told about is a log nobody
// opens.
//
// Three states, and the bar looks different in each rather than relying on the text:
//   idle     — dim, no fill, no button.
//   running  — accent fill, live counter, "Pause" when the task can actually stop.
//   paused   — amber fill frozen where it stopped, "Resume".
//
// A task that is NOT pausable gets no button and no pointer cursor. See activity.ts on
// why: the S-Concrete batch is a spawned BatchReporter and the ETABS push is a COM
// round-trip; neither can be told to hold, and a button that lies about that is worse
// than no button.

const KIND = {
  start: { dot: '#94a3b8', label: 'started' },
  done: { dot: '#15803d', label: 'finished' },
  error: { dot: '#b91c1c', label: 'error' },
  info: { dot: '#2563eb', label: 'note' },
}

const clock = at => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

/** The run log, above the strip that opened it. */
function LogPanel({ anchor, entries, onClear, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    const away = e => {
      if (ref.current?.contains(e.target)) return
      if (e.target?.closest?.('[data-statusbar-log-btn]')) return
      onClose()
    }
    const esc = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [onClose])

  // Newest first. A log you open because something just happened should not ask you to
  // scroll to the bottom to find out what.
  const rows = [...entries].reverse()
  const errors = entries.filter(e => e.kind === 'error').length

  return createPortal(
    <div
      ref={ref}
      style={{
        position: 'fixed',
        right: Math.max(8, window.innerWidth - anchor.right),
        bottom: Math.max(8, window.innerHeight - anchor.top + 6),
        width: 460, maxWidth: 'calc(100vw - 24px)', maxHeight: '52vh',
        display: 'flex', flexDirection: 'column',
        background: 'white', border: '1px solid #cbd5e1', borderRadius: 10,
        boxShadow: '0 12px 32px rgba(0,0,0,0.18)', zIndex: Z.popover, overflow: 'hidden',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: '1px solid #eceef0', background: '#fbfcfd', fontSize: 11,
      }}>
        <span style={{ fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          Run log
        </span>
        <span style={{ color: '#94a3b8' }}>
          {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          {errors > 0 && <span style={{ color: '#b91c1c', fontWeight: 600 }}>{` · ${errors} error${errors === 1 ? '' : 's'}`}</span>}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={onClear}
          disabled={!entries.length}
          style={{
            border: 'none', background: 'none', fontSize: 11, fontWeight: 600,
            color: entries.length ? '#2563eb' : '#cbd5e1',
            cursor: entries.length ? 'pointer' : 'default', padding: '0 4px',
          }}
        >Clear</button>
      </div>

      <div style={{ overflowY: 'auto', padding: '4px 0' }}>
        {!rows.length && (
          <div style={{ padding: '16px 12px', fontSize: 11, color: '#94a3b8', textAlign: 'center' }}>
            Nothing has run yet this session.
          </div>
        )}
        {rows.map(e => {
          const k = KIND[e.kind] ?? KIND.info
          return (
            <div key={e.seq} style={{
              display: 'flex', gap: 8, padding: '5px 12px', alignItems: 'flex-start',
              background: e.kind === 'error' ? '#fef2f2' : 'transparent',
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: k.dot,
                flexShrink: 0, marginTop: 5,
              }} />
              <span style={{
                fontSize: 10, color: '#94a3b8', flexShrink: 0, marginTop: 1,
                fontVariantNumeric: 'tabular-nums',
              }}>{clock(e.at)}</span>
              <span style={{
                fontSize: 11, lineHeight: 1.5, color: e.kind === 'error' ? '#b91c1c' : '#334155',
                minWidth: 0, wordBreak: 'break-word',
              }}>{e.message}</span>
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}

export default function StatusBar() {
  const a = useSyncExternalStore(subscribeActivity, getActivity, getActivityServerSnapshot)
  const entries = useSyncExternalStore(subscribeActivity, getActivityLog, getActivityLogServerSnapshot)
  const perf = useSyncExternalStore(subscribePerf, getPerf, getPerfServerSnapshot)
  const [open, setOpen] = useState(null)   // the ⋯ button's rect while the panel is up
  const btnRef = useRef(null)

  // Uncaught errors and rejected promises land in the log too — see activity.ts. Done
  // here because this is the one component that reads the log, and the call is
  // idempotent, so a remount does not stack listeners.
  useEffect(() => { captureGlobalErrors() }, [])

  const running = !a.finished && a.id > 0
  const determinate = a.total > 0
  // An indeterminate task still gets a bar — a slow sweep of the strip — because "it is
  // working" is the one thing the strip can still show once the label is gone.
  const pct = determinate ? Math.min(100, Math.round((a.done / a.total) * 100)) : 0

  const state = !running ? 'idle' : a.paused ? 'paused' : 'run'
  const canToggle = running && a.pausable
  const counter = running && determinate ? `${a.done}/${a.total}` : ''
  const hasErrors = entries.some(e => e.kind === 'error')

  return (
    <div
      className={'sdash-statusbar sdash-statusbar--' + state + (canToggle ? ' is-clickable' : '')}
      // The whole strip is the hit target, not a 12px button. It is the thinnest thing
      // on screen; asking someone to hit a control inside it would be the wrong ask.
      onClick={canToggle ? toggleActivity : undefined}
      role={canToggle ? 'button' : 'status'}
      tabIndex={canToggle ? 0 : -1}
      onKeyDown={canToggle ? e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleActivity() }
      } : undefined}
      aria-live={canToggle ? 'off' : 'polite'}
      // The label is not shown any more, but it is still the best answer to "what is it
      // doing right now?" — so it lives on the tooltip, where it costs no width.
      title={
        canToggle
          ? `${a.label} — ${a.paused ? 'paused, click to resume' : 'click to pause'}`
          : running ? `${a.label} — this step cannot be paused once it has started`
            : (a.label || undefined)
      }
    >
      <div className="sdash-statusbar-track" aria-hidden="true">
        <div
          className={'sdash-statusbar-fill' + (running && !determinate && !a.paused ? ' sweep' : '')}
          style={determinate ? { width: pct + '%' } : undefined}
        />
      </div>
      {counter && <span className="sdash-statusbar-count">{counter}</span>}
      {canToggle && (
        <span className="sdash-statusbar-action">{a.paused ? 'Resume' : 'Pause'}</span>
      )}

      <span style={{ flex: 1 }} />

      {/* Frame meter. Present only while sampling — an always-on fps readout is a
          number nobody reads and a rAF loop nobody asked for. Click to copy the full
          report (frames, long tasks, scene size, GPU status). */}
      {perf.enabled && (
        <button
          className={'sdash-statusbar-perf' + (perf.stats && perf.stats.fps < 30 ? ' bad'
            : perf.stats && perf.stats.fps < 50 ? ' warn' : '')}
          onClick={e => { e.stopPropagation(); void perfReport().then(t => navigator.clipboard?.writeText(t)) }}
          title={'Frame meter — click to copy the full performance report. '
            + 'Long tasks point at script; none, with slow frames, points at paint.'}
        >
          {perf.stats
            ? `${perf.stats.fps} fps · ${perf.stats.mean} ms · p95 ${perf.stats.p95}`
            : 'measuring…'}
          {perf.longTasks > 0 && (
            <span className="sdash-statusbar-perftag">{perf.longTasks} long</span>
          )}
        </button>
      )}

      <button
        ref={btnRef}
        data-statusbar-log-btn
        className="sdash-statusbar-log"
        // The strip toggles pause on click; this button is a different command sitting
        // inside that hit target, so it must not also pause the sweep it is reporting on.
        onClick={e => {
          e.stopPropagation()
          if (open) { setOpen(null); return }
          const r = btnRef.current?.getBoundingClientRect()
          if (r) setOpen({ right: r.right, top: r.top })
        }}
        aria-expanded={!!open}
        aria-label={`Run log${hasErrors ? ' — contains errors' : ''}`}
        title={hasErrors ? 'Run log — contains errors' : 'Run log — what has run this session'}
      >
        ⋯
        {hasErrors && <span className="sdash-statusbar-logdot" aria-hidden="true" />}
      </button>

      {open && (
        <LogPanel
          anchor={open}
          entries={entries}
          onClear={clearActivityLog}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}
