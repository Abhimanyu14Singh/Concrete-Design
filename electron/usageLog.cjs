/**
 * Usage log — the app's flight recorder, and the only thing that survives a session.
 *
 * WHY THIS EXISTS. The app is installed on other people's machines, and the two parts
 * most likely to fail there are the two we cannot reproduce here: the ETABS sidecar
 * (their ETABS build, their .NET runtime) and the S-Concrete batch (their install, their
 * paths). "The import did nothing" is not a bug report. A timestamped record of what was
 * clicked, what it called, how long it took and what came back, is.
 *
 * WHAT IT IS NOT. It is not analytics and it never touches the network. Records are
 * appended to a JSONL file under the user's own profile, and they leave the machine only
 * when the user picks Help -> Export usage data and sends the file deliberately. There is
 * no endpoint to configure, so there is nothing to be blocked by a corporate firewall and
 * nothing to review before an install.
 *
 * WHAT IT MUST NEVER CONTAIN. Structural models are client-confidential. No project
 * content, no geometry, no forces, no member or file names. IPC arguments are dropped by
 * DEFAULT and a channel discloses fields only by naming them in `DESCRIBERS` below --
 * disclosure is opt-in, so a handler added later leaks nothing until someone decides what
 * is safe to say about it. Everything that does get through is run past `scrub()`, which
 * strips paths (a path holds a client's name as surely as the project does) and e-mail
 * addresses.
 *
 * SHAPE. One JSON object per line, one file per day:
 *   {"t":"2026-08-27T...","sid":"...","seq":7,"src":"main","lvl":"info","ev":"ipc","p":{...}}
 * `session.start` carries the install id, versions and machine; every later line carries
 * only the session id, because the file is read back as a stream and the constants only
 * need saying once.
 *
 * BUDGETS. A recorder that fills someone's disk or slows the app it watches has done more
 * harm than the bug it was there to catch. Writes are buffered and flushed on a timer,
 * errors flush at once (the session that crashes is the one worth having), each event
 * name is capped per session, each file is capped, and old files are deleted.
 */

