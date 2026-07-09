/**
 * HelpView — the "Doc Resources" tab. A self-contained, in-app user guide that
 * explains how S-Dashboard works: the workflow, every view, the design/verify
 * steps, the codes and checks, units, and a glossary. Written so a new user can
 * read top-to-bottom and understand the app.
 *
 * Content is data (SECTIONS) rendered with a sticky table of contents so the doc
 * stays navigable as it grows. Styling uses the shared theme tokens only.
 */
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

// ── The guide ────────────────────────────────────────────────────────────────
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
          <LI><B>Reinforcement</B> — top and bottom bars entered as one or more <B>layers</B> (count × size). <Code>+ Add layer</Code> stacks a second/third layer; the outer layer is the one nearest the face. Skin (side-face) bars and stirrups (size, spacing, legs, and an optional 3-zone spacing) are set here too.</LI>
          <LI><B>Load cases</B> — the factored combinations, each with M, V, T (and P for columns). The worst case governs.</LI>
        </UL>
        <H3>Results</H3>
        <UL>
          <LI>A <B>pass/fail banner</B> and the governing check, plus each check's <B>DCR</B> (demand ÷ capacity — see <em>Design codes</em>).</LI>
          <LI><B>Warnings</B> — code notes flagged by severity (amber = advisory, red = failing/needs a bigger section). Examples: below minimum steel, spacing too tight, section inadequate for shear, skin reinforcement required on a deep beam.</LI>
          <LI>A <B>section drawing</B> (the cross-section with bars, stirrup, and skin bars) and a <B>∑ Calc Sheet</B> that shows the full hand-calculation behind every number.</LI>
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
        <P><B>Suggest</B> picks the lightest <em>practical</em> reinforcement that meets the group's worst demand at a target DCR (default <B>0.90</B>, editable). It is verification-driven — it doesn't guess a formula answer, it re-runs the real design engine on a trial cage and adjusts until it passes. In outline:</P>
        <UL>
          <LI><B>Envelope the demand</B> — the worst required top/bottom steel and shear across the whole group; the highest-moment member governs the geometry.</LI>
          <LI><B>Size the bars</B> — start at the smallest practical bar size and fewest bars that hold the area (top &amp; bottom share one bar size), preferring a single layer, then two, and a <B>third layer only as a fallback</B> when no size fits in two.</LI>
          <LI><B>Size the stirrups</B> — the fewest legs / smallest size / largest spacing that meets the shear demand, as a 3-zone <em>[end · mid · end]</em> pattern.</LI>
          <LI><B>Verify &amp; bump</B> — re-run every member; if a face or the shear is over target, add bars / a layer / tighten stirrups and try again.</LI>
          <LI><B>Deep beams</B> — code-based <B>skin (side-face) bars</B> are added automatically (ACI h&nbsp;&gt;&nbsp;36″ / EC2 h&nbsp;&gt;&nbsp;1000&nbsp;mm).</LI>
        </UL>
        <P>On success the note reads e.g. <Code>Flex 0.87 · Shear 0.62 at target 0.90 — review, then Apply.</Code> (columns also show P-M, axial, and ρ). Minimum steel is a hard floor; over-reinforcement is caught automatically because the strength-reduction factor drops and pushes the DCR up.</P>
        <H3>When it can't</H3>
        <P>If the section genuinely can't work, Suggest returns a red note instead of a cage, e.g. <em>"No practical bar layout fits this section — consider a larger section"</em> (the area won't fit even in three layers), <em>"…exceeds the target DCR…"</em>, or a shear/stirrup equivalent. <B>Suggest all groups</B> does the same for every group at once and reports how many met target and how many need larger sections.</P>
        <Callout tone="warn">Suggest sizes flexure, shear, and deep-beam skin bars. It does <B>not</B> size closed <B>torsion</B> stirrups, and columns are handled by a separate column auto-designer. Always review the suggested cage before applying.</Callout>
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
          <LI><B>Re-run existing folder</B> — re-run the .SCO files already on disk (keeps hand-edits; does <em>not</em> pick up changes you made in the app since).</LI>
          <LI><B>Push N groups to ETABS</B> — push the designed groups back into the ETABS model.</LI>
        </UL>
        <P>Results come back per group: a <B>Status</B> (OK / near / NG), the governing DCR, any S-Concrete warnings, and the cage that was used. The map recolors by the S-Concrete result so you can see verified vs failing members immediately.</P>
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
          <LI><B>Flexure</B> — positive (sagging) and negative (hogging) moment capacity vs demand, with the strength-reduction / tension-controlled behaviour built in.</LI>
          <LI><B>Shear</B> — concrete + stirrup capacity, with the section-crushing / strut limit (adding stirrups past that point can't help — the section must grow).</LI>
          <LI><B>Torsion</B> — where present.</LI>
          <LI><B>Crack width</B> (EC2) — the side-face and main-face crack widths under the SLS quasi-permanent moment, against a limit (default 0.3&nbsp;mm).</LI>
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
      <>
        <P>The app works in <B>imperial</B> (in / psi / kips / kip-ft) or <B>SI</B> (mm / MPa / kN / kN·m). Toggle it in <Code>⚙</Code> preferences. Everything is stored in one canonical unit set internally and converted for display, so switching units never changes the design — only how the numbers are shown. In the ETABS wizard you can additionally override the units of the <em>incoming</em> data field-by-field.</P>
      </>
    ),
  },
  {
    id: 'columns',
    title: 'Columns',
    node: (
      <>
        <P>Columns are first-class members. They import from ETABS with their axial + biaxial moments, appear on the map, and can be grouped like beams. A column group's ✨ Suggest sizes a <B>symmetric cage</B> (longitudinal steel held between ρ = 1% and 8%) checked against the <B>P-M interaction</B> and axial demand, then sizes ties for shear. The <B>Column stacks</B> analysis (Analyze menu) rolls a column up its stories and shows the capacity curve. Column .SCO export includes biaxial shear and circular sections.</P>
      </>
    ),
  },
  {
    id: 'export',
    title: 'Saving & exporting',
    node: (
      <>
        <UL>
          <LI><B>Save / Open</B> — the whole project (members, groups, cages, S-Concrete results) is one file you can save and reopen.</LI>
          <LI><B>Export ▾ → Report</B> — a formatted PDF calculation report.</LI>
          <LI><B>Export ▾ → Excel</B> — a formula-traceable spreadsheet.</LI>
          <LI><B>Export ▾ → Schedule</B> — a rebar schedule PDF.</LI>
          <LI><B>Print</B> — the current view.</LI>
        </UL>
      </>
    ),
  },
  {
    id: 'glossary',
    title: 'Glossary',
    node: (
      <>
        <UL>
          <LI><B>DCR</B> — Demand-Capacity Ratio; demand ÷ capacity. ≤ 1 passes.</LI>
          <LI><B>Cage</B> — the full set of reinforcement for a member (top/bottom/skin bars + stirrups).</LI>
          <LI><B>Group</B> — a set of members that share one cage, designed to the group's worst demand.</LI>
          <LI><B>ULS / SLS</B> — Ultimate (strength, factored loads) / Serviceability (e.g. crack width, under quasi-permanent loads) Limit States.</LI>
          <LI><B>Quasi-permanent</B> — the long-term service load combination used for crack-width checks.</LI>
          <LI><B>Envelope</B> — the worst value across the load combinations you selected.</LI>
          <LI><B>Governing</B> — the check or member producing the worst DCR.</LI>
          <LI><B>Skin / side-face reinforcement</B> — bars on the sides of a deep beam to control side-face cracking.</LI>
          <LI><B>.SCO</B> — the S-Concrete input file the app writes for each group.</LI>
        </UL>
      </>
    ),
  },
];

