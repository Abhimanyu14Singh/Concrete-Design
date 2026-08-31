import { useState } from 'react'
import MapCanvas from '../../components/ModelMap/MapCanvas.tsx'
import Dropdown from '../../components/common/Dropdown.tsx'
import { Icon } from '../../components/common/Icon.tsx'
import PanelFrame from '../PanelFrame'
import PlanFilter from '../PlanFilter'
import PlanHistogram from '../PlanHistogram'
import { useFmt } from '../format'
import { dcrBandsFrom, DEFAULT_DCR_THRESHOLDS } from '../../theme.ts'
import { frameColorFor } from '../../components/ModelMap/frameColor.ts'

// The plan view — the app's own MapCanvas, unmodified: colouring by DCR or by group,
// lasso multi-select, zoom and pan, the rich hover tooltip, all of it.
//
// It is the panel that makes the rail and the workspace agree about *where* a beam is.
// Click a line and the whole workspace follows it; double-click and it becomes the
// selected member. Detached onto a second monitor it is the model, permanently open,
// beside whatever you are designing.
//
// It is also where GROUPING happens: the lasso is what feeds "Group selection" in the
// Groups panel, the active group halftones everything outside it, and an auto-group
// preview paints its proposed bins straight onto the model.
//
// ── 2D / 3D ──────────────────────────────────────────────────────────────────────
// The toggle changes the PROJECTION and nothing else. MapCanvas puts every point —
// frames, grids, columns, diagrams, tags, and the lasso's hit test — through one P(),
// so picking, selecting, colouring and hovering behave identically tilted. That is why
// this is a one-prop change here rather than a second canvas: there is no 3D mode to
// keep in sync with the 2D one, because there is only one canvas.
//
// Columns only draw in 3D (in plan a column is a single point, and a field of dots over
// the beams is noise), and they are scenery — never selectable, never grouped.
//
// Note what does NOT cross the bus: `selected` is a Set in MapCanvas's own API, but it
// travels as a plain array and is rebuilt here. Sets do survive a structured clone, but
// an array also survives the shallow prop compare in publish() legibly, and one fewer
// exotic type in a payload is one fewer thing to debug later. `gradeColorMap` is the one
// Map that does travel: it is MapCanvas's own prop type, and rebuilding it either side
// would be pure ceremony.

// ── Colour by ────────────────────────────────────────────────────────────────────
// The app's full scheme list, in the app's order and with the app's wording, because
// these are the same modes computed by the same functions — a label that read
// differently here would imply a difference that does not exist.
//
// A dropdown rather than the chip row it replaces: thirteen schemes is far past what a
// segmented control can show without wrapping the toolbar onto three lines, and in a
// panel that can be tiled three-across there is no width to spend. It also puts the
// active scheme in words at all times, which a row of equal-looking chips does not.
//
// Metric modes carry a unit in their label, so the list has to be built per render from
// the live unit system — hard-coding "lb/ft" would be a wrong label the moment anyone
// flips to SI, on a number an engineer reads off the ramp.
const colourOptions = (label, hasOverlay, hasSco) => [
  // FIRST, and the default. No scheme: every beam in the standard colour set in
  // Preferences, so the plan opens as a drawing of the model rather than as a verdict on
  // it — which also matters on a model nothing has been run against yet, where a DCR map
  // colours the whole floor from missing results.
  // Labelled just “–”. It is the ABSENCE of a scheme, and the dropdown already carries
  // “Colour by” as its own label — spelling out "None (standard colours)" made the
  // closed control twice the width of every other entry to say nothing extra.
  { value: 'none', label: '–' },
  { value: 'dcr', label: 'DCR' },
  { value: 'group', label: 'Design group' },
  { value: 'groupTags', label: 'Group + tags' },
  { value: 'section', label: 'Section' },
  { value: 'flexSteel', label: 'Steel % (ρ)' },
  { value: 'stirrups', label: `Stirrups (${label('areaPerLength')})` },
  { value: 'weight', label: `Steel weight (${label('steelWeightPerLength')})` },
  { value: 'height', label: `Height (${label('length')})` },
  { value: 'width', label: `Width (${label('length')})` },
  { value: 'concGrade', label: 'Conc grade (f′c)' },
  { value: 'steelGrade', label: 'Steel grade (f_y)' },
  // Both of these colour from data that may not exist. An option that paints the whole
  // model one flat grey is a dead control, and worse, it reads as "the model lost its
  // grouping" rather than "nothing has been proposed yet" — so each appears only once
  // there is something for it to show. S-Concrete now has a panel here, so that one is
  // reachable: run a batch on the desktop shell and the scheme appears.
  ...(hasOverlay ? [{ value: 'autoGroup', label: 'Auto-group overlay' }] : []),
  // Appears only once a batch has produced something. The DCR is the whole verdict: it
  // sits on the same bands as the app's own DCR, so the two maps can be flipped between
  // and compared, and ≥ 1.00 IS the fail. A separate pass/fail scheme drew the same
  // results in three flat colours and answered strictly less.
  ...(hasSco ? [{ value: 'sconcreteDcr', label: 'S-Concrete DCR' }] : []),
]

