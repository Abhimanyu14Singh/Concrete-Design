# Beam designer, in the Template's clothes

The `Template/` design system and popout architecture, wearing the real beam designer.

Nothing here reimplements the app. `runDesign`, `generateBreakdown`, `SectionView`,
`ElevationView`, `MemberEditor`, `MapCanvas`, `GroupPanel`, `AutoGroupPanel`,
`GroupDashboard` and `buildDashboardPayload` are all imported from `../src` — so every
DCR, every calc line, every drawing and the whole grouping workflow are the real thing.
If a number here disagrees with the app, the demo is not what's wrong.

**Seven additive changes were made to `../src`**, each defaulting to today's behaviour so
the app renders exactly as before. `tsc -b` is clean and all 922 tests pass.

The recurring shape is a **CSS custom property whose fallback is the app's current
value**. These components size themselves with inline styles, which cannot read a
stylesheet — so a variable is the only way for a host to adjust one without either
forking the component or fighting it with `!important`. Every one of them is a layout
choice that is *right where the app puts it* (a narrow right-hand tab) and wrong at panel
width; none is a behaviour change.

| file | change | why |
|---|---|---|
| `SectionInput/MemberEditor.tsx` | spacing **and the card stack's column rule** read seven CSS custom properties (`--me-cols: auto` is one column, i.e. today) | a panel needs the form denser *and* wider-aware than a full page does |
| `ModelMap/GroupPanel.tsx` | `--gp-primary-flex` on the "Group selection" button (default `1 1 100%` = its own row) | four buttons abreast in the app's narrow tab would each be ~50px of truncated label; given panel width they belong on one line |
| `ModelMap/AutoGroupPanel.tsx` | `--ag-pool-align` on the Pool cluster's `margin-left` (default `auto`) | `auto` reads well in a narrow tab, where the clusters wrap anyway; at panel width it flings Cluster-by and Pool to opposite edges with a gulf between |
| `Dashboard/GroupDashboard.tsx` | `variant?: 'full' \| 'list'` | `'list'` drops the header and the card grid and lets the beam list fill the box |
| `Dashboard/SectionCard.tsx` | `width?` / `height?` for the drawing (default 248×168), and `layout?: 'stack' \| 'split'` (default `'stack'` = today) | the card is legible in a 248px grid cell; given a whole panel it should draw bigger, and its one-line detail rows belong in a column beside the section rather than spanning the panel above and below it |
| `Detailing/SectionView.tsx` | the **skin label** is drawn whenever there ARE skin bars (plain text), and is editable wherever `editBarSize` is — it used to require `editStirrup`, so a view could draw the side bars and never name them. It now reads **opposite the stirrup label**: mid-height in the left gutter, right-aligned outside the `h = …` dimension. Separately, the drawing's ground reads `--sv-bg` (default `#f8fafc` = today) | see [the collision](#2-a-collision-in-sectionview--fixed) below: mid-left is where the rotated `h = …` dimension lives, which is why no dimensioned view could show skin at all. The ground is right when the view is a *tile*; when it IS the surface it becomes a grey rectangle on the host's background and every dimension and bar label inside reads as text on a second colour |
| `Detailing/ElevationView.tsx` | same `--sv-bg` on its ground, same default | the two drawings share a workspace and often sit side by side — one keeping a slate tile while the other went transparent is the more obvious seam |

## Run it

```bash
cd demo
npm run build && npm run serve     # → http://127.0.0.1:5174
```

No `npm install` needed. `build.mjs` borrows esbuild from `../Template/node_modules`, and
react / react-dom / electron resolve up to the repo root — so the demo runs against the
same React 19 the app does. (`npm install` here only if `Template/` goes away.)

```bash
npm run dev        # esbuild --watch, in one terminal
npm run serve      # the server pushes a reload on every rebuild, in another
npm run desktop    # Electron — detached panels get real OS windows and taskbar entries
```

## The model

