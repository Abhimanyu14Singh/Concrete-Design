import SectionView from '../../../src/components/Detailing/SectionView.tsx'
import SectionCard from '../../../src/components/Dashboard/SectionCard.tsx'
import { formatBarLabel } from '../../../src/utils/rebar.ts'
import { getBarArea, coverFor } from '../../../src/utils/concreteDesign.ts'
import PanelFrame from '../PanelFrame.js'
import { useFmt } from '../format.js'

// The section, for whatever is selected — and what is selected can be a GROUP or a
// MEMBER, which are genuinely different things to look at.
//
//   member  the app's SectionView: the beam's own cage, dimensioned, bars editable
//   group   the app's SectionCard: the group's TEMPLATE cage with the whole set's
//           worst M⁺ / M⁻ / V on it, the curtailment flags, ρ and steel weight —
//           the thing you edit once and apply to every beam in the group
//
// Both are the app's own components. Nothing is redrawn here; the panel only decides
// which one the current selection calls for and how big a box to give it.

const area = groups => (groups || []).reduce((s, g) => s + g.numBars * getBarArea(g.barSize), 0)
// formatBarLabel takes the SIZE alone (`#8`, or `Ø25` for a metric bar held as a
// negative) — the count belongs to the layer, and multi-layer cages read "3-#8 + 2-#8".
const bars = groups => (groups || []).map(g => `${g.numBars}-${formatBarLabel(g.barSize)}`).join(' + ') || '—'

const STRIP = 62   // the value strip's height, reserved out of the drawing's box
// The group card's left detail column — `--sc-side` (196px, set on .demo-groupcard) plus
// the 10px gutter beside it. Reserved here because the SVG is hard-sized from a number:
// the card lays the column out in CSS, but only this file can subtract it from the width
// the drawing is told to be. If one moves, move the other.
const SIDE = 206

