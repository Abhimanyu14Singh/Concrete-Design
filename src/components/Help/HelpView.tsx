/**
 * HelpView — the "Help" tab. Five sub-tabs:
 *   • Doc Resources — the full in-app user guide (how everything works).
 *   • Your first model — a step-by-step first run.
 *   • Keyboard shortcuts — the real shortcuts wired in App.tsx.
 *   • FAQ & troubleshooting — the common gotchas.
 *   • Diagnostics — what the usage log records, and the switch to stop it.
 *
 * Panels elsewhere can deep-link in via <HelpLink section="…" /> (see HelpLink.tsx),
 * which dispatches an `open-help` event; App switches to this tab and passes the
 * target section down as `target`, and the guide scrolls to it.
 *
 * Content is data (SECTIONS / QA / steps); styling uses shared theme tokens only.
 */
import { useState, useEffect } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { INK, SURFACE, BORDER, ACCENT, STATUS, MONO_NUM, LABEL_STYLE, ICON } from '../../theme';
import { Icon } from '../common/Icon';
import type { IconName } from '../common/Icon';
import type { UsageState } from '../../utils/electronBridge';

// ── Prose primitives ──────────────────────────────────────────────────────────
const P = ({ children }: { children: ReactNode }) => (
  <p style={{ fontSize: 13, lineHeight: 1.62, color: INK.base, margin: '0 0 10px' }}>{children}</p>
);
const H3 = ({ children }: { children: ReactNode }) => (
  <h3 style={{ fontSize: 14, fontWeight: 700, color: INK.strong, margin: '16px 0 6px' }}>{children}</h3>
);
const B = ({ children }: { children: ReactNode }) => <strong style={{ color: INK.strong, fontWeight: 700 }}>{children}</strong>;
const UL = ({ children }: { children: ReactNode }) => (
  <ul style={{ margin: '0 0 10px', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</ul>
);
const LI = ({ children }: { children: ReactNode }) => (
  <li style={{ fontSize: 13, lineHeight: 1.55, color: INK.base }}>{children}</li>
);
const Code = ({ children }: { children: ReactNode }) => (
  <code style={{ ...MONO_NUM, fontSize: 12, background: SURFACE.subtle, border: `1px solid ${BORDER.default}`, borderRadius: 4, padding: '1px 5px', color: INK.strong }}>{children}</code>
);
const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd style={{ ...MONO_NUM, fontSize: 11.5, background: 'white', border: `1px solid ${BORDER.strong}`, borderBottomWidth: 2, borderRadius: 5, padding: '2px 7px', color: INK.strong, whiteSpace: 'nowrap' }}>{children}</kbd>
);
const Tag = ({ children, bg, fg }: { children: ReactNode; bg: string; fg: string }) => (
  <span style={{ fontSize: 11, fontWeight: 700, background: bg, color: fg, borderRadius: 5, padding: '1px 7px', whiteSpace: 'nowrap' }}>{children}</span>
);
const Callout = ({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'ok' }) => {
  const c = tone === 'warn'
    ? { bg: STATUS.warnBg, br: STATUS.warnBorder, fg: STATUS.warn }
    : tone === 'ok'
      ? { bg: STATUS.okBg, br: STATUS.okBorder, fg: STATUS.ok }
      : { bg: ACCENT.softBg, br: ACCENT.softBorder, fg: ACCENT.primaryHover };
  return (
    <div style={{ background: c.bg, border: `1px solid ${c.br}`, borderLeft: `3px solid ${c.fg}`, borderRadius: 6, padding: '8px 12px', margin: '0 0 12px' }}>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: INK.base }}>{children}</div>
    </div>
  );
};
/** Reference table — the default for anything that gets looked up rather than read.
 *  `align` marks right-aligned (numeric) columns per index. */
const Table = ({ head, rows, align }: { head: string[]; rows: ReactNode[][]; align?: ('l' | 'r')[] }) => (
  <div style={{ overflowX: 'auto', margin: '0 0 12px' }}>
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
      <thead>
        <tr>{head.map((h, i) => (
          <th key={i} style={{ ...LABEL_STYLE, padding: '6px 10px 7px', borderBottom: `2px solid ${BORDER.default}`, textAlign: align?.[i] === 'r' ? 'right' : 'left', whiteSpace: 'nowrap' }}>{h}</th>
        ))}</tr>
      </thead>
      <tbody>{rows.map((r, ri) => (
        <tr key={ri}>{r.map((c, ci) => (
          <td key={ci} style={{ padding: '7px 10px', borderBottom: `1px solid ${BORDER.subtle}`, color: INK.base, lineHeight: 1.5, textAlign: align?.[ci] === 'r' ? 'right' : 'left', verticalAlign: 'top' }}>{c}</td>
        ))}</tr>
      ))}</tbody>
    </table>
  </div>
);

/** An icon beside its label on one line — <Icon> is display:block, so without this
 *  the pair wraps in a narrow table cell. Pass no children for a bare icon. */
const IconLabel = ({ name, children }: { name: IconName; children?: ReactNode }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
    <Icon name={name} size={ICON.sm} />{children && <B>{children}</B>}
  </span>
);

/** Where a control actually lives, e.g. <Path>File › Import from ETABS…</Path>.
 *  Engineers ask "where is it" far more often than "what is it called". */
const Path = ({ children }: { children: ReactNode }) => (
  <span style={{ ...MONO_NUM, fontSize: 11.5, background: ACCENT.softBg, border: `1px solid ${ACCENT.softBorder}`, color: ACCENT.primaryHover, borderRadius: 5, padding: '1px 7px', whiteSpace: 'nowrap' }}>{children}</span>
);

const numBadge: CSSProperties = {
  width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 11, fontWeight: 700, color: 'white', background: ACCENT.primary,
};
const PageTitle = ({ icon, title, sub }: { icon: IconName; title: string; sub: string }) => (
  <div style={{ marginBottom: 18 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: INK.strong }}>
      <Icon name={icon} size={ICON.xl} />
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: INK.strong }}>{title}</h2>
    </div>
    <p style={{ fontSize: 13, color: INK.secondary, margin: '4px 0 0' }}>{sub}</p>
  </div>
);

// ── Doc Resources — the full guide ─────────────────────────────────────────────
interface Section { id: string; title: string; node: ReactNode; }