174 beams in 11 design groups, ~5,700 load rows, all designed eagerly on every model
change — the whole set runs through the engine in **under 40 ms**, which is why the rail
can carry live DCRs rather than a cheaper stand-in.

Six beams are hand-written to carry the cases worth looking at; the other 168 are a
generated 4-level frame on an A–F × 1–8 grid. **Spans are read off the grid**, not from a
per-role constant, so the plan view and the design are the same building — a 30 ft girder
is a 30 ft line. Load intensity scales as L², with deterministic jitter (hashed from each
id, so the building is identical on every reload and screenshots stay comparable).

The cages are tuned so ~9% of beams are over capacity and ~12% are near it, spread across
three groups. A model where everything passes proves nothing; one where a third fails is
not a building anyone would ship.

**192 columns** sit at the grid intersections, one lift per storey. They are context, not
members — never designed, never selectable, never grouped — and they only draw in 3D,
because in plan a column projects to a single point. They earn their place the moment you
tilt the view: without them the model is four unconnected rafts of beams floating one
above another, and it is genuinely hard to tell which storey you are looking at.

The 11 groups it ships with are a **starting point, not the model**. Grouping is editable
(see below) and deliberately not persisted, so a reload always shows you what `data.js`
actually describes rather than what you did to it last time.

## What to try

1. **Click B3.** It fails at 2.71. The Calc Sheet opens on the row that caused it.
2. **Detach a panel** with the ⧉ in its header. In the browser it becomes a real window
   (allow pop-ups for 127.0.0.1); on the desktop, a real OS window. Resize it — the
   drawing grows with the window, which is the part that is easy to get wrong.
3. **With Section detached, switch beams in the main window.** The detached panel
   follows. It holds no state of its own.
4. **Click a bar label in the detached Section** (`4-#9`). The edit is applied in the
   *main* window; the rail, the calc sheet and the force diagram all recompute. Nothing
   is duplicated.
5. **Click B4** and look at the Force Diagram: shear capacity is a **step**, 176 / 94 /
   176, because the links are zoned and capacity is read at the zone the demand sits in.

   The panel draws **three** diagrams — M, V and **T** — one per ULS check, so every DCR
   chip has a picture behind it. **Click B6** for the torsion one: a spandrel twists +47
   at one end through zero to −47 at the other, against a φTn of 34.3 mirrored at ±,
   which is the 1.37 its torsion chip reports. Torsion governs **43 of the 174 beams**
   here, so it is not a diagram for the odd spandrel.

   The grey line under the capacity is the **Tcr threshold** — below it the code lets
   torsion be neglected and no torsion design is done at all. That is a different
   statement from "the cage carries it", which is why it is not drawn in the capacity
   colour. 45 of the 174 beams sit under it.
6. **Right-click a panel header → Jump to governing row.** The selection moves to the
   row that produced the member's worst check, so the panels never tell two different
   stories. (This used to be a row of check chips in a header strip above the workspace.
   The strip is gone: every number on it was already shown by the panel that owns it —
   the rail has the DCR rollup, Section the geometry and materials, the Group Dashboard
   the group envelope — and a row that only restates its neighbours is the first thing
   that should give up its ~47px.)
7. **Click a group HEADING in the rail.** The Section panel switches from one beam's
   dimensioned section to that group's **template cage** — the app's own SectionCard at
   full size, with the whole set's worst M⁺ / M⁻ / V on it, the curtailment flags, ρ and
   steel weight. The status line under the workspace follows the group too. Click a beam
   under it and everything goes back to that member.

   Given a panel the card runs `layout="split"`: the opposite-end ◨, middle-third and
   end-third cage rows and the ρ line collect into a **196px column on the left**, and
   the drawing takes everything else. Each of those rows is one line of text — stacked,
   they spanned the whole panel to say it while the section was squeezed into a
   letterbox between them. Same blocks, same editing, ordered with CSS rather than a
   second copy of the JSX, so the grid card and the panel cannot drift.

   The Group Dashboard is a **group list on the left, that group's beam list on the
   right**. The card grid it replaces was doing two jobs — browsing groups and drawing
   each cage — and they wanted separating: the cage now gets a whole panel at a legible
   size, while browsing shows twenty groups at once instead of four. Narrower than 640px
   the group list becomes a chip strip above the beams, so the panel still works tiled
   three-across.

   Note the other panels keep showing the last selected MEMBER while a group is selected,
   and say so in their subtitles. A group has no single calc sheet or force diagram, so
   there is nothing truthful to put there.
