/**
 * P-M and P-M-M interaction charts, opened from the Calc Sheet's section header.
 *
 * Two things it must do to be worth having:
 *
 *   1. Plot the φ-surface the CHECK used, not a redrawn approximation. The points
 *      come straight off AxialFlexureResult.points — the same array the ray-scaling
 *      in beamAxialFlexure walks — so the curve and the utilisation can never
 *      disagree. A chart that is drawn independently of the number beside it is
 *      worse than no chart.
 *   2. Show WHERE the load sits. The demand marker and the ray to the surface are
 *      the whole point: "util = 0.96" means the marker is 96% of the way out along
 *      that ray, and seeing that is the difference between trusting the number and
 *      taking it on faith.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import type { InteractionPoint } from '../../types';
import { ACCENT, BORDER, INK, MONO_NUM, STATUS, SURFACE, TYPE } from '../../theme';
import { useUnits } from '../../contexts/UnitsContext';

const PAD = { l: 62, r: 18, t: 16, b: 42 };

/** Nice round axis bound at or above `v`. */
function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

/**
 * A round axis bound at or above `v`, on a FINER ladder than niceMax's.
 *
 * niceMax steps 1 → 2 → 2.5 → 5 → 10, which is right for a fixed chart but throws away
 * plot on this one: a surface reaching 517 kip-ft gets an axis to 1000 and draws itself
 * at half size in the left half of the box. Extra rungs keep the "fit" fit.
 */
const NICE = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
function niceBound(v: number): number {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (NICE.find(x => n <= x + 1e-9) ?? 10) * mag;
}

/** A "nice" gridline step for a span, aiming for roughly `target` divisions. */
function niceStep(span: number, target: number): number {
  const raw = Math.abs(span) / Math.max(1, target);
  if (!(raw > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** Gridline values spanning [a, b] on a nice step. */
function axisTicks(a: number, b: number, target: number): number[] {
  const s = niceStep(b - a, target);
  const out: number[] = [];
  // Guard the loop rather than trusting the arithmetic: a degenerate window (which a
  // zoom can reach) would otherwise spin forever building ticks.
  for (let v = Math.ceil(a / s) * s, i = 0; v <= b + s * 1e-6 && i < 400; v += s, i++) {
    out.push(Math.abs(v) < s * 1e-6 ? 0 : v);
  }
  return out;
}

/**
 * A smooth path through the sampled surface, with per-segment overshoot clamped.
 *
 * The surface is only sampled at ~30 points, so a raw polyline reads as faceted at
 * dialog size. Catmull-Rom fixes that, but it overshoots at a corner — and this curve
 * HAS one, where φPn is clipped flat by the §22.4.2.1 compression cap. An overshoot
 * there would draw capacity the section does not have, so the control points are
 * clamped into each segment's own bounding box: smooth along the smooth parts, exact
 * at the corner.
 */
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return '';
  const cl = (v: number, a: number, b: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), v));
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? pts[i + 1];
    const c1x = cl(p1[0] + (p2[0] - p0[0]) / 6, p1[0], p2[0]);
    const c1y = cl(p1[1] + (p2[1] - p0[1]) / 6, p1[1], p2[1]);
    const c2x = cl(p2[0] - (p3[0] - p1[0]) / 6, p1[0], p2[0]);
    const c2y = cl(p2[1] - (p3[1] - p1[1]) / 6, p1[1], p2[1]);
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/**
 * The largest φMn the sampled surface offers at axial load `P`.
 *
 * Linear interpolation between the samples the CHECK walked — the same array and the
 * same "take the outermost crossing" rule `beamAxialFlexure.interpAt` uses — so a
 * capacity read off the crosshair agrees with the one the engine reported. Null when
 * `P` is off the end of the surface, which is a real answer: there is no capacity there.
 */
export function phiMnAtP(points: InteractionPoint[], P: number): number | null {
  let best: number | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if ((a.phiPn - P) * (b.phiPn - P) <= 0) {
      const t = (P - a.phiPn) / ((b.phiPn - a.phiPn) || 1e-12);
      const m = a.phiMn + t * (b.phiMn - a.phiMn);
      if (best === null || m > best) best = m;
    }
  }
  return best;
}

/** The data window the chart is showing, in DISPLAY units. Zoom and pan move this. */
export interface PMView { m0: number; m1: number; p0: number; p1: number }

/** What the crosshair is over, in DISPLAY units. */
export interface PMProbe {
  M: number;
  P: number;
  /** Surface capacity at this axial load — null past the ends of the surface. */
  phiMn: number | null;
  /** |M| / φMn at THIS axial load. A horizontal cut, not the radial utilisation the
   *  check reports; the dialog labels it as such. */
  ratio: number | null;
  /** True once the reader has clicked to pin the crosshair. */
  pinned: boolean;
}

