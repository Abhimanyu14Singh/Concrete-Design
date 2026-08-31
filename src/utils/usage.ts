/**
 * Usage — the renderer's end of the flight recorder in `electron/usageLog.cjs`.
 *
 * WHAT IT IS FOR. Not "how many people opened the app". The question this exists to
 * answer is *where the workflow breaks down*: how far into an ETABS import someone got
 * before they closed the wizard, how long they sat on the step before giving up, which
 * check they overrode rather than believed, whether anyone reaches S-Concrete
 * verification at all. That is a sequence, not a count — which is why every event carries
 * `_dt`, the gap in milliseconds since the previous one. A 40-second gap on "Filter"
 * followed by `wizard.cancel` is a usability finding; the same two events without the gap
 * are noise.
 *
 * WHAT IT MUST NEVER CARRY. No project content, geometry, forces, member or group names,
 * and no file paths. Sizes and counts, yes — a 900-member model failing where a 20-member
 * one does not is the finding. Names are not. The main process scrubs paths and addresses
 * again on arrival, but the rule is enforced HERE, at the call site, by not passing them.
 *
 * BROWSER BUILDS. `window.electronAPI` is undefined outside Electron, so everything here
 * degrades to a no-op rather than a feature check at each call site.
 *
 * BATCHING. Events queue and go over one IPC call on a timer. An interaction that had to
 * wait for a process hop before it could proceed would be measuring the measurement.
 * Errors bypass the timer: the session that is about to die is the one worth having.
 */

import { subscribeActivity, getActivityLog } from './activity';

export type UsageLevel = 'info' | 'warn' | 'error';

/** One queued record. `p` is already flattened; the main process sanitizes again. */
interface QueuedEvent {
  ev: string;
  p?: Record<string, unknown>;
  lvl?: UsageLevel;
  /** The window this came from — the main process turns it into `renderer:<role>`. */
  src?: string;
  /**
   * When the event HAPPENED, stamped here rather than on arrival. Events sit in the
   * queue for up to a second, so letting the main process time them would collapse a
   * whole interaction onto one instant and lose the very gaps `_dt` measures.
   */
  ts: number;
}

/** Where a batch goes. Swapped in tests; resolves to the preload bridge in the app. */
type Transport = (batch: QueuedEvent[]) => void;

const FLUSH_MS = 1200;
const QUEUE_CAP = 500;
const MAX_ERRORS = 100;
/** Identical error text inside this window is one error repeating, not a new fact. */
const ERROR_DEDUPE_MS = 2000;

let queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let transport: Transport | null = null;
let started = false;
let startedAt = 0;
let lastAt = 0;
let n = 0;
let errorCount = 0;
let dropped = 0;
const recentErrors = new Map<string, number>();
const onceSeen = new Set<string>();
let context: Record<string, unknown> = {};
let role = 'main';

// ── Transport ────────────────────────────────────────────────────────────────

function defaultTransport(batch: QueuedEvent[]): void {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  // Fire and forget. A failed send must never surface as an unhandled rejection —
  // that would be the recorder manufacturing the errors it is here to observe.
  void api?.usageEvents?.(batch)?.catch?.(() => {});
}

function send(batch: QueuedEvent[]): void {
  (transport ?? defaultTransport)(batch);
}

/** True when there is somewhere for events to go (Electron, or a test transport). */
function active(): boolean {
  if (transport) return true;
  return typeof window !== 'undefined' && !!window.electronAPI?.usageEvents;
}

// ── Queue ────────────────────────────────────────────────────────────────────

export function flushUsage(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  if (dropped) {
    batch.push({ ev: 'usage.dropped', p: { count: dropped }, lvl: 'warn', src: role, ts: Date.now() });
    dropped = 0;
  }
  send(batch);
}

