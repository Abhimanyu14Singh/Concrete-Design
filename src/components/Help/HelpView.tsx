/**
 * HelpView — the "Help" tab. Four sub-tabs:
 *   • Doc Resources — the full in-app user guide (how everything works).
 *   • Your first model — a step-by-step first run.
 *   • Keyboard shortcuts — the real shortcuts wired in App.tsx.
 *   • FAQ & troubleshooting — the common gotchas.
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

/** Where a control actually lives, e.g. <Path>Viewer › Design › Suggest</Path>.
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
              <Path>Header › ETABS</Path>],
            [<><Tag bg={ACCENT.softBg} fg={ACCENT.primary}>2 · Design</Tag></>,
              'Put similar members in a group; give the group one reinforcement cage.',
              <Path>Viewer › Design</Path>],
            [<><Tag bg={ACCENT.softBg} fg={ACCENT.primary}>3 · Verify</Tag></>,
              'Write an .SCO per group, run the S-Concrete batch, read results back.',
              <Path>Viewer › Verify</Path>],
          ]}
        />
        <P>Results — pass/fail, demand-capacity ratios, warnings — are read back onto the model, so the plan itself shows what still needs attention.</P>
        <Table
          head={['', 'Supported']}
          rows={[
            ['Codes', <><Code>ACI 318-19</Code>, <Code>ACI 318-14</Code>, <Code>EN 1992-1-1</Code> (Eurocode 2)</>],
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
        <P>A header strip across the top, and one of four views below it.</P>
        <H3>The four views</H3>
        <Table
          head={['Tab', 'What it is', 'Use it to']}
          rows={[
            [<B>Viewer</B>, 'The model in 2D plan or rotatable 3D, coloured by any metric.',
              'Group members, design cages, run the S-Concrete batch. Most of the work happens here.'],
            [<B>Dashboard</B>, 'Every member in one table, grouped by design group.',
              'Scan the whole job for hot spots; apply skin reinforcement in bulk.'],
            [<B>Member</B>, 'One member in full: inputs left, code results and section drawing right.',
              'Check or hand-edit a single member and read its calc sheet.'],
            [<B>Help</B>, 'This guide.', 'Look things up.'],
          ]}
        />
        <H3>The header</H3>
        <Table
          head={['Control', 'Does']}
          rows={[
            [<IconLabel name="members">Members</IconLabel>, 'Member list — slides out over the view; click a member to open it.'],
            [<B>Saved / Unsaved</B>, 'Whether the project has unwritten changes.'],
            [<span style={{ display: 'inline-flex', gap: 6 }}><Icon name="undo" size={ICON.sm} /><Icon name="redo" size={ICON.sm} /></span>, 'Undo / redo the last edit.'],
            [<B>ETABS</B>, 'Open the import wizard — the start of every job.'],
            [<B>Export</B>, 'PDF report, spreadsheets, rebar schedules. See Saving & exporting.'],
            [<IconLabel name="settings">Settings</IconLabel>, <>Project settings — design code, units, default materials, cot θ, torsion, display scale.</>],
          ]}
        />
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
        <P><Path>Header › ETABS</Path> opens the import wizard. Connect to a running ETABS model through the CSI API, or read an exported tables file. Four steps: <B>Connect</B> → <B>Filter</B> → <B>Rebar Defaults</B> → <B>Review &amp; Import</B>.</P>
        <H3>Units — read them, then override if needed</H3>
        <P>The wizard detects the model's units and shows a live <B>"Reads as"</B> sample of an imported value so you can confirm they look sensible. Detection trusts ETABS's <em>present-units</em> setting first (what the tables are actually formatted in), then the model's saved units. If a value looks wrong (e.g. a 300&nbsp;mm beam reading as 0.3&nbsp;in, or material strengths in the thousands), override <B>Force</B>, <B>Length</B>, and <B>Material</B> units directly in the panel — the sample updates as you change them, and a red warning appears when the numbers look implausible.</P>
        <H3>Force source — Design vs Analysis</H3>
        <P>Beam forces can come from two different ETABS tables, and they are <em>not</em> the same number:</P>
        <UL>
          <LI><B>Design forces</B> (default) — values at the design stations / face of support.</LI>
          <LI><B>Element (Analysis) forces</B> — the raw per-combination analysis forces, i.e. what the ETABS frame-force display shows.</LI>
        </UL>
        <P>If the moments/shears you see in the app don't match what you read in ETABS, switch the <B>Force source</B> to <B>Element</B>. The app envelopes only the combinations you select, so a higher value in ETABS usually means a combination you didn't import.</P>
        <H3>What comes in</H3>
        <UL>
          <LI>The <B>model map</B> — the frame connectivity used to draw the 2D/3D plan.</LI>
          <LI><B>Members</B> — beams, with their section, material, and the envelope of the load combinations you chose (plus station forces along the span, used for crack checks).</LI>
        </UL>
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
    title: 'The Viewer',
    node: (
      <>
        <P>The <B>Viewer</B> draws the model in <B>2D plan</B> or a rotatable <B>3D</B> view — the <Code>3D</Code> button beside the filter icon switches between them. It is where steps 2 and 3 happen.</P>
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
          <LI>Open <B>Auto-group</B> from inside <Path>Viewer › Design</Path> to cluster members by size and demand automatically, then accept the clusters. It drills in over the group list — <Code>← Back to groups</Code> returns.</LI>
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
        <P>Designing in the app is fast but approximate; <B>S-Concrete</B> is the authoritative check. <Path>Viewer › Verify</Path> writes an <B>.SCO</B> file per group from your current cage, runs the S-Concrete batch, and reads the results back.</P>
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
        <P>Switch the <B>Design code</B> in project settings between <Code>ACI 318-19</Code>, <Code>ACI 318-14</Code> and <Code>EN 1992-1-1</Code>. The engine, the clause references, the warnings and the .SCO handed to S-Concrete all change with it. Choosing EC2 also switches display to SI.</P>
      </>
    ),
  },
  {
    id: 'units',
    title: 'Units',
    node: (
      <>
        <P>The app works in <B>imperial</B> (in · psi · kips · kip-ft) or <B>SI</B> (mm · MPa · kN · kN·m). Switch it in project settings — <Path>Header › settings icon</Path>.</P>
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
        <Path>Header › settings icon</Path> — pick the <B>Design code</B> (ACI 318-19/-14 or EN 1992-1-1), units, and default materials. On a new project this dialog opens by itself as <B>"Set up your project"</B>. Do this first: changing the code re-runs every check. EC2 switches display to SI automatically.
      </Step>
      <Step n={2} title="Import your model">
        <Path>Header › ETABS</Path> — connect to a running model or read a tables file. Confirm the <B>units</B> against the "Reads as" sample (override Force/Length/Material if a value looks wrong), choose the <B>Force source</B> (Design vs Element), and select the load combinations to envelope.
      </Step>
      <Step n={3} title="Look the model over">
        On the <B>Dashboard</B> you get every member with its DCR. In the <B>Viewer</B>, set <B>Colour by → DCR</B> to see hot spots. Click any member to open it in the <B>Member</B> view and check its inputs before you detail anything.
      </Step>
      <Step n={4} title="Group similar members">
        <Path>Viewer › Design</Path> — select similar frames on the plan and make a group, or open <B>Auto-group</B> and accept the clusters. Each group shares one cage.
      </Step>
      <Step n={5} title="Reinforce each group">
        Click a group to open its rebar editor. Press <B>Suggest</B> for a practical cage (or set bars by hand), <B>review</B> it, then <Code>Apply to N members</Code>. <B>Suggest all groups</B> does the lot. The plan recolours immediately.
      </Step>
      <Step n={6} title="Verify in S-Concrete (desktop)">
        <Path>Viewer › Verify</Path> — press <B>Batch · N groups</B>. The app writes an .SCO per group, runs S-Concrete, and reads Status / DCR / warnings back onto the plan. Needs the Windows desktop app.
      </Step>
      <Step n={7} title="Chase the reds">
        Anything red failed. Open it, read the warning, give the group a bigger cage or a bigger section, re-Suggest, re-run the batch. Repeat until nothing is red.
      </Step>
      <Step n={8} title="Export the deliverables">
        <Path>Header › Export</Path> — PDF report, Excel summary, member DCR list, or group rebar schedule. <Kbd>Ctrl</Kbd><Kbd>S</Kbd> keeps the whole project in one <Code>.scdb</Code> file.
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
        <KeyRow keys={<><Kbd>Ctrl</Kbd><Kbd>S</Kbd></>} action="Save the project" />
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

      <Callout>In the <B>desktop app</B>, <Kbd>Ctrl</Kbd><Kbd>N</Kbd> / <Kbd>Ctrl</Kbd><Kbd>O</Kbd> / <Kbd>Ctrl</Kbd><Kbd>S</Kbd> come from the native File menu and use the OS file dialogs. In a browser they are handled in-page: Save downloads the <Code>.scdb</Code>, Open shows a file picker.</Callout>
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
        Two reasons. First, the <B>Force source</B>: switch it to <B>Element (Analysis)</B> in the wizard to match the ETABS frame-force display (the default <em>Design</em> forces are taken at design stations). Second, the app envelopes only the <B>combinations you selected</B> — a higher value in ETABS usually means a combo you didn't import.
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
        There isn't one. <B>Import</B> is the <Code>ETABS</Code> button in the header; <B>Design</B> and <B>Verify</B> are tabs on the right-hand panel of the <B>Viewer</B>, alongside <B>Dashboard</B>. The <B>Design code</B> that used to sit in the ribbon now lives in project settings, opened from the settings icon beside <Code>Export</Code>.
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

// ── Container ───────────────────────────────────────────────────────────────────
const HELP_TABS = [
  { key: 'guide', label: 'Doc Resources', icon: 'docs' },
  { key: 'start', label: 'Your first model', icon: 'quickstart' },
  { key: 'keys', label: 'Keyboard shortcuts', icon: 'keyboard' },
  { key: 'faq', label: 'FAQ & troubleshooting', icon: 'faq' },
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
    </div>
  );
}
