import { useCallback, useRef } from 'react'
import GroupPanel from '../../components/ModelMap/GroupPanel.tsx'
import AutoGroupPanel from '../../components/ModelMap/AutoGroupPanel.tsx'
import PanelFrame from '../PanelFrame'

// Grouping — the app's own two panels, unmodified, on the ordinary bus.
//
// A design GROUP is the unit this app actually designs in: one cage checked against the
// envelope of every beam in the set. Until now the demo could only *show* the grouping
// that data.js shipped with; this is where you make one. Two tabs, because the app has
// two genuinely different ways in and they answer different questions:
//
//   Groups     — manual. Lasso beams on the plan, "Group selection", rename, recolour,
//                add/remove members, dissolve. What you reach for when you already know
//                which beams belong together (a line of spandrels, one storey's girders).
//   Auto-group — clustering. Bin the model by demand within each section family (Jenks
//                natural breaks or quantiles), preview the bins on the plan, then commit.
//                What you reach for at import scale, when 174 beams arrive and nobody
//                knows yet what the sensible families are.
//
// Both write through the SAME onGroupsChange, so a hand-made group and a committed
// suggestion are the same kind of object afterwards — there is no "auto group" mode to
// get stuck in, and the rail, the plan, the Section panel and the Group Dashboard all
// follow either one without knowing which made it.
//
// Selection crosses the bus as an ARRAY, not a Set. Sets do survive a structured clone,
// but an array also survives the shallow prop compare in publish() legibly — and the
// Plan panel already made the same trade for the same reason.

const TABS = [['groups', 'Groups'], ['auto', 'Auto-group']]

export default function GroupsPanel({
  groups, frames, members, selectedFrames, activeGroupId, dcrById, resultById, tab,
  onGroupsChange, onActiveGroupChange, onSelectFrames, onDeleteGroupWithMembers,
  onApplySuggestion, onOverlayChange, onHighlightFrames, onTab,
  ...frame
}) {
  const selected = new Set(selectedFrames)

  // AutoGroupPanel pushes its overlay from an EFFECT keyed on `[bins, onOverlayChange]`,
  // so a fresh arrow per render re-fires it every render — which, once the overlay lands
  // in state and re-renders this panel, is an infinite loop. Detached it is worse: the
  // bus rebuilds every callback on every render, so the identity can never be stable
  // upstream. Pin ONE identity here and let it read the latest prop through a ref; that
  // holds in all three hosts rather than relying on every caller to memoise correctly.
  const overlayRef = useRef(onOverlayChange)
  overlayRef.current = onOverlayChange
  const emitOverlay = useCallback(bins => overlayRef.current && overlayRef.current(bins), [])

  const highlightRef = useRef(onHighlightFrames)
  highlightRef.current = onHighlightFrames
  const emitHighlight = useCallback(
    names => highlightRef.current && highlightRef.current([...names]), [])

  const active = tab === 'auto' ? 'auto' : 'groups'
  const grouped = new Set(groups.flatMap(g => g.memberIds))

  return (
    <PanelFrame {...frame}
      title="Groups"
      // The tabs ride IN the header, between the title and the count, because they name
      // what the panel is showing — "Groups › Auto-group" reads as one title. They used
      // to sit on a strip of their own below it, which cost the panel a whole row of
      // height to hold two buttons and a note the GroupPanel footer already prints.
      titleAfter={(
        <span className="demo-headseg">
          {TABS.map(([k, label]) => (
            <button key={k} className={'sdash-loads-chip' + (k === active ? ' on' : '')}
                    onClick={() => onTab(k)}>{label}</button>
          ))}
        </span>
      )}
      subtitle={`${groups.length} group${groups.length === 1 ? '' : 's'} · ${members.length - grouped.size} ungrouped`}>
      {() => (
        <div className="demo-groups" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* The two tabs want opposite things from this box, so it cannot be one rule.
              GroupPanel is a full-height flex column that scrolls its own list (and
              keeps its action row and footer pinned) — giving it a scrolling parent as
              well produces two nested scrollbars and a footer that slides away.
              AutoGroupPanel is a plain long form with no scroller of its own, so here
              the parent has to be the one that scrolls or its Commit button is
              unreachable. */}
          <div style={{ flex: 1, minHeight: 0, overflow: active === 'groups' ? 'hidden' : 'auto' }}>
            {active === 'groups' ? (
              <GroupPanel
                groups={groups}
                frames={frames}
                members={members}
                selected={selected}
                activeGroupId={activeGroupId}
                dcrById={dcrById}
                designResultsById={resultById}
                onGroupsChange={onGroupsChange}
                onActiveGroupChange={onActiveGroupChange}
                onSelectionChange={names => onSelectFrames([...names])}
                onDeleteGroupWithMembers={onDeleteGroupWithMembers}
                onAutoGroup={() => onTab('auto')}
              />
            ) : (
              <AutoGroupPanel
                members={members}
                onApplySuggestion={onApplySuggestion}
                onOverlayChange={emitOverlay}
                onHighlightChange={emitHighlight}
              />
            )}
          </div>
        </div>
      )}
    </PanelFrame>
  )
}