function enqueue(e: QueuedEvent, immediate: boolean): void {
  if (queue.length >= QUEUE_CAP) { dropped++; queue.shift(); }
  queue.push(e);
  if (immediate) { flushUsage(); return; }
  if (!timer) timer = setTimeout(flushUsage, FLUSH_MS);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Record one event.
 *
 * `name` is a dotted noun.verb — `wizard.step`, `design.run`, `export.pdf` — because the
 * log is read back by grouping on it. Props should be counts, durations, enum-ish
 * strings and booleans; see the file header for what may not appear.
 */
export function track(name: string, props?: Record<string, unknown>, level: UsageLevel = 'info'): void {
  if (!active()) return;
  try {
    const now = Date.now();
    // The clock starts at the first event, not at `initUsage`. Module-level tracking
    // (deserializeProject, say) can run before the boot call, and stamping those with
    // `_t: 0` would put them at an origin that had not happened yet.
    if (!startedAt) startedAt = now;
    const p: Record<string, unknown> = { ...(props ?? {}) };
    // Underscored so a caller's own `dt`/`n` cannot collide with the sequencing fields.
    p._n = ++n;
    p._dt = lastAt ? now - lastAt : 0;
    p._t = now - startedAt;
    // Hidden means alt-tabbed, not stalled — without this every lunch break reads as a
    // user stuck on the step they left open.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') p._bg = true;
    lastAt = now;
    enqueue({ ev: name, p, lvl: level, src: role, ts: now }, level === 'error');
  } catch { /* the recorder must never be the thing that breaks */ }
}

/** Record `name` at most once per session — for milestones, which repeat but only count once. */
export function trackOnce(name: string, props?: Record<string, unknown>): void {
  if (onceSeen.has(name)) return;
  onceSeen.add(name);
  track(name, props);
}

/**
 * Time something and record how long it took.
 *
 *   const done = trackTiming('design.sweep');
 *   ...
 *   done({ members: 312 });
 *
 * The returned function is safe to call twice and safe to never call (an abandoned timer
 * simply records nothing, which is the honest outcome for work that never finished).
 */
export function trackTiming(name: string, props?: Record<string, unknown>): (extra?: Record<string, unknown>) => void {
  const t0 = Date.now();
  let done = false;
  return (extra?: Record<string, unknown>) => {
    if (done) return;
    done = true;
    track(name, { ...(props ?? {}), ...(extra ?? {}), ms: Date.now() - t0 });
  };
}

/**
 * Sticky facts about the session — design code, model size, active view.
 *
 * Emitted as a `context` event when something CHANGES rather than stamped onto every
 * record. The log is read as a stream, so the reader carries the last value forward; the
 * alternative repeats the same four fields on every line and buys nothing.
 */
export function setUsageContext(patch: Record<string, unknown>): void {
  if (!active()) return;
  let changed = false;
  const delta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (context[k] !== v) { context[k] = v; delta[k] = v; changed = true; }
  }
  if (changed) track('context', delta);
}

// ── Error capture ────────────────────────────────────────────────────────────

/**
 * Frames reduced to `function (basename.js:line:col)`.
 *
 * A packaged stack is full of `file:///C:/Program Files/S-Dashboard/resources/app.asar/…`,
 * which is both a path we must not keep and noise around the only part that matters. The
 * basename survives — the built asset name is what makes a stack traceable back to a
 * specific build — and the user's directory layout does not.
 */
export function compactStack(stack?: string | null, frames = 6): string | undefined {
  if (!stack) return undefined;
  return stack
    .split('\n')
    .slice(0, frames)
    // GREEDY to the last separator, deliberately. A lazy `\S*?` stops at the first one
    // it can, which captures the leading directory instead of the basename — leaving the
    // rest of the user's path in the string while looking, in a spot check, as though it
    // had been stripped.
    .map(line => line
      .replace(/(?:file|https?|blob):\/\/[^\s)]*\/([^/\s)]+)/g, '$1')
      .replace(/[A-Za-z]:[\\/][^\s)]*[\\/]([^\\/\s)]+)/g, '$1')
      .trim())
    .filter(Boolean)
    .join(' | ');
}

function trackError(kind: string, message: string, stack?: string | null, extra?: Record<string, unknown>): void {
  if (errorCount >= MAX_ERRORS) return;
  const text = String(message ?? '').slice(0, 300);
  const now = Date.now();
  const seen = recentErrors.get(text);
  if (seen && now - seen < ERROR_DEDUPE_MS) return;   // one throw per frame, not per pixel
  recentErrors.set(text, now);
  errorCount++;
  track(kind, { message: text, stack: compactStack(stack), ...(extra ?? {}) }, 'error');
}