const SECTIONS: Section[] = [
  {
    id: 'overview',
    title: 'What S-Dashboard is',
    node: (
      <>
        <P><B>S-Dashboard</B> takes a reinforced-concrete frame from <B>ETABS</B>, lets you group members and design their reinforcement, then verifies that reinforcement in <B>S-Concrete</B> — all from one project file.</P>
        <P>The work runs in three steps. Each one lives in a specific place:</P>
        <Table
          head={['Step', 'What you do', 'Where']}
          rows={[
            [<><Tag bg={ACCENT.softBg} fg={ACCENT.primary}>1 · Import</Tag></>,
              'Pull beams, with their analysis forces, out of ETABS.',
              <Path>File › Import from ETABS…</Path>],
            [<><Tag bg={ACCENT.softBg} fg={ACCENT.primary}>2 · Design</Tag></>,
              'Put similar members in a group; give the group one reinforcement cage.',
              <Path>Groups panel</Path>],
            [<><Tag bg={ACCENT.softBg} fg={ACCENT.primary}>3 · Verify</Tag></>,
              'Write an .SCO per group, run the S-Concrete batch, read results back.',
              <Path>S-Concrete panel</Path>],
          ]}
        />
        <P>Results — pass/fail, demand-capacity ratios, warnings — are read back onto the model, so the plan itself shows what still needs attention.</P>
        <Table
          head={['', 'Supported']}
          rows={[
            ['Codes', <><Code>ACI 318-19</Code>, <Code>EN 1992-1-1</Code> (Eurocode 2)</>],
            ['Members', 'Beams — rectangular, T and L sections'],
            ['Units', 'Imperial (in · psi · kips) or SI (mm · MPa · kN)'],
          ]}
        />
      </>
    ),
  },
  {
    id: 'layout',
    title: 'How the screen is organized',
    node: (
      <>
        <P>One workspace of <B>panels</B>. A menu bar and a row of panel chips across the
        top, the panels themselves tiled below, and a status strip along the bottom.
        There are no tabs to switch between — you open the panels you need and put them
        where you want them.</P>
        <H3>The panels</H3>
        <Table
          head={['Panel', 'What it is', 'Use it to']}
          rows={[
            [<B>Model</B>, 'The frame in 2D plan or rotatable 3D, coloured by any metric.',
              'Select and group members, read DCRs off the plan, filter what is drawn.'],
            [<B>Groups</B>, 'The design groups, and the auto-grouping proposals.',
              'Make groups from a selection, or let Auto-group cluster them for you.'],
            [<B>Group Dashboard</B>, 'Every group with its governing DCR, and the beams inside it.',
              'Size a whole group’s cage, run ✨ Suggest, push resized sections back to ETABS.'],
            [<B>Section</B>, 'The cage drawing for the selected member or group.',
              'Read the bar layout; edit it directly in group mode.'],
            [<B>Editor</B>, 'One member’s inputs — geometry, materials, cover, bars, links.',
              'Hand-edit a single member.'],
            [<B>Calc Sheet</B>, 'The step-by-step derivation for the selected load row.',
              'See exactly which clause produced a number.'],
            [<B>Loads</B>, 'Every load row on the member.', 'Find which row governs which check.'],
            [<B>Force Diagram</B>, 'M and V envelopes along the span.', 'See where the demand peaks.'],
            [<B>Elevation</B>, 'The member along its length with its curtailment zones.', 'Check where bars stop.'],
            [<B>S-Concrete</B>, 'The verification batch and its results.', 'Write .SCO files, run S-Concrete, read results back.'],
          ]}
        />
        <Callout>Every panel can be <B>detached into its own window</B> — the ↗ button on
        its header, or drag the header out of the workspace. Detached panels are real
        windows: put the Model on a second monitor and keep designing on the first. Drag
        one window’s panel into another to combine them, or <B>Merge into ▾</B> to move
        the lot. The main window still owns the project, so everything stays in step.</Callout>
        <H3>The menu bar and header</H3>
        <Table
          head={['Control', 'Does']}
          rows={[
            [<B>File</B>, <>New / Open / <B>Save</B> / <B>Save As…</B> / <B>Import from ETABS…</B> / Reset the workspace.</>],
            [<B>View</B>, 'Reload and full screen.'],
            [<B>Preferences</B>, 'Appearance and the standard colour set.'],
            [<B>Help</B>, 'This guide, the first-run walkthrough, shortcuts, FAQ and About.'],
            [<IconLabel name="members">Groups &amp; members</IconLabel>, 'The rail — slides out over the workspace; click a member to select it everywhere.'],
            [<B>Panel chips</B>, 'The row of icons in the middle. Click one to open or focus that panel.'],
            [<IconLabel name="export">Export</IconLabel>, 'PDF report, spreadsheets, rebar schedules. See Saving & exporting.'],
            [<IconLabel name="settings">Settings</IconLabel>, <>Project settings — design code, units, default materials, cot θ, torsion, display scale.</>],
          ]}
        />
        <H3>The status strip</H3>
        <P>A hairline progress bar along the bottom, with a counter and a <B>Pause</B>
        switch while a long job runs. The <Code>⋯</Code> button on the right opens the
        <B> run log</B> — what has run this session and how it ended, newest first. It
        carries a red dot when something failed, so an error that scrolled past is still
        findable.</P>
        <H3>Project settings</H3>
        <P>Everything that applies to the <em>whole</em> project lives in one dialog, opened from the settings icon beside <B>Export</B>. On a brand-new project it opens by itself as <B>"Set up your project"</B>.</P>
        <Table
          head={['Setting', 'Notes']}
          rows={[
            ['Design code', <>Drives every check, the clause references, and the .SCO handed to S-Concrete. Choosing <Code>EN 1992-1-1</Code> also switches display to SI.</>],
            ['Units', 'Display only — the design never changes, just how numbers are shown.'],
            ['Concrete / Reinforcing steel', 'Default f′c, λ, fy, fyt for new members.'],
            [<>Shear strut angle (cot&nbsp;θ)</>, <>EC2 §6.2.3. Default 2.5 (θ = 21.8°, most link-efficient); lower is more conservative and matches checkers that fix θ.</>],
            ['Neglect torsion', <>Sets T<sub>u</sub> = 0 on every beam check and omits torsion from the .SCO.</>],
            ['Display scale', 'Zooms the whole UI.'],
          ]}
        />
        <Callout tone="warn">Changing the <B>design code</B> or <B>cot θ</B> re-runs every check in the project. Set them before you detail, not after.</Callout>
      </>
    ),
  },
  {
    id: 'import',
    title: '1 · Import from ETABS',
    node: (
      <>
        <P><Path>File › Import from ETABS…</Path> opens the import wizard. Connect to a running ETABS model through the CSI API, or read an exported tables file. Four steps: <B>Connect</B> → <B>Filter</B> → <B>Rebar Defaults</B> → <B>Review &amp; Import</B>.</P>
        <H3>Units — read them, then override if needed</H3>
        <P>The Filter step states the model's units outright — <B>ETABS model units: Force
        … Length … Material f′c / fy …</B> — so you can compare them against ETABS on the
        other screen without guessing. It says whether those came from ETABS's own
        <em> present-units</em> setting or were assumed. Below that, a live <B>"Reads as"</B>
        sample shows a real section and material as the app has interpreted them.</P>
        <P>If a value looks wrong (a 300&nbsp;mm beam reading as 0.3&nbsp;in, say), override
        <B> Force</B>, <B>Length</B> and <B>Material</B> directly — the sample updates as you
        change them. A warning appears when the numbers look implausible, and it names the
        sections or materials that tripped it: if only a few of many are odd, the units are
        probably fine and those are stray entries in the model.</P>
        <H3>What gets imported — the four filters</H3>
        <P>Four dropdowns narrow the import. Leaving one empty means <em>all</em>.</P>
        <UL>
          <LI><B>Stories</B> and <B>Beam sections</B> and <B>ETABS groups</B> — sections and
          groups are additive: a member matching <em>either</em> comes in.</LI>
          <LI><B>Material</B> — an <em>additional</em> filter, applied on top. This is how you
          leave steel framing behind on a mixed model: pick the concrete materials, or press
          <B> Concrete only</B>, which ticks every material that reports an f′c. A section whose
          material ETABS did not report is kept rather than silently dropped.</LI>
        </UL>
        <Callout>Forces always come from the ETABS <B>Element (analysis)</B> table — the same
        numbers the frame-force display shows. There used to be a choice between that and the
        concrete <em>Design Forces</em> table, which reports at design stations and so reads
        differently at supports; that mismatch was the single most common surprise after an
        import, so there is now one answer instead of a question.</Callout>
        <H3>What comes in</H3>
        <UL>
          <LI>The <B>model map</B> — the frame connectivity used to draw the 2D/3D plan.</LI>
          <LI><B>Members</B> — beams, with their section, material, and the envelope of the load combinations you chose (plus station forces along the span, used for crack checks).</LI>
        </UL>
        <H3>No ETABS? Take the demo model</H3>
        <P><B>Explore the demo model</B> on the opening screen loads a built-in two-storey
        frame — 34 beams over two levels in two section sizes, with columns, slabs, a core
        wall and grid lines, already grouped by storey and section and carrying station
        forces along every span. It arrives on the wizard's default starting cage, so most
        members pass and a few do not: enough to try grouping, <B>Suggest</B>, the Calc
        Sheet and the exports end to end without a licence or a model. The same frame is
        available inside the wizard as the <B>Sample model (demo)</B> source if you want to
        walk the import steps themselves.</P>
      </>
    ),
  },
  {
    id: 'member',
    title: 'The Member view — designing one member',
    node: (
      <>
        <P>Pick a member from the <B>Member</B> dropdown (or click one on the map / Dashboard). The screen splits into <B>Input</B> (left) and <B>Results</B> (right).</P>
        <H3>Input</H3>
        <UL>
          <LI><B>General / Materials</B> — label, span, member type; concrete f′c (cylinder), steel fy / fyt.</LI>
          <LI><B>Section</B> — rectangular, T or L beam, with width, depth, flange, clear cover, and stirrup size.</LI>
          <LI><B>Reinforcement</B> — top and bottom bars entered as one or more <B>layers</B> (count × size). <Code>+ Add layer</Code> stacks a second/third layer; the outer layer is nearest the face. Skin (side-face) bars and stirrups (size, spacing, legs, optional 3-zone spacing) are set here too.</LI>
          <LI><B>Load cases</B> — the factored combinations, each with M, V and T. The worst case governs.</LI>
        </UL>
        <H3>Results</H3>
        <UL>
          <LI>A <B>pass/fail banner</B> and the governing check, plus each check's <B>DCR</B> (demand ÷ capacity — see <em>Design codes</em>).</LI>
          <LI><B>Warnings</B> — code notes flagged by severity (amber = advisory, red = failing/needs a bigger section): below minimum steel, spacing too tight, section inadequate for shear, skin reinforcement required on a deep beam, and more.</LI>
          <LI>A <B>section drawing</B> (bars, stirrup, skin bars) and a <B>∑ Calc Sheet</B> showing the full hand-calculation behind every number.</LI>
          <LI><Code>Optimize</Code> proposes a lighter cage that still meets the target DCR for this one member.</LI>
        </UL>
      </>
    ),
  },
  {
    id: 'dashboard',
    title: 'The Dashboard',
    node: (
      <>
        <P>The Dashboard lists every member (grouped by design group) with its governing <B>DCR chip</B> — green below 0.90, amber 0.90–1.00, red at or above 1.00. It's the fastest way to scan the whole job, jump into a member to edit it, and spot anything overstressed.</P>
        <P>The Dashboard is also where you apply <B>minimum skin reinforcement</B> to deep beams that were flagged for it (choose bars-per-face and a size, then apply to all flagged members at once).</P>
      </>
    ),
  },
  {
    id: 'map',
    title: 'The Model view',
    node: (
      <>
        <P>The <B>Model</B> panel draws the frame in <B>2D plan</B> or a rotatable <B>3D</B> view — the <Code>3D</Code> button beside the filter icon switches between them. It is where steps 2 and 3 happen.</P>
        <H3>The panel on the right</H3>
        <P>One bar, always visible, with three workflow tabs and two analyses:</P>
        <Table
          head={['Tab', 'Shows']}
          rows={[
            [<IconLabel name="design">Design</IconLabel>, 'Group list + the reinforcement editor. Auto-group is a sub-view here — use ← Back to groups to return.'],
            [<IconLabel name="groupDashboard">Dashboard</IconLabel>, 'Section cards and the per-group DCR table, split beside the plan.'],
            [<IconLabel name="verify">Verify</IconLabel>, 'The S-Concrete batch — push, run, read results per group.'],
            [<IconLabel name="savings">Savings</IconLabel>, 'Tonnage you could save by merging groups at the target DCR.'],
            [<IconLabel name="takeoff">Takeoff</IconLabel>, 'Concrete and steel quantities, by member type and per gross floor area.'],
          ]}
        />
        <P>You can move between all five at any time. The two analyses are toggles — click the lit one again to go back to <B>Design</B>. Selecting a group opens its rebar editor as its own column between the plan and the panel.</P>
        <H3>The toolbar above the plan</H3>
        <Table
          head={['Control', 'Does']}
          rows={[
            ['Show / Filter', 'Hide or isolate stories, member types, walls, grids, openings, columns.'],
            [<B>3D</B>, <>Switch between the 2D plan and a 3D axonometric view. Everything else — colouring, diagrams, inspect, selection, grouping — behaves identically in both. <B>Drag empty space to orbit</B>; hold <Kbd>Shift</Kbd> while dragging to lasso-select instead. Columns, walls and slabs from the ETABS model are drawn as context so the frame reads as a building — they are geometry only and are never designed, selected or exported.</>],
            [<B>Colour by</B>, <>Recolour every frame by DCR, design group, section, flexural steel %, stirrups, weight, depth, width, concrete or steel grade, or the S-Concrete result.</>],
            [<>M&nbsp;/&nbsp;V</>, 'Overlay the moment or shear envelope on each frame.'],
            [<IconLabel name="inspect">Inspect</IconLabel>, 'Click a beam for a card with its section sketch, DCR, cage and V/M diagrams.'],
            [<IconLabel name="warning">Warnings</IconLabel>, 'Highlight members with design errors or warnings.'],
            [<IconLabel name="resync">Re-sync</IconLabel>, 'Re-pull forces from the live ETABS model.'],
            ['Fit', 'Re-centre and zoom the model to the window.'],
          ]}
        />
        <H3>DCR colour bands</H3>
        <Table
          head={['Band', 'DCR', 'Means']}
          align={['l', 'r', 'l']}
          rows={[
            [<Tag bg={STATUS.okBg} fg={STATUS.ok}>green</Tag>, <Code>&lt; 0.70</Code>, 'Comfortable.'],
            [<Tag bg="#ecfccb" fg="#4d7c0f">lime</Tag>, <Code>0.70 – 0.90</Code>, 'Working, with headroom.'],
            [<Tag bg={STATUS.warnBg} fg={STATUS.warn}>amber</Tag>, <Code>0.90 – 1.00</Code>, 'At or past the practical target — review.'],
            [<Tag bg={STATUS.failBg} fg={STATUS.fail}>red</Tag>, <Code>≥ 1.00</Code>, 'Demand exceeds capacity. Fails.'],
          ]}
        />
        <P>Clicking a frame inspects it. Clicking it while a group is active adds or removes it from that group.</P>
      </>
    ),
  },
  {
    id: 'design',
    title: '2 · Design — groups & the reinforcement cage',
    node: (
      <>
        <P>Rather than detailing every beam individually, you put <B>similar members into a group</B> and give the group <em>one</em> reinforcement cage. The cage is designed against the group's <B>worst</B> demand, so it is safe for every member in it.</P>
        <H3>Making groups</H3>
        <UL>
          <LI>Select frames on the plan and create a group from the selection, or</LI>
          <LI>Open <B>Auto-group</B> from inside <Path>Groups panel</Path> to cluster members by size and demand automatically, then accept the clusters. It drills in over the group list — <Code>← Back to groups</Code> returns.</LI>
        </UL>
        <H3>The reinforcement editor</H3>
        <P>Click a group to open its editor (the slide-out column). Set the cage — <B>top</B> and <B>bottom</B> bars (each as one or more layers), <B>skin</B> bars per face, and <B>stirrups</B> (size, spacing, legs, optional zoned spacing over the thirds of the span). Then press <Code>Apply to N members</Code> to write the cage onto every member in the group. The map DCR colors and warnings refresh immediately.</P>
        <Callout>A cage you didn't design by hand? Press <B>Suggest</B> and the app sizes a practical cage for you — see the next section.</Callout>
      </>
    ),
  },
  {
    id: 'suggest',
    title: 'The Suggest auto-designer',
    node: (
      <>
        <P><B>Suggest</B> picks the lightest <em>practical</em> reinforcement that meets the group's worst demand at a target DCR (default <B>0.90</B>, editable). It is verification-driven — it doesn't guess a formula answer, it re-runs the real design engine on a trial cage and adjusts until it passes:</P>
        <P>Clicking <B>Suggest</B> first opens a small dialog to set the <B>minimum</B> top-bar, bottom-bar, and stirrup sizes — Suggest then uses <em>that size or larger</em>. Leave them at the defaults (the smallest practical size) to let it choose freely. Because top and bottom share one bar size, the larger of the two minimums applies. <B>Suggest all groups</B> shows the same dialog and applies your minimums to every group.</P>
        <UL>
          <LI><B>Envelope the demand</B> — the worst required top/bottom steel and shear across the whole group; the highest-moment member governs the geometry.</LI>
          <LI><B>Size the bars</B> — start at the smallest practical bar size and fewest bars that hold the area (top &amp; bottom share one size), preferring a single layer, then two, and a <B>third layer only as a fallback</B> when no size fits in two.</LI>
          <LI><B>Size the stirrups</B> — the fewest legs / smallest size / largest spacing that meets the shear demand, as a 3-zone <em>[end · mid · end]</em> pattern.</LI>
          <LI><B>Verify &amp; bump</B> — re-run every member; if a face or the shear is over target, add bars / a layer / tighten stirrups and try again.</LI>
          <LI><B>Deep beams</B> — code-based <B>skin (side-face) bars</B> are added automatically (ACI h&nbsp;&gt;&nbsp;36″ / EC2 h&nbsp;&gt;&nbsp;1000&nbsp;mm).</LI>
        </UL>
        <P>On success the note reads e.g. <Code>Flex 0.87 · Shear 0.62 at target 0.90 — review, then Apply.</Code> Minimum steel is a hard floor; over-reinforcement is caught automatically because the strength-reduction factor drops and pushes the DCR up. If the section genuinely can't work, Suggest returns a red note (e.g. <em>"No practical bar layout fits this section"</em> — the area won't fit even in three layers). <B>Suggest all groups</B> does the same for every group and reports how many met target.</P>
        <Callout tone="warn">Suggest sizes flexure, shear, and deep-beam skin bars. It does <B>not</B> size closed <B>torsion</B> stirrups. Always review the suggested cage before applying.</Callout>
      </>
    ),
  },
  {
    id: 'verify',
    title: '3 · Verify with S-Concrete',
    node: (
      <>
        <P>Designing in the app is fast but approximate; <B>S-Concrete</B> is the authoritative check. <Path>S-Concrete panel</Path> writes an <B>.SCO</B> file per group from your current cage, runs the S-Concrete batch, and reads the results back.</P>
        <UL>
          <LI><B>Batch · N groups</B> — build the .SCO files and run them. For EC2 beams this emits a <B>ULS</B> file (strength) and a separate <B>SLS crack</B> file, because crack-width is a serviceability check evaluated under the quasi-permanent loads — it must not run against factored ULS forces.</LI>
          <LI><B>Re-run existing folder</B> — re-run the .SCO files already on disk (keeps hand-edits; does <em>not</em> pick up app changes made since).</LI>
          <LI><B>Push N groups to ETABS</B> — push the designed groups back into the ETABS model.</LI>
        </UL>
        <P>Results come back per group: a <B>Status</B> (OK / near / NG), the governing DCR, any S-Concrete warnings, and the cage that was used. The map recolors by the S-Concrete result so verified vs failing members are obvious.</P>
        <Callout tone="warn">The S-Concrete batch and live ETABS steps run <B>only in the Windows desktop app</B> (they launch S-Concrete / ETABS locally). In a browser you can still import, group, and design; run the batch on the desktop.</Callout>
      </>
    ),
  },
  {
    id: 'codes',
    title: 'Design codes & the checks',
    node: (
      <>
        <P>Every number in the app is a <B>DCR — demand ÷ capacity</B>. <B>≤ 1.00 passes</B>; the app's practical target is 0.90 so there's headroom. Colors: green &lt; 0.90, amber 0.90–1.00, red ≥ 1.00.</P>
        <H3>What's checked</H3>
        <Table
          head={['Check', 'Applies to', 'What it compares']}
          rows={[
            [<B>Flexure</B>, 'Beams', 'Sagging (M⁺) and hogging (M⁻) capacity vs demand, with strength-reduction / tension-controlled behaviour and compression steel credited.'],
            [<B>Shear</B>, 'Beams', 'Concrete + stirrup capacity, including the strut-crushing limit — past that, more stirrups cannot help and the section must grow.'],
            [<B>Torsion</B>, 'Beams', <>Where present. Suppressed entirely by <B>Neglect torsion</B> in project settings.</>],
            [<>Shear&nbsp;+&nbsp;torsion links</>, 'Beams', 'The combined link demand from shear and torsion.'],
            [<B>Crack width</B>, <>Beams — <Code>EC2</Code> only</>, <>Side-face and main-face widths under the <B>SLS quasi-permanent</B> moment, against a limit (default 0.3&nbsp;mm). §7.3.4.</>],
            [<B>Steel limits</B>, 'All', <>Minimum and maximum steel, bar spacing, and deep-beam skin reinforcement (h &gt; 36″ / 1000&nbsp;mm).</>],
          ]}
        />
        <Callout>Each check reports the <B>governing</B> DCR — the worst across every load row, not the first row. Two checks can be governed by different load cases; expanding a check jumps the loads and calc sheet to the case that governs <em>that</em> check.</Callout>
        <H3>ACI vs EC2</H3>
        <P>Switch the <B>Design code</B> in project settings between <Code>ACI 318-19</Code> and <Code>EN 1992-1-1</Code>. The engine, the clause references, the warnings and the .SCO handed to S-Concrete all change with it. Choosing EC2 also switches display to SI.</P>
      </>
    ),
  },
  {
    id: 'units',
    title: 'Units',
    node: (
      <>
        <P>The app works in <B>imperial</B> (in · psi · kips · kip-ft) or <B>SI</B> (mm · MPa · kN · kN·m). Switch it in project settings — <Path>Project settings</Path>.</P>
        <Callout>Everything is stored internally in one canonical unit set and converted only for display, so <B>switching units never changes the design</B> — only how numbers are shown. The one place units do affect data is the ETABS wizard, where you override the units of the <em>incoming</em> file field-by-field.</Callout>
      </>
    ),
  },
  {
    id: 'export',
    title: 'Saving & exporting',
    node: (
      <>
        <P>The whole project — members, groups, cages, S-Concrete results — is a single <Code>.scdb</Code> file. <Code>Save</Code> and <Code>Open</Code> round-trip all of it.</P>
        <H3>Export menu</H3>
        <Table
          head={['Item', 'Format', 'Contains']}
          rows={[
            [<B>PDF Report…</B>, 'PDF', 'A formatted calculation report; a dialog lets you pick the title block and which sections to include.'],
            [<B>Excel Summary</B>, 'Spreadsheet', 'Formula-traceable workbook of the design.'],
            [<B>Member DCR List</B>, 'Spreadsheet · PDF', 'One row per member with its governing DCR per check.'],
            [<B>Group Schedule</B>, 'PDF · Spreadsheet', 'The rebar schedule, one entry per design group.'],
          ]}
        />
        <Callout>Print the current view with the browser/OS print command — the header and member list are hidden automatically in print.</Callout>
      </>
    ),
  },
  {
    id: 'glossary',
    title: 'Glossary',
    node: (
      <Table
        head={['Term', 'Meaning']}
        rows={[
          [<B>DCR</B>, 'Demand-Capacity Ratio — demand ÷ capacity. ≤ 1.00 passes; the app targets 0.90 for headroom.'],
          [<B>Cage</B>, 'The full reinforcement for a member: top and bottom bars, skin bars, stirrups.'],
          [<B>Group</B>, "A set of members sharing one cage, sized to the group's worst demand."],
          [<B>Envelope</B>, 'The worst value across the load combinations you imported.'],
          [<B>Governing</B>, 'The check, load row, or member producing the worst DCR.'],
          [<>ULS / SLS</>, 'Ultimate (strength, factored loads) / Serviceability (crack width, service loads) Limit States.'],
          [<B>Quasi-permanent</B>, 'The long-term service combination used for EC2 crack-width checks.'],
          [<>Skin / side-face bars</>, 'Bars on the sides of a deep beam controlling side-face cracking.'],
          [<Code>.SCO</Code>, 'The S-Concrete input file written for each group.'],
          [<Code>.scdb</Code>, 'The project file — everything, in one place.'],
        ]}
      />
    ),
  },
];