const { app, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// -- Budgets -----------------------------------------------------------------
const FLUSH_MS         = 1500;          // buffered writes; errors bypass this
const BUFFER_LIMIT     = 64;            // flush early once this many are queued
const MAX_FILE_BYTES   = 8  * 1024 * 1024;
const MAX_TOTAL_BYTES  = 24 * 1024 * 1024;
const MAX_DAYS         = 30;
const MAX_PER_EVENT    = 500;           // per event NAME, per session
const MAX_PER_SESSION  = 20000;         // absolute ceiling on one session
const MAX_EVENT_BYTES  = 8000;          // one record; bigger loses its props
const MAX_STRING       = 300;
const MAX_KEYS         = 32;
const MAX_DEPTH        = 4;

// -- Module state ------------------------------------------------------------
let state = null;                       // { installId, consent, firstSeen, sessions }
let sessionId = null;
let seq = 0;
let buffer = [];
let flushTimer = null;
const counts = new Map();               // event name -> emitted this session
let sessionTotal = 0;
let retentionDone = false;
let startedAt = 0;
let dirtyState = false;
let errorBoxes = 0;

/** Home directory, resolved once -- `scrub` replaces it before anything else. */
const HOME = (() => { try { return os.homedir(); } catch { return ''; } })();

// -- Paths -------------------------------------------------------------------
// Resolved lazily: `instrumentIpc` runs at module load, BEFORE app.whenReady, and
// touching userData that early is not worth the risk. Nothing needs a real directory
// until the first flush.

function logDir() {
  return path.join(app.getPath('userData'), 'usage');
}

function ensureDir() {
  const dir = logDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stateFile() {
  return path.join(logDir(), 'state.json');
}

/** `usage-YYYY-MM-DD.jsonl` -- one file per calendar day, in local time. */
function todayFile() {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
  return path.join(logDir(), `usage-${stamp}.jsonl`);
}

/** Every retained log file, oldest first. */
function logFiles() {
  try {
    return fs.readdirSync(logDir())
      .filter(f => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .map(f => path.join(logDir(), f));
  } catch {
    return [];
  }
}

// -- Persistent state (install id + consent) ---------------------------------

/**
 * The install id is a random opaque token, not a machine fingerprint.
 *
 * It exists so several exported files can be recognised as coming from the same install
 * -- "the same person hitting the same wall on Tuesday and again on Thursday" -- and it
 * is deliberately NOT derived from the hostname, the MAC address or the user name, so it
 * carries no identity of its own and resetting it is just deleting a file.
 */
function loadState() {
  if (state) return state;
  let stored = null;
  try { stored = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { /* first run */ }
  state = {
    installId: (stored && typeof stored.installId === 'string' && stored.installId) || crypto.randomUUID(),
    consent:   stored && typeof stored.consent === 'boolean' ? stored.consent : true,
    firstSeen: (stored && stored.firstSeen) || new Date().toISOString(),
    sessions:  (stored && Number.isFinite(stored.sessions)) ? stored.sessions : 0,
  };
  if (!stored) dirtyState = true;
  return state;
}

function saveState() {
  if (!state) return;
  try {
    ensureDir();
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
    dirtyState = false;
  } catch { /* a recorder that throws is worse than one that forgets */ }
}

function isEnabled() {
  return loadState().consent !== false;
}

/** Turning it OFF also stops the session mid-flight; turning it ON re-announces one. */
function setConsent(next) {
  const on = next !== false;
  const s = loadState();
  if (s.consent === on) return { consent: on };
  if (!on) {
    logEvent('consent.off', {});
    flushSync();
    s.consent = false;
    saveState();
    buffer = [];
    return { consent: false };
  }
  s.consent = true;
  saveState();
  writeSessionStart('consent');
  return { consent: true };
}

// -- Redaction ---------------------------------------------------------------

function extOf(p) {
  const m = /(\.[A-Za-z0-9]{1,8})$/.exec(p);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Path patterns, built rather than written literally, because the escaping defeats
 * reading them and the three variants must not drift apart.
 *
 * SPACES ARE THE WHOLE PROBLEM. Windows paths are full of them — `Program Files`,
 * `S-Concrete Batches`, and above all client directories like `Acme Tower` — so a pattern
 * built on `\S` stops at the first space and leaves the rest of the path sitting in the
 * message. That is not a cosmetic miss: `C:\Jobs\Acme Tower\Phase 2\model.edb` redacted
 * to `<path> Tower\Phase 2\model.edb` has published the client's name.
 *
 * So segments admit spaces. The catch is the LAST one, which is where a path meets the
 * sentence around it: greedy matching there turns "open C:\a\b.edb because it is locked"
 * into one enormous path. The tail therefore accepts either a spaced filename that ends
 * in an extension (`my model.edb`) or a single unspaced token — and prose, which is
 * neither, is left alone.
 */
const SEG    = '[^\\\\/:*?"<>|\\r\\n]';       // legal inside a segment, spaces included
const SEG_NS = '[^\\s\\\\/:*?"<>|\\r\\n]';    // the same, minus spaces
const DIRS   = `(?:${SEG}+[\\\\/])*`;
const TAIL   = `(?:${SEG_NS}+(?: ${SEG_NS}+)*\\.[A-Za-z0-9]{1,8}|${SEG_NS}*)`;

const RE_UNC   = new RegExp(`\\\\\\\\${DIRS}${TAIL}`, 'g');
const RE_HOME  = new RegExp(`~[\\\\/]${DIRS}${TAIL}`, 'g');
const RE_DRIVE = new RegExp(`[A-Za-z]:[\\\\/]${DIRS}${TAIL}`, 'g');
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g;

/**
 * Strip anything that could name a person, a client or a job from free text.
 *
 * Paths are the real hazard: `C:\Jobs\Acme Tower\Phase 2\model.edb` gives away the client,
 * the project and the stage in one string, and paths turn up unbidden inside exception
 * messages from every layer of the stack. What survives is the SHAPE -- that it was a path
 * and what kind of file it pointed at -- which is what a diagnosis actually needs
 * ("`<path.edb>` not found" is as useful as the original and tells us nothing private).
 *
 * Order matters. Home first, so a user directory becomes `~` and cannot then be read as a
 * bare drive path; UNC before drive letters, because `\\server\share` is not `C:\`.
 */
function scrub(text) {
  if (typeof text !== 'string' || !text) return text;
  let s = text;
  if (HOME) {
    // Case-insensitively: Windows hands the same directory back either way.
    for (;;) {
      const i = s.toLowerCase().indexOf(HOME.toLowerCase());
      if (i < 0) break;
      s = s.slice(0, i) + '~' + s.slice(i + HOME.length);
    }
  }
  s = s.replace(RE_UNC,   m => `<unc${extOf(m)}>`);
  s = s.replace(RE_HOME,  m => `<home${extOf(m)}>`);
  s = s.replace(RE_DRIVE, m => `<path${extOf(m)}>`);
  s = s.replace(RE_EMAIL, '<email>');
  return s;
}

/**
 * Where a path lives, without saying where it is.
 *
 * A failing S-Concrete run is a different problem depending on whether the output folder
 * sits under the user's profile, on a mapped network drive or inside Program Files --
 * permissions, latency and virtualisation all differ. That distinction is worth keeping;
 * the path itself is not.
 */
function pathShape(p) {
  if (typeof p !== 'string' || !p) return null;
  const lower = p.toLowerCase();
  let scope = 'other';
  if (/^\\\\/.test(p)) scope = 'unc';
  else if (HOME && lower.startsWith(HOME.toLowerCase())) scope = 'home';
  else if (/^[a-z]:\\program files/i.test(p)) scope = 'programfiles';
  else if (/^[a-z]:\\windows/i.test(p)) scope = 'windows';
  else if (/^[a-z]:/i.test(p)) scope = 'drive';
  return { scope, ext: extOf(p) || null, depth: p.split(/[\\/]+/).filter(Boolean).length };
}

/** Depth-, width- and length-capped copy of a props object, with every string scrubbed. */
function sanitize(value, depth) {
  const d = depth || 0;
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? value : String(value);
  if (t === 'boolean') return value;
  if (t === 'bigint') return Number(value);
  if (t === 'string') {
    const s = scrub(value);
    return s.length > MAX_STRING ? s.slice(0, MAX_STRING) + '\u2026' : s;
  }
  if (d >= MAX_DEPTH) return '<deep>';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_KEYS).map(v => sanitize(v, d + 1));
    if (value.length > MAX_KEYS) out.push(`<+${value.length - MAX_KEYS} more>`);
    return out;
  }
  if (t === 'object') {
    const out = {};
    let n = 0;
    for (const k of Object.keys(value)) {
      if (n++ >= MAX_KEYS) { out._truncated = true; break; }
      out[k] = sanitize(value[k], d + 1);
    }
    return out;
  }
  return `<${t}>`;
}

/** First few frames of a stack, scrubbed -- enough to locate a throw, not a whole trace. */
function shortStack(err, frames) {
  const raw = err && err.stack ? String(err.stack) : '';
  if (!raw) return null;
  return scrub(raw.split('\n').slice(0, frames || 6).join('\n'));
}

// -- Writing -----------------------------------------------------------------

/**
 * Record one event. Never throws, never blocks on I/O, and silently does nothing when
 * the user has switched recording off.
 *
 * `level: 'error'` flushes immediately rather than waiting for the timer -- the session
 * that is about to die is precisely the one whose tail must reach the disk.
 */
function logEvent(name, props, opts) {
  try {
    if (!isEnabled()) return;
    if (sessionTotal >= MAX_PER_SESSION) return;

    const n = (counts.get(name) || 0) + 1;
    counts.set(name, n);
    if (n > MAX_PER_EVENT) {
      if (n === MAX_PER_EVENT + 1) {
        push(record('log.suppressed', { ev: name, after: MAX_PER_EVENT }, 'warn', 'main'));
      }
      return;
    }
    sessionTotal++;
    const level = (opts && opts.level) || 'info';
    push(record(name, props, level, (opts && opts.src) || 'main', opts && opts.at));
    if (level === 'error') flushSync();
  } catch { /* the recorder must never be the thing that breaks */ }
}

/**
 * `at` is when the event HAPPENED, which for a renderer event is not when it arrived.
 *
 * The renderer batches, so a queue flushed a second later would otherwise stamp six
 * events with one arrival time and compress a whole interaction into a single instant —
 * destroying exactly the timing the log exists to record, and making renderer events
 * impossible to line up against the main-process `ipc` lines around them. The renderer
 * therefore stamps each event as it is created and this end honours it, falling back to
 * now if the value is missing or implausible (a corrected system clock, mostly).
 */
function stampOf(at) {
  const now = Date.now();
  if (typeof at !== 'number' || !Number.isFinite(at)) return now;
  return Math.abs(now - at) > 86400000 ? now : at;
}

function record(name, props, level, src, at) {
  const when = stampOf(at);
  const line = {
    t: new Date(when).toISOString(),
    sid: sessionId,
    seq: ++seq,
    src: src || 'main',
    lvl: level || 'info',
    ev: name,
  };
  if (startedAt) line.ms = when - startedAt;
  const p = props && typeof props === 'object' ? sanitize(props, 0) : null;
  if (p && Object.keys(p).length) line.p = p;
  // A single oversized record would push every useful line out of the retention budget.
  if (JSON.stringify(line).length > MAX_EVENT_BYTES) {
    line.p = { _dropped: 'oversize' };
  }
  return line;
}

function push(line) {
  buffer.push(line);
  if (buffer.length >= BUFFER_LIMIT) { flushSync(); return; }
  if (!flushTimer) {
    flushTimer = setTimeout(flushSync, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();  // never hold the process open
  }
}

/** Append the buffer. Synchronous on purpose: this is also the crash path. */
function flushSync() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!buffer.length) { if (dirtyState) saveState(); return; }
  const lines = buffer;
  buffer = [];
  try {
    ensureDir();
    if (!retentionDone) { retentionDone = true; enforceRetention(); }
    const file = todayFile();
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* new file */ }
    if (size > MAX_FILE_BYTES) return;  // today is full; tomorrow gets a fresh file
    fs.appendFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    if (dirtyState) saveState();
  } catch { /* disk full, roaming profile offline, AV lock -- all survivable */ }
}

/** Delete by age, then by total size, oldest first. Today's file is never touched. */
function enforceRetention() {
  try {
    const keep = todayFile();
    const cutoff = Date.now() - MAX_DAYS * 86400000;
    const surviving = [];
    for (const f of logFiles()) {
      if (f === keep) { surviving.push(f); continue; }
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs < cutoff) { try { fs.unlinkSync(f); } catch { /* locked */ } continue; }
      surviving.push(f);
    }
    let total = 0;
    const sized = surviving.map(f => {
      let s = 0;
      try { s = fs.statSync(f).size; } catch { /* gone */ }
      total += s;
      return { f, s };
    });
    for (const { f, s } of sized) {
      if (total <= MAX_TOTAL_BYTES) break;
      if (f === keep) continue;
      try { fs.unlinkSync(f); total -= s; } catch { /* locked */ }
    }
  } catch { /* not worth a second attempt */ }
}

