/**
 * ETABS bridge — runs in the Electron MAIN process (Windows only).
 *
 * Spawns the bundled .NET sidecar (EtabsHelper.exe), which attaches to the
 * running ETABS instance through the .NET API (ETABSv1.dll loaded by
 * reflection — no COM registration needed) and serves ETABS database tables.
 *
 * Protocol with the sidecar: one JSON object per line on stdin/stdout,
 * correlated by id: {id, method, params} → {id, result | error}.
 *
 * IPC surface (renderer → 'etabs' channel): connect | getTable | disconnect.
 * Table → app-model mapping lives in the renderer (tableConnection.ts).
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let helperProc = null;
let nextId = 1;
const pending = new Map(); // id → {resolve, reject}
let stdoutBuf = '';

function helperPath() {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'etabs-helper', 'EtabsHelper.exe');
    if (fs.existsSync(packaged)) return packaged;
  }
  // Dev fallback: dotnet publish output in the repo
  const dev = path.join(
    __dirname, '..', 'build-helper', 'EtabsHelper.exe',
  );
  if (fs.existsSync(dev)) return dev;
  return null;
}

function ensureHelper() {
  if (helperProc && helperProc.exitCode === null) return helperProc;

  if (process.platform !== 'win32') {
    throw new Error(
      'Live ETABS connection is only available in the Windows desktop app. ' +
      'Use the sample model to explore the workflow.'
    );
  }
  const exe = helperPath();
  if (!exe) {
    throw new Error(
      'The ETABS helper (EtabsHelper.exe) is missing from this build. ' +
      'Reinstall the app from a current build' +
      (process.resourcesPath ? '' : ', or run "npm run build:helper" in development') + '.'
    );
  }

  helperProc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  stdoutBuf = '';

  helperProc.stdout.setEncoding('utf8');
  helperProc.stdout.on('data', chunk => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      pending.delete(msg.id);
      if (msg.error !== undefined) waiter.reject(new Error(String(msg.error)));
      else waiter.resolve(msg.result);
    }
  });

  helperProc.stderr.setEncoding('utf8');
  helperProc.stderr.on('data', d => console.error('[EtabsHelper]', String(d).trim()));

  helperProc.on('exit', code => {
    for (const { reject } of pending.values()) {
      reject(new Error(
        `The ETABS helper exited unexpectedly (code ${code}). ` +
        'Make sure the .NET 6 (or later) runtime is installed — it ships with ETABS 21+.'
      ));
    }
    pending.clear();
    helperProc = null;
  });

  return helperProc;
}

function call(method, params, timeoutMs = 120000) {
  const proc = ensureHelper();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`ETABS helper request "${method}" timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject: e => { clearTimeout(timer); reject(e); },
    });
    proc.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + '\n');
  });
}

function killHelper() {
  if (helperProc && helperProc.exitCode === null) {
    try { helperProc.kill(); } catch { /* already gone */ }
  }
  helperProc = null;
}

const handlers = {
  connect: () => call('connect'),
  getUnits: () => call('getUnits'),
  // Large models can take minutes to serialize a force table — give table
  // fetches a 10-minute budget instead of the default 2 minutes.
  getTable: ({ key, group }) => call('getTable', { key, group: group ?? '' }, 600000),
  selectCombos: ({ combos }) => call('selectCombos', { combos: combos ?? [] }),
  disconnect: async () => {
    try { await call('disconnect', {}, 5000); } catch { /* best effort */ }
    killHelper();
    return true;
  },
};

/** Register the single 'etabs' IPC channel. */
function registerEtabsBridge(ipcMain) {
  ipcMain.handle('etabs', async (_event, { method, args }) => {
    const fn = handlers[method];
    if (!fn) throw new Error(`Unknown ETABS bridge method: ${method}`);
    return fn(args ?? {});
  });
}

module.exports = { registerEtabsBridge, killHelper };