/** One load row, plotted as a demand dot. Clicking one selects it. */
export interface PMRow {
  id: string;
  label: string;
  Pu: number;
  /** Sagging demand (+M). */
  Mu: number;
  /** Hogging demand, plotted at −Mu_neg when the hogging branch is shown. */
  Mu_neg?: number;
}

export interface PMChartProps {
  /** The sampled φ-surface, compression branch first. */
  points: InteractionPoint[];
  /** The hogging surface, drawn mirrored into −M so one picture holds both senses. */
  pointsNeg?: InteractionPoint[];
  /** The applied load — drawn as the demand marker. */
  Pu: number;
  Mu: number;
  /** Hogging demand. Plotted at −Mu_neg, and only when `pointsNeg` is present. */
  Mu_neg?: number;
  /** Where the radial ray meets the SAGGING surface, and how far along it the load sits. */
  phiPnAtRay?: number;
  phiMnAtRay?: number;
  util?: number;
  /**
   * The same three for the HOGGING branch.
   *
   * They are separate because they are separate solves: `beamAxialFlexure` is called
   * once per bending sense, each against its own φMn0, and a row that is pure hogging
   * has util 0 on the sagging branch. Drawing only the sagging ray on such a row — which
   * is most rows near a support — put "util 0.000" on a beam at 90% of capacity.
   */
  phiPnAtRayNeg?: number;
  phiMnAtRayNeg?: number;
  utilNeg?: number;
  /** Every load row of the member, as a demand cloud behind the selected one. */
  rows?: PMRow[];
  selectedRowId?: string;
  onPickRow?: (id: string) => void;
  /** Also draw the unfactored surface — S-Concrete's "Nominal" overlay. */
  showNominal?: boolean;
  /** Controlled data window. Omit and the chart owns its own (and still zooms/pans). */
  view?: PMView | null;
  onView?: (v: PMView | null) => void;
  /** The fitted window, reported whenever it is recomputed. A host with its own zoom
   *  buttons needs it: "fit" is `view = null`, so the first button press has nothing to
   *  scale until it knows what fit actually is. */
  onFit?: (v: PMView) => void;
  /** Live crosshair readout. Fires on every move, and with null on leave. */
  onProbe?: (p: PMProbe | null) => void;
  width?: number;
  height?: number;
}

/** Named points worth landing on: they are where the section changes behaviour. */
interface KeyPt { M: number; P: number; label: string; note: string }

/**
 * The φ-interaction surface, interactive.
 *
 * Wheel zooms about the cursor, drag pans, moving the pointer probes the surface and
 * clicking pins the crosshair where it is. `view` is controlled-or-not in the usual
 * React way, so a host that wants its own zoom buttons (see PMDialog) can drive the
 * window without the chart needing to know the buttons exist.
 *
 * Everything below the props boundary is in DISPLAY units. Converting once, here, is
 * what lets the gridlines land on round numbers in whatever system is selected — a
 * chart drawn in stored imperial and relabelled would tick every 137 mm.
 */