// ── M / V overlay ────────────────────────────────────────────────────────────────
// The force envelopes, drawn on the plan itself: one filled polygon per beam, set
// perpendicular to the member and scaled to the worst value in the model, so the shape
// of the demand is legible at model scale without opening a beam.
//
// It answers a question colouring cannot. A DCR map says which frames are in trouble;
// the envelope says how the load is actually distributed along and across the floor —
// where the transfer beams are picking up, which bays run flat. The two read together:
// colour for the verdict, polygons for the demand behind it.
//
// Two buttons on the bar, not a dropdown. These are the overlay you reach for while
// looking at the plan and then turn off again, and a dropdown makes that three actions
// (open, pick, and later open-pick-None) for something worth one click.
//
// They stay MUTUALLY EXCLUSIVE — diagramMode is a single value, because the two
// envelopes have different units and share one normalisation, so both at once would be
// a meaningless drawing. Pressing the lit one turns it off; the title says so, which is
// the part a dropdown got for free and buttons have to state.
const DIAGRAMS = [
  ['moment', 'M', 'Moment envelope on the plan — signed, so hogging and sagging fall on opposite sides of the member'],
  ['shear', 'V', 'Shear envelope on the plan — signed, so the polygon crosses the member where the shear reverses'],
]

/** Shared empty lookup — `frameColorFor` wants the categorical maps even in the modes
 *  that never read them, and a fresh `new Map()` per render is a new prop every time. */
const EMPTY_MAP = new Map()

const ctl = { padding: '3px 8px', border: '1px solid var(--sd-border, #cbd5e1)', borderRadius: 6, fontSize: 11, background: 'white', minWidth: 96 }