function GuidePage({ scrollTo }: { scrollTo: (id: string) => void }) {
  return (
    <>
      <PageTitle icon="docs" title="Doc Resources" sub="The full user guide — how the app works, end to end. Read straight through, or jump to a section." />
      <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
        <nav style={{ position: 'sticky', top: 0, width: 210, flexShrink: 0, alignSelf: 'flex-start' }}>
          <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>On this page</div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {SECTIONS.map((s, i) => (
              <li key={s.id}>
                <button
                  onClick={() => scrollTo(s.id)}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 7, width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: 6, fontSize: 12.5, lineHeight: 1.35, color: INK.secondary }}
                  onMouseEnter={e => { e.currentTarget.style.background = SURFACE.subtle; e.currentTarget.style.color = ACCENT.primary; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = INK.secondary; }}
                >
                  <span style={{ ...MONO_NUM, color: INK.muted, fontSize: 11 }}>{String(i + 1).padStart(2, '0')}</span>
                  <span>{s.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <article style={{ flex: 1, minWidth: 0, maxWidth: 760 }}>
          {SECTIONS.map((s, i) => (
            <section key={s.id} id={`doc-${s.id}`} style={{ scrollMarginTop: 12, marginBottom: 26 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 8px', paddingBottom: 8, borderBottom: `1px solid ${BORDER.default}` }}>
                <span style={numBadge}>{i + 1}</span>
                <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: INK.strong }}>{s.title}</h2>
              </div>
              {s.node}
            </section>
          ))}
        </article>
      </div>
    </>
  );
}

// ── Your first model ────────────────────────────────────────────────────────────
const Step = ({ n, title, children }: { n: number; title: string; children: ReactNode }) => (
  <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
    <span style={numBadge}>{n}</span>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: INK.strong, margin: '1px 0 4px' }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: INK.base }}>{children}</div>
    </div>
  </div>
);