8. **Detach the Group Dashboard, then double-click a group card in that window.** The
   main window's selection moves. It is the app's own dashboard on the ordinary bus.
9. **Resize a group, then hit ⇪ Push on the Group Dashboard.** Change a beam's width or
   depth in the Editor (or move beams into a group with a different section) and the Push
   button counts the groups that no longer match what was imported. It opens a review
   screen: what each group was and now is, the **ETABS frame-section property** to create
   for it (`B14X32-C5000`, editable), and the **new model name**. Push and the working
   model is frozen under that name, re-run, and the Group Dashboard switches to it.

   A **model picker** then appears in the top bar beside the project settings, cycling
   the working model against each pushed one — resize, push, re-run, and read the two
   side by side, which is the whole reason to resize anything. It sits there rather than
   on the dashboard because it is context for every panel: pick a pushed model and the
   rail's DCRs, the plan's colours, the section, the calc sheet and the force diagram all
   describe it too. A pushed model is a **snapshot**, so the workspace goes read-only on
   one and says so — an edit there would silently fork a version you had already named.

   **It does not write to ETABS, and the dialog says so.** The app's connection is
   read-only today — no `DefineFrameSection`, `AssignSection`, `SaveAs` or `RunAnalysis`
   exists in the adapters, the Electron bridge or the C# sidecar. What runs is the exact
   payload those four calls would take, plus the app's own engine standing in for the
   re-analysis. The transport is the one piece missing, and `etabsPush.js` builds the
   payload in the shape the COM calls want so it is ready for it.
10. **In the Plan, click a beam** — the whole workspace follows it. Switch storeys
   (L1 holds the six study beams), or pick a scheme from **Colour by** — the app's full
   list, in the app's order and computed by the app's own functions: DCR, design group,
   group + tags, section, steel % (ρ, with a bot/top face switch), stirrups, steel
   weight, height, width, concrete grade, steel grade, and the auto-group overlay once
   one exists. Metric schemes carry their unit in the label and follow the unit toggle;
   the continuous ones get a ramp legend from MapCanvas, the two categorical grade ones
   get a swatch key under the toolbar. Beside it, **overlay** draws the M or V envelope
   on the plan itself. Picking a beam
   in the rail highlights it on the plan and follows it to its storey.
11. **Lasso some beams on the plan, then hit "Group selection"** in the Groups panel.
    Rename it, click the dot to recolour it, add or remove members. Selecting a group
    halftones everything outside it, so you can see the set you have actually made rather
    than the one you meant to. The rail, the plan's Group colouring, the Section panel's
    template cage and the Group Dashboard all follow immediately — there is one setter
    behind all of them.
12. **Right-click a beam on the plan → pick a group.** The beam joins that group *and
    adopts its detailing*: the group's section, material and cage, copied from the beam
    that **governs** the group — the one its design is actually driven by, not whichever
    was imported first (they differ in 7 of the 11 shipped groups). Its span, position
    and loads are untouched, so the group's cage is immediately checked against this
    beam's own demands, which is the question worth asking: does this detailing work
    here? Each entry names its donor (`→ L2 Girders (as L2-B7)`), because the copy is
    destructive and the donor is the one fact that decides what you get. Works in a
    detached Plan window too — the items are built in the main window and only their
    labels cross the bus, so the same click does the same thing in either place.
