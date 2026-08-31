/**
 * A frame-time meter for the model view, and the machine facts that explain it.
 *
 * WHY THIS EXISTS. A synthetic project at the real ETABS scale — 3857 areas, 877
 * columns, 609 frames over 12 storeys — orbits at 60 fps in this app, and an isolated
 * bench says the SVG layer costs ~19 ms/frame at that size while a canvas rewrite costs
 * ~46 ms. So the obvious suspects (node count, SVG-vs-canvas) are ruled out on a quiet
 * machine, and the slowness someone reports on a loaded one cannot be diagnosed by
 * reading code. This measures it where it actually happens.
 *
 * COST. The sampler is OFF by default and, when on, does one `requestAnimationFrame`
 * hop that pushes a number into a ring buffer. Statistics are recomputed — and React is
 * notified — at most a few times a second, never per frame: a meter that re-rendered the
 * status bar 60 times a second would be measuring itself.
 *
 * The three answers it is built to separate:
 *   • SOFTWARE RENDERING — `gpu` reports Chromium's own feature status. If canvas and
 *     compositing read "software only", 3857 translucent fills are being rasterised on
 *     the CPU and no amount of React tuning will help.
 *   • FILL RATE — frames are slow, but the scene node count is modest and long tasks are
 *     absent: the time is going to paint, so draw fewer/cheaper pixels.
 *   • SCRIPT — long tasks line up with the slow frames: the time is in JS (React
 *     rebuilding layers, the design engine re-running), so memoise.
 */

/** Rolling window. 4 seconds at 60 Hz — long enough to survive a stutter, short enough
 *  that the numbers still describe what the user is doing right now. */
const CAP = 240;
/** How often statistics are published. 250 ms keeps the readout legible and the cost of
 *  the meter itself off the flame chart. */
const PUBLISH_MS = 250;

export interface FrameStats {
  samples: number;
  /** Milliseconds between presented frames. */
  mean: number;
  median: number;
  p95: number;
  worst: number;
  /** Derived from the mean, which is what "how does it feel" tracks. */
  fps: number;
}

export interface SceneStats {
  svgNodes: number;
  polygons: number;
  lines: number;
  domTotal: number;
}

/** Chromium's own view of what is hardware-accelerated. Shape is Electron's. */
export type GpuStatus = {
  featureStatus?: Record<string, string>;
  info?: unknown;
  error?: string;
} | null;

export interface PerfSnapshot {
  enabled: boolean;
  stats: FrameStats | null;
  /** Long tasks (>50 ms of blocked main thread) seen in the window, if the browser
   *  reports them. A slow frame WITH a long task is script; without, it is paint. */
  longTasks: number;
  worstLongTask: number;
}

const IDLE: PerfSnapshot = Object.freeze({ enabled: false, stats: null, longTasks: 0, worstLongTask: 0 });

let snapshot: PerfSnapshot = IDLE;
const listeners = new Set<() => void>();

const frames: number[] = [];
let raf = 0;
let last = 0;
let lastPublish = 0;
let longTasks = 0;
let worstLongTask = 0;
let observer: PerformanceObserver | null = null;

function emit(next: PerfSnapshot): void {
  snapshot = Object.freeze(next);
  for (const fn of listeners) fn();
}

export function subscribePerf(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getPerf(): PerfSnapshot {
  return snapshot;
}

export function getPerfServerSnapshot(): PerfSnapshot {
  return IDLE;
}

/** Percentile from an ASCENDING copy — the caller must not pass the live buffer. */
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[i];
}

export function frameStats(samples: number[]): FrameStats | null {
  if (samples.length < 2) return null;
  const s = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((t, x) => t + x, 0) / samples.length;
  return {
    samples: samples.length,
    mean: +mean.toFixed(1),
    median: +pct(s, 0.5).toFixed(1),
    p95: +pct(s, 0.95).toFixed(1),
    worst: +s[s.length - 1].toFixed(1),
    fps: Math.round(1000 / Math.max(mean, 0.001)),
  };
}

function tick(now: number): void {
  if (last) {
    const dt = now - last;
    // Drop absurd gaps: a backgrounded tab or a devtools pause is not a slow frame.
    if (dt < 2000) {
      frames.push(dt);
      if (frames.length > CAP) frames.shift();
    }
  }
  last = now;
  if (now - lastPublish >= PUBLISH_MS) {
    lastPublish = now;
    emit({ enabled: true, stats: frameStats(frames), longTasks, worstLongTask });
  }
  raf = requestAnimationFrame(tick);
}

