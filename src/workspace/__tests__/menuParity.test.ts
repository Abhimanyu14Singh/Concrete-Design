import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The app has TWO menu bars, and only one of them is visible at a time:
//
//   browser build  → the in-page <MenuBar> (WorkspaceView renders it when !window.electronAPI)
//   desktop build  → the NATIVE menu built in electron/main.cjs
//
// So a menu added to one of them exists in every host except the other — and the desktop
// one is the app people install. That is not hypothetical: 0.1.16 shipped a Preferences
// menu that was only ever added to the in-page bar, verified in the browser, and therefore
// completely absent from the installer.
//
// This is a SOURCE test rather than a behavioural one because the two definitions cannot
// meet at runtime: MENUS is local to the MenuBar component, and main.cjs runs in the
// Electron main process where there is no DOM to render into. Comparing the text is the
// only place the two can be checked against each other at all.
const read = (p: string) => readFileSync(resolve(__dirname, '../../..', p), 'utf8')

/** Top-level entries of the native template: `label:` at the template's own indent. */
const nativeMenus = (src: string) =>
  [...src.matchAll(/^ {6}label: '([^']+)',$/gm)].map(m => m[1])

/** Keys of the in-page MENUS map: `Name: () =>` at its own indent. */
const pageMenus = (src: string) =>
  [...src.matchAll(/^ {4}([A-Z][A-Za-z]*): \(\) =>/gm)].map(m => m[1])

describe('menu parity between the two hosts', () => {
  const native = nativeMenus(read('electron/main.cjs'))
  const page = pageMenus(read('src/workspace/MenuBar.jsx'))

  // Guard the guard. Both regexes lean on indentation, so a reformat could quietly match
  // nothing and turn the real assertion into a comparison of two empty arrays.
  it('finds both menu definitions', () => {
    expect(native.length).toBeGreaterThan(2)
    expect(page.length).toBeGreaterThan(2)
  })

  // Order too, not just membership: these are the same bar seen in two hosts, and
  // Preferences landing after Help in one of them is a difference the user would notice.
  it('offers the same top-level menus, in the same order', () => {
    expect(native).toEqual(page)
  })

  // The specific entry this test was written for.
  it('reaches the model-appearance dialog from the native menu', () => {
    const main = read('electron/main.cjs')
    expect(main).toMatch(/label: 'Preferences'/)
    expect(main).toMatch(/send\('open-preferences'\)/)
    // …and something on the other side has to be listening, or the menu item is a no-op.
    expect(read('electron/preload.cjs')).toMatch(/onOpenPreferences/)
    expect(read('src/workspace/WorkspaceView.jsx')).toMatch(/onOpenPreferences\(\(\) => setPrefsOpen\(true\)\)/)
  })
})