// -- Session -----------------------------------------------------------------

/**
 * The header record. Everything constant about this run lives here and nowhere else, so
 * the per-event lines stay small: versions (which build is this bug in?), the OS build,
 * the locale and the screen geometry (a 4K laptop at 250% scale is its own class of
 * layout bug), and how many sessions this install has had -- first run versus habit.
 */
function writeSessionStart(reason) {
  const s = loadState();
  const screens = (() => {
    try {
      const { screen } = require('electron');
      return screen.getAllDisplays().map(d => ({
        w: d.size.width, h: d.size.height, scale: d.scaleFactor,
      }));
    } catch { return null; }
  })();
  logEvent('session.start', {
    reason: reason || 'launch',
    installId: s.installId,
    session: s.sessions,
    firstSeen: s.firstSeen,
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    locale: (() => { try { return app.getLocale(); } catch { return null; } })(),
    cpus: (() => { try { return os.cpus().length; } catch { return null; } })(),
    memGB: Math.round(os.totalmem() / 1073741824),
    packaged: app.isPackaged,
    screens,
  });
}

/** Start recording. Called once, from `app.whenReady`. */
function beginSession() {
  const s = loadState();
  sessionId = crypto.randomUUID().slice(0, 8);
  startedAt = Date.now();
  s.sessions += 1;
  dirtyState = true;
  writeSessionStart('launch');
  captureProcessErrors();
  return sessionId;
}

