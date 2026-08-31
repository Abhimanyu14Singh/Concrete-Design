import { useState } from 'react'
import Portal from './Portal'
import { toPushProperties } from './etabsPush'
import { SECTION_PUSH_STEPS, buildSectionPushPlan, validateSectionPush } from '../adapters/etabs/pushSections'

// "Push to ETABS" — review what resized, name the properties, name the model, push.
//
// The screen an engineer needs before a destructive round trip: WHICH groups changed,
// what each one was and now is, what the new ETABS frame-section property will be called,
// and what the saved model will be called. Every name is editable, because naming is
// their filing convention and not ours, and both are pre-filled so the common case is one
// click.
//
// ── One button per step, not one button ────────────────────────────────────────
// A live push is five different actions: a file write, three edits, and an analysis that
// can take an hour. Firing all five off one click asks the engineer to authorise all of
// that in a single gesture — and if the fourth fails they cannot tell which of the first
// three happened. The Save As going first is what makes stepping through it safe: after
// step 1 every edit lands on the copy, so stopping half way leaves the original model
// exactly as it was.
//
// So each step is its own button, lit in order. A step turns GREEN when it lands and
// unlocks the next; a failure stops the run where it happened and says so, with the
// steps behind it still green, which is the accurate picture of a half-finished push.
// The order is `SECTION_PUSH_STEPS`, not a list retyped here — a frame cannot go on a
// property that does not exist, and saving before assigning writes the old assignments.
//
// ── The honesty line ───────────────────────────────────────────────────────────
// This does not write to ETABS, and the dialog says so on its face. The app's ETABS
// connection is read-only today: there is no DefineFrameSection, no AssignSection, no
// SaveAs and no RunAnalysis anywhere in the adapters, the Electron bridge or the C#
// sidecar. What it does do is build the exact payload those calls would take and re-run
// the app's own engine over the resized model, which is the round trip minus the
// transport. A dialog that said "pushed to ETABS" while doing that would be lying about
// the one thing the user cannot check from here.