/** Public seam so `ErrorBoundary` can report a React render failure with its component stack. */
export function trackException(error: unknown, where?: string, extra?: Record<string, unknown>): void {
  const err = error instanceof Error ? error : null;
  trackError('error.caught', err ? err.message : String(error), err?.stack, { where, ...(extra ?? {}) });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

/**
 * Start recording for this window. Idempotent — every window role calls it, and React
 * StrictMode calls each of those twice in development.
 *
 * The activity mirror is the reason this is cheap to adopt: the app ALREADY narrates
 * itself into `activity.ts` for the status bar ("Suggested 7/11 groups · 2 unresolved"),
 * and every one of those lines is exactly the sentence a usage log wants. Subscribing to
 * it means the existing instrumentation flows in without touching a single call site, and
 * anything added to the status bar later arrives here for free.
 */
export function initUsage(windowRole = 'main'): void {
  if (started || !active()) return;
  started = true;
  role = windowRole;
  startedAt = Date.now();
  lastAt = startedAt;

  track('renderer.start', {
    role,
    ua: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 120) : null,
    lang: typeof navigator !== 'undefined' ? navigator.language : null,
    dpr: typeof window !== 'undefined' ? window.devicePixelRatio : null,
    w: typeof window !== 'undefined' ? window.innerWidth : null,
    h: typeof window !== 'undefined' ? window.innerHeight : null,
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('error', e => {
      trackError('error.uncaught', e.message || 'Unknown error', (e.error as Error | undefined)?.stack, {
        source: e.filename ? e.filename.split(/[\\/]/).pop() : undefined,
        line: e.lineno,
      });
    });
    window.addEventListener('unhandledrejection', e => {
      const r = (e as PromiseRejectionEvent).reason;
      const err = r instanceof Error ? r : null;
      trackError('error.rejection', err ? err.message : String(r), err?.stack);
    });
    // Last chance to get the tail of the session onto disk.
    window.addEventListener('pagehide', () => { track('renderer.end', { role }); flushUsage(); });
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      track('window.visibility', { state: document.visibilityState });
      if (document.visibilityState === 'hidden') flushUsage();
    });
  }

  mirrorActivityLog();
}

/**
 * Strip the user's own labels out of a status-bar sentence.
 *
 * The status bar names things, because a person reading it needs to know WHICH group:
 * `Suggested 2/12 groups · 10 unresolved (LOWER ROOF · B18X60-5KSI, L02 · B18X60-5KSI…)`.
 * Those are the engineer's group labels and their ETABS section names, and the
 * Diagnostics page promises they are never recorded — so the parenthetical has to go
 * before the line is mirrored.
 *
 * Only lists are removed, not every bracket: a name list is what `names()` in design.js
 * produces — a long parenthetical of comma- or `·`-separated items. A short aside like
 * `(ACI 318-19)` says something about the app, not about the user's model, and is kept.
 *
 * This is a backstop, not the plan. The prose was never a good carrier for facts we
 * want to count — `suggest.sweep` records the same sweep as reason codes, which is both
 * more useful and private by construction. Anything worth analysing should get its own
 * structured event rather than relying on what survives here.
 */
export function stripLabels(message: string): string {
  return message.replace(/\(([^)]{20,})\)/g, (whole, inner: string) => {
    if (!/,|·/.test(inner)) return whole;             // an aside, not a list
    const n = inner.split(/,|·/).filter(s => s.trim()).length;
    return `(${n} names omitted)`;
  });
}

let lastActivitySeq = 0;
function mirrorActivityLog(): void {
  subscribeActivity(() => {
    try {
      for (const entry of getActivityLog()) {
        if (entry.seq <= lastActivitySeq) continue;
        lastActivitySeq = entry.seq;
        track('activity', { kind: entry.kind, message: stripLabels(entry.message) },
          entry.kind === 'error' ? 'error' : 'info');
      }
    } catch { /* never let the mirror break the store it observes */ }
  });
}

// ── Test seams ───────────────────────────────────────────────────────────────

/** Route batches somewhere else. Passing null restores the preload bridge. */
export function __setUsageTransport(t: Transport | null): void {
  transport = t;
}

/** Drop all state between cases. */
export function __resetUsage(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  queue = [];
  started = false;
  startedAt = 0;
  lastAt = 0;
  n = 0;
  errorCount = 0;
  dropped = 0;
  recentErrors.clear();
  onceSeen.clear();
  context = {};
  lastActivitySeq = 0;
  role = 'main';
}