/** Close the record with a duration, then flush synchronously -- quit will not wait. */
function endSession(reason) {
  if (!sessionId) return;
  logEvent('session.end', { reason: reason || 'quit', durationMs: Date.now() - startedAt });
  flushSync();
  saveState();
}

// -- Crash capture -----------------------------------------------------------

/**
 * Main-process failures.
 *
 * Installing a handler for `uncaughtException` SUPPRESSES Electron's own error box, which
 * would turn a visible crash into a silently half-dead app -- so the box is put back,
 * capped at three, because the alternative to one dialog is a hundred. The process is
 * deliberately left running: that is Electron's default and it is not this module's place
 * to change how the app behaves when it fails.
 */
let processErrorsCaptured = false;
function captureProcessErrors() {
  if (processErrorsCaptured) return;
  processErrorsCaptured = true;

  process.on('uncaughtException', err => {
    logEvent('main.uncaught', {
      message: scrub(err && err.message ? err.message : String(err)),
      name: err && err.name,
      stack: shortStack(err),
    }, { level: 'error' });
    console.error('[main] uncaught:', err);
    if (errorBoxes++ < 3) {
      try { dialog.showErrorBox('S-Dashboard', String((err && err.message) || err)); } catch { /* headless */ }
    }
  });

  process.on('unhandledRejection', reason => {
    const err = reason instanceof Error ? reason : null;
    logEvent('main.unhandled-rejection', {
      message: scrub(err ? err.message : String(reason)),
      stack: err ? shortStack(err) : null,
    }, { level: 'error' });
  });
}

