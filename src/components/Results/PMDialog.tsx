/**
 * The N-vs-M window — the P-M interaction diagram laid out the way S-CONCRETE lays it
 * out, because that is the window engineers here already read.
 *
 * Three columns, matching the reference:
 *
 *   left    the section as WORDS — dimensions, As′ and As with their ratios, the link
 *           detail. This is the "what am I looking at" column, and it is why the
 *           diagram can be read without the Section panel open beside it.
 *   centre  the diagram (see PMChart) — crosshair, zoom, pan, both bending senses.
 *   right   the section as a PICTURE, then the controls, then the live readout that
 *           S-Concrete calls "Diagram Values".
 *
 * What is deliberately NOT copied: S-Concrete's Theta dropdown. Theta rotates the
 * moment vector for a biaxially-loaded COLUMN. A beam bends about one axis, and its two
 * interesting directions are sagging and hogging — different faces of the same cage, so
 * genuinely two different curves. Those are the branches this window offers instead. A
 * theta control here would be a dial wired to nothing.
 *
 * Its sign convention is not copied either. S-Concrete plots N negative upward
 * (compression −ve); this app has used Pu +ve in compression everywhere since the
 * engine was written, so the axis stays compression-positive and says so. Same picture,
 * same shape, numbers that agree with the rest of the app.
 */