export function startPerf(): void {
  if (snapshot.enabled) return;
  frames.length = 0;
  last = 0; lastPublish = 0; longTasks = 0; worstLongTask = 0;
  emit({ enabled: true, stats: null, longTasks: 0, worstLongTask: 0 });
  // Being ON is state; SAMPLING needs a browser. Split so the store behaves the same
  // everywhere and only the measurement is conditional.
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return;
  // Long tasks are the discriminator between paint-bound and script-bound. Not every
  // engine ships the entry type, so its absence must not break the meter.
  try {
    observer = new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        longTasks++;
        worstLongTask = Math.max(worstLongTask, Math.round(e.duration));
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch { observer = null; }
  raf = requestAnimationFrame(tick);
}

export function stopPerf(): void {
  if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
  raf = 0;
  observer?.disconnect();
  observer = null;
  emit(IDLE);
}

export function togglePerf(): void {
  if (snapshot.enabled) stopPerf(); else startPerf();
}

/**
 * What is currently on the canvas.
 *
 * Counted from the DOM rather than from React state on purpose: the question is what
 * the BROWSER is being asked to draw, which is the thing that costs. Reads the largest
 * SVG, which is the plan canvas — the toolbar icons are SVGs too.
 */
export function sceneStats(): SceneStats {
  if (typeof document === 'undefined') return { svgNodes: 0, polygons: 0, lines: 0, domTotal: 0 };
  let best: SVGSVGElement | null = null;
  let bestN = -1;
  for (const svg of Array.from(document.querySelectorAll('svg'))) {
    const n = svg.querySelectorAll('*').length;
    if (n > bestN) { bestN = n; best = svg as SVGSVGElement; }
  }
  return {
    svgNodes: best ? best.querySelectorAll('*').length : 0,
    polygons: best ? best.querySelectorAll('polygon, path').length : 0,
    lines: best ? best.querySelectorAll('line').length : 0,
    domTotal: document.querySelectorAll('*').length,
  };
}

/**
 * Whether Chromium is actually using the GPU.
 *
 * Desktop asks the main process (`app.getGPUFeatureStatus`), which is the authoritative
 * answer. A browser build has no such API, so it falls back to the WebGL renderer
 * string — often masked, but "SwiftShader" or "llvmpipe" in it is a definitive software
 * -rendering tell, which is the case worth catching.
 */
export async function gpuStatus(): Promise<GpuStatus> {
  const api = (window as Window & { electronAPI?: { gpuStatus?: () => Promise<GpuStatus> } }).electronAPI;
  if (api?.gpuStatus) {
    try { return await api.gpuStatus(); } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') as WebGLRenderingContext | null;
    if (!gl) return { featureStatus: { webgl: 'unavailable' } };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'masked';
    return { featureStatus: { webgl_renderer: renderer } };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Everything above as one pasteable block. */
export async function perfReport(): Promise<string> {
  const p = getPerf();
  const scene = sceneStats();
  const gpu = await gpuStatus();
  const lines = ['S-Dashboard — model view performance'];
  lines.push('', `when: ${new Date().toISOString()}`);
  if (p.stats) {
    const s = p.stats;
    lines.push('', 'Frames (last 4 s of interaction):',
      `  mean ${s.mean} ms  (~${s.fps} fps)`,
      `  median ${s.median} ms · p95 ${s.p95} ms · worst ${s.worst} ms`,
      `  samples ${s.samples}`);
  } else {
    lines.push('', 'Frames: not sampled — turn the meter on, orbit for a few seconds, then copy.');
  }
  lines.push('', `Long tasks (>50 ms blocked): ${p.longTasks}${p.worstLongTask ? `, worst ${p.worstLongTask} ms` : ''}`,
    '  many long tasks -> the time is in SCRIPT; none -> the time is in PAINT');
  lines.push('', 'Scene:',
    `  plan SVG nodes ${scene.svgNodes} (${scene.polygons} filled shapes, ${scene.lines} lines)`,
    `  document nodes ${scene.domTotal}`);
  lines.push('', 'GPU:');
  if (!gpu) lines.push('  unavailable');
  else if (gpu.error) lines.push(`  ERROR ${gpu.error}`);
  else {
    for (const [k, v] of Object.entries(gpu.featureStatus ?? {})) lines.push(`  ${k}: ${v}`);
    if (gpu.info) lines.push(`  info: ${JSON.stringify(gpu.info).slice(0, 400)}`);
  }
  lines.push('', `viewport: ${window.innerWidth}x${window.innerHeight} @ dpr ${window.devicePixelRatio}`);
  lines.push(`ua: ${navigator.userAgent}`);
  return lines.join('\n');
}

/** Test seam. */
export function resetPerf(): void {
  if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
  raf = 0;
  observer?.disconnect();
  observer = null;
  frames.length = 0;
  last = 0; lastPublish = 0; longTasks = 0; worstLongTask = 0;
  snapshot = IDLE;
  for (const fn of listeners) fn();
}