export function PMChart({
  points, pointsNeg, Pu, Mu, Mu_neg, phiPnAtRay, phiMnAtRay, util,
  phiPnAtRayNeg, phiMnAtRayNeg, utilNeg,
  rows, selectedRowId, onPickRow, showNominal = false,
  view: viewProp, onView, onFit, onProbe,
  width = 520, height = 380,
}: PMChartProps) {
  const { fmtVal, label, toDisplay, fromDisplay } = useUnits();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [ownView, setOwnView] = useState<PMView | null>(null);
  // The crosshair is remembered in DATA coordinates, not pixels: a pinned probe has to
  // stay on the point of the surface it was pinned to while you zoom in on it, which is
  // most of the reason to pin one.
  const [probe, setProbe] = useState<{ M: number; P: number; pinned: boolean } | null>(null);
  const [hoverKey, setHoverKey] = useState<number | null>(null);
  // A pan has to suppress the click that ends it, or every drag would also re-pin the
  // crosshair somewhere the reader did not choose.
  const pan = useRef<{ x: number; y: number; view: PMView; moved: boolean } | null>(null);

  const controlled = viewProp !== undefined;
  const view = controlled ? viewProp : ownView;
  const setView = useCallback((v: PMView | null) => {
    if (onView) onView(v);
    if (!controlled) setOwnView(v);
  }, [onView, controlled]);

  const M = (v: number) => toDisplay(v, 'moment');
  const F = (v: number) => toDisplay(v, 'force');
  /** Print an ALREADY-CONVERTED number. fmtVal converts on the way in, so running an
   *  axis tick through it would apply the unit conversion a second time. */
  const num = (v: number, d = 0) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(d));

  // ── the surfaces, in display units ────────────────────────────────────────
  // Hogging is mirrored into −M. That is not a sign convention being invented: a beam
  // resists sagging and hogging with different faces of the same cage, so its envelope
  // genuinely is two different curves, and drawing only the sagging quadrant (as the
  // single-branch chart did) hides the half that governs at the supports.
  const surf = useMemo(() => {
    /**
     * Put the pure-tension tip at the FRONT of the branch.
     *
     * `beamAxialFlexure` sweeps the compression branch and then appends the exact
     * pure-tension point, so the array ends where the curve begins. Stroked in that
     * order the last segment runs from the squash cap straight down to the tip — a
     * chord across the middle of the diagram that looks like a stray line and is the
     * one part of the drawing that is not a capacity. Moved to the front it becomes the
     * path's CLOSING segment instead: the M = 0 edge of the envelope, filled but not
     * stroked (the path is never closed with Z), which is exactly what it is.
     */
    const tipFirst = (ps: InteractionPoint[]) => {
      if (ps.length < 3) return ps;
      const last = ps[ps.length - 1];
      const min = Math.min(...ps.map(p => p.phiPn));
      return last.phiPn <= min + 1e-9 ? [last, ...ps.slice(0, -1)] : ps;
    };
    const conv = (ps: InteractionPoint[], sign: number) => tipFirst(ps).map(p => ({
      M: sign * M(p.phiMn), P: F(p.phiPn),
      Mn: sign * M(p.Mn), Pn: F(p.Pn),
      c: p.c, phi: p.phi, eps_t: p.eps_t,
    }));
    return { pos: conv(points ?? [], 1), neg: pointsNeg?.length ? conv(pointsNeg, -1) : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, pointsNeg, toDisplay]);

  const dMu = M(Mu), dPu = F(Pu);
  const dMuNeg = surf.neg && Mu_neg !== undefined ? -M(Mu_neg) : undefined;

  // ── fit ───────────────────────────────────────────────────────────────────
  const fit = useMemo<PMView>(() => {
    const all = [...surf.pos, ...(surf.neg ?? [])];
    // The nominal surface is bigger than the φ one, so it joins the fit only while it is
    // being shown — otherwise every diagram would carry empty margin for a curve that is
    // switched off, and turning the overlay on would draw a line off the top of the box.
    const nom = showNominal ? all.map(p => ({ M: p.Mn, P: p.Pn })) : [];
    const ms = [...all.map(p => p.M), ...nom.map(p => p.M), dMu, ...(dMuNeg !== undefined ? [dMuNeg] : []),
      ...(phiMnAtRay !== undefined ? [M(phiMnAtRay)] : []),
      ...(surf.neg && phiMnAtRayNeg !== undefined ? [-M(phiMnAtRayNeg)] : []),
      ...(rows ?? []).flatMap(r => [M(r.Mu), ...(surf.neg && r.Mu_neg !== undefined ? [-M(r.Mu_neg)] : [])]), 0];
    const ps = [...all.map(p => p.P), ...nom.map(p => p.P), dPu, ...(phiPnAtRay !== undefined ? [F(phiPnAtRay)] : []),
      ...(phiPnAtRayNeg !== undefined ? [F(phiPnAtRayNeg)] : []),
      ...(rows ?? []).map(r => F(r.Pu)), 0];
    const m1 = niceBound(Math.max(...ms) * 1.06);
    const m0 = surf.neg || Math.min(...ms) < 0 ? -niceBound(Math.abs(Math.min(...ms)) * 1.06) : 0;
    const p1 = niceBound(Math.max(...ps) * 1.06);
    const p0 = -niceBound(Math.abs(Math.min(...ps)) * 1.06);
    return { m0, m1, p0, p1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surf, dMu, dPu, dMuNeg, phiMnAtRay, phiPnAtRay, phiMnAtRayNeg, phiPnAtRayNeg, rows, showNominal, toDisplay]);

  // Report the fitted window by VALUE, not by object identity. The host stores what it
  // is handed, which re-renders this chart; if a re-render could produce an equal-but-new
  // `fit` object the two would ping-pong for ever. Comparing the four numbers makes the
  // effect idempotent and takes that whole class of bug off the table.
  const lastFit = useRef<PMView | null>(null);
  useEffect(() => {
    const p = lastFit.current;
    if (p && p.m0 === fit.m0 && p.m1 === fit.m1 && p.p0 === fit.p0 && p.p1 === fit.p1) return;
    lastFit.current = fit;
    onFit?.(fit);
  }, [fit, onFit]);

  const V = view ?? fit;

  const iw = Math.max(1, width - PAD.l - PAD.r);
  const ih = Math.max(1, height - PAD.t - PAD.b);
  const px = (m: number) => PAD.l + ((m - V.m0) / (V.m1 - V.m0 || 1)) * iw;
  const py = (p: number) => PAD.t + (1 - (p - V.p0) / (V.p1 - V.p0 || 1)) * ih;
  const mAt = (x: number) => V.m0 + ((x - PAD.l) / iw) * (V.m1 - V.m0);
  const pAt = (y: number) => V.p0 + (1 - (y - PAD.t) / ih) * (V.p1 - V.p0);

  const paths = useMemo(() => {
    const line = (list: { M: number; P: number }[]) =>
      smoothPath(list.map(p => [px(p.M), py(p.P)] as [number, number]));
    const nom = (list: { Mn: number; Pn: number }[]) =>
      smoothPath(list.map(p => [px(p.Mn), py(p.Pn)] as [number, number]));
    return {
      pos: line(surf.pos), neg: surf.neg ? line(surf.neg) : '',
      posNom: nom(surf.pos), negNom: surf.neg ? nom(surf.neg) : '',
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surf, V, iw, ih]);

  // ── the points where the section changes behaviour ────────────────────────
  const keyPts = useMemo<KeyPt[]>(() => {
    const out: KeyPt[] = [];
    const branch = (list: typeof surf.pos, tag: string) => {
      if (!list.length) return;
      const top = list.reduce((a, b) => (b.P > a.P ? b : a), list[0]);
      out.push({ M: top.M, P: top.P, label: `φPn,max${tag}`, note: `§22.4.2.1 compression cap — ${num(top.P)} ${label('force')}` });
      // Pure flexure: where the surface crosses P = 0. This is the anchor the whole
      // curve was pinned to, so it IS the φMn the flexure check used.
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i];
        if ((a.P > 0) !== (b.P > 0)) {
          const t = (0 - a.P) / ((b.P - a.P) || 1e-12);
          out.push({ M: a.M + t * (b.M - a.M), P: 0, label: `φMn0${tag}`, note: 'Pure flexure — the capacity the beam check reports at Pu = 0' });
          break;
        }
      }
      // εt = 0.005 and 0.002: the tension-controlled limit and the compression-
      // controlled one. Between them φ ramps, and that ramp is most of the curve's
      // shape near the knee — worth being able to point at.
      for (const [target, name, why] of [
        [0.005, 'εt = 0.005', 'Tension-controlled limit — φ = 0.90 at and below this axial load'],
        [0.002, 'εt = 0.002', 'Compression-controlled limit (balanced point) — φ = 0.65 above this'],
      ] as [number, string, string][]) {
        for (let i = 1; i < list.length; i++) {
          const a = list[i - 1], b = list[i];
          if ((a.eps_t - target) * (b.eps_t - target) <= 0 && a.eps_t !== b.eps_t) {
            const t = (target - a.eps_t) / (b.eps_t - a.eps_t);
            out.push({ M: a.M + t * (b.M - a.M), P: a.P + t * (b.P - a.P), label: `${name}${tag}`, note: why });
            break;
          }
        }
      }
    };
    branch(surf.pos, '');
    if (surf.neg) branch(surf.neg, ' −');
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surf]);

  // ── interaction ───────────────────────────────────────────────────────────
  const local = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return null;
    // The SVG is laid out at its attribute size, so client px map 1:1 — except inside
    // App.tsx's zoom transform, where they do not. Scale by the measured box.
    return { x: ((e.clientX - r.left) / (r.width || 1)) * width, y: ((e.clientY - r.top) / (r.height || 1)) * height };
  };
  const inPlot = (q: { x: number; y: number }) =>
    q.x >= PAD.l && q.x <= PAD.l + iw && q.y >= PAD.t && q.y <= PAD.t + ih;

  const report = useCallback((q: { M: number; P: number; pinned: boolean } | null) => {
    if (!onProbe) return;
    if (!q) { onProbe(null); return; }
    // Read the capacity off the branch the cursor is ON. Sagging and hogging are
    // different curves; using the sagging one for a cursor at −M would report a
    // capacity from the wrong face of the beam.
    const src = q.M < 0 && pointsNeg?.length ? pointsNeg : points;
    const capStored = phiMnAtP(src ?? [], fromDisplay(q.P, 'force'));
    const cap = capStored === null ? null : M(capStored);
    onProbe({ M: q.M, P: q.P, phiMn: cap, ratio: cap && cap > 0 ? Math.abs(q.M) / cap : null, pinned: q.pinned });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onProbe, points, pointsNeg, toDisplay, fromDisplay]);

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const q = local(e);
    if (!q) return;
    if (pan.current) {
      const dx = q.x - pan.current.x, dy = q.y - pan.current.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) pan.current.moved = true;
      const b = pan.current.view;
      const dm = (dx / iw) * (b.m1 - b.m0), dp = (dy / ih) * (b.p1 - b.p0);
      setView({ m0: b.m0 - dm, m1: b.m1 - dm, p0: b.p0 + dp, p1: b.p1 + dp });
      return;
    }
    if (probe?.pinned) return;                       // a pinned crosshair stays put
    if (!inPlot(q)) { setProbe(null); report(null); return; }
    const next = { M: mAt(q.x), P: pAt(q.y), pinned: false };
    setProbe(next);
    report(next);
  };

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    const q = local(e);
    if (!q || !inPlot(q)) return;
    (e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId);
    pan.current = { x: q.x, y: q.y, view: V, moved: false };
  };

  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = pan.current;
    pan.current = null;
    (e.currentTarget as SVGSVGElement).releasePointerCapture?.(e.pointerId);
    if (!p || p.moved) return;                       // that was a pan, not a click
    const q = local(e);
    if (!q || !inPlot(q)) return;
    const next = probe?.pinned ? null : { M: mAt(q.x), P: pAt(q.y), pinned: true };
    setProbe(next);
    report(next);
  };

  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    const q = local(e);
    if (!q || !inPlot(q)) return;
    // Zoom about the CURSOR, not the centre: it is how every map and CAD view behaves,
    // and it is the only way to walk into a corner of the diagram without also panning.
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const m = mAt(q.x), p = pAt(q.y);
    setView({
      m0: m + (V.m0 - m) * k, m1: m + (V.m1 - m) * k,
      p0: p + (V.p0 - p) * k, p1: p + (V.p1 - p) * k,
    });
  };

  if (!points?.length) {
    return <div style={{ padding: 20, fontSize: TYPE.label, color: INK.muted }}>No interaction data for this row.</div>;
  }

  // The headline is the GOVERNING utilisation across the senses on show — the same
  // max() DesignResults.DCR_PM takes. A row at a support is pure hogging, so its sagging
  // util is 0.000; printing that alone said "no demand" on a beam at capacity.
  const govUtil = surf.neg && utilNeg !== undefined ? Math.max(util ?? 0, utilNeg) : util;
  const govSense = surf.neg && utilNeg !== undefined && utilNeg > (util ?? 0) ? 'hogging' : 'sagging';
  const over = (govUtil ?? 0) > 1;
  const tick: CSSProperties = { fontSize: TYPE.micro, fill: INK.muted, fontFamily: 'inherit' };
  const mTicks = axisTicks(V.m0, V.m1, Math.max(3, Math.round(iw / 78)));
  const pTicks = axisTicks(V.p0, V.p1, Math.max(3, Math.round(ih / 46)));
  const clipId = 'pmclip';

  /**
   * The demand cloud, with co-located rows merged into one dot.
   *
   * Rows really do land on the same point: a beam's moment diagram is near-symmetric, so
   * the station at 4.8 ft and the one at 19.2 ft sit on top of each other. Drawn as
   * separate circles the top one wins every click, so the tooltip named one row and
   * selecting gave you another — which is worse than not offering the click.
   *
   * Merged on ROUNDED PIXELS rather than on values, so what counts as "the same point" is
   * what the reader can actually distinguish. That also makes zoom the way to separate
   * them: magnify and the group splits into its members, each individually clickable.
   */
  const rowDots = (() => {
    const byPos = new Map<string, { x: number; y: number; at: { id: string; label: string; sense: string; Mu: number; Pu: number }[] }>();
    for (const r of rows ?? []) {
      if (r.id === selectedRowId) continue;
      const senses: { m: number; sense: string; Mu: number }[] = [];
      // A row with no moment in a given sense has nothing to plot there. Drawing it
      // anyway put a dot at the origin — and on a real model most rows are pure hogging
      // or pure sagging, so dozens stacked on one pixel.
      if (r.Mu > 0 || r.Pu !== 0) senses.push({ m: M(r.Mu), sense: 'sagging', Mu: r.Mu });
      if (surf.neg && r.Mu_neg !== undefined && r.Mu_neg > 0) senses.push({ m: -M(r.Mu_neg), sense: 'hogging', Mu: r.Mu_neg });
      for (const d of senses) {
        const x = Math.round(px(d.m)), y = Math.round(py(F(r.Pu)));
        const k = `${x}:${y}`;
        const g = byPos.get(k) ?? { x, y, at: [] };
        g.at.push({ id: r.id, label: r.label, sense: d.sense, Mu: d.Mu, Pu: r.Pu });
        byPos.set(k, g);
      }
    }
    return [...byPos.values()];
  })();

  return (
    <svg ref={svgRef} width={width} height={height}
      style={{ display: 'block', touchAction: 'none', cursor: 'crosshair' }}
      onPointerMove={onMove} onPointerDown={onDown} onPointerUp={onUp}
      onPointerLeave={() => { if (!probe?.pinned) { setProbe(null); report(null); } }}
      onWheel={onWheel}>
      <defs>
        <clipPath id={clipId}><rect x={PAD.l} y={PAD.t} width={iw} height={ih} /></clipPath>
      </defs>
      <rect x={PAD.l} y={PAD.t} width={iw} height={ih} fill={SURFACE.subtle} stroke={BORDER.default} />

      {/* gridlines + ticks */}
      {mTicks.map(t => (
        <g key={`m${t}`}>
          <line x1={px(t)} y1={PAD.t} x2={px(t)} y2={PAD.t + ih} stroke={t === 0 ? BORDER.strong : BORDER.subtle} strokeWidth={1} />
          <text x={px(t)} y={PAD.t + ih + 13} textAnchor="middle" style={{ ...tick, ...MONO_NUM }}>{num(t)}</text>
        </g>
      ))}
      {pTicks.map(t => (
        <g key={`p${t}`}>
          <line x1={PAD.l} y1={py(t)} x2={PAD.l + iw} y2={py(t)} stroke={t === 0 ? BORDER.strong : BORDER.subtle} strokeWidth={1} />
          <text x={PAD.l - 6} y={py(t) + 3} textAnchor="end" style={{ ...tick, ...MONO_NUM }}>{num(t)}</text>
        </g>
      ))}

      <g clipPath={`url(#${clipId})`}>
        {/* the nominal (unfactored) surface, when asked for — dashed and unfilled so it
            can never be mistaken for the one the check used */}
        {showNominal && (
          <>
            <path d={paths.posNom} fill="none" stroke={INK.muted} strokeWidth={1.1} strokeDasharray="5 3" />
            {paths.negNom && <path d={paths.negNom} fill="none" stroke={INK.muted} strokeWidth={1.1} strokeDasharray="5 3" />}
          </>
        )}

        {/* the φ-surface — one path per bending sense */}
        <path d={paths.pos} fill={ACCENT.softBg} stroke={ACCENT.primary} strokeWidth={1.7} strokeLinejoin="round" />
        {paths.neg && <path d={paths.neg} fill={ACCENT.softBg} stroke={ACCENT.primary} strokeWidth={1.7} strokeLinejoin="round" />}

        {/* every other load row, behind the selected one. The cloud is the point: one
            marker says where this row sits, the cloud says whether it is the outlier. */}
        {rowDots.map(g => (
          // Slightly bigger and darker where several rows coincide, so a crowded point
          // looks crowded rather than looking like one ordinary row.
          <circle key={`${g.x}:${g.y}`} cx={g.x} cy={g.y} r={g.at.length > 1 ? 4 : 3}
            fill={INK.secondary} fillOpacity={g.at.length > 1 ? 0.55 : 0.35}
            stroke="white" strokeWidth={0.8}
            style={{ cursor: onPickRow ? 'pointer' : 'default' }}
            onPointerDown={onPickRow ? e => { e.stopPropagation(); } : undefined}
            onClick={onPickRow ? e => { e.stopPropagation(); onPickRow(g.at[0].id); } : undefined}>
            {/* `combo_station` first — that is what identifies the row, and with 30+ dots
                on the surface it is the only thing you can act on. The forces come after,
                and are formatted HERE rather than baked into the label upstream, because
                this is where the unit system is: the row's own producer has no access to
                it and would freeze the numbers imperial.
                The sense is named because a row can have two dots — the hogging one is
                plotted mirrored into −M, and without saying so a reader sees the same
                combo twice at the same P and assumes a duplicate. */}
            <title>
              {g.at.slice(0, 5).map(a =>
                `${a.label}  ${a.sense} M = ${fmtVal(a.Mu, 'moment')} ${label('moment')}, P = ${fmtVal(a.Pu, 'force')} ${label('force')}`,
              ).join('\n')}
              {g.at.length > 5 ? `\n+${g.at.length - 5} more here` : ''}
              {g.at.length > 1 ? '\nThese rows sit on the same point — zoom in to separate them.' : ''}
              {onPickRow ? `\nclick to select ${g.at.length > 1 ? g.at[0].label : 'this row'}` : ''}
            </title>
          </circle>
        ))}

        {/* radial ray from the origin through the demand to the surface — one per
            bending sense, because each is a separate solve against a separate branch */}
        {[
          { m: phiMnAtRay, p: phiPnAtRay, u: util, sense: 'sagging', sign: 1 },
          { m: phiMnAtRayNeg, p: phiPnAtRayNeg, u: utilNeg, sense: 'hogging', sign: -1 },
        ].map(r => (r.m === undefined || r.p === undefined || (r.sign < 0 && !surf.neg) ? null : (
          <g key={r.sense}>
            <line x1={px(0)} y1={py(0)} x2={px(r.sign * M(r.m))} y2={py(F(r.p))}
              stroke={INK.secondary} strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={px(r.sign * M(r.m))} cy={py(F(r.p))} r={3.5} fill="none" stroke={INK.secondary} strokeWidth={1.2}>
              <title>
                Where the {r.sense} load&apos;s ray meets the φ-surface
                {r.u !== undefined ? ` — util ${r.u.toFixed(3)} is how far along it the demand sits` : ''}
              </title>
            </circle>
          </g>
        )))}

        {/* the points where the section changes behaviour */}
        {keyPts.map((k, i) => (
          <g key={i} onPointerEnter={() => setHoverKey(i)} onPointerLeave={() => setHoverKey(null)}>
            <rect x={px(k.M) - 3.5} y={py(k.P) - 3.5} width={7} height={7} fill="white"
              stroke={ACCENT.primary} strokeWidth={1.2} style={{ cursor: 'help' }} />
            <title>{k.label} — {k.note}</title>
          </g>
        ))}

        {/* the selected row's demand — one marker per sense that HAS one. A row with no
            sagging moment gets no sagging marker: a filled dot at the origin reads as a
            demand point, and it would sit on top of the ray the hogging check drew. When
            the row has neither (no moment, no axial) the origin marker is the honest
            picture and is kept. */}
        {(Mu > 0 || Pu !== 0 || dMuNeg === undefined || dMuNeg === 0) && (
          <circle cx={px(dMu)} cy={py(dPu)} r={5} fill={over ? STATUS.fail : STATUS.ok} stroke="white" strokeWidth={1.5}>
            <title>Selected row, sagging: M = {fmtVal(Mu, 'moment')} {label('moment')}, P = {fmtVal(Pu, 'force')} {label('force')}</title>
          </circle>
        )}
        {dMuNeg !== undefined && dMuNeg !== 0 && (
          <circle cx={px(dMuNeg)} cy={py(dPu)} r={5} fill={over ? STATUS.fail : STATUS.ok} stroke="white" strokeWidth={1.5}>
            <title>Selected row, hogging: M = {fmtVal(Mu_neg ?? 0, 'moment')} {label('moment')}, P = {fmtVal(Pu, 'force')} {label('force')}</title>
          </circle>
        )}

        {/* the crosshair */}
        {probe && (
          <g pointerEvents="none">
            <line x1={px(probe.M)} y1={PAD.t} x2={px(probe.M)} y2={PAD.t + ih}
              stroke={probe.pinned ? ACCENT.primary : INK.muted} strokeWidth={1} strokeDasharray={probe.pinned ? undefined : '2 3'} />
            <line x1={PAD.l} y1={py(probe.P)} x2={PAD.l + iw} y2={py(probe.P)}
              stroke={probe.pinned ? ACCENT.primary : INK.muted} strokeWidth={1} strokeDasharray={probe.pinned ? undefined : '2 3'} />
            <circle cx={px(probe.M)} cy={py(probe.P)} r={3} fill="none" stroke={probe.pinned ? ACCENT.primary : INK.secondary} strokeWidth={1.2} />
          </g>
        )}
      </g>

      {/* axes */}
      <text x={PAD.l + iw / 2} y={height - 6} textAnchor="middle" style={tick}>
        M ({label('moment')}){surf.neg ? '  —  hogging left, sagging right' : ''}
      </text>
      <text x={12} y={PAD.t + ih / 2} textAnchor="middle" style={tick}
        transform={`rotate(-90, 12, ${PAD.t + ih / 2})`}>
        P ({label('force')}) — compression +
      </text>

      {/* the number, on the picture */}
      <text x={PAD.l + iw - 6} y={PAD.t + 14} textAnchor="end"
        style={{ ...MONO_NUM, fontSize: TYPE.label, fontWeight: 700, fill: over ? STATUS.fail : STATUS.ok }}>
        {govUtil !== undefined ? `util ${govUtil.toFixed(3)}${surf.neg && utilNeg !== undefined ? ` (${govSense})` : ''}` : ''}
      </text>
      {hoverKey !== null && (
        <text x={PAD.l + 6} y={PAD.t + 14} style={{ ...tick, fill: INK.base, fontWeight: 600 }}>
          {keyPts[hoverKey].label}
        </text>
      )}
    </svg>
  );
}

