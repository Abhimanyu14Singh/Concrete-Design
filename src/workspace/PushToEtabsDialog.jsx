import { useState } from 'react'
import Portal from './Portal'
import { buildPushPayload, validatePush } from './etabsPush'

// "Push to ETABS" — review what resized, name the properties, name the model, push.
//
// The screen an engineer needs before a destructive round trip: WHICH groups changed,
// what each one was and now is, what the new ETABS frame-section property will be called,
// and what the saved model will be called. Every name is editable, because naming is
// their filing convention and not ours, and both are pre-filled so the common case is one
// click.
//
// ── The honesty line ───────────────────────────────────────────────────────────
// This does not write to ETABS, and the dialog says so on its face. The app's ETABS
// connection is read-only today: there is no DefineFrameSection, no AssignSection, no
// SaveAs and no RunAnalysis anywhere in the adapters, the Electron bridge or the C#
// sidecar. What it does do is build the exact payload those calls would take and re-run
// the app's own engine over the resized model, which is the round trip minus the
// transport. A dialog that said "pushed to ETABS" while doing that would be lying about
// the one thing the user cannot check from here.

export default function PushToEtabsDialog({ rows, modelName: initialName, onCancel, onPush }) {
  // Local drafts: a name being typed is this dialog's business until Push. Lifting it
  // would re-run the app's design memo on every keystroke of a text field that changes
  // nothing about the model.
  const [names, setNames] = useState(() => Object.fromEntries(rows.map(r => [r.groupId, r.propertyName])))
  const [modelName, setModelName] = useState(initialName)

  const draft = rows.map(r => ({ ...r, propertyName: names[r.groupId] ?? r.propertyName }))
  const errors = validatePush(draft, modelName)
  const payload = buildPushPayload(draft, modelName)
  const canPush = rows.length > 0 && errors.length === 0

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

                <label className="demo-pushfield wide">
                  <span>New model name</span>
                  <input value={modelName} spellCheck={false} onChange={e => setModelName(e.target.value)} />
                </label>

                {/* What the four COM calls would receive. Shown rather than described,
                    because this is the part that has to be right when the sidecar lands
                    and the only way to check it from here is to read it. */}
                <div className="demo-pushplan">
                  <b>{payload.defineFrameSections.length}</b> frame propert
                  {payload.defineFrameSections.length === 1 ? 'y' : 'ies'} defined ·
                  {' '}<b>{payload.frameCount}</b> frame{payload.frameCount === 1 ? '' : 's'} reassigned ·
                  {' '}saved as <b>{modelName || '—'}</b> · analysis re-run
                </div>

                {errors.map(e => <div key={e} className="demo-pusherr">{e}</div>)}
              </>
            )}
          </div>

          <div className="demo-modal-foot">
            {/* Stated plainly, not buried in a tooltip. The user cannot verify from here
                whether ETABS was touched, so the screen has to tell them. */}
            <span className="demo-pushnote">
              Simulated — the ETABS connection is read-only today, so this builds the push
              payload and re-runs the design here. Nothing is written to a .EDB.
            </span>
            <span style={{ flex: 1 }} />
            <button className="sdash-loads-chip" onClick={onCancel}>Cancel</button>
            <button
              className="demo-suggest"
              disabled={!canPush}
              title={canPush ? 'Create the properties, reassign the frames, save as the new model and re-run'
                : rows.length ? errors[0] : 'Nothing has been resized'}
              onClick={() => onPush({ rows: draft, modelName, payload })}
            >
              Push, save as, and run
            </button>
          </div>
        </div>
      </div>
    </Portal>
  )
}
