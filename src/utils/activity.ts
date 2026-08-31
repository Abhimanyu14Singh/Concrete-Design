/**
 * What the app is doing right now — one shared, framework-free store behind the
 * status bar at the bottom of the shell.
 *
 * Deliberately a SINGLETON with ONE current task rather than a queue. The shell runs
 * one long job at a time (a Suggest sweep, an S-Concrete batch, an ETABS push) and a
 * status bar that could show two of them would have to choose which — so the choice is
 * made here instead, by the last `begin()` winning. A second job starting while one
 * runs is a bug in the caller, not a case for the bar to arbitrate.
 *
 * PAUSE IS OPT-IN, and it is honest. A task is `pausable` only if its driver actually
 * yields — it must `await gate()` between chunks — because a pause button over a
 * synchronous loop or a spawned sidecar is a control that does nothing, and a dead
 * control is worse than no control. `beginActivity` takes the flag; the bar shows the
 * button only when it is set.
 */

/** The bar's whole view of the world. Frozen, and replaced (never mutated) on change,
 *  so `useSyncExternalStore` can compare snapshots by reference. */
export interface ActivitySnapshot {
  /** Monotonic id — a new task is a new id, so consumers can tell restart from update. */
  readonly id: number;
  /** One short line: what is happening. Shown verbatim beside the bar. */
  readonly label: string;
  /** Units finished. Meaningless when `total` is 0. */
  readonly done: number;
  /** Total units, or 0 for indeterminate work (a sidecar we cannot count). */
  readonly total: number;
  readonly pausable: boolean;
  readonly paused: boolean;
  /** Set once the task ends, so the bar can show a fading "done" line. */
  readonly finished: boolean;
}

/** The handle a driver keeps. Only the driver should hold one. */
export interface ActivityHandle {
  readonly id: number;
  /** Report progress. Any field omitted is left as-is. */
  update(patch: { done?: number; total?: number; label?: string }): void;
  /**
   * Yield to the pause switch. Resolves immediately when running; when paused it
   * resolves on resume. Call it BETWEEN units of work, never inside one — the point is
   * to stop at a boundary where the model is consistent.
   *
   * It also yields to the event loop unconditionally, which is what lets the bar repaint
   * and the pause button take a click at all during a tight sweep.
   */
  gate(): Promise<void>;
  /** Mark the task finished. Safe to call twice; a stale handle is ignored. */
  end(note?: string): void;
}

/** One line of the run log — what the ⋯ button behind the status bar shows. */
export interface ActivityLogEntry {
  readonly seq: number;
  /** Epoch ms. Formatted at render time so the store stays locale-free. */
  readonly at: number;
  readonly kind: 'start' | 'done' | 'error' | 'info';
  readonly message: string;
}

/**
 * Why a log exists at all.
 *
 * The status bar carries ONE line, and that line is overwritten by the next thing that
 * happens — so the outcome of a sweep ("Suggested 7/11 groups · 2 unresolved (L2
 * Spandrels) — …") lived exactly as long as it took the user to start something else,
 * and the strip had to be wide enough to hold a sentence nobody had time to read. The
 * log is where that sentence goes instead: the bar shows PROGRESS, the log shows WHAT
 * HAPPENED, and neither has to be both.
 *
 * Capped rather than unbounded. A session that runs a hundred sweeps does not need the
 * first one, and an ever-growing array behind a component that re-renders on every
 * progress tick is a leak with a UI attached.
 */
const LOG_CAP = 200;
let log: readonly ActivityLogEntry[] = Object.freeze([]);
let nextSeq = 1;

function pushLog(kind: ActivityLogEntry['kind'], message: string): void {
  const text = (message ?? '').trim();
  if (!text) return;
  const entry: ActivityLogEntry = Object.freeze({ seq: nextSeq++, at: Date.now(), kind, message: text });
  const next = [...log, entry];
  log = Object.freeze(next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next);
  for (const fn of listeners) fn();
}

/** Record something worth remembering. Callers use this for outcomes the bar cannot hold. */
export function logActivity(message: string, kind: ActivityLogEntry['kind'] = 'info'): void {
  pushLog(kind, message);
}

/** Newest last — the order it happened in, which is the order it reads in. */
export function getActivityLog(): readonly ActivityLogEntry[] {
  return log;
}

/** Non-DOM snapshot, stable by reference so `useSyncExternalStore` does not thrash. */
const EMPTY_LOG: readonly ActivityLogEntry[] = Object.freeze([]);
export function getActivityLogServerSnapshot(): readonly ActivityLogEntry[] {
  return EMPTY_LOG;
}

export function clearActivityLog(): void {
  log = Object.freeze([]);
  for (const fn of listeners) fn();
}

