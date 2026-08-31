import GroupDashboard from '../../../src/components/Dashboard/GroupDashboard.tsx'
import PanelFrame from '../PanelFrame.js'
import { dcrTone, fmtDcr } from '../design.js'

// The Group Dashboard — the app's own component, on the same bus as everything else.
//
// Worth doing for a reason beyond completeness: this is the ONE view the real app can
// already pop out, and it does it through a bespoke Electron IPC channel of its own
// (electron/main.cjs + DashboardWindowRoot + a DashboardCommand union). Here it is just
// another panel: same PanelFrame, same BroadcastChannel, same "props out, calls back"
// contract as the Section drawing. Nothing about it needs to be special, which is the
// argument for generalising the popout rather than adding a second bespoke channel the
// next time a view wants its own window.
//
// Shape: a GROUP list on the left, the selected group's BEAM list on the right (the app's
// GroupDashboard in `variant="list"`). The card grid it replaces was doing two jobs —
// browsing the groups and drawing each one's cage — and they wanted separating: the cage
// now gets the whole Section panel, at a size you can read, while browsing gets a list
// that shows twenty groups at once instead of four.
//
// The payload is built in the main window by the app's own buildDashboardPayload(), so
// what crosses the bus is plain data — which is exactly what a structured clone wants.

/** Side by side needs room for a 230px list AND a readable beam table; under that it
 *  stacks, with the groups as a horizontal strip. Driven by the measured box rather
 *  than a media query, because a panel's width has nothing to do with the viewport's. */
const SPLIT_AT = 640

export default function DashboardPanel({
  payload, selectedGroupId, suggestNote, suggestBusy,
  // The model this dashboard is reading, and the ones it could read instead. A version is
  // a frozen push: same groups, same beams, the geometry and design they had at the
  // moment it was made.
  resizedCount = 0, readOnly = false,
  onSelectGroup, onApplyRebar, onOpenMember, onSetReviewed, onSuggestAll,
  onPushToEtabs,
  ...frame
}) {
  const group = payload.groups.find(g => g.id === selectedGroupId)

  return (
    <PanelFrame {...frame}
      title="Group Dashboard"
      subtitle={`${payload.groups.length} group${payload.groups.length === 1 ? '' : 's'}${group ? ` · ${group.label}` : ''}`}
      actions={(
        <>
          {/* The outcome rides next to the button that produced it, ellipsised, with the
              whole sentence on hover — a note is worth a header slot, not a row. */}
          {suggestNote && <span className="demo-dashnote" title={suggestNote}>{suggestNote}</span>}
          {onPushToEtabs && (
            <button className="demo-push-btn" onClick={onPushToEtabs}
                    disabled={!resizedCount || readOnly}
                    title={readOnly
                      ? 'Viewing a pushed model — switch back to the working model to push again'
                      : resizedCount
                      ? `Create an ETABS frame property for each of the ${resizedCount} resized group(s), reassign their frames, save as a new model and re-run`
                      : 'Nothing has been resized since the model was imported'}>
              ⇪ Push{resizedCount ? ` (${resizedCount})` : ''}
            </button>
          )}
          <button className="demo-suggest" onClick={onSuggestAll}
                  disabled={!onSuggestAll || suggestBusy}
                  title="Auto-size every group's cage to satisfy the DCRs and clear errors">
            ✨ {suggestBusy ? 'Sizing…' : 'Suggest'}
          </button>
        </>
      )}>
      {box => {
        const stacked = box.w < SPLIT_AT
        return (
          <div className={'demo-dashsplit' + (stacked ? ' stacked' : '')}>
            <div className="demo-grouplist">
              {payload.groups.map(g => (
                <GroupRow key={g.id} g={g} on={g.id === selectedGroupId}
                          // Self-toggling: clicking the group that is already selected
                          // turns it off. Selecting a group focuses the plan on its
                          // beams and halftones the rest of the model, so without this
                          // the dashboard is a one-way door — you can filter down to a
                          // group but not get the other beams back from here. The app's
                          // own SectionCard grid has always toggled this way; this list
                          // was the thing that did not.
                          stacked={stacked}
                          onClick={() => onSelectGroup(g.id === selectedGroupId ? null : g.id)} />
              ))}
            </div>
            <div className="demo-dashdetail">
              {group ? (
                <GroupDashboard
                  variant="list"
                  payload={payload}
                  selectedGroupId={selectedGroupId}
                  onSelectGroup={onSelectGroup}
                  onApplyRebar={onApplyRebar}
                  onOpenMember={onOpenMember}
                  onSetReviewed={onSetReviewed}
                  onSuggestAll={onSuggestAll}
                />
              ) : (
                <div className="demo-empty"><b>No group selected.</b>
                  <span>Pick one from the list.</span></div>
              )}
            </div>
          </div>
        )
      }}
    </PanelFrame>
  )
}

const TONE = { ok: '#15803d', warn: '#b45309', fail: '#b91c1c', none: '#9ca3af' }

/** One group. Reviewed groups never read red — the design is unchanged, an engineer has
 *  accepted it, which is the app's own rule and has to hold here too.
 *
 *  The wording is the APP's, not the rail's. This row sits directly beside the app's own
 *  beam list, which calls the same two states `n ✕` / `n ⚠` in its "Beams flagged" strip
 *  and NG / Warning in the Status column. The rail's "3 over / 2 warned" is fine on the
 *  far side of the screen, but half a panel away from "3 ✕ 2 ⚠" it reads as a different
 *  measure of a different thing. Same numbers — errorBeamCount/warnBeamCount are built
 *  from the identical predicates the list re-derives — so they have to be the same words.
 *
 *  Both counts show, rather than the first that is non-zero: a group with 3 NG and 2
 *  warned said "3 over" here while the list beside it said "3 ✕ 2 ⚠". A clean group
 *  stays quiet — "✓ all pass" belongs in the detail header for the ONE selected group,
 *  not repeated down twenty rows. */
function GroupRow({ g, on, stacked, onClick }) {
  const tone = g.reviewed ? 'ok' : dcrTone(g.govDCR)
  const flagged = g.reviewed ? 'Reviewed — engineer sign-off, NG/warnings accepted'
    : g.errorBeamCount || g.warnBeamCount
      ? `${g.errorBeamCount} failing (NG) · ${g.warnBeamCount} warned`
      : 'All beams pass'
  return (
    <button className={'demo-grouprow' + (on ? ' on' : '') + (stacked ? ' chip' : '')} onClick={onClick}
            title={`${g.label} — ${g.beamCount} beam${g.beamCount === 1 ? '' : 's'}, governing DCR ${fmtDcr(g.govDCR)}\n${flagged}`}>
      <span className="demo-grpdot" style={{ background: g.color }} />
      <span className="demo-grouprow-name">
        <span className="demo-grplabel">{g.label}</span>
        {!stacked && (
          <span className="demo-grpmeta">
            {g.beamCount} beam{g.beamCount === 1 ? '' : 's'}
            {g.reviewed ? <span className="demo-grpok"> · ✓ Reviewed</span> : <>
              {g.errorBeamCount > 0 && <span className="demo-grpfail"> · {g.errorBeamCount} ✕</span>}
              {g.warnBeamCount > 0 && <span className="demo-grpwarn"> · {g.warnBeamCount} ⚠</span>}
            </>}
          </span>
        )}
      </span>
      <span className="demo-grouprow-dcr" style={{ color: TONE[tone] }}>{fmtDcr(g.govDCR)}</span>
    </button>
  )
}