// ── View ───────────────────────────────────────────────────────────────────────
const numBadge: CSSProperties = {
  width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 11, fontWeight: 700, color: 'white', background: ACCENT.primary,
};

export default function HelpView() {
  const scrollTo = (id: string) => {
    document.getElementById(`doc-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 22 }}>📖</span>
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: INK.strong }}>Doc Resources</h2>
        </div>
        <p style={{ fontSize: 13, color: INK.secondary, margin: '4px 0 0' }}>
          S-Dashboard user guide — how the app works, end to end. Read straight through, or jump to a section.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
        {/* Table of contents (sticky) */}
        <nav style={{ position: 'sticky', top: 0, width: 210, flexShrink: 0, alignSelf: 'flex-start' }}>
          <div style={{ ...LABEL_STYLE, marginBottom: 8 }}>On this page</div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {SECTIONS.map((s, i) => (
              <li key={s.id}>
                <button
                  onClick={() => scrollTo(s.id)}
                  style={{
                    display: 'flex', alignItems: 'baseline', gap: 7, width: '100%', textAlign: 'left',
                    background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: 6,
                    fontSize: 12.5, lineHeight: 1.35, color: INK.secondary,
                  }}
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

        {/* Article */}
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
          <div style={{ fontSize: 11, color: INK.muted, borderTop: `1px solid ${BORDER.subtle}`, paddingTop: 10 }}>
            That's the tour. The quickest way to learn the rest is to import a model and click around — every panel has a tooltip, and the ∑ Calc Sheet on a member shows the full math behind any number.
          </div>
        </article>
      </div>
    </div>
  );
}