function StartPage() {
  return (
    <div style={{ maxWidth: 760 }}>
      <PageTitle icon="quickstart" title="Your first model" sub="Eight steps from an ETABS model to a verified, documented design." />
      <Step n={1} title="Set the design code and units">
        <Path>Project settings</Path> — pick the <B>Design code</B> (ACI 318-19/-14 or EN 1992-1-1), units, and default materials. On a new project this dialog opens by itself as <B>"Set up your project"</B>. Do this first: changing the code re-runs every check. EC2 switches display to SI automatically.
      </Step>
      <Step n={2} title="Import your model">
        <Path>File › Import from ETABS…</Path> — connect to a running model or read a tables file. Confirm the <B>units</B> against the "Reads as" sample (override Force/Length/Material if a value looks wrong), use the <B>Material</B> filter to leave any steel framing behind, and select the load combinations to envelope.
      </Step>
      <Step n={3} title="Look the model over">
        The <B>Group Dashboard</B> lists every group with its governing DCR. In the <B>Model</B> panel, set <B>Colour by → DCR</B> to see hot spots. Click any member to select it — the Editor, Section, Loads and Calc Sheet panels all follow the selection — and check its inputs before you detail anything.
      </Step>
      <Step n={4} title="Group similar members">
        <Path>Groups panel</Path> — select similar frames in the Model panel and press <B>Group selection</B>, or open <B>Auto-group</B> and accept the clusters. Each group shares one cage.
      </Step>
      <Step n={5} title="Reinforce each group">
        Click a group to open its rebar editor. Press <B>Suggest</B> for a practical cage (or set bars by hand), <B>review</B> it, then <Code>Apply to N members</Code>. <B>Suggest all groups</B> does the lot. The plan recolours immediately.
      </Step>
      <Step n={6} title="Verify in S-Concrete (desktop)">
        <Path>S-Concrete panel</Path> — press <B>Batch · N groups</B>. The app writes an .SCO per group, runs S-Concrete, and reads Status / DCR / warnings back onto the plan. Needs the Windows desktop app.
      </Step>
      <Step n={7} title="Chase the reds">
        Anything red failed. Open it, read the warning, give the group a bigger cage or a bigger section, re-Suggest, re-run the batch. Repeat until nothing is red.
      </Step>
      <Step n={8} title="Export the deliverables">
        <Path>Export</Path> — PDF report, Excel summary, member DCR list, or group rebar schedule. <Kbd>Ctrl</Kbd><Kbd>S</Kbd> keeps the whole project in one <Code>.scdb</Code> file; <Kbd>Ctrl</Kbd><Kbd>⇧</Kbd><Kbd>S</Kbd> saves it under a new name.
      </Step>
      <Callout tone="ok">No ETABS handy? The app opens with a small sample project, so you can practise steps 3–8 (Dashboard → Group → Suggest → Export) without importing anything.</Callout>
    </div>
  );
}