/**
 * Renderer failures, per window.
 *
 * `render-process-gone` is the white-screen crash the user reports as "it just closed".
 * `unresponsive` is the frozen one -- worth separating, because a 40-second design sweep
 * that blocks the main thread looks identical to a hang from the outside and this is how
 * we tell which we are dealing with. Console errors are included because React logs
 * component failures there and never through `window.onerror`, and they are rate-limited
 * hard: a render loop that throws every frame would otherwise fill the file by itself.
 */
function attachWindow(win, role) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  const tag = role || 'main';

  wc.on('render-process-gone', (_e, details) => {
    logEvent('renderer.gone', {
      role: tag, reason: details && details.reason, exitCode: details && details.exitCode,
    }, { level: 'error' });
  });
  wc.on('unresponsive', () => logEvent('renderer.unresponsive', { role: tag }, { level: 'warn' }));
  wc.on('responsive', () => logEvent('renderer.responsive', { role: tag }));
  wc.on('did-fail-load', (_e, code, desc) => {
    logEvent('renderer.load-failed', { role: tag, code, desc: scrub(String(desc)) }, { level: 'error' });
  });
  wc.on('preload-error', (_e, preloadPath, err) => {
    logEvent('renderer.preload-error', {
      role: tag, message: scrub(err && err.message ? err.message : String(err)),
    }, { level: 'error' });
  });

  // Electron >= 37 passes a single event object; older builds pass positional args.
  // Both shapes are read so this keeps working across an Electron bump.
  wc.on('console-message', (...args) => {
    const e = args[0];
    const obj = e && typeof e === 'object' && 'message' in e ? e : null;
    const level = obj ? obj.level : args[1];
    const message = obj ? obj.message : args[2];
    const isError = level === 'error' || level === 3;
    if (!isError) return;
    logEvent('renderer.console-error', {
      role: tag,
      message: scrub(String(message || '')).slice(0, MAX_STRING),
      source: obj ? scrub(String(obj.sourceId || '')) : null,
      line: obj ? obj.lineNumber : args[3],
    }, { level: 'warn' });
  });
}

