// The demo's server. Used two ways: `npm run serve` runs it standalone for the browser,
// and the Electron shell imports startServer() so the desktop build is not running a
// second, subtly-different copy.
//
// It exists for a reason beyond "serving files": the panels talk to their detached
// windows over a BroadcastChannel, and that only reaches windows of the SAME ORIGIN. A
// page opened from file:// gets an opaque origin, so the channel connects to nothing and
// every detached panel sits on "Loading…" for ever. http://127.0.0.1 is a real origin,
// which is all the popout system needs — in the browser as much as in Electron.
//
// It also watches the bundle and pushes a reload, so `npm run dev` in one terminal and
// this in another is a live edit loop.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.map': 'application/json',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json',
}

/**
 * Start the static server.
 * @param {number} port 0 lets the OS pick a free one — what Electron wants, so two
 *   runs of the desktop shell cannot collide on a fixed port.
 * @returns {Promise<number>} the port actually bound
 */
export function startServer(port = 0) {
  const clients = new Set()

  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0])

    // Live reload: the page holds this open and reloads when the bundle changes.
    if (url === '/__reload') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      })
      res.write('retry: 1000\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '')
    const file = path.join(ROOT, rel)
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return }  // never escape the demo dir

    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',   // a demo you are actively editing must never cache
      })
      res.end(buf)
    })
  })

  // Debounced: esbuild writes the bundle, its CSS and two sourcemaps, which is four
  // events for one build — and a mid-write read would serve a truncated file.
  let timer = null
  try {
    fs.watch(path.join(ROOT, 'dist'), () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        for (const c of clients) { try { c.write('data: reload\n\n') } catch { /* client went away */ } }
      }, 120)
    })
  } catch { /* dist/ not built yet — run `npm run build` first */ }

  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
}

// Standalone: `node server.mjs`. Skipped when Electron imports startServer().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = await startServer(Number(process.env.PORT || 5174))
  console.log(`\n  S-Dash beam demo → http://127.0.0.1:${port}\n`)
  console.log('  Detach a panel with the ⧉ in its header — it opens as its own window.')
  console.log('  (Browser: allow pop-ups for 127.0.0.1. Desktop: `npm run desktop` gives real OS windows.)\n')
}