/**
 * The same φ-surface at header size — a real plot, not a glyph.
 *
 * Drawn from the identical `points` array the full chart uses, so the thumbnail in a
 * panel header and the chart it opens are the same curve at two scales. Padding and
 * labels are dropped rather than shrunk: at 46×20 an axis label is illegible noise, but
 * the SHAPE of the interaction surface and where the demand sits on it both read fine,
 * and those are the two things worth carrying in a header.
 */
export function PMSpark({
  points, Pu, Mu, width = 46, height = 20,
}: { points: InteractionPoint[]; Pu: number; Mu: number; width?: number; height?: number }) {
  if (!points?.length) return null;
  const m = 2;                                   // hairline inset so the curve is not clipped
  const Mmax = Math.max(...points.map(p => p.phiMn), Math.abs(Mu), 1e-6);
  const Phi = Math.max(...points.map(p => p.phiPn), Pu);
  const Plo = Math.min(...points.map(p => p.phiPn), Pu);
  const span = Math.max(Phi - Plo, 1e-6);
  const px = (v: number) => m + (Math.abs(v) / Mmax) * (width - 2 * m);
  const py = (v: number) => m + (1 - (v - Plo) / span) * (height - 2 * m);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.phiMn)},${py(p.phiPn)}`).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }} aria-hidden>
      <path d={d} fill={ACCENT.softBg} stroke={ACCENT.primary} strokeWidth={1} strokeLinejoin="round" />
      <line x1={px(0)} y1={py(0)} x2={width - m} y2={py(0)} stroke={BORDER.strong} strokeWidth={0.5} />
      <circle cx={px(Mu)} cy={py(Pu)} r={2.2} fill={STATUS.fail} stroke="white" strokeWidth={0.8} />
    </svg>
  );
}

export interface BiaxialChartProps {
  Mux: number; Muy: number;
  phiMnx: number; phiMny: number;
  alpha: number; util: number;
  width?: number; height?: number;
}

/**
 * The Bresler load contour in the Mx–My plane, at the applied Pu.
 *
 * This is the honest picture of the method that was actually used: a contour
 * between the two uniaxial capacities, not a slice through a rigorously
 * integrated surface. Drawing it as a smooth 3-D-looking envelope would imply a
 * calculation that did not happen. The α = 1 straight line is drawn alongside so
 * the cost of the chosen α is visible — that is the whole judgement being made.
 */
export function BiaxialChart({
  Mux, Muy, phiMnx, phiMny, alpha, util, width = 520, height = 380,
}: BiaxialChartProps) {
  const { label } = useUnits();
  const iw = Math.max(1, width - PAD.l - PAD.r);
  const ih = Math.max(1, height - PAD.t - PAD.b);
  const xMax = niceMax(Math.max(phiMnx, Math.abs(Mux)) * 1.12);
  const yMax = niceMax(Math.max(phiMny, Math.abs(Muy)) * 1.12);
  const px = (m: number) => PAD.l + (Math.abs(m) / xMax) * iw;
  const py = (m: number) => PAD.t + (1 - Math.abs(m) / yMax) * ih;

  // (x/φMnx)^α + (y/φMny)^α = 1, walked in the first quadrant.
  const contour = (a: number) => {
    const pts: string[] = [];
    for (let i = 0; i <= 60; i++) {
      const rx = i / 60;
      const ry = Math.pow(Math.max(0, 1 - Math.pow(rx, a)), 1 / a);
      pts.push(`${px(rx * phiMnx)},${py(ry * phiMny)}`);
    }
    return pts.join(' ');
  };
  const over = util > 1;
  const tick: CSSProperties = { fontSize: TYPE.micro, fill: INK.muted };

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <rect x={PAD.l} y={PAD.t} width={iw} height={ih} fill={SURFACE.subtle} stroke={BORDER.default} />
      {/* α = 1 reference — the conservative floor */}
      {alpha !== 1 && (
        <polyline points={contour(1)} fill="none" stroke={BORDER.strong} strokeWidth={1} strokeDasharray="4 3" />
      )}
      <polyline points={contour(alpha)} fill={ACCENT.softBg} stroke={ACCENT.primary} strokeWidth={1.6} />
      {/* ray + demand */}
      <line x1={px(0)} y1={py(0)} x2={px(Mux)} y2={py(Muy)} stroke={INK.muted} strokeWidth={1} strokeDasharray="3 3" />
      <circle cx={px(Mux)} cy={py(Muy)} r={5} fill={over ? STATUS.fail : STATUS.ok} stroke="white" strokeWidth={1.5} />

      <text x={PAD.l + iw / 2} y={height - 8} textAnchor="middle" style={tick}>Mux ({label('moment')})</text>
      <text x={12} y={PAD.t + ih / 2} textAnchor="middle" style={tick}
        transform={`rotate(-90, 12, ${PAD.t + ih / 2})`}>Muy ({label('moment')})</text>
      <text x={PAD.l - 6} y={PAD.t + 8} textAnchor="end" style={tick}>{yMax.toFixed(0)}</text>
      <text x={PAD.l + iw} y={height - 24} textAnchor="end" style={tick}>{xMax.toFixed(0)}</text>
      <text x={PAD.l + iw - 6} y={PAD.t + 14} textAnchor="end"
        style={{ ...MONO_NUM, fontSize: TYPE.label, fontWeight: 700, fill: over ? STATUS.fail : STATUS.ok }}>
        util {util.toFixed(3)}
      </text>
      <text x={PAD.l + iw - 6} y={PAD.t + 30} textAnchor="end" style={tick}>
        α = {alpha}{alpha !== 1 ? '  (dashed = α 1.0)' : ''}
      </text>
    </svg>
  );
}