import { useCallback, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { InteractionPoint, MaterialProps, RebarLayout, SectionDimensions } from '../../types';
import { ACCENT, BORDER, INK, MONO_NUM, STATUS, SURFACE, TYPE } from '../../theme';
import { useUnits } from '../../contexts/UnitsContext';
import { getBarArea } from '../../utils/concreteDesign';
import { formatBarLabel } from '../../utils/rebar';
import SectionView from '../Detailing/SectionView';
import { PMChart } from './InteractionChart';
import type { PMProbe, PMRow, PMView } from './InteractionChart';

export interface PMDialogProps {
  /** Sagging φ-surface — AxialFlexureResult.points for sense 'pos'. */
  points: InteractionPoint[];
  /** Hogging φ-surface. Optional: without it the window shows one branch, as before. */
  pointsNeg?: InteractionPoint[];
  section: SectionDimensions;
  rebar: RebarLayout;
  material?: MaterialProps;
  /** Titles the window: the member (or group) and the load combination. */
  memberLabel: string;
  loadLabel?: string;
  code?: string;
  /** The selected row's demand. */
  Pu: number;
  Mu: number;
  Mu_neg?: number;
  phiPnAtRay?: number;
  phiMnAtRay?: number;
  util?: number;
  /** The hogging branch's own ray and utilisation — a separate solve, see PMChart. */
  phiPnAtRayNeg?: number;
  phiMnAtRayNeg?: number;
  utilNeg?: number;
  /** Every row of the member — the demand cloud. Clicking one selects it. */
  rows?: PMRow[];
  selectedRowId?: string;
  onPickRow?: (id: string) => void;
  /** Panel size to fill. The window sizes the diagram from whatever it is given. */
  width?: number;
  height?: number;
}

const COL_W = 178;

export default function PMDialog({
  points, pointsNeg, section, rebar, material, memberLabel, loadLabel, code,
  Pu, Mu, Mu_neg, phiPnAtRay, phiMnAtRay, util, phiPnAtRayNeg, phiMnAtRayNeg, utilNeg,
  rows, selectedRowId, onPickRow,
  width = 980, height = 620,
}: PMDialogProps) {
  const { fmtVal, label, units } = useUnits();
  const [view, setView] = useState<PMView | null>(null);
  const [fitView, setFitView] = useState<PMView | null>(null);
  const [probe, setProbe] = useState<PMProbe | null>(null);
  const [nominal, setNominal] = useState(false);
  const [branch, setBranch] = useState<'both' | 'pos'>(pointsNeg?.length ? 'both' : 'pos');

  const plotW = Math.max(280, width - 2 * COL_W - 26);
  const plotH = Math.max(240, height - 78);

  // Which sense governs, and by how much. Only counted when its branch is actually on
  // show — with the hogging curve switched off, quoting a hogging utilisation would name
  // a number against a curve that is not in the picture.
  const showBoth = branch === 'both' && !!pointsNeg?.length;
  const gov = util === undefined && utilNeg === undefined ? undefined
    : showBoth && (utilNeg ?? 0) > (util ?? 0)
      ? { util: utilNeg ?? 0, sense: 'hogging' }
      : { util: util ?? 0, sense: 'sagging' };

  // ── zoom, driven from the sidebar ─────────────────────────────────────────
  // The buttons move the SAME data window the wheel moves — one model, so a wheel-zoom
  // followed by a button press does not fight itself. `view === null` means "fit", and
  // that is how Fit is implemented: throw the window away and let the chart re-derive
  // it. The chart hands the fitted window back through onFit, which is what the first
  // button press scales from and what the percentage below is measured against.
  const zoomBy = useCallback((k: number) => {
    setView(v => {
      const b = v ?? fitView;
      if (!b) return v;
      const cm = (b.m0 + b.m1) / 2, cp = (b.p0 + b.p1) / 2;
      return { m0: cm + (b.m0 - cm) * k, m1: cm + (b.m1 - cm) * k, p0: cp + (b.p0 - cp) * k, p1: cp + (b.p1 - cp) * k };
    });
  }, [fitView]);
  // Fit is the 100% datum. Measured on the moment span, which is the axis a reader is
  // normally zooming into; the two scale together under the buttons and the wheel.
  const zoomPct = view && fitView && view.m1 > view.m0
    ? Math.round((100 * (fitView.m1 - fitView.m0)) / (view.m1 - view.m0))
    : 100;

  // ── the left column ───────────────────────────────────────────────────────
  const facts = useMemo(() => {
    const As = (g?: { numBars: number; barSize: number }[]) =>
      (g ?? []).reduce((t, b) => t + b.numBars * getBarArea(b.barSize), 0);
    const h = section.h ?? 0;
    const b = section.b ?? 0;
    const bw = section.bw ?? b;
    const Ast = As(rebar.topBars), Asb = As(rebar.botBars);
    // ρ against b·h, the ratio S-Concrete prints beside each face. Deliberately the
    // GROSS rectangle, not bw·d — it is a detailing ratio for comparing cages, not the
    // ρ any capacity equation uses, and quoting bw·d under the same name would invite it
    // to be read into a code check it plays no part in.
    const bh = (section.type === 'T_beam' || section.type === 'L_beam' ? bw : b) * h;
    const ties = rebar.ties;
    const zones = rebar.tieZones;
    const bars = (g?: { numBars: number; barSize: number }[]) =>
      (g ?? []).filter(x => x.numBars > 0).map(x => `${x.numBars}−${formatBarLabel(x.barSize)}`).join(' + ') || '—';
    return { Ast, Asb, bh, h, b, bw, ties, zones, topDesc: bars(rebar.topBars), botDesc: bars(rebar.botBars) };
  }, [section, rebar]);

  const dim = (v: number) => `${fmtVal(v, 'length', units === 'si' ? 0 : 1)} ${label('length')}`;
  // 2 dp on in², none on mm². 1529.03 mm² claims a hundredth of a square millimetre of
  // steel — precision the bar schedule does not have and nobody asked for.
  const area = (v: number) => `${fmtVal(v, 'area', units === 'si' ? 0 : 2)} ${label('area')}`;

  const sectionName = section.type === 'T_beam' ? 'T-Beam'
    : section.type === 'L_beam' ? 'L-Beam' : 'Rectangular Beam';

  return (
    <div style={{ display: 'flex', gap: 12, width, height, alignItems: 'stretch',
      font: `${TYPE.body}px inherit`, color: INK.base }}>

      {/* ── left: the section in words ─────────────────────────────────────── */}
      <div style={{ width: COL_W, flex: 'none', overflow: 'auto', paddingRight: 2 }}>
        <Block title="Concrete Section">
          <div style={{ fontWeight: 600, color: INK.strong }}>
            {dim(facts.bw)} Wide × {dim(facts.h)} Deep
          </div>
          <div style={{ color: INK.secondary }}>{sectionName}</div>
          {material && (
            <div style={{ marginTop: 3 }}>
              <Row k="f′c" v={`${fmtVal(material.fc, 'stress', 0)} ${label('stress')}`} />
              <Row k="fy" v={`${fmtVal(material.fy, 'stress', 0)} ${label('stress')}`} />
            </div>
          )}
        </Block>

        <Block title="Top Bars">
          <div style={{ ...MONO_NUM, color: INK.strong, fontWeight: 600 }}>{facts.topDesc}</div>
          <Row k="As′" v={area(facts.Ast)} />
          <Row k="As′/bh" v={facts.bh > 0 ? (facts.Ast / facts.bh).toFixed(5) : '—'} />
        </Block>

        <Block title="Bottom Bars">
          <div style={{ ...MONO_NUM, color: INK.strong, fontWeight: 600 }}>{facts.botDesc}</div>
          <Row k="As" v={area(facts.Asb)} />
          <Row k="As/bh" v={facts.bh > 0 ? (facts.Asb / facts.bh).toFixed(5) : '—'} />
        </Block>

        <Block title="Stirrups (closed)">
          {facts.ties ? (
            <>
              {/* Zoned links get all three spacings, not the end one with the middle
                  hidden behind it: the shear and torsion capacity the surface's cage
                  relies on differs by a factor of three between them on this model. */}
              <div style={{ ...MONO_NUM, color: INK.strong, fontWeight: 600 }}>
                {formatBarLabel(facts.ties.barSize)} @ {dim(facts.zones ? facts.zones[0].spacing : facts.ties.spacing)}
                {facts.zones ? ' (ends)' : ''}
              </div>
              {facts.zones && (
                <div style={{ ...MONO_NUM, color: INK.secondary }}>
                  {formatBarLabel(facts.ties.barSize)} @ {dim(facts.zones[1].spacing)} (middle ⅓)
                </div>
              )}
              <Row k="legs" v={String(facts.ties.legs)} />
            </>
          ) : <div style={{ color: INK.muted }}>none</div>}
          <div style={{ color: INK.secondary, marginTop: 2 }}>
            {facts.Ast > 0 ? 'Compression steel included' : 'No compression steel'}
          </div>
        </Block>

        <Block title="Selected Demand">
          <Row k="M" v={`${fmtVal(Mu, 'moment')} ${label('moment')}`} />
          {Mu_neg !== undefined && Mu_neg !== 0 && (
            <Row k="M−" v={`${fmtVal(Mu_neg, 'moment')} ${label('moment')}`} />
          )}
          <Row k="N" v={`${fmtVal(Pu, 'force')} ${label('force')}`} />
          {/* The GOVERNING utilisation across the two senses — the max() the engine's
              own DCR_PM takes. Reporting the sagging one alone read 0.000 on every row
              at a support, where the demand is pure hogging. */}
          {gov !== undefined && (
            <Row k="N-vs-M util" v={`${gov.util.toFixed(3)}${showBoth ? ` (${gov.sense})` : ''}`}
              tone={gov.util > 1 ? STATUS.fail : gov.util > 0.9 ? STATUS.warn : STATUS.ok} />
          )}
          <div style={{ fontSize: TYPE.micro, color: INK.muted, lineHeight: 1.45, marginTop: 4 }}>
            {Pu === 0
              ? 'This row carries no axial load, so its marker sits on the P = 0 axis — the surface still shows how much axial the section could take.'
              : 'Utilisation is radial: how far along the ray from the origin to the surface the demand sits.'}
          </div>
        </Block>
      </div>

      {/* ── centre: the diagram ────────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* No title here. The window this sits in already carries "N vs M Diagram" and
            the member, and repeating it twelve pixels below reads as a bug. What the
            header does NOT carry is the code the surface was built under, so that stays. */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, minHeight: 14 }}>
          <span style={{ fontSize: TYPE.micro, color: INK.muted }}>
            φ-surface · {gov ? `governing sense: ${gov.sense}` : 'no demand on this row'}
          </span>
          <div style={{ flex: 1 }} />
          {code && <span style={{ fontSize: TYPE.micro, color: INK.muted }}>{code}</span>}
        </div>
        <PMChart
          points={points}
          pointsNeg={branch === 'both' ? pointsNeg : undefined}
          Pu={Pu} Mu={Mu} Mu_neg={branch === 'both' ? Mu_neg : undefined}
          phiPnAtRay={phiPnAtRay} phiMnAtRay={phiMnAtRay} util={util}
          phiPnAtRayNeg={phiPnAtRayNeg} phiMnAtRayNeg={phiMnAtRayNeg} utilNeg={utilNeg}
          rows={rows} selectedRowId={selectedRowId} onPickRow={onPickRow}
          showNominal={nominal}
          view={view} onView={setView} onFit={setFitView}
          onProbe={setProbe}
          width={plotW} height={plotH}
        />
        <div style={{ fontSize: TYPE.micro, color: INK.muted, marginTop: 2 }}>
          Move to probe · click to pin the crosshair · wheel to zoom · drag to pan
          {rows?.length ? ' · click a grey dot to jump to that load row' : ''}
        </div>
      </div>

      {/* ── right: picture, controls, readout ──────────────────────────────── */}
      <div style={{ width: COL_W, flex: 'none', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
        <div style={{ border: `1px solid ${BORDER.default}`, borderRadius: 6, background: SURFACE.raised, padding: 2 }}>
          <SectionView section={section} rebar={rebar} width={COL_W - 8} height={132}
            showDims={false} barLabels={false} padL={10} padR={10} padT={10} padB={10} />
        </div>

        <Block title="View">
          <div style={{ display: 'flex', gap: 4 }}>
            <Btn onClick={() => zoomBy(1 / 1.25)} title="Zoom in">＋</Btn>
            <Btn onClick={() => zoomBy(1.25)} title="Zoom out">－</Btn>
            <Btn onClick={() => setView(null)} title="Fit the whole surface">Fit</Btn>
            <span style={{ flex: 1 }} />
            <span style={{ ...MONO_NUM, fontSize: TYPE.micro, color: INK.secondary, alignSelf: 'center' }}>
              {zoomPct} %
            </span>
          </div>
        </Block>

        <Block title="Curves">
          <label style={CHECK}>
            <input type="checkbox" checked={nominal} onChange={e => setNominal(e.target.checked)} />
            Nominal (unfactored)
          </label>
          <label style={{ ...CHECK, opacity: pointsNeg?.length ? 1 : 0.45 }}
            title={pointsNeg?.length ? 'Draw the hogging surface mirrored into −M' : 'No hogging surface was supplied for this row'}>
            <input type="checkbox" disabled={!pointsNeg?.length}
              checked={branch === 'both' && !!pointsNeg?.length}
              onChange={e => setBranch(e.target.checked ? 'both' : 'pos')} />
            Hogging branch
          </label>
          <div style={{ fontSize: TYPE.micro, color: INK.muted, lineHeight: 1.45, marginTop: 3 }}>
            The solid surface is the φ-factored one the check walked. Nominal is drawn
            dashed and is not a capacity you may design to.
          </div>
        </Block>

        <Block title="Diagram Values">
          {probe ? (
            <>
              <Row k="M" v={`${num(probe.M)} ${label('moment')}`} />
              <Row k="N" v={`${num(probe.P)} ${label('force')}`} />
              <Row k={`φMn at this N`} v={probe.phiMn === null ? 'off surface' : `${num(probe.phiMn)} ${label('moment')}`} />
              <Row k="M / φMn" v={probe.ratio === null ? '—' : probe.ratio.toFixed(3)}
                tone={probe.ratio === null ? undefined : probe.ratio > 1 ? STATUS.fail : STATUS.ok} />
              <div style={{ fontSize: TYPE.micro, color: INK.muted, lineHeight: 1.45, marginTop: 4 }}>
                A horizontal cut at this axial load — not the radial utilisation the check
                reports. {probe.pinned ? 'Pinned; click the plot to release.' : ''}
              </div>
            </>
          ) : (
            <div style={{ fontSize: TYPE.micro, color: INK.muted, lineHeight: 1.5 }}>
              Move the pointer over the diagram to read M, N and the capacity there.
            </div>
          )}
        </Block>
      </div>
    </div>
  );
}

/** Print an already-converted display number. */
function num(v: number): string {
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(Math.abs(v) < 10 ? 1 : 0);
}

const CHECK: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: TYPE.label,
  color: INK.base, cursor: 'pointer', marginBottom: 2,
};

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: TYPE.micro, textTransform: 'uppercase', letterSpacing: '0.06em',
        color: INK.secondary, fontWeight: 700, marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: TYPE.label, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: INK.secondary }}>{k}</span>
      <span style={{ ...MONO_NUM, fontWeight: 600, color: tone ?? INK.strong, whiteSpace: 'nowrap' }}>{v}</span>
    </div>
  );
}

function Btn({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={title}
      style={{ background: SURFACE.raised, border: `1px solid ${BORDER.strong}`, borderRadius: 5,
        padding: '2px 8px', fontSize: TYPE.label, cursor: 'pointer', color: INK.base, fontWeight: 600,
        lineHeight: 1.6 }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = ACCENT.primary; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = BORDER.strong; }}>
      {children}
    </button>
  );
}