// ── Keyboard shortcuts ──────────────────────────────────────────────────────────
const KeyRow = ({ keys, action }: { keys: ReactNode; action: ReactNode }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '8px 0', borderBottom: `1px solid ${BORDER.subtle}` }}>
    <div style={{ width: 210, flexShrink: 0, display: 'flex', gap: 5, flexWrap: 'wrap' }}>{keys}</div>
    <div style={{ fontSize: 13, color: INK.base }}>{action}</div>
  </div>
);

function KeysPage() {
  return (
    <div style={{ maxWidth: 700 }}>
      <PageTitle icon="keyboard" title="Keyboard shortcuts" sub="On macOS use ⌘ where ⌃ Ctrl is shown." />
      <div style={{ ...LABEL_STYLE, margin: '0 0 6px' }}>File</div>
      <div style={{ marginBottom: 18 }}>
        <KeyRow keys={<><Kbd>Ctrl</Kbd><Kbd>N</Kbd></>} action="New project" />
        <KeyRow keys={<><Kbd>Ctrl</Kbd><Kbd>O</Kbd></>} action="Open a project file" />
        <KeyRow keys={<><Kbd>Ctrl</Kbd><Kbd>S</Kbd></>} action={<>Save — writes back to the file the project came from, without asking</>} />
        <KeyRow keys={<><Kbd>Ctrl</Kbd><Kbd>⇧</Kbd><Kbd>S</Kbd></>} action={<>Save As… — always asks, and adopts the new file</>} />
      </div>

      <div style={{ ...LABEL_STYLE, margin: '0 0 6px' }}>Editing</div>
      <div style={{ marginBottom: 18 }}>
        <KeyRow keys={<><Kbd>Ctrl</Kbd><Kbd>Z</Kbd></>} action="Undo" />
        <KeyRow keys={<><Kbd>Ctrl</Kbd><Kbd>Y</Kbd>{'  '}<span style={{ color: INK.muted, fontSize: 12 }}>or</span>{'  '}<Kbd>Ctrl</Kbd><Kbd>⇧</Kbd><Kbd>Z</Kbd></>} action="Redo" />
        <KeyRow keys={<><Kbd>Enter</Kbd>{'  '}<span style={{ color: INK.muted, fontSize: 12 }}>/</span>{'  '}<Kbd>Esc</Kbd></>} action="Commit / cancel a group rename" />
      </div>

      <div style={{ ...LABEL_STYLE, margin: '0 0 6px' }}>Navigation</div>
      <div style={{ marginBottom: 18 }}>
        <KeyRow keys={<><Kbd>↑</Kbd><Kbd>↓</Kbd></>} action={<>Previous / next member — <B>Member view only</B></>} />
        <KeyRow keys={<Kbd>Esc</Kbd>} action="Close an open dropdown or the project-settings dialog" />
        <KeyRow keys={<Kbd>F1</Kbd>} action={<>Open this guide — <B>desktop app only</B> (also under the Help menu)</>} />
      </div>

      <Callout>In the <B>desktop app</B>, <Kbd>Ctrl</Kbd><Kbd>N</Kbd> / <Kbd>Ctrl</Kbd><Kbd>O</Kbd> / <Kbd>Ctrl</Kbd><Kbd>S</Kbd> / <Kbd>Ctrl</Kbd><Kbd>⇧</Kbd><Kbd>S</Kbd> come from the native File menu and use the OS file dialogs. In a <B>browser</B> a page cannot write back to a file it was given, so Save and Save As both download the <Code>.scdb</Code> and the distinction between them disappears.</Callout>
    </div>
  );
}

