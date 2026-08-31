// Bundle the demo. No install step: esbuild is borrowed from whichever node_modules
// in this repo already has it, and react/react-dom resolve up to the repo root — so
// the demo runs against the SAME React 19 the real app does.
//
// The point of bundling with esbuild rather than Vite is that the demo has to load
// real .ts/.tsx out of ../src (the engine, SectionView) with no type-check step and
// no config to keep in sync. esbuild transpiles TypeScript by stripping types, which
// is exactly what a demo wants: if the engine compiles for the app, it compiles here.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')

// Ordered by likelihood, not preference — any of them is the same compiler.
const CANDIDATES = ['esbuild', '../Template/node_modules/esbuild', '../node_modules/esbuild']
let esbuild = null
for (const id of CANDIDATES) {
  try { esbuild = require(id); break } catch { /* try the next one */ }
}
if (!esbuild) {
  console.error(
    'No esbuild found. Tried:\n  ' + CANDIDATES.join('\n  ') +
    '\nFix with:  cd demo && npm install',
  )
  process.exit(1)
}

fs.mkdirSync(path.join(HERE, 'dist'), { recursive: true })

// Inter, copied next to the bundle so demo.css can @font-face it. The real app gets
// Inter through @fontsource-variable/inter's own CSS + a bundler that understands
// .woff2; here one file and one rule is less machinery for the same result. Missing
// font is not fatal — the stack falls through to Segoe UI, which is half the toggle.
const INTER_SRC = path.join(REPO, 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')
const INTER_DST = path.join(HERE, 'dist/inter.woff2')
if (fs.existsSync(INTER_SRC)) {
  fs.copyFileSync(INTER_SRC, INTER_DST)
} else if (!fs.existsSync(INTER_DST)) {
  console.warn('Inter woff2 not found — the Inter half of the font toggle will fall back to Segoe UI.')
}

const watch = process.argv.includes('--watch')

// Vite's `?raw` import — `import tpl from './x.sco?raw'` gives the file as a string. The
// app uses it for the S-Concrete .SCO templates, and esbuild has neither the suffix nor a
// loader for the extension, so anything reaching scoWriter* fails the build with "No
// loader is configured for .sco". Teaching esbuild the same trick keeps ../src importable
// as-is rather than making the demo avoid whole modules.
const rawQuery = {
  name: 'vite-raw-query',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, args => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw',
    }))
    build.onLoad({ filter: /.*/, namespace: 'raw' }, async args => ({
      contents: await fs.promises.readFile(args.path, 'utf8'),
      loader: 'text',
    }))
  },
}

/** @type {import('esbuild').BuildOptions} */
const opts = {
  absWorkingDir: HERE,
  entryPoints: ['src/index.js'],
  bundle: true,
  outfile: 'dist/bundle.js',
  loader: { '.js': 'jsx' },     // the demo writes JSX in .js files, as the Template does
  jsx: 'automatic',
  format: 'iife',
  target: ['chrome120'],        // Electron 42 / any current browser
  // The @font-face url is a runtime path the server answers, not something to inline.
  // Without this esbuild tries to resolve /dist/inter.woff2 off disk and fails the build.
  external: ['/dist/*'],
  plugins: [rawQuery],
  sourcemap: true,
  keepNames: true,              // a stack trace names the function it threw in
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"development"',
    // ../src is Vite code and reads import.meta.env. esbuild's iife output has no
    // import.meta, so give it a literal. DEV:false keeps the "no <UnitsProvider>"
    // console warning quiet in panels that legitimately render outside one.
    // A define value has to be an identifier or valid JSON — hence the quoted keys.
    'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"production"}',
  },
}

if (watch) {
  const ctx = await esbuild.context(opts)
  await ctx.watch()
  console.log('watching src/ and ../src/ — edit anything and the bundle rebuilds')
} else {
  await esbuild.build(opts)
  console.log('built dist/bundle.js')
}
