/**
 * Electron main-process bridge for the S-Concrete batch workflow.
 *
 * Writes the .SCO files the renderer generated into an output folder, then drives
 * S-Concrete's BatchReporter through the bundled native sidecar
 * (SConcreteHelper.exe — Windows UI Automation, NO Python / pywinauto), and reads
 * the resulting SConcreteResults.SCRS back for the renderer to parse.
 *
 * The sidecar replaced the old `python run_batch_reporter.py …` shell-out, so the
 * user no longer configures a Python interpreter or a script path — only an output
 * folder. S-Concrete (S-FRAME Product Suite) must still be installed; the sidecar
 * auto-detects it under C:\Program Files (x86)\S-FRAME Software\.
 *
 * Run modes:
 *   • `run`   — write the app-generated .SCO files into <outDir>, then report.
 *   • `rerun` — DON'T write anything; report on the .SCO files already in <outDir>
 *               (the "tweak a .SCO by hand, then re-run" loop — edits preserved).
 *   • `detect`— report whether S-Concrete/BatchReporter is installed.
 *
 * Windows + S-Concrete only; elsewhere the run rejects with a clear message.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCRS_NAME = 'SConcreteResults.SCRS';
const BATCH_TIMEOUT_MS = 1_800_000; // 30 min — matches the sidecar's batch budget

/** Locate the bundled sidecar (packaged resources first, dev publish fallback). */
function helperPath() {
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'sconcrete-helper', 'SConcreteHelper.exe');
    if (fs.existsSync(packaged)) return packaged;
  }
  const dev = path.join(__dirname, '..', 'build-helper-sconcrete', 'SConcreteHelper.exe');
  if (fs.existsSync(dev)) return dev;
  return null;
}

function writeScoFiles(outDir, files) {
  if (!outDir) throw new Error('outDir is required');
  fs.mkdirSync(outDir, { recursive: true });
  let count = 0;
  for (const f of files || []) {
    if (!f || !f.fileName) continue;
    fs.writeFileSync(path.join(outDir, f.fileName), f.text ?? '', 'utf8');
    count += 1;
  }
  return count;
}

/** Count the .SCO files already present in a folder (case-insensitive). */
function countScoFiles(outDir) {
  return fs.readdirSync(outDir).filter((f) => /\.sco$/i.test(f)).length;
}

function requireHelper() {
  if (process.platform !== 'win32') {
    throw new Error(
      'The S-Concrete batch runner is only available in the Windows desktop app with S-Concrete installed.',
    );
  }
  const exe = helperPath();
  if (!exe) {
    throw new Error(
      'The S-Concrete helper (SConcreteHelper.exe) is missing from this build. Reinstall the app from a current build' +
      (process.resourcesPath ? '' : ', or run "npm run build:helper" in development') + '.',
    );
  }
  return exe;
}

/**
 * Spawn the sidecar and resolve with { exitCode, json, stderr }. The sidecar
 * prints progress on stderr and a single JSON summary line on stdout.
 */
function spawnHelper(exe, args, timeoutMs, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let errLine = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => {
      stderr += d;
      // Forward each complete stderr line as a live progress update.
      if (!onProgress) return;
      errLine += d;
      let nl;
      while ((nl = errLine.indexOf('\n')) >= 0) {
        const line = errLine.slice(0, nl).trim();
        errLine = errLine.slice(nl + 1);
        if (line) { try { onProgress(line); } catch { /* ignore */ } }
      }
    });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      reject(new Error('S-Concrete BatchReporter timed out.'));
    }, timeoutMs || BATCH_TIMEOUT_MS);
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(
        `Could not start SConcreteHelper.exe: ${e.message}. ` +
        'If a runtime is reported missing, install the free .NET Desktop Runtime 6 (x64).',
      ));
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      // The last parseable stdout line is the JSON result.
      const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      let json = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { json = JSON.parse(lines[i]); break; } catch { /* not JSON */ }
      }
      resolve({ exitCode: code, json, stderr: stderr.slice(-4000) });
    });
  });
}