// ── FAQ & troubleshooting ───────────────────────────────────────────────────────
const QA = ({ q, children }: { q: string; children: ReactNode }) => (
  <div style={{ marginBottom: 16, paddingBottom: 14, borderBottom: `1px solid ${BORDER.subtle}` }}>
    <div style={{ fontSize: 13.5, fontWeight: 700, color: INK.strong, margin: '0 0 5px' }}>{q}</div>
    <div style={{ fontSize: 13, lineHeight: 1.6, color: INK.base }}>{children}</div>
  </div>
);

function FaqPage() {
  return (
    <div style={{ maxWidth: 760 }}>
      <PageTitle icon="faq" title="FAQ & troubleshooting" sub="The questions that come up most often." />
      <QA q="The moments/shears I imported don't match ETABS.">
        The app envelopes only the <B>combinations you selected</B>, so a higher value in ETABS usually means a combination you did not import. Forces themselves come from the ETABS <B>Element (analysis)</B> table, which is what the frame-force display shows, so the two should otherwise agree station for station.
      </QA>
      <QA q="Material strengths or dimensions look absurdly large or small.">
        The model's units were mis-detected. In the ETABS wizard, override <B>Force / Length / Material</B> units and watch the <B>"Reads as"</B> sample until a known value looks right (e.g. a 300&nbsp;mm beam should read 300&nbsp;mm, not 0.3&nbsp;in).
      </QA>
      <QA q="The Batch / Push-to-ETABS buttons don't do anything.">
        Those steps launch S-Concrete / ETABS locally, so they run <B>only in the Windows desktop app</B>. In a browser you can still import, group, and design — then run the batch on the desktop.
      </QA>
      <QA q="Suggest says “No practical bar layout fits this section.”">
        The required steel won't fit even in <B>three layers</B> of the largest practical bar. The section is too small for the demand — enlarge it (or reduce the load / split the span). Other red notes mean it fits but can't reach the target DCR / shear.
      </QA>
      <QA q="A deep beam is failing crack width.">
        Crack width is a <B>serviceability</B> check, evaluated under the <em>quasi-permanent</em> (service) loads — not the factored ULS forces. Make sure skin (side-face) bars are present: <B>Suggest adds them automatically on deep beams</B> (h &gt; 36″ / 1000&nbsp;mm), or add them per face in the rebar editor / Dashboard.
      </QA>
      <QA q="What do the DCR colours mean?">
        <Tag bg={STATUS.okBg} fg={STATUS.ok}>green</Tag> &lt; 0.90, <Tag bg={STATUS.warnBg} fg={STATUS.warn}>amber</Tag> 0.90–1.00, <Tag bg={STATUS.failBg} fg={STATUS.fail}>red</Tag> ≥ 1.00. A DCR ≤ 1.00 passes; the app targets 0.90 so there's headroom.
      </QA>
      <QA q="Why did applying one cage change my whole group?">
        That's by design — a <B>group shares one cage</B>, sized to its worst member, so every member in it is safe. Edit a member on its own in the Member view if it needs a different cage (but re-applying the group overwrites it).
      </QA>
      <QA q="Where did Import / Design / Verify go? I don't see a workflow ribbon.">
        There isn't one, and there are no tabs either. <B>Import</B> is <Code>File › Import from ETABS…</Code>; <B>Design</B> happens in the <B>Groups</B> and <B>Group Dashboard</B> panels; <B>Verify</B> is the <B>S-Concrete</B> panel. Open any of them from the row of panel chips in the header. The <B>Design code</B> lives in project settings, on the gear beside <Code>Export</Code>.
      </QA>
      <QA q="I opened Dashboard or Verify and now I can't get back to Design.">
        You can — the <B>Design · Dashboard · Verify</B> bar stays visible in all three, so click straight between them. <B>Savings</B> and <B>Takeoff</B> sit beside them as icon toggles; clicking the lit one again returns you to Design.
      </QA>
      <QA q="The disk / a save failed with “no space left.”">
        You're out of the session's disk allowance. Delete large temporary files (old exports, folders) and try again — freed space is usable immediately.
      </QA>
    </div>
  );
}