export default function PushToEtabsDialog({
  rows, modelName: initialName, live = false, eUnits = null, busy = null,
  /** Combos the model was imported under — what the re-import step reads back. */
  combos = [],
  onCancel, onPush,
  /** Run one step of the live push: (stepId, plan) → {ok, error?, note?}. */
  onPushStep,
  /** Every step finished — the host reports the outcome and closes. */
  onPushDone,
}) {
  // Local drafts: a name being typed is this dialog's business until Push. Lifting it
  // would re-run the app's design memo on every keystroke of a text field that changes
  // nothing about the model.
  const [names, setNames] = useState(() => Object.fromEntries(rows.map(r => [r.groupId, r.propertyName])))
  const [modelName, setModelName] = useState(initialName)
  // Run the analysis after saving, on by default — it is the point of the round trip,
  // and the one step worth being able to skip because it is the one that takes an hour.
  const [runAnalysis, setRunAnalysis] = useState(true)
  // Per-step progress: id → 'done' | 'running' | { error }. Absent = not started.
  // Keyed by id rather than index so unticking "re-run" cannot silently shift which
  // step a green tick belongs to.
  const [stepState, setStepState] = useState({})

  const draft = rows.map(r => ({ ...r, propertyName: names[r.groupId] ?? r.propertyName }))
  const properties = toPushProperties(draft)
  // The app's own validation and plan builder — the same ones the write path runs, so
  // what this screen shows is what ETABS will be told, converted into its units.
  const errors = validateSectionPush(properties, modelName)
  // The combo set to re-read after the analysis: THE ONE THIS MODEL WAS IMPORTED UNDER,
  // taken off the members' own station forces rather than asked of ETABS. Re-reading
  // "whatever combos the model has now" would compare the new design against a different
  // load case than the old one was sized on, which is not a comparison.
  const plan = buildSectionPushPlan(properties, modelName, { eUnits, runAnalysis, combos })
  const canPush = rows.length > 0 && errors.length === 0 && !busy

  // The steps this plan actually has work for. Recomputed as the plan changes, so
  // unticking "re-run the analysis" removes that button rather than leaving a dead one.
  const steps = SECTION_PUSH_STEPS.filter(st => st.applies(plan))
  const doneOf = id => stepState[id] === 'done'
  const runningOf = id => stepState[id] === 'running'
  const errorOf = id => (stepState[id] && stepState[id].error) || null
  // Strictly in order: a step is available only once everything before it is green.
  // This is the sequence's own constraint, not a UI preference — see the header.
  const nextIdx = steps.findIndex(st => !doneOf(st.id))
  const allDone = nextIdx === -1
  const anyStarted = steps.some(st => stepState[st.id])

  const runStep = async (st) => {
    if (!onPushStep) return
    setStepState(s2 => ({ ...s2, [st.id]: 'running' }))
    const r = await onPushStep(st.id, plan)
    setStepState(s2 => ({ ...s2, [st.id]: r?.ok ? 'done' : { error: r?.error || 'failed' } }))
  }

  /** Native file picker on the desktop; the field stays typeable either way. */
  const pickPath = async () => {
    const api = typeof window !== 'undefined' && window.electronAPI
    if (!api?.pickPath) return
    const r = await api.pickPath({ mode: 'file', filters: [{ name: 'ETABS model', extensions: ['EDB'] }] })
    if (r && r.path) setModelName(r.path)
  }

  return (
    <Portal>
      <div className="demo-modal-back" onMouseDown={onCancel}>
        <div className="demo-modal demo-push" onMouseDown={e => e.stopPropagation()}>
          <div className="demo-modal-head">
            <span className="demo-modal-title">Push to ETABS</span>
            <span className="demo-modal-sub">
              {rows.length
                ? <><b>{rows.length}</b> group{rows.length === 1 ? '' : 's'} resized since import</>
                : 'nothing resized'}
            </span>
            <span style={{ flex: 1 }} />
            <button className="demo-winbtn x" onClick={onCancel} title="Close">✕</button>
          </div>

          <div className="demo-modal-body">
            {rows.length === 0 ? (
              <div className="demo-empty" style={{ minHeight: 120 }}>
                <b>No group has been resized.</b>
                <span>
                  Change a beam&rsquo;s width or depth — in the Editor, or by moving beams into a
                  group whose section differs — and the groups that changed appear here.
                </span>
              </div>
            ) : (
              <>
                <div className="demo-pushlist">
                  {draft.map(r => (
                    <div key={r.groupId} className="demo-pushrow">
                      <span className="demo-grpdot" style={{ background: r.color }} />
                      <span className="demo-pushname">
                        <span className="demo-grplabel">{r.label}</span>
                        <span className="demo-grpmeta">
                          {/* The section it WAS and the section it now is, because the
                              whole reason a new property is needed is that these differ. */}
                          {r.from.b}×{r.from.h} → <b>{r.to.b}×{r.to.h}</b>
                          {' · '}f′c {(r.to.fc / 1000).toFixed(1)} ksi
                          {' · '}{r.frameNames.length} frame{r.frameNames.length === 1 ? '' : 's'}
                          {r.changedCount < r.memberCount
                            ? ` (${r.changedCount} of ${r.memberCount} changed)` : ''}
                        </span>
                      </span>
                      <label className="demo-pushfield">
                        <span>Frame property</span>
                        <input
                          value={names[r.groupId] ?? ''}
                          spellCheck={false}
                          onChange={e => setNames(n => ({ ...n, [r.groupId]: e.target.value }))}
                        />
                      </label>
                    </div>
                  ))}
                </div>

                {/* A PATH, not a name: File.Save writes where it is told, and a bare
                    "model_rev2.EDB" lands wherever ETABS' working directory points. */}
                <label className="demo-pushfield wide">
                  <span>Save the new model as</span>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <input value={modelName} spellCheck={false} style={{ flex: 1 }}
                           onChange={e => setModelName(e.target.value)} />
                    {typeof window !== 'undefined' && window.electronAPI?.pickPath && (
                      <button className="sdash-loads-chip" onClick={pickPath} title="Browse…">…</button>
                    )}
                  </span>
                </label>

                <label className="demo-pushcheck">
                  <input type="checkbox" checked={runAnalysis} onChange={e => setRunAnalysis(e.target.checked)} />
                  <span>Re-run the analysis after saving <i>— editing a section unlocks the
                    model and discards its results, so without this the new file has none</i></span>
                </label>

                {/* What ETABS will actually be told, in ITS units. Shown rather than
                    described: it is the part that has to be right, and reading it is the
                    only way to check it from here. */}
                <div className="demo-pushplan">
                  <b>{plan.define.length}</b> frame propert{plan.define.length === 1 ? 'y' : 'ies'} defined ·
                  {' '}<b>{plan.frameCount}</b> frame{plan.frameCount === 1 ? '' : 's'} reassigned ·
                  {' '}saved as <b>{modelName || '—'}</b>{plan.runAnalysis ? ' · analysis re-run' : ''}
                  {plan.lengthFactor !== 1 && (
                    <> · dimensions ×<b>{plan.lengthFactor}</b> into the model&rsquo;s units</>
                  )}
                </div>

                {errors.map(e => <div key={e} className="demo-pusherr">{e}</div>)}
              </>
            )}
          </div>

          {/* The run itself: one button per step, lit in order, green when it lands. Only
              on a live connection — the simulated path writes nothing, so there is
              nothing to authorise a piece at a time. */}
          {live && onPushStep && (
            <div className="demo-pushsteps">
              {steps.map((st, i) => {
                const done = doneOf(st.id), running = runningOf(st.id), err = errorOf(st.id);
                // Available only when everything before it is green. The order is the
                // sequence's own requirement, not a preference — see the header.
                const ready = i === nextIdx && !running;
                return (
                  <div key={st.id} className="demo-pushstep">
                    <button
                      className={'demo-pushstep-btn'
                        + (done ? ' done' : '') + (running ? ' running' : '') + (err ? ' failed' : '')}
                      disabled={!ready || !!busy}
                      title={err ? `Failed: ${err}` : st.detail(plan)}
                      onClick={() => runStep(st)}
                    >
                      <span className="demo-pushstep-n">{done ? '✓' : running ? '…' : err ? '!' : i + 1}</span>
                      {st.label}
                    </button>
                    {err ? <span className="demo-pushstep-err" title={err}>{err}</span> : null}
                  </div>
                );
              })}
              {allDone && <span className="demo-pushstep-ok">All steps complete.</span>}
            </div>
          )}

          <div className="demo-modal-foot">
            {/* Stated plainly, not buried in a tooltip. The user cannot verify from here
                whether ETABS was touched, so the screen has to tell them. */}
            <span className="demo-pushnote">
              {busy || (live
                ? <>Saves a copy to the path above and works in THAT file: defines the
                    properties, reassigns the frames
                    {runAnalysis
                      ? <>, re-runs the analysis and reads the new forces back onto these
                          members — resizing redistributes load, so the design is then
                          checked against what the beams actually carry now</>
                      : <> and leaves it unanalysed</>}.
                    Your open model is saved-as first and never edited, so it keeps its
                    analysis results — editing a section unlocks a model, and only the
                    copy gets unlocked.</>
                : <>Simulated — no live ETABS model is attached, so this builds the plan and
                    re-runs the design here. Nothing is written to a .EDB.</>)}
            </span>
            <span style={{ flex: 1 }} />
            <button className="sdash-loads-chip" onClick={onCancel}>
              {anyStarted && !allDone ? 'Close' : 'Cancel'}
            </button>
            {live && onPushStep ? (
              allDone ? (
                <button className="demo-suggest"
                        onClick={() => onPushDone?.({ modelName, rows: draft })}>Finish</button>
              ) : null
            ) : (
              <button
                className="demo-suggest"
                disabled={!canPush}
                title={!rows.length ? 'Nothing has been resized' : errors[0]
                  || 'Build the plan and re-run the design here — nothing is written to ETABS'}
                onClick={() => onPush({ rows: draft, modelName, properties, plan, live })}
              >
                {busy ? 'Working…' : 'Simulate the push'}
              </button>
            )}
          </div>
        </div>
      </div>
    </Portal>
  )
}