/** Is S-Concrete / BatchReporter installed? (drives the UI's availability hint). */
async function detect() {
  if (process.platform !== 'win32') return { found: false, reason: 'not-windows' };
  const exe = helperPath();
  if (!exe) return { found: false, reason: 'helper-missing' };
  try {
    const r = await spawnHelper(exe, ['--detect'], 30000);
    if (r.json && r.json.found) return { found: true, reporter: r.json.reporter, sconcrete: r.json.sconcrete };
    return { found: false, reason: 'sconcrete-not-installed' };
  } catch (e) {
    return { found: false, reason: e.message };
  }
}

/** Drive BatchReporter over <outDir> and read the .SCRS back. */
async function driveBatch(scoCount, { outDir, title, engineer, makePdf }, onProgress) {
  const exe = requireHelper();
  const args = [outDir, '--title', title || 'S-Concrete Batch', '--engineer', engineer || ''];
  // PDF is OPT-IN: the .SCRS carries all the results the app reads, and generating
  // the full BatchReporter PDF is slow (it renders every section and the sidecar
  // waits up to ReportTimeout for it). Only make it when explicitly requested.
  if (makePdf !== true) args.push('--no-pdf');
  const r = await spawnHelper(exe, args, BATCH_TIMEOUT_MS, onProgress);
  if (!r.json || !r.json.ok) {
    const why = (r.json && r.json.error) || r.stderr || `exit code ${r.exitCode}`;
    throw new Error(`S-Concrete batch did not complete: ${why}`);
  }
  const scrsPath = path.join(outDir, SCRS_NAME);
  let scrsText = null;
  try { scrsText = fs.readFileSync(scrsPath, 'utf8'); } catch { /* missing if the run produced nothing */ }
  return { exitCode: r.exitCode, scoCount, scrsPath, scrsText, stderr: r.stderr, pdf: r.json.pdf || '', status: r.json.status || '' };
}

/** Write the app's .SCO files, then run the reporter. */
async function runBatch(args, onProgress) {
  const { outDir, files } = args || {};
  if (!outDir) throw new Error('outDir is required');
  if (onProgress) onProgress(`Writing ${(files || []).length} .SCO file(s)…`);
  const scoCount = writeScoFiles(outDir, files);
  return driveBatch(scoCount, args, onProgress);
}

/** Re-run on the .SCO files ALREADY in <outDir> — no writing, so manual edits survive. */
async function rerunBatch(args, onProgress) {
  const { outDir } = args || {};
  if (!outDir) throw new Error('outDir is required');
  let scoCount;
  try {
    scoCount = countScoFiles(outDir);
  } catch (e) {
    throw new Error(`Cannot read the output folder "${outDir}": ${e.message}`);
  }
  if (!scoCount) {
    throw new Error(`No .SCO files found in "${outDir}". Generate or place .SCO files there first.`);
  }
  return driveBatch(scoCount, args, onProgress);
}

function registerSconcreteBridge(ipcMain) {
  ipcMain.handle('sconcrete', async (event, { method, args }) => {
    // Live progress: forward each sidecar stderr line to the renderer.
    const onProgress = (line) => { try { event.sender.send('sconcrete-progress', line); } catch { /* window gone */ } };
    const a = args ?? {};
    switch (method) {
      case 'generate': return { outDir: a.outDir, scoCount: writeScoFiles(a.outDir, a.files) };
      case 'run': return runBatch(a, onProgress);
      case 'rerun': return rerunBatch(a, onProgress);
      case 'detect': return detect();
      case 'readScrs': return { scrsText: fs.readFileSync(a.scrsPath, 'utf8') };
      default: throw new Error(`Unknown sconcrete method: ${method}`);
    }
  });
}

module.exports = { registerSconcreteBridge };