13. **Groups → Auto-group.** Bin the 174 beams by demand within each section family
    (Jenks natural breaks, or quantiles), drag the boundary sliders, hover a bin to light
    its beams up on the plan. The proposal is a **preview** — an extra `Auto` colour mode
    appears on the plan while one exists — until *Commit as Design Groups*, which turns it
    into ordinary groups. A committed suggestion and a hand-lassoed group are the same
    object afterwards; there is no auto-group mode to get stuck in.
14. **Plan → 3D.** The same canvas, tilted. Drag empty space to orbit, `1`–`4` for
    top / front / right / iso, `F` or double-click to fit, shift-drag to lasso-select.
    Every 2D behaviour survives the tilt — picking, hover cards, colouring, the M / V
    overlay, grouping — because MapCanvas puts every point through one projection
    function. Columns appear (they only draw in 3D) and the storey filter goes to `All`;
    switching back returns you to the storey you were on.
15. **Toolbar → in·kip / mm·kN.** Units change everywhere, detached windows included.
16. **Toolbar → Inter / Segoe** swaps the typeface, detached windows included.
17. **Switch to EN 1992-1-1.** Different engine, Eurocode calc sheet, a fourth chip
    (crack width), and the capacity lines relabel `φMn → M_Rd` — EC2 has no φ.
18. **Rearrange, then reload.** Which panels are open, docked or floating, and where the
    floating ones sit, all come back.
19. **Toolbar → ✓ S-Concrete.** The last step of the workflow the app exists to serve:
    design → group → **verify against an independent checker**. The panel is the app's
    own `SconcreteDashboard` — it writes one `.SCO` per design group (with the cage you
    have applied, not the one that was imported), drives S-Concrete's BatchReporter
    through the bundled `SConcreteHelper` sidecar, reads the `.SCRS` back and shows each
    group's verdict beside the app's own governing DCR.

    **It needs the desktop shell** (`npm run desktop`) with S-Concrete installed —
    writing files and driving another Windows application are not things a browser can
    do, and the panel says so itself in the browser rather than offering buttons that
    fail after the click. The sidecar comes from `npm run build:helper`; without it the
    panel reports the helper is missing, which is also what the app does.

    Once a batch has run, the plan's colour dropdown grows an **S-Concrete pass/fail**
    scheme. That option has always been in the list's code and has never been reachable
    here, because nothing produced the data — it appears only when there is something to
    colour, so it is never a control that paints the model one flat grey.

## Three states, one component

A panel is one component that renders in one of three places and never knows which:

| | where | size comes from | header offers |
|---|---|---|---|
| **dock** | a tile in the column layout | the layout's fractions | maximise · float · detach · close |
| **float** | draggable over the workspace, portalled to `<body>` | its own drag/resize state | dock · detach · close |
| **window** | its own OS / browser window | the OS window | attach |

### Moving between them by dragging

**Drag any panel by its header.** Where you let go decides what happens:

| release | result |
|---|---|
| over the workspace | docks there — a slot in a column, or a new column at an edge |
| elsewhere in the window | floats, under the cursor |
| **outside the window** | **tears off into its own window** |

A blue bar shows where a dock will land, and a ghost on the cursor says which of the
three it is going to be, so nothing is a guess.

Tear-off works because the header takes a **pointer capture**. Without it the browser
stops delivering `pointermove` the moment the cursor leaves the window, so a drag toward
the second monitor would simply stop reporting and could not be told apart from one that
ended at the edge. With capture, `clientX/clientY` keep going and go out of range — which
is the signal. There is a 12px margin, because someone dropping a panel against the right
edge of the workspace is aiming at a new column, not at a new window.

### The rail

The group tree starts **collapsed** — a 34px strip down the left, still carrying the
over-capacity count so a shut rail is not a blank edge you have to open to learn anything
from. Click it to open; **Esc** or a click anywhere else shuts it.

