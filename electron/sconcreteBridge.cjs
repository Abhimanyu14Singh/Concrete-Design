/**
 * Electron main-process bridge for the S-Concrete batch workflow (merged from
 * Column_Design_DW/callbacks_batch.py). Writes the .SCO files the renderer
 * generated, launches S-Concrete's BatchReporter, and returns the resulting
 * SConcreteResults.SCRS text for the renderer to parse (src/utils/sco/scrsParser).
 *
 * BatchReporter and its Python host are S-Concrete-install-specific paths
 * (the column repo hardcodes them), so they are passed in from app settings:
 *   python.exe  run_batch_reporter.py  <scoDir>  --title <t>  --engineer <e>
 * The batch writes <scoDir>/SConcreteResults.SCRS.
 *
 * This only runs on Windows with S-Concrete installed; elsewhere `run` rejects.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCRS_NAME = 'SConcreteResults.SCRS';

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

function runBatch(args) {
  const { outDir, files, pythonExe, batchReporter, title, engineer, timeoutMs } = args || {};
  return new Promise((resolve, reject) => {
    try {
      if (!pythonExe || !batchReporter) {
        throw new Error(
          'S-Concrete BatchReporter is not configured. Set the Python executable and ' +
          'run_batch_reporter.py paths in settings before running a batch.',
        );
      }
      const scoCount = writeScoFiles(outDir, files);
      const cliArgs = [
        batchReporter,
        outDir,
        '--title', title || 'S-Concrete Batch',
        '--engineer', engineer || '',
      ];
      const proc = spawn(pythonExe, cliArgs, { windowsHide: true });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('BatchReporter timed out'));
      }, timeoutMs || 600000);
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        const scrsPath = path.join(outDir, SCRS_NAME);
        let scrsText = null;
        try { scrsText = fs.readFileSync(scrsPath, 'utf8'); } catch { /* missing if the run failed */ }
        resolve({ exitCode: code, scoCount, scrsPath, scrsText, stderr: stderr.slice(0, 4000) });
      });
    } catch (e) {
      reject(e);
    }
  });
}

const handlers = {
  // Write .SCO files only (no run) — useful for "export .SCO files".
  generate: ({ outDir, files }) => ({ outDir, scoCount: writeScoFiles(outDir, files) }),
  // Write + launch BatchReporter + read the .SCRS report.
  run: (args) => runBatch(args),
  // Re-read an existing .SCRS (e.g. after the user ran S-Concrete manually).
  readScrs: ({ scrsPath }) => ({ scrsText: fs.readFileSync(scrsPath, 'utf8') }),
};

function registerSconcreteBridge(ipcMain) {
  ipcMain.handle('sconcrete', async (_event, { method, args }) => {
    const fn = handlers[method];
    if (!fn) throw new Error(`Unknown sconcrete method: ${method}`);
    return fn(args ?? {});
  });
}

module.exports = { registerSconcreteBridge };