// -- IPC instrumentation -----------------------------------------------------

/**
 * Time and record EVERY `ipcMain.handle` channel by wrapping the registrar itself.
 *
 * The alternative -- a try/finally around each handler -- is a large edit that goes stale
 * the moment someone adds a channel, and the channels most worth watching (`etabs`,
 * `sconcrete`) live in bridge modules that should not have to know this file exists.
 * Wrapping the registration is one hook that covers all of them, including handlers added
 * later, and it is why `instrumentIpc` must run BEFORE any `handle` call.
 *
 * Arguments are NOT logged. `DESCRIBERS` is the whole disclosure surface: a channel says
 * what it is willing to reveal, and everything unlisted contributes nothing but a name, a
 * duration and an outcome.
 */
const SKIP_CHANNELS = new Set([
  'usage:event', 'usage:events', 'usage:state', 'usage:set-consent',
  'usage:export', 'usage:open-folder',
  'popout:bounds',   // polled at the start of every cross-window drag
  'path-exists',     // fires on every keystroke in the S-Concrete path fields
]);

const DESCRIBERS = {
  // The two bridges: the METHOD is the whole point (which call failed), the args are
  // model data and stay out.
  etabs:     a => ({ method: a && a[0] && a[0].method }),
  sconcrete: a => ({ method: a && a[0] && a[0].method }),
  // Size, not content: a 40 MB project that fails to save is a different bug from a 4 kB
  // one, and whether a path was supplied separates Save from Save As.
  'save-file': a => ({
    bytes: a && a[0] && typeof a[0].content === 'string' ? a[0].content.length : null,
    hadPath: !!(a && a[0] && a[0].filePath),
  }),
  'pick-path': a => ({ mode: a && a[0] && a[0].mode }),
  'open-path': a => ({ shape: pathShape(a && a[0] && a[0].target) }),
  'popout:open': a => ({ kind: a && a[0] }),
};

/** Handlers here report failure by returning a shape, not by throwing (see main.cjs). */
function outcomeOf(result) {
  if (!result || typeof result !== 'object') return { ok: true };
  if (result.error) return { ok: false, err: scrub(String(result.error)).slice(0, MAX_STRING) };
  if (result.success === false || result.ok === false) {
    return { ok: false, canceled: !!result.canceled };
  }
  return { ok: true };
}

function instrumentIpc(ipcMain) {
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (SKIP_CHANNELS.has(channel)) return original(channel, listener);
    return original(channel, async (event, ...args) => {
      const t0 = process.hrtime.bigint();
      const ms = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      let described = null;
      try { described = DESCRIBERS[channel] ? DESCRIBERS[channel](args) : null; } catch { /* never block the call */ }
      try {
        const result = await listener(event, ...args);
        const outcome = outcomeOf(result);
        logEvent('ipc', { ch: channel, ...described, ms: ms(), ...outcome },
          { level: outcome.ok ? 'info' : 'warn' });
        return result;
      } catch (err) {
        logEvent('ipc', {
          ch: channel, ...described, ms: ms(), ok: false, threw: true,
          err: scrub(err && err.message ? err.message : String(err)).slice(0, MAX_STRING),
        }, { level: 'error' });
        throw err;
      }
    });
  };
}

// -- Export ------------------------------------------------------------------

/**
 * Concatenate the retained files into one `.jsonl` the user can attach to an e-mail.
 *
 * One plain-text file rather than an archive, deliberately: it needs no tool to open, it
 * survives every mail gateway that strips `.zip`, and the person receiving it can read it
 * with `grep`. The manifest written at the top makes a partial file self-describing --
 * retention may have deleted the beginning of the story, and the reader should be told
 * that rather than left to infer it.
 */