Open, it **overlays** the workspace rather than pushing it. That is deliberate: the
section drawing, the plan and the force diagram are all sized from a measured box, so a
push-open would re-render three drawings every time you glanced at the group tree. The
**pin** button switches it to pushing and keeps it open, for anyone who would rather have
it permanently there; its width is draggable and both are remembered.

### Sizing

- **Drag the gutters** between tiles — vertical between columns, horizontal within one.
  Sizes are stored as fractions, so a split survives a window resize instead of drifting.
- **Double-click a header** (or the ⛶ button) to maximise a panel to the whole workspace,
  again to restore.
- **Everything else adjusts on its own.** Close, float or tear off a panel and the
  survivors' fractions are renormalised to fill — that is one `normalize()` in
  `dockLayout.js`, not a rule per case. Emptied columns disappear and give their width
  back.
- The whole arrangement is persisted, so it is there tomorrow.

The layout model is a list of columns, each a list of panels, with a fraction on each
(`dockLayout.js`). A full binary-split tree would allow arrangements this cannot express —
a panel spanning two columns at the top — at the cost of a tree-walking hit test, rebalance
on removal, and eight drop targets per node. Columns cover what anyone actually builds and
the layout fits on one line of JSON.

The main window owns **all** state. Panels take props and hand back events. That single
rule is what makes this work, and it is worth keeping even if nothing is ever detached,
because it is also what makes the panels testable.

Nine panels are registered: **Plan**, **Groups**, Section, Calc Sheet, Loads, Force
Diagram, Elevation, Editor, Group Dashboard. Plan / Groups / Section / Calc Sheet start
docked; the rest are a toolbar click away.

Plan and Groups are docked as a **pair**, because neither is much use without the other:
the lasso that feeds "Group selection" is on the plan, and the group you make is what
colours it back. Loads gave up that slot — it is the most specialised of the four, and the
check chips already say which row governs.

## Layout

```
build.mjs           esbuild; also copies Inter next to the bundle
server.mjs          static server + live reload. Exports startServer() for Electron
electron/main.cjs   the desktop shell — imports the SAME server
src/
  index.js          entry — routes to App, or to a single detached panel
  App.js            the main window: owns ALL state, hands panels props
  GroupRail.js      the left rail: groups, members nested, filter + fails-only
  data.js           174 beams + 11 groups + 192 columns + a ModelMap, app shapes
  design.js         the ONLY engine link — runDesign, generateBreakdown, nothing else
  format.js         display formatting through the app's real UnitsContext
  layout.js         which panels are where, persisted
  PanelFrame.js     the chrome: the one place that knows a panel can live in 3 hosts
  panels/           Plan · Groups · Section · Calc Sheet · Loads · Force · Elevation
                    · Editor · Group Dashboard
  MenuBar.js        File · View · Help, in the page (the app's is a native menu)
  etabsPush.js      resized-group detection + the ETABS push payload (pure)
  PushToEtabsDialog.js  review what resized, name the properties, name the model
  popoutBus.js      the panel registry + what may cross between windows
  usePopoutHost.js  main-window half of the bus
  Popout.js         detached-window half of the bus
  Portal.js         renders to <body>, so nothing can bury a floating panel
  useFillWindow.js  who decides a panel's drawing size (a ResizeObserver on the body)
  UnitsBridge.js    pushes `units` into the real UnitsContext, in both windows
  ui.css            the Template's design system, verbatim but for :root
  shell.css         everything the Template had no class for, in its vocabulary
```

## Two real bugs this turned up

### 1. `cloneable()` deletes shared references, not just cycles — **fix this before porting**

The Template's `cloneable()` (`Template/src/popoutBus.js`) carries one `WeakSet` for the
whole traversal and returns `undefined` for anything already in it. That catches cycles —
and also **deletes every repeat of a merely shared reference**:

```js
const cage = { topBars: [{ numBars: 3, barSize: 8 }] }
cloneable({ members: [{ id: 'A', rebar: cage }, { id: 'B', rebar: cage }] })
// → A.rebar survives, B.rebar is undefined
```