export default function PlanPanel({
  frames, grids, columns, walls, stories, hiddenStories, elements,
  colorMode, dcrById, infoById, designGroups,
  selectedFrames, errorFrames, focusFrames, autoGroupOverlay, view3d,
  diagramMode = 'off', diagramDataById,
  // The load combinations imported from ETABS, and which one the M / V overlay draws.
  // '' = the envelope across all of them.
  combos = [], planCombo = '',
  metricById, metricRange, metricLabel, flexFace = 'bot',
  // The distribution of the model, overlaid bottom-left. One numeric series — whatever
  // `colorMode` is colouring by — already converted to display units, labelled and given
  // a unit by the workspace (see `histSeries` there). Null for the categorical modes.
  histSeries,
  // Line weight: the pen the plan is drawn with, from a hairline at 0 to a heavy line at
  // 1, measured in SCREEN px so the weight does not change as you zoom. Section width
  // only modulates it. The app's own control, same range and same default.
  // Colour / opacity / fill per element kind — the user's Preferences (Preferences →
  // Model appearance). Undefined falls back to MapCanvas's own defaults, so a caller that
  // does not set it draws the map exactly as it always did.
  elementStyles,
  widthById, lineWeightScale = 0.35,
  // The DCR scale, editable from the legend at the bottom-left of the canvas. Bands are
  // DERIVED (dcrBandsFrom) rather than passed as a fifth piece of state, so the fills and
  // the legend are built from the same two facts and cannot drift.
  dcrThresholds, dcrColors, onDcrThresholds, onDcrColors,
  gradeColorMap, gradeLegend, markEndById, scoStatusById, scoDcrById,
  onHiddenStories, onElements,
  onColorMode, onSelectFrames, onOpenMember, onView3d, onDiagramMode, onPlanCombo, onFlexFace, onLineWeight,
  // Right-click a beam. The panel only reports WHICH beam and WHERE — the items, and the
  // state they close over, belong to the host window, which is also the window the menu
  // has to render in. `onMenu` (the header's) works the same way.
  onBeamMenu,
  ...frame
}) {
  const { label } = useFmt()
  const selected = new Set(selectedFrames)
  const errorIds = new Set(errorFrames)
  // Empty = no focus. MapCanvas halftones every frame OUTSIDE a non-empty focus set, so
  // an empty one has to stay empty rather than becoming "focus nothing" — which would
  // dim the entire model.
  const focus = focusFrames && focusFrames.length ? new Set(focusFrames) : undefined
  const overlay = autoGroupOverlay || []
  const scoStatus = scoStatusById || {}
  const scoDcr = scoDcrById || {}
  // `|| colorMode === 'sconcreteDcr'` keeps the ACTIVE scheme in the list even when the
  // results behind it are not loaded. A mode with no matching option leaves the picker
  // reading back its raw key ("sconcreteDcr") with no way to name what you are looking
  // at — reachable now that a machine last left on the withdrawn pass/fail scheme is
  // migrated onto this one at boot, before any batch has run.
  const options = colourOptions(label, overlay.length > 0,
    Object.keys(scoStatus).length > 0 || Object.keys(scoDcr).length > 0
      || colorMode === 'sconcreteDcr')
  const [histClosed, setHistClosed] = useState(false)
  // Which beams the hovered histogram bar holds. LOCAL, like the histogram's own axis
  // state: it is a property of where the pointer is in this panel, so it neither travels
  // the bus nor persists — a detached Model window emphasises from its own histogram.
  const [histHover, setHistHover] = useState(null)
  const bands = dcrBandsFrom(dcrThresholds || DEFAULT_DCR_THRESHOLDS, dcrColors)
  // The colour the MAP would draw a member in — handed to the histogram so a bar is
  // filled the same colour as the beams inside it. This is `frameColorFor` itself, the
  // function the canvas below calls per frame, rather than a second implementation of
  // the ramp: a bar that is nearly the right red is a bar you cannot trust to pair with
  // anything, and re-deriving one of these two from the other is how they drift.
  //
  // Built here rather than in the workspace because it is a FUNCTION, and `histSeries`
  // crosses the popout bus where a structured clone would choke on one.
  //
  // The two group maps are empty on purpose: every mode that reads them is categorical
  // and draws no histogram at all, so there is nothing to look up.
  const histColorOf = id => frameColorFor({ memberId: id, sectionName: '' }, {
    colorMode, dcrById, groupColorMap: EMPTY_MAP, autoGroupColorMap: EMPTY_MAP,
    metricById: metricById || {}, metricRange, gradeColorMap,
    scoStatusById: scoStatus, scoDcrById: scoDcr, dcrBands: bands,
    beamColor: elementStyles?.beam?.color,
  })
  const legend = gradeLegend || []
  // Reserved out of the canvas box. The SVG is hard-sized from a number, so anything
  // else in this column has to be subtracted here — a legend row that appears without
  // being accounted for pushes the canvas past the panel and clips it.
  const BAR = 38 + (legend.length ? 26 : 0)

  const hidden = new Set(hiddenStories)
  const shown = frames.filter(f => !hidden.has(f.story)).length
  // Walls and floors share one array and one MapCanvas flag, so the two filters are
  // applied by choosing what goes IN rather than by a second flag.
  const shownWalls = (walls || []).filter(w => (w.kind === 'slab' ? elements.floors : elements.walls))
  // One visible storey is the normal case, so name it; otherwise count. "2/5 storeys"
  // says the filter is on without making you open it.
  const visible = stories.filter(s2 => !hidden.has(s2))
  const storeyText = visible.length === 1 ? visible[0]
    : visible.length === stories.length ? 'all storeys'
      : `${visible.length}/${stories.length} storeys`
  // The active scheme, named in the subtitle — a dropdown collapses to one line of text,
  // so the header is where "what am I looking at" now lives.
  const modeLabel = (options.find(o => o.value === colorMode) || {}).label || colorMode
  // Which combo the overlay is on, for the panel subtitle. An overlay drawn from one
  // combination and an overlay drawn from the envelope are different pictures, and
  // nothing else on screen says which one you are looking at.
  const diagramLabel = diagramMode === 'off' ? null
    : `${diagramMode === 'moment' ? 'M' : 'V'} · ${planCombo || 'envelope'}`

  return (
    <PanelFrame {...frame}
      title="Model"
      subtitle={`${view3d ? '3D · ' : ''}${storeyText} · ${shown} frames · ${modeLabel}`
        + (diagramLabel ? ` · ${diagramLabel}` : '')}>
      {box => (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div className="demo-planbar">
            <PlanFilter
              stories={stories}
              hiddenStories={hiddenStories}
              elements={elements}
              onHiddenStories={onHiddenStories}
              onElements={onElements}
            />
            <div className="demo-planseg">
              {/* One button, two labels — it names the view you are IN, and pressing it
                  goes to the other. A pair of 2D/3D chips would need a selected state to
                  say the same thing in twice the width. */}
              <button className={'sdash-loads-chip' + (view3d ? ' on' : '')}
                      title={view3d
                        ? 'Back to the 2D plan'
                        : 'Tilt the model — drag empty space to orbit, shift-drag to lasso, 1–4 for standard views'}
                      onClick={() => onView3d(!view3d)}>
                {view3d ? '3D' : '2D'}
              </button>
            </div>
            {onLineWeight && (
              <label className="demo-lineweight" title="Line weight — drag left for a hairline plan, right for heavy lines (wider beams always read a little heavier)">
                <Icon name="lineWeight" size={14} />
                <input
                  className="slim-range" type="range" min={0} max={1} step={0.05}
                  value={lineWeightScale}
                  onChange={e => onLineWeight(parseFloat(e.target.value))}
                />
              </label>
            )}
            <span style={{ flex: 1 }} />
            {/* WHICH combination the M / V overlay draws. It sits immediately left of the
                two buttons because it qualifies them — "moment, of this combo" — and it
                only appears once a diagram is on, since with the overlay off there is
                nothing for it to qualify.

                The envelope stays the first entry and the default. It answers "how much
                does this member have to take anywhere", which is the right question for
                sizing — but it is NOT a bending moment diagram: at a station where one
                combo sags and another hogs it keeps the larger magnitude, so the curve
                hops between combos and the line joining those points is a load case that
                does not exist. Picking a combo is how you get a diagram you can read. */}
            {diagramMode !== 'off' && combos.length > 0 && (
              <Dropdown
                value={planCombo}
                options={[
                  { value: '', label: 'Envelope (worst |M|, V)' },
                  ...combos.map(c => ({ value: c, label: c })),
                ]}
                onChange={onPlanCombo}
                title="Which load combination the overlay draws — Envelope is the worst of all of them, not a real diagram"
                ariaLabel="Overlay load combination"
                style={{ ...ctl, minWidth: 150, maxWidth: 190 }}
              />
            )}
            <div className="demo-planseg">
              {DIAGRAMS.map(([k, lbl, tip]) => (
                <button key={k}
                        className={'sdash-loads-chip' + (diagramMode === k ? ' on' : '')}
                        title={diagramMode === k ? `${tip} — click to turn off` : tip}
                        onClick={() => onDiagramMode(diagramMode === k ? 'off' : k)}>
                  {lbl}
                </button>
              ))}
            </div>
            <Dropdown
              value={colorMode}
              options={options}
              onChange={onColorMode}
              title="Colour the plan by…"
              ariaLabel="Colour by"
              style={{ ...ctl, minWidth: 132 }}
            />
            {/* Only ρ has two answers, so only ρ gets the face switch. It sits beside the
                dropdown rather than inside it, because it is not a thirteenth scheme —
                it is a parameter of one of them, and folding it in would make two rows
                of the list mean "the same map of a different face". */}
            {colorMode === 'flexSteel' && (
              <button className="sdash-loads-chip on"
                      title="Which face the ratio measures — sagging (bottom) or hogging (top) steel"
                      onClick={() => onFlexFace(flexFace === 'bot' ? 'top' : 'bot')}>
                {flexFace === 'bot' ? 'Bot ↕' : 'Top ↕'}
              </button>
            )}
          </div>

          {/* The two GRADE modes are categorical, and MapCanvas draws a legend only for
              the continuous ramps — so without this the plan is coloured by something
              with no key at all. */}
          {legend.length > 0 && (
            <div className="demo-planlegend">
              {legend.map(g => (
                <span key={g.key} className="demo-swatch" title={`${g.count} member${g.count === 1 ? '' : 's'}`}>
                  <i style={{ background: g.color }} />{g.label}
                  <b style={{ marginLeft: 4, opacity: 0.6 }}>{g.count}</b>
                </span>
              ))}
            </div>
          )}

          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
            {/* Over the canvas, not beside it. Its own axis state is LOCAL: which
                distribution you are reading is a property of looking at this panel, not
                of the model, so it neither travels the bus nor lands in the saved
                layout — and a detached Plan window keeps its own. */}
            <PlanHistogram
              series={histSeries}
              collapsed={histClosed}
              onCollapsed={setHistClosed}
              /* MapCanvas parks the DCR scale legend in the same bottom-left corner, so in
                 those two modes the histogram sits a row higher instead of on top of it. */
              raised={colorMode === 'dcr' || colorMode === 'sconcreteDcr'}
              colorOfMember={histColorOf}
              onHoverMembers={ids => setHistHover(ids.length ? new Set(ids) : null)}
            />
            <MapCanvas
              frames={frames}
              grids={grids}
              showGrids={elements.grids}
              columns={columns}
              walls={shownWalls}
              showWalls={elements.walls || elements.floors}
              showColumns={elements.columns}
              view3d={view3d}
              hiddenStories={hidden}
              colorMode={colorMode}
              dcrById={dcrById}
              infoById={infoById}
              designGroups={designGroups}
              dcrBands={bands}
              emphasisMembers={histHover}
              dcrThresholds={dcrThresholds}
              onDcrThresholdsChange={onDcrThresholds}
              dcrColors={dcrColors}
              onDcrColorsChange={onDcrColors}
              diagramMode={diagramMode}
              diagramDataById={diagramDataById || {}}
              elementStyles={elementStyles}
              metricById={metricById}
              metricRange={metricRange}
              metricLabel={metricLabel}
              widthById={widthById}
              lineWeightScale={lineWeightScale}
              gradeColorMap={gradeColorMap}
              markEndById={markEndById}
              scoStatusById={scoStatus}
              scoDcrById={scoDcr}
              autoGroupOverlay={overlay}
              focusFrames={focus}
              // The red halo is a statement about DCR, so it belongs to the DCR map and
              // nowhere else. Left always-on it painted a permanent alarm over the
              // overstressed beams under every scheme — including the ones (group,
              // section, grade) where a result colour means nothing and the halo is just
              // noise you cannot turn off.
              showErrors={colorMode === 'dcr'}
              errorMemberIds={errorIds}
              selected={selected}
              onSelectionChange={names => onSelectFrames([...names])}
              onDoubleClick={onOpenMember}
              onBeamContextMenu={onBeamMenu}
              width={Math.max(280, box.w)}
              height={Math.max(200, box.h - BAR)}
            />
          </div>
        </div>
      )}
    </PanelFrame>
  )
}
