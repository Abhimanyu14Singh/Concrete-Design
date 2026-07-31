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
import { INK, SURFACE, BORDER, ACCENT, STATUS, MONO_NUM, LABEL_STYLE } from '../../theme';

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
const numBadge: CSSProperties = {
  width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 11, fontWeight: 700, color: 'white', background: ACCENT.primary,
};
const PageTitle = ({ icon, title, sub }: { icon: string; title: string; sub: string }) => (
  <div style={{ marginBottom: 18 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 22 }}>{icon}</span>
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
        <P><B>S-Dashboard</B> takes a reinforced-concrete frame from <B>ETABS</B>, lets you group members and design their reinforcement, and then verifies that reinforcement in <B>S-Concrete</B> — all from one project file. It is built around a three-step workflow shown in the ribbon at the top of every screen:</P>
        <P>
          <Tag bg={ACCENT.softBg} fg={ACCENT.primary}>1 · Import</Tag>{' → '}
          <Tag bg={ACCENT.softBg} fg={ACCENT.primary}>2 · Design</Tag>{' → '}
          <Tag bg={ACCENT.softBg} fg={ACCENT.primary}>3 · Verify</Tag>
        </P>
        <P>You <B>import</B> beams and columns (with their analysis forces) from ETABS, <B>design</B> them by putting similar members into groups and assigning one reinforcement "cage" per group, and <B>verify</B> those cages by running the S-Concrete batch. Results (pass/fail, demand-capacity ratios, warnings) are read back onto the model so you can see at a glance what still needs attention.</P>
        <P>The app supports <B>ACI 318-19 / 318-14</B> (US) and <B>EN 1992-1-1</B> (Eurocode 2), in imperial or SI units. It designs <B>beams</B> and <B>columns</B>.</P>
      </>
    ),
  },
  {
    id: 'layout',
    title: 'How the screen is organized',
    node: (
      <>
        <P>The window has three fixed parts:</P>
        <UL>
          <LI><B>The header</B> — the view tabs (<Code>Dashboard</Code>, <Code>Map</Code>, <Code>Member</Code>, <Code>Help</Code>), the save state, undo/redo, and the file actions (<Code>New</Code>, <Code>Open</Code>, <Code>Save</Code>, <Code>⇪ ETABS</Code>, <Code>Export ▾</Code>, <Code>⚙</Code> preferences).</LI>
          <LI><B>The workflow ribbon</B> — the <B>Import → Design → Verify</B> steps (a step turns green with a ✓ when it is done) and the <B>Design code</B> selector. The code lives here because it drives the checks and the .SCO handed to S-Concrete.</LI>
          <LI><B>The content area</B> — whichever view tab is active.</LI>
        </UL>
        <H3>The three working views</H3>
        <UL>
          <LI><B>Dashboard</B> — a table of every member with its governing DCR; the place to edit one member's inputs and read its full results.</LI>
          <LI><B>Map</B> — a 2D/3D plan of the whole model, colored by any metric (DCR, steel %, …); this is where you group members, design cages, and run the S-Concrete verification.</LI>
          <LI><B>Member</B> — the detailed single-member design screen: inputs on the left, code results and the section drawing on the right.</LI>
        </UL>
        <Callout>Two selectors are always available: the <B>units</B> toggle (imperial ↔ SI, in ⚙ preferences) and the <B>Design code</B> (in the ribbon). Switching either re-runs every check.</Callout>
      </>
    ),
  },
  {
    id: 'import',
    title: '1 · Import from ETABS',
    node: (
      <>
        <P>Click <Code>⇪ ETABS</Code> in the header (or <B>Import</B> in the ribbon) to open the import wizard. You can connect to a running ETABS model through the CSI API, or read an exported tables file.</P>
        <H3>Units — read them, then override if needed</H3>
        <P>The wizard detects the model's units and shows a live <B>"Reads as"</B> sample of an imported value so you can confirm they look sensible. Detection trusts ETABS's <em>present-units</em> setting first (what the tables are actually formatted in), then the model's saved units. If a value looks wrong (e.g. a 300&nbsp;mm beam reading as 0.3&nbsp;in, or material strengths in the thousands), override <B>Force</B>, <B>Length</B>, and <B>Material</B> units directly in the panel — the sample updates as you change them, and a red warning appears when the numbers look implausible.</P>
        <H3>Force source — Design vs Analysis</H3>
        <P>Beam/column forces can come from two different ETABS tables, and they are <em>not</em> the same number:</P>
        <UL>
          <LI><B>Design forces</B> (default) — values at the design stations / face of support.</LI>
          <LI><B>Element (Analysis) forces</B> — the raw per-combination analysis forces, i.e. what the ETABS frame-force display shows.</LI>
        </UL>
        <P>If the moments/shears you see in the app don't match what you read in ETABS, switch the <B>Force source</B> to <B>Element</B>. The app envelopes only the combinations you select, so a higher value in ETABS usually means a combination you didn't import.</P>
        <H3>What comes in</H3>
        <UL>
          <LI>The <B>model map</B> — the frame connectivity used to draw the 2D/3D plan.</LI>
          <LI><B>Members</B> — beams and columns, with their section, material, and the envelope of the load combinations you chose (plus station forces along the span, used for crack checks).</LI>
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
          <LI><B>Section</B> — rectangular / T / L beam or rectangular / circular column, with width, depth, flange, clear cover, and stirrup size.</LI>
          <LI><B>Reinforcement</B> — top and bottom bars entered as one or more <B>layers</B> (count × size). <Code>+ Add layer</Code> stacks a second/third layer; the outer layer is nearest the face. Skin (side-face) bars and stirrups (size, spacing, legs, optional 3-zone spacing) are set here too.</LI>
          <LI><B>Load cases</B> — the factored combinations, each with M, V, T (and P for columns). The worst case governs.</LI>
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
    title: 'The Map view',
    node: (
      <>
        <P>The Map draws the model in <B>2D plan</B> or a rotatable <B>3D</B> view. Use it to see the whole job at once and to run the design/verify steps.</P>
        <UL>
          <LI><B>Colour by</B> — recolor every frame by DCR, Steel %, Stirrups, Weight, its group, or its section. The <B>DCR bands</B> go green (&lt; 0.70) → lime (0.70–0.90) → amber (0.90–1.00) → red (≥ 1.00).</LI>
          <LI><B>Diagram / M / V</B> — overlay moment or shear diagrams on the frames.</LI>
          <LI><B>Floors</B> — filter to one story or show all.</LI>
          <LI><B>Fit</B> re-centers the model; <B>Re-sync</B> re-pulls forces from ETABS.</LI>
          <LI>Click a beam to inspect it (a card shows its DCR, cage, and forces); click again while a group is active to add/remove it from that group.</LI>
        </UL>
        <P>The right-hand <B>Design + Verify</B> panel is where steps 2 and 3 happen (below). When you select a group, its reinforcement editor slides out as its own column between the map and the panel.</P>
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
          <LI>Select frames on the map and create a group from the selection, or</LI>
          <LI>Use <B>Auto-group</B> (the <em>Analyze</em> menu) to cluster members by size/demand automatically, then accept the suggestion.</LI>
        </UL>
        <H3>The reinforcement editor</H3>
        <P>Click a group to open its editor (the slide-out column). Set the cage — <B>top</B> and <B>bottom</B> bars (each as one or more layers), <B>skin</B> bars per face, and <B>stirrups</B> (size, spacing, legs, optional zoned spacing over the thirds of the span). Then press <Code>Apply to N members</Code> to write the cage onto every member in the group. The map DCR colors and warnings refresh immediately.</P>
        <Callout>A cage you didn't design by hand? Press <B>✨ Suggest</B> and the app sizes a practical cage for you — see the next section.</Callout>
      </>
    ),
  },
  {
    id: 'suggest',
    title: 'The ✨ Suggest auto-designer',
    node: (
      <>
        <P><B>Suggest</B> picks the lightest <em>practical</em> reinforcement that meets the group's worst demand at a target DCR (default <B>0.90</B>, editable). It is verification-driven — it doesn't guess a formula answer, it re-runs the real design engine on a trial cage and adjusts until it passes:</P>
        <P>Clicking <B>✨ Suggest</B> first opens a small dialog to set the <B>minimum</B> top-bar, bottom-bar, and stirrup sizes — Suggest then uses <em>that size or larger</em>. Leave them at the defaults (the smallest practical size) to let it choose freely. Because top and bottom share one bar size, the larger of the two minimums applies. <B>✨ Suggest all groups</B> shows the same dialog and applies your minimums to every group.</P>
        <UL>
          <LI><B>Envelope the demand</B> — the worst required top/bottom steel and shear across the whole group; the highest-moment member governs the geometry.</LI>
          <LI><B>Size the bars</B> — start at the smallest practical bar size and fewest bars that hold the area (top &amp; bottom share one size), preferring a single layer, then two, and a <B>third layer only as a fallback</B> when no size fits in two.</LI>
          <LI><B>Size the stirrups</B> — the fewest legs / smallest size / largest spacing that meets the shear demand, as a 3-zone <em>[end · mid · end]</em> pattern.</LI>
          <LI><B>Verify &amp; bump</B> — re-run every member; if a face or the shear is over target, add bars / a layer / tighten stirrups and try again.</LI>
          <LI><B>Deep beams</B> — code-based <B>skin (side-face) bars</B> are added automatically (ACI h&nbsp;&gt;&nbsp;36″ / EC2 h&nbsp;&gt;&nbsp;1000&nbsp;mm).</LI>
        </UL>
        <P>On success the note reads e.g. <Code>Flex 0.87 · Shear 0.62 at target 0.90 — review, then Apply.</Code> (columns also show P-M, axial, and ρ). Minimum steel is a hard floor; over-reinforcement is caught automatically because the strength-reduction factor drops and pushes the DCR up. If the section genuinely can't work, Suggest returns a red note (e.g. <em>"No practical bar layout fits this section"</em> — the area won't fit even in three layers). <B>Suggest all groups</B> does the same for every group and reports how many met target.</P>
        <Callout tone="warn">Suggest sizes flexure, shear, and deep-beam skin bars. It does <B>not</B> size closed <B>torsion</B> stirrups, and columns use a separate column auto-designer. Always review the suggested cage before applying.</Callout>
      </>
    ),
  },
  {
    id: 'verify',
    title: '3 · Verify with S-Concrete',
    node: (
      <>
        <P>Designing in the app is fast but approximate; <B>S-Concrete</B> is the authoritative check. The <B>Verify</B> block (bottom of the Map's Design + Verify panel) writes an <B>.SCO</B> file per group from your current cage, runs the S-Concrete batch, and reads the results back.</P>
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
        <UL>
          <LI><B>Flexure</B> — positive (sagging) and negative (hogging) moment capacity vs demand, with strength-reduction / tension-controlled behaviour built in.</LI>
          <LI><B>Shear</B> — concrete + stirrup capacity, with the section-crushing / strut limit (past that, adding stirrups can't help — the section must grow).</LI>
          <LI><B>Torsion</B> — where present.</LI>
          <LI><B>Crack width</B> (EC2) — side-face and main-face crack widths under the SLS quasi-permanent moment, against a limit (default 0.3&nbsp;mm).</LI>
          <LI><B>Detailing</B> — minimum and maximum steel, bar spacing, and deep-beam <B>skin reinforcement</B> (required when h &gt; 36″ / 1000&nbsp;mm).</LI>
        </UL>
        <H3>ACI vs EC2</H3>
        <P>Switch the <B>Design code</B> in the ribbon between <Code>ACI318-19</Code>, <Code>ACI318-14</Code>, and <Code>EN1992-1-1</Code>. The engine, the warnings, and the .SCO handed to S-Concrete all change accordingly. Choosing EC2 also switches the app to SI units.</P>
      </>
    ),
  },
  {
    id: 'units',
    title: 'Units',
    node: (
      <P>The app works in <B>imperial</B> (in / psi / kips / kip-ft) or <B>SI</B> (mm / MPa / kN / kN·m). Toggle it in <Code>⚙</Code> preferences. Everything is stored in one canonical unit set internally and converted for display, so switching units never changes the design — only how the numbers are shown. In the ETABS wizard you can additionally override the units of the <em>incoming</em> data field-by-field.</P>
    ),
  },
  {
    id: 'columns',
    title: 'Columns',
    node: (
      <P>Columns are first-class members. They import from ETABS with their axial + biaxial moments, appear on the map, and can be grouped like beams. A column group's ✨ Suggest sizes a <B>symmetric cage</B> (longitudinal steel held between ρ = 1% and 8%) checked against the <B>P-M interaction</B> and axial demand, then sizes ties for shear. The <B>Column stacks</B> analysis (Analyze menu) rolls a column up its stories and shows the capacity curve. Column .SCO export includes biaxial shear and circular sections.</P>
    ),
  },
  {
    id: 'export',
    title: 'Saving & exporting',
    node: (
      <UL>
        <LI><B>Save / Open</B> — the whole project (members, groups, cages, S-Concrete results) is one file you can save and reopen.</LI>
        <LI><B>Export ▾ → Report</B> — a formatted PDF calculation report.</LI>
        <LI><B>Export ▾ → Excel</B> — a formula-traceable spreadsheet.</LI>
        <LI><B>Export ▾ → Schedule</B> — a rebar schedule PDF.</LI>
        <LI><B>Print</B> — the current view.</LI>
      </UL>
    ),
  },
  {
    id: 'glossary',
    title: 'Glossary',
    node: (
      <UL>
        <LI><B>DCR</B> — Demand-Capacity Ratio; demand ÷ capacity. ≤ 1 passes.</LI>
        <LI><B>Cage</B> — the full set of reinforcement for a member (top/bottom/skin bars + stirrups).</LI>
        <LI><B>Group</B> — a set of members that share one cage, designed to the group's worst demand.</LI>
        <LI><B>ULS / SLS</B> — Ultimate (strength, factored loads) / Serviceability (e.g. crack width, quasi-permanent loads) Limit States.</LI>
        <LI><B>Quasi-permanent</B> — the long-term service load combination used for crack-width checks.</LI>
        <LI><B>Envelope</B> — the worst value across the load combinations you selected.</LI>
        <LI><B>Governing</B> — the check or member producing the worst DCR.</LI>
        <LI><B>Skin / side-face reinforcement</B> — bars on the sides of a deep beam to control side-face cracking.</LI>
        <LI><B>.SCO</B> — the S-Concrete input file the app writes for each group.</LI>
      </UL>
    ),
  },
];

function GuidePage({ scrollTo }: { scrollTo: (id: string) => void }) {
  return (
    <>
      <PageTitle icon="📖" title="Doc Resources" sub="The full user guide — how the app works, end to end. Read straight through, or jump to a section." />
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
      <PageTitle icon="🚀" title="Your first model" sub="Eight steps from an ETABS model to a verified, documented design." />
      <Step n={1} title="Set the design code and units">
        Pick your <B>Design code</B> in the ribbon (ACI 318-19/-14 or EN 1992-1-1) and your units in <Code>⚙</Code> preferences. Do this first — both re-run every check. Choosing EC2 switches to SI automatically.
      </Step>
      <Step n={2} title="Import your model">
        Click <Code>⇪ ETABS</Code>. In the wizard, confirm the <B>units</B> against the "Reads as" sample (override Force/Length/Material if a value looks wrong), choose the <B>Force source</B> (Design vs Element), and select the load combinations to envelope. Import.
      </Step>
      <Step n={3} title="Look the model over">
        On the <B>Dashboard</B> you get every member with its DCR; on the <B>Map</B>, colour by <B>DCR</B> to see hot spots. Click any member to open it in the <B>Member</B> view and check its inputs.
      </Step>
      <Step n={4} title="Group similar members">
        In the Map's <B>Design + Verify</B> panel, select similar frames and make a group — or run <B>Auto-group</B> (Analyze menu) and accept the clusters. Each group will share one reinforcement cage.
      </Step>
      <Step n={5} title="Reinforce each group">
        Click a group to open its editor. Press <B>✨ Suggest</B> for a practical cage (or set bars by hand), <B>review</B> the result, then <Code>Apply to N members</Code>. Use <B>✨ Suggest all groups</B> to do them all at once. The map recolours immediately.
      </Step>
      <Step n={6} title="Verify in S-Concrete (desktop)">
        In the <B>Verify</B> block press <B>Batch · N groups</B>. The app writes an .SCO per group, runs S-Concrete, and reads the Status/DCR/warnings back onto the map. (This step needs the Windows desktop app.)
      </Step>
      <Step n={7} title="Chase the reds">
        Anything red failed. Open it, see why (the warning tells you), give the group a bigger cage or a bigger section, re-Suggest, and re-run the batch. Repeat until the map is green.
      </Step>
      <Step n={8} title="Export the deliverables">
        <Code>Export ▾</Code> → a PDF <B>Report</B>, a formula-traceable <B>Excel</B>, or a rebar <B>Schedule</B>. <Code>Save</Code> keeps the whole project (design + results) in one file.
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
      <PageTitle icon="⌨️" title="Keyboard shortcuts" sub="On macOS use ⌘ where ⌃ Ctrl is shown." />
      <div>
        <KeyRow keys={<><Kbd>Ctrl</Kbd><Kbd>N</Kbd></>} action="New project" />
        <KeyRow keys={<><Kbd>Ctrl</Kbd><Kbd>O</Kbd></>} action="Open a project file" />
        <KeyRow keys={<><Kbd>Ctrl</Kbd><Kbd>S</Kbd></>} action="Save the project" />
        <KeyRow keys={<><Kbd>Ctrl</Kbd><Kbd>Z</Kbd></>} action="Undo" />
        <KeyRow keys={<><Kbd>Ctrl</Kbd><Kbd>Y</Kbd>{'  '}<span style={{ color: INK.muted, fontSize: 12 }}>or</span>{'  '}<Kbd>Ctrl</Kbd><Kbd>⇧</Kbd><Kbd>Z</Kbd></>} action="Redo" />
        <KeyRow keys={<><Kbd>↑</Kbd><Kbd>↓</Kbd></>} action="Previous / next member (in the Member view)" />
        <KeyRow keys={<Kbd>Esc</Kbd>} action="Close the open menu or dialog" />
        <KeyRow keys={<Kbd>F1</Kbd>} action="Open Help (desktop app) — also under the Help menu" />
        <KeyRow keys={<><Kbd>Enter</Kbd>{'  '}<span style={{ color: INK.muted, fontSize: 12 }}>/</span>{'  '}<Kbd>Esc</Kbd></>} action="Commit / cancel a group rename" />
      </div>
      <Callout>In the <B>desktop app</B>, Save and Open use the operating system's native file dialogs; the rest of the shortcuts work everywhere.</Callout>
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
      <PageTitle icon="💬" title="FAQ & troubleshooting" sub="The questions that come up most often." />
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
      <QA q="Clicking a step in the workflow ribbon doesn't open a screen.">
        <B>Import</B> opens the ETABS wizard; <B>Design</B> and <B>Verify</B> jump to the Map's <B>Design + Verify</B> panel, where those actions live.
      </QA>
      <QA q="The disk / a save failed with “no space left.”">
        You're out of the session's disk allowance. Delete large temporary files (old exports, folders) and try again — freed space is usable immediately.
      </QA>
    </div>
  );
}

// ── Container ───────────────────────────────────────────────────────────────────
const HELP_TABS = [
  { key: 'guide', label: '📖 Doc Resources' },
  { key: 'start', label: '🚀 Your first model' },
  { key: 'keys', label: '⌨️ Keyboard shortcuts' },
  { key: 'faq', label: '💬 FAQ & troubleshooting' },
] as const;
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
            }}
          >
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
