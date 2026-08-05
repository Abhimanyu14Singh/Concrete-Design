/**
 * One-command desktop dev loop: start the Vite dev server in-process, then launch
 * Electron against it. Closing the app (or Ctrl-C) stops both.
 *
 * Why a script rather than an npm one-liner: the two have to start in order —
 * Electron shows a blank window if it loads before Vite is listening — and the
 * usual `concurrently` + `wait-on` pair would add dependencies. Using Vite's Node
 * API means `listen()` resolves exactly when the server is ready, so there is no
 * polling and no race. It also resolves Electron's binary through Node instead of
 * the shell, so it behaves the same on Windows (cmd.exe), macOS and Linux.
 *
 *   npm run dev:desktop      # desktop app + hot reload
 *   npm run dev              # browser only (http://localhost:5173)
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);

// electron/main.cjs loads http://localhost:5173 in dev, so the port is not
// negotiable: strictPort makes a busy port a loud failure instead of letting Vite
// slide to 5174 and leaving Electron pointed at a dead URL.
const PORT = 5173;

let electron = null;
let server = null;
let shuttingDown = false;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electron && electron.exitCode === null && electron.signalCode === null) {
    // Windows has no POSIX signals; kill() maps to TerminateProcess there.
    try { electron.kill(); } catch { /* already gone */ }
  }
  if (server) {
    try { await server.close(); } catch { /* already closing */ }
  }
  process.exit(code);
}

process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });

// ── Vite ────────────────────────────────────────────────────────────────────
try {
  server = await createServer({ server: { port: PORT, strictPort: true } });
  await server.listen();
} catch (err) {
  const busy = err && (err.code === 'EADDRINUSE' || /in use|strictPort/i.test(String(err.message)));
  console.error(busy
    ? `\n✖ Port ${PORT} is already in use — another dev server is probably running.\n  Close it (or stop the other terminal) and try again.\n`
    : `\n✖ Could not start the Vite dev server: ${err?.message ?? err}\n`);
  process.exit(1);
}
server.printUrls();

// ── Electron ────────────────────────────────────────────────────────────────
let electronBin;
try {
  // The electron package's main export is the absolute path to its binary.
  electronBin = require('electron');
} catch {
  console.error('\n✖ Electron is not installed. Run `npm ci` first.\n');
  await shutdown(1);
}

console.log('\n▶ launching the desktop app…\n');
electron = spawn(electronBin, ['electron/main.cjs', '--dev'], { stdio: 'inherit' });

electron.on('error', (err) => {
  console.error(`\n✖ Failed to launch Electron: ${err.message}\n`);
  void shutdown(1);
});

// Closing the app window ends the session — stop Vite too, so no stray server
// is left holding port 5173.
electron.on('exit', (code) => {
  if (!shuttingDown) {
    console.log('\n■ app closed — stopping the dev server.');
    void shutdown(code ?? 0);
  }
});