// ── Diagnostics ─────────────────────────────────────────────────────────────────

/**
 * What the app records about its own use, said plainly, with the switch next to it.
 *
 * This page is the honesty half of the usage log. Recording is on by default because a
 * log nobody knew to turn on is a log that is empty on the day it is needed — but "on by
 * default" only stays defensible if the user can see exactly what is kept, see that it
 * never leaves the machine, read it themselves in a text editor, and switch it off in one
 * click. All four are here. Nothing on this page sends anything anywhere; Export writes a
 * file the user then chooses what to do with.
 */
function DiagnosticsPage() {
  const [state, setState] = useState<UsageState | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;

  useEffect(() => { void api?.usageState?.().then(setState).catch(() => {}); }, [api]);

  if (!api?.usageState) {
    return (
      <div style={{ maxWidth: 760 }}>
        <PageTitle icon="inspect" title="Diagnostics" sub="Usage recording — desktop app only." />
        <Callout>
          The usage log is part of the installed desktop app. In a browser there is nothing
          to record and nothing is written.
        </Callout>
      </div>
    );
  }

  const on = state?.consent !== false;
  const mb = state ? (state.bytes / 1048576).toFixed(2) : '0.00';

  const setConsent = (next: boolean) => {
    void api.usageSetConsent?.(next).then(setState).catch(() => {});
  };
  const doExport = () => {
    setNote(null);
    void api.usageExport?.().then(r => {
      if (r?.canceled) return;
      setNote(r?.ok
        ? `Written — ${r.lines ?? 0} records, ${((r.bytes ?? 0) / 1024).toFixed(0)} kB. Attach it to an e-mail.`
        : `Could not export: ${r?.error ?? 'unknown error'}`);
    }).catch(() => setNote('Could not export the usage data.'));
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <PageTitle icon="inspect" title="Diagnostics"
        sub="What this app records about its own use — and how to send it to us." />

      <Callout tone="ok">
        <B>Nothing here goes to the internet.</B> The app has no analytics service and makes
        no network calls. Records are written to a file on this machine, and they reach us
        only if you export them and send the file yourself.
      </Callout>

      <H3>What is recorded</H3>
      <UL>
        <LI>Which screens and dialogs you opened, and how long you spent on each.</LI>
        <LI>Import steps: how many storeys, sections and combinations you selected, how
          many beams matched, and any error the wizard showed.</LI>
        <LI>Counts and sizes — number of members, groups, load rows, how long a design
          sweep or an S-Concrete batch took.</LI>
        <LI>Design outcomes as <B>totals only</B> — how many members pass, are near
          capacity, or are over; the worst DCR; which check governs how many members; and
          why a Suggest sweep could not size a cage (e.g. <Code>flexure-ladder</Code>).</LI>
        <LI>Errors and crashes, with the code location they came from.</LI>
        <LI>Your app version, Windows version, screen size and design code.</LI>
      </UL>

      <H3>What is never recorded</H3>
      <UL>
        <LI><B>No project data</B> — no geometry, sections, materials, forces, or the
          results of any individual member.</LI>
        <LI><B>No names</B> — not the project, the members, the groups, the sections or
          the ETABS model. Where the app's own status messages list group names, the list
          is replaced by a count before it is recorded.</LI>
        <LI><B>No file paths</B> — a path names a client, so paths are reduced to their
          kind (<Code>&lt;path.edb&gt;</Code>) before they are written.</LI>
        <LI><B>No review notes</B> — what you write when marking a member Reviewed is
          yours, and stays on this machine.</LI>
        <LI>No user name, e-mail, machine name or IP address.</LI>
      </UL>

      <H3>Status</H3>
      <Table
        head={['', '']}
        rows={[
          ['Recording', on ? <Tag bg={STATUS.okBg} fg={STATUS.ok}>on</Tag>
            : <Tag bg={STATUS.failBg} fg={STATUS.fail}>off</Tag>],
          ['This session', `${state?.events ?? 0} records`],
          ['On disk', `${state?.files ?? 0} file(s), ${mb} MB`],
          ['Kept for', `${state?.retentionDays ?? 30} days, then deleted automatically`],
          ['Install ID', <Code>{state?.installId?.slice(0, 8) ?? '—'}</Code>],
          ['Sessions', String(state?.sessions ?? 0)],
        ]}
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0 8px' }}>
        <button onClick={doExport} style={diagBtn(true)}>Export usage data…</button>
        <button onClick={() => void api.usageOpenFolder?.()} style={diagBtn(false)}>
          Open the folder
        </button>
        <button onClick={() => setConsent(!on)} style={diagBtn(false)}>
          {on ? 'Turn recording off' : 'Turn recording on'}
        </button>
      </div>
      {note && <P>{note}</P>}

      <Callout>
        The exported file is plain text, one record per line — open it in Notepad and read
        it before you send it. To erase everything recorded so far, turn recording off and
        delete the files in that folder.
      </Callout>
    </div>
  );
}