// Props are flat and plain on purpose. They are structured-cloned on the way to a
// detached window, and a function anywhere in the tree makes postMessage throw — which
// leaves the panel showing "Loading…" for ever with nothing logged. So: data in props,
// callables in the PANELS registry. Never a whole `design` object with methods on it.
export default function SectionPanel({
  mode, memberId, section: s, rebar: r, result, group, editedDims,
  onRebarChange, onSectionChange, onApplyRebar, onApplySection, onSetReviewed, onToggleCurtailmentNote,
  onSetOppositeTop, onSetMidThirdTop, onSetEndThirdBot,
  ...frame
}) {
  const { fmt, fmtVal, label } = useFmt()

  if (mode === 'group') {
    return (
      <PanelFrame {...frame} title="Section" subtitle={group
        ? `${group.label} · ${group.memberIds.length} beam${group.memberIds.length === 1 ? '' : 's'}`
        : 'no group'}>
        {box => (
          <div className="demo-groupcard">
            {group ? (
              // The card is the dashboard's, given a whole panel instead of a 248px grid
              // cell — so the drawing is sized from the box like every other panel's.
              //
              // No upper bound. These used to cap at 560×420, which meant that past a
              // fairly small panel the cage stopped growing and sat in the middle of an
              // increasingly empty box — maximise the panel and you got the same small
              // drawing with more whitespace around it. A panel's job is to use the space
              // it was given.
              //
              // Worth knowing what "fill" can and cannot mean here: SectionView scales
              // with Math.min(drawW/secW, drawH/secH) and centres the result, so the cage
              // keeps its true proportions and the SMALLER ratio wins. A beam section is
              // taller than it is wide, so height is normally what binds — a very wide,
              // short panel still leaves margin either side, and that is correct. The
              // alternative is a stretched section, which would be a lie about the shape.
              //
              // `layout="split"` puts the opposite-end / middle-third / end-third cages
              // and the ρ line in a column to the LEFT instead of stacked full-width
              // under the drawing. Each is one line of text; spanning a whole panel to
              // say it pushed the section into a letterbox between them.
              //
              // The space that frees goes to the drawing, and the reservations change
              // with it: only the name row is above it now, so the height budget drops
              // from 190 to 96 — the drawing gains ~94px of height and loses the SIDE
              // column's width. Both are reserved, not guessed; take them out and the
              // section pushes its own chrome off the panel.
              <SectionCard
                group={group}
                selected
                layout="split"
                onSelect={() => {}}
                onApplyRebar={onApplyRebar}
                onApplySection={onApplySection}
                editedDims={editedDims}
                onSetReviewed={onSetReviewed}
                onToggleCurtailmentNote={onToggleCurtailmentNote}
                onSetOppositeTop={onSetOppositeTop}
                onSetMidThirdTop={onSetMidThirdTop}
                onSetEndThirdBot={onSetEndThirdBot}
                // Dimensioned and frameless, so a group's section is drawn the same way
                // a member's is. The two views differ in WHAT they show — a group carries
                // the set's envelope, its curtailment flags and ρ — but they should not
                // differ in how a section is drawn, or switching between them reads as
                // switching tools.
                showDims
                flat
                width={Math.max(260, box.w - 40 - SIDE)}
                height={Math.max(180, box.h - 96)}
              />
            ) : (
              <div className="demo-empty"><b>No group selected.</b>
                <span>Pick a group heading in the rail.</span></div>
            )}
          </div>
        )}
      </PanelFrame>
    )
  }

  return (
    <PanelFrame {...frame} title="Section" subtitle={memberId}>
      {box => (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div className="demo-draw" style={{ flex: 1, minHeight: 0 }}>
            {/* editBarSize makes the bar labels on the drawing clickable. The edit is
                reported UP as a whole new rebar layout — the panel keeps no state of its
                own, so an edit made in a detached window is applied by the same handler
                in the main window as one made in the docked panel. */}
            <SectionView
              section={s}
              rebar={r}
              result={result}
              width={Math.max(200, box.w - 8)}
              height={Math.max(140, box.h - STRIP - 8)}
              showDims
              // 96, not the 54 a bare "h = …" dimension needs: the skin label draws
              // OPPOSITE the stirrup label, at mid-height in the left gutter, which
              // means right-aligned outside the h dimension (SectionView's
              // `skinAnchor` wants padL ≥ 88 or it drops the label to the corner).
              padL={96}
              // Bar editing carries the SKIN affordance with it now — count, size and
              // c/c per face, plus "＋ skin" on a beam that has none. It used to ride on
              // editStirrup, which this panel cannot switch on: that drew the label
              // through the rotated "h = …" dimension, both being anchored to the
              // section's left edge (see demo/README.md). The label now drops to the
              // bottom-left corner when dimensions are on, so the two no longer meet.
              editBarSize={!!onRebarChange}
              // editStirrup stays off: it is the stirrup's own edit surface (size, c/c,
              // legs, ⅓ zones) and this workspace already has one — the Editor panel.
              onRebarChange={onRebarChange}
              onSectionChange={onSectionChange}
              editedDims={editedDims}
            />
          </div>
          <div className="sdash-sect-info">
            {/* Every section in this model is rectangular, so there is no shape prefix to
                choose and no flange to append — b IS the width. */}
            <span>Rect&nbsp;
              <b>{fmtVal(s.b, 'length')}×{fmtVal(s.h, 'length')}</b>
              <span className="sdash-sect-lbl"> {label('length')}</span></span>
            <span>cover <b>{fmt(coverFor(s, 'bot'), 'length')}</b></span>
            <span>top <b>{bars(r.topBars)}</b> <span className="sdash-sect-lbl">{fmt(area(r.topBars), 'area')}</span></span>
            <span>bot <b>{bars(r.botBars)}</b> <span className="sdash-sect-lbl">{fmt(area(r.botBars), 'area')}</span></span>
            {/* Skin / face reinforcement, stated even when there is none — on a deep web
                that is a detailing decision, and a strip that simply omitted the line
                would read as "not applicable" rather than "none". Counted PER FACE, the
                way the cage is specified and the way the drawing lays it out: the area is
                both faces, so it is 2 × the bar count. The c/c only prints when the cage
                carries one; otherwise the bars are spread evenly over the clear web and
                the drawing's own label is where that derived spacing belongs. */}
            <span>skin <b>{r.sideBars?.length ? bars(r.sideBars) : '—'}</b>
              {r.sideBars?.length ? (
                <>
                  {r.sideBars[0].spacing ? <> @ <b>{fmt(r.sideBars[0].spacing, 'length')}</b></> : null}
                  {' '}<span className="sdash-sect-lbl">per face · {fmt(2 * area(r.sideBars), 'area')}</span>
                </>
              ) : null}
            </span>
            <span>links <b>{r.ties.legs}-leg {formatBarLabel(r.ties.barSize)}</b>
              {/* Zoned links are three spacings over equal thirds, and the shear check
                  reads capacity at the zone the demand sits in — so printing one number
                  here would be a lie on exactly the members that need care. */}
              {r.tieZones
                ? <> @ <b>{r.tieZones.map(z => fmtVal(z.spacing, 'length')).join('/')} {label('length')}</b>
                     <span className="sdash-sect-lbl">zoned</span></>
                : <> @ <b>{fmt(r.ties.spacing, 'length')}</b></>}
            </span>
          </div>
        </div>
      )}
    </PanelFrame>
  )
}