/**
 * Route uncaught errors and rejected promises into the log.
 *
 * The alternative was a `logActivity` call at every catch site in the app, which is both
 * a large edit and one that goes stale the moment someone adds a new one. A window-level
 * listener catches what actually reaches the user as a broken screen, including the
 * failures nobody wrote a handler for. Idempotent: safe to call from a component that
 * may mount more than once.
 */
let errorsCaptured = false;
export function captureGlobalErrors(): void {
  if (errorsCaptured || typeof window === 'undefined') return;
  errorsCaptured = true;
  window.addEventListener('error', e => {
    pushLog('error', e.message || String((e as ErrorEvent).error ?? 'Unknown error'));
  });
  window.addEventListener('unhandledrejection', e => {
    const r = (e as PromiseRejectionEvent).reason;
    pushLog('error', r instanceof Error ? r.message : String(r));
  });
}

const IDLE: ActivitySnapshot = Object.freeze({
  id: 0, label: '', done: 0, total: 0, pausable: false, paused: false, finished: true,
});

let snapshot: ActivitySnapshot = IDLE;
let nextId = 1;
/** Resolvers waiting on `gate()` while paused, drained by resume(). */
let waiters: (() => void)[] = [];
const listeners = new Set<() => void>();

function emit(next: ActivitySnapshot): void {
  snapshot = Object.freeze(next);
  for (const fn of listeners) fn();
}

export function subscribeActivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getActivity(): ActivitySnapshot {
  return snapshot;
}

/** Server-render / non-DOM snapshot. The bar has nothing to say before hydration. */
export function getActivityServerSnapshot(): ActivitySnapshot {
  return IDLE;
}

/**
 * Start a task and take its handle. Replaces whatever was showing — see the file note
 * on why there is no queue. Starting a task always clears any inherited pause, so a job
 * cannot begin life already halted by the previous one's switch.
 */
export function beginActivity(opts: {
  label: string;
  total?: number;
  pausable?: boolean;
}): ActivityHandle {
  const id = nextId++;
  // A new task cancels the old one's pause; anything still waiting on the old gate is
  // released so its driver can unwind rather than hang forever.
  const stale = waiters;
  waiters = [];
  for (const w of stale) w();

  emit({
    id,
    label: opts.label,
    done: 0,
    total: Math.max(0, opts.total ?? 0),
    pausable: !!opts.pausable,
    paused: false,
    finished: false,
  });
  pushLog('start', opts.label);

  const isCurrent = () => snapshot.id === id && !snapshot.finished;

  return {
    id,
    update(patch) {
      if (!isCurrent()) return;
      emit({
        ...snapshot,
        done: patch.done ?? snapshot.done,
        total: patch.total ?? snapshot.total,
        label: patch.label ?? snapshot.label,
      });
    },
    gate() {
      // Always hand the thread back, paused or not: without this a `for` loop that
      // awaits a resolved promise still starves paint, and the bar would only ever
      // update after the sweep it is meant to be narrating had finished.
      if (!isCurrent() || !snapshot.paused) {
        return new Promise<void>(resolve => { setTimeout(resolve, 0); });
      }
      return new Promise<void>(resolve => { waiters.push(resolve); });
    },
    end(note) {
      if (snapshot.id !== id) return;
      const drain = waiters;
      waiters = [];
      for (const w of drain) w();
      emit({
        ...snapshot,
        label: note ?? snapshot.label,
        paused: false,
        finished: true,
        done: snapshot.total > 0 ? snapshot.total : snapshot.done,
      });
      // The outcome is the half worth keeping — it names what was resolved and what
      // was not, and it is exactly the line the bar used to throw away.
      if (note) pushLog('done', note);
    },
  };
}

/** Pause the current task, if it is pausable and still running. */
export function pauseActivity(): void {
  if (!snapshot.pausable || snapshot.finished || snapshot.paused) return;
  emit({ ...snapshot, paused: true });
}

/** Resume, releasing every driver waiting on `gate()`. */
export function resumeActivity(): void {
  if (!snapshot.paused) return;
  const drain = waiters;
  waiters = [];
  emit({ ...snapshot, paused: false });
  for (const w of drain) w();
}

/** What the status bar's click does. */
export function toggleActivity(): void {
  if (snapshot.paused) resumeActivity();
  else pauseActivity();
}

/**
 * Publish a task that reports but cannot be paused — a spawned sidecar, a COM call.
 * Returns a setter for the message and an `end`. Kept separate from `beginActivity` so
 * a caller has to say out loud that its work is not pausable.
 */
export function beginIndeterminate(label: string): { set(label: string): void; end(note?: string): void } {
  const h = beginActivity({ label, total: 0, pausable: false });
  return {
    set: (next: string) => h.update({ label: next }),
    end: (note?: string) => h.end(note),
  };
}

/** Test seam — drop all state between cases. */
export function resetActivity(): void {
  waiters = [];
  nextId = 1;
  snapshot = IDLE;
  log = Object.freeze([]);
  nextSeq = 1;
  for (const fn of listeners) fn();
}