const diagBtn = (primary: boolean): CSSProperties => ({
  padding: '7px 14px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  border: `1px solid ${primary ? ACCENT.primary : BORDER.strong}`,
  background: primary ? ACCENT.primary : 'white',
  color: primary ? 'white' : INK.base,
});

// ── Container ───────────────────────────────────────────────────────────────────
const HELP_TABS = [
  { key: 'guide', label: 'Doc Resources', icon: 'docs' },
  { key: 'start', label: 'Your first model', icon: 'quickstart' },
  { key: 'keys', label: 'Keyboard shortcuts', icon: 'keyboard' },
  { key: 'faq', label: 'FAQ & troubleshooting', icon: 'faq' },
  { key: 'diagnostics', label: 'Diagnostics', icon: 'inspect' },
] as const satisfies readonly { key: string; label: string; icon: IconName }[];
type HelpTab = typeof HELP_TABS[number]['key'];

export default function HelpView({ target }: { target?: { tab?: string; section?: string } | null }) {
  const [helpTab, setHelpTab] = useState<HelpTab>('guide');

  const scrollTo = (id: string) => {
    document.getElementById(`doc-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // React to a deep-link: the native Help menu passes a sub-tab; a panel's "?"
  // passes a doc section (which lives on the guide, so switch there and scroll).
  useEffect(() => {
    if (!target) return;
    if (target.section) {
      setHelpTab('guide');
      const section = target.section;
      const t = setTimeout(() => scrollTo(section), 60);
      return () => clearTimeout(t);
    }
    if (target.tab && HELP_TABS.some(t => t.key === target.tab)) {
      setHelpTab(target.tab as HelpTab);
    }
  }, [target]);

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${BORDER.default}`, marginBottom: 20, flexWrap: 'wrap' }}>
        {HELP_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setHelpTab(t.key)}
            style={{
              padding: '8px 14px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 600, marginBottom: -1,
              borderBottom: `2px solid ${helpTab === t.key ? ACCENT.primary : 'transparent'}`,
              color: helpTab === t.key ? ACCENT.primary : INK.secondary,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <Icon name={t.icon} />
            {t.label}
          </button>
        ))}
      </div>

      {helpTab === 'guide' && <GuidePage scrollTo={scrollTo} />}
      {helpTab === 'start' && <StartPage />}
      {helpTab === 'keys' && <KeysPage />}
      {helpTab === 'faq' && <FaqPage />}
      {helpTab === 'diagnostics' && <DiagnosticsPage />}
    </div>
  );
}