async function exportBundle(win) {
  try {
    flushSync();
    const s = loadState();
    const files = logFiles();
    if (!files.length) return { ok: false, error: 'No usage data has been recorded yet.' };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultPath = path.join(
      app.getPath('desktop'),
      `s-dashboard-usage-${s.installId.slice(0, 8)}-${stamp}.jsonl`,
    );
    const res = await dialog.showSaveDialog(win || undefined, {
      title: 'Export usage data',
      defaultPath,
      filters: [{ name: 'Usage log (JSON lines)', extensions: ['jsonl'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };

    const manifest = {
      t: new Date().toISOString(),
      ev: 'export.manifest',
      src: 'main',
      p: {
        installId: s.installId,
        firstSeen: s.firstSeen,
        sessions: s.sessions,
        app: app.getVersion(),
        electron: process.versions.electron,
        platform: process.platform,
        osRelease: os.release(),
        files: files.map(f => path.basename(f)),
        retentionDays: MAX_DAYS,
        note: 'No project data, geometry, forces, member names or file paths are recorded.',
      },
    };

    const out = fs.createWriteStream(res.filePath, { encoding: 'utf8' });
    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.write(JSON.stringify(manifest) + '\n');
      for (const f of files) {
        try {
          let text = fs.readFileSync(f, 'utf8');
          if (text && !text.endsWith('\n')) text += '\n';
          out.write(text);
        } catch { /* a file locked mid-export is not worth failing the whole export */ }
      }
      out.end(resolve);
    });

    let bytes = 0, lines = 0;
    try {
      bytes = fs.statSync(res.filePath).size;
      lines = fs.readFileSync(res.filePath, 'utf8').split('\n').filter(Boolean).length;
    } catch { /* the file is written; the summary is a nicety */ }
    logEvent('usage.exported', { files: files.length, bytes, lines });
    return { ok: true, filePath: res.filePath, bytes, lines, files: files.length };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** What the Diagnostics panel shows: enough to prove the thing is on and bounded. */
function usageState() {
  const s = loadState();
  let bytes = 0;
  const files = logFiles();
  for (const f of files) {
    try { bytes += fs.statSync(f).size; } catch { /* gone */ }
  }
  return {
    consent: s.consent !== false,
    installId: s.installId,
    firstSeen: s.firstSeen,
    sessions: s.sessions,
    sessionId,
    events: sessionTotal,
    files: files.length,
    bytes,
    dir: logDir(),
    retentionDays: MAX_DAYS,
  };
}

/**
 * Register the renderer-facing surface.
 *
 * `usage:events` takes a BATCH. The renderer emits an event per click and per engine run;
 * one IPC round trip apiece would put a process hop in the middle of interactions this is
 * supposed to be measuring, so the renderer buffers and this end unpacks.
 */
function registerUsageLog(ipcMain) {
  ipcMain.handle('usage:events', (_e, batch) => {
    if (!Array.isArray(batch)) return { ok: false };
    for (const item of batch.slice(0, 200)) {
      if (!item || typeof item.ev !== 'string') continue;
      // `src` names the PROCESS and the window within it — `renderer:panel`, not `panel`.
      // The window role alone collided with the main process's own `main`, so a renderer
      // event from the main window and a real main-process event were indistinguishable
      // in the file, which is the one distinction the field exists to make.
      logEvent(item.ev, item.p, {
        level: item.lvl || 'info',
        src: item.src ? `renderer:${String(item.src).slice(0, 24)}` : 'renderer',
        at: item.ts,
      });
    }
    return { ok: true };
  });
  ipcMain.handle('usage:state', () => usageState());
  ipcMain.handle('usage:set-consent', (_e, on) => { setConsent(on); return usageState(); });
  ipcMain.handle('usage:export', async e => {
    const { BrowserWindow } = require('electron');
    return exportBundle(BrowserWindow.fromWebContents(e.sender) || undefined);
  });
  ipcMain.handle('usage:open-folder', async () => {
    try {
      ensureDir();
      const err = await shell.openPath(logDir());
      return err ? { ok: false, error: err } : { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

module.exports = {
  // lifecycle
  beginSession, endSession, registerUsageLog, instrumentIpc, attachWindow,
  // writing
  logEvent, flushSync,
  // state
  loadState, setConsent, isEnabled, usageState, exportBundle, logDir, logFiles,
  // pure helpers, exported for the tests
  scrub, sanitize, pathShape, shortStack, outcomeOf, stampOf,
};