Any payload of real size is a DAG, not a tree: two beams pointing at one cage, a group
template also referenced by its members, a bar array reused across rows. The receiving
panel then crashes on `.length` of something that was plainly there in the sending
window — a horrible bug to chase, because the object is fine everywhere you would think
to look. It took out the detached Group Dashboard here.

Fixed in `demo/src/popoutBus.js` by tracking the current **path** instead: add on the way
down, remove on the way back up. The cycle guard still holds (an ancestor is still in the
set) and siblings share freely.

### 2. A collision in `SectionView` — fixed

It drew the skin / face-reinforcement label at `x = ox − 8` with `textAnchor="end"`, so it
ran leftward straight through the rotated **`h = …`** dimension at `ox − 26`. They overlap
at every width and zoom — no padding fixes it, because both are anchored to the section's
left edge.

It needed `showDims` **and** `editStirrup` together, and nothing in the app asked for
both: the only caller that set `editStirrup` (`SectionCard.tsx`) passes
`showDims={false}`. So it was latent rather than live — until the first screen that wants
dimensions and a full cage at once, which is exactly what a full-size Section panel is.

Fixed by moving the label **outside** the dimension rather than away from it. The links
are named in the right gutter at mid-height, so the face steel is named at mid-height on
the left — the two read as a pair — right-aligned at `ox − 38`, clear of the `h` text at
`ox − 26` and the arrow line at `ox − 14`. That wants `padL ≥ 88` (this panel passes 96);
a caller too narrow for it, like the app's 300px member drawing, drops the label to the
bottom-left corner instead of clipping it. Undimensioned callers keep the plain mid-left
position, so `SectionCard` is pixel-identical.

Two related gaps closed with it, because they were all the same root cause — skin was
treated as a *stirrup-editor* feature rather than part of the cage:

- **A view could draw the side bars and never name them.** The dots were always plotted;
  the label was gated on `editStirrup`. Every non-`editStirrup` caller — the app's own
  `MemberResults` included — drew a cage whose skin was invisible at label level. Now the
  label follows the bars: present ⇒ named.
- **Editing it followed `editBarSize`**, the flag that already means "step counts and bar
  sizes on this drawing", rather than the stirrup flag. So this panel offers `＋ skin` and
  the count / size / c/c steppers without also taking on stirrup-zone editing, which
  belongs to the Editor panel.

A cage with no stored `spacing` reports the c/c the drawing actually uses (bars spread
evenly over the clear web) instead of a nominal 12 in that would have been a lie about the
picture beside it.

## Other things that will bite you

Carried over from the Template, all still true.

**Props are structured-cloned, so functions cannot travel.** Sending one throws
`DataCloneError` and the panel receives nothing at all — it shows "Loading…" for ever
with nothing logged. Send plain data and declare anything callable in
`PANELS[kind].fns` / `.reqs`. This is why panels take flat props (`section`, `rebar`,
`result`) and never a `design` object with methods on it.

**A call that needs an answer needs `reqs`, not `fns`.** A context menu's items are built
in the main window and each carries a closure over its state; neither can be posted. So
the labels travel, the detached window renders them, and the chosen index comes back —
the closure runs where it was made.

**A panel's drawing is sized from a number, so that number must follow the window.**
Stretching the frame with CSS is not enough: the frame grows and the SVG inside it does
not. `PanelFrame` measures the body with a ResizeObserver and hands the box down, so one
mechanism covers all three hosts.

**`transform: scale` breaks `position: fixed`.** Floating panels portal to `<body>` for
this reason. The real app's zoom wrapper in `App.tsx` is exactly such an ancestor.

**Nothing may hand-format a number with a unit on it.** The engine stores imperial; the
display system converts at the boundary. A hard-coded `in²` is a wrong label the moment
anyone flips to SI, on a number an engineer will read off the screen. Everything goes
through `format.js` → the app's real `useUnits()`.
