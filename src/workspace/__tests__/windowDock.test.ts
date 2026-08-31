/**
 * The multi-window docking model: panels moving between the workspace and any number of
 * detached windows, each of which is a container with its own column layout.
 *
 * The scenario that drove this feature is the last test: detach one panel, detach a
 * second, then dock the second INTO the first window.
 */
import { describe, it, expect } from 'vitest'
import {
  DOCK, windowIds, panelsInWindow, newWinId, windowLabel,
  movePanelToWindow, detachToNewWindow, closeWindowPanels, mergeWindows, prune, hitTestWindows, isWinOf,
} from '../windowDock.js'
import { needsPost } from '../usePopoutHost.js'
import { panelsOf } from '../dockLayout.js'
import type { DockLayout } from '../dockLayout'
import type { DockState, HostKind, WinId } from '../windowDock'

const base = (): DockState => ({
  hosts: { plan: 'dock', groups: 'dock', section: 'dock', calc: 'dock', loads: null },
  winOf: {},
  winDock: {},
  dock: { cols: [{ w: 1, items: [{ kind: 'plan', h: 0.5 }, { kind: 'groups', h: 0.5 }] },
                 { w: 1, items: [{ kind: 'section', h: 0.5 }, { kind: 'calc', h: 0.5 }] }] },
})

/** The layouts under test always exist by this point; `dock` is nullable in the model. */
const L = (l: DockLayout | null): DockLayout => l as DockLayout
const H = (h: Record<string, HostKind>) => h
const W = (w: Record<string, WinId>) => w

describe('window ids', () => {
  it('allocates w1, w2, … and reuses the first gap', () => {
    const hosts = H({ a: 'window', b: 'window', c: 'window' })
    const winOf = W({ a: 'w1', b: 'w2', c: 'w3' })
    expect(newWinId(hosts, winOf)).toBe('w4')
    expect(newWinId(H({ a: 'window', c: 'window' }), W({ a: 'w1', c: 'w3' }))).toBe('w2')
    expect(newWinId({}, {})).toBe('w1')
  })

  it('labels windows for the "Move to" menu', () => {
    expect(windowLabel(DOCK)).toBe('Workspace')
    expect(windowLabel('w2')).toBe('Window 2')
  })

  it('only counts windows that still hold a panel', () => {
    expect(windowIds(H({ a: 'window', b: 'dock' }), W({ a: 'w1', b: 'w2' }))).toEqual(['w1'])
  })
})

describe('moving panels between hosts', () => {
  it('detaches into a new window and takes the panel out of the dock layout', () => {
    const { state, winId } = detachToNewWindow(base(), 'calc')
    expect(winId).toBe('w1')
    expect(state.hosts.calc).toBe('window')
    expect(state.winOf.calc).toBe('w1')
    expect(panelsOf(L(state.dock))).not.toContain('calc')
    expect(panelsInWindow(state.hosts, state.winOf, 'w1')).toEqual(['calc'])
  })

  it('THE SCENARIO: a second detached panel docks into the first window', () => {
    // Detach Calc → w1. Detach Section → w2.
    let s = detachToNewWindow(base(), 'calc').state
    const second = detachToNewWindow(s, 'section')
    s = second.state
    expect(second.winId).toBe('w2')
    expect(windowIds(s.hosts, s.winOf)).toEqual(['w1', 'w2'])

    // Now drop Section onto w1, beside Calc as a new column.
    s = movePanelToWindow(s, 'section', 'w1', { type: 'newcol', ci: 1 })

    expect(s.winOf.section).toBe('w1')
    expect(panelsInWindow(s.hosts, s.winOf, 'w1').sort()).toEqual(['calc', 'section'])
    // w2 is emptied and its layout is gone — no orphan window left behind.
    expect(windowIds(s.hosts, s.winOf)).toEqual(['w1'])
    expect(s.winDock.w2).toBeUndefined()
    // Both panels live in w1's own column layout.
    expect(panelsOf(s.winDock.w1).sort()).toEqual(['calc', 'section'])
    expect(s.winDock.w1.cols.length).toBe(2)
  })

  it('places at the drop target inside the destination window', () => {
    let s = detachToNewWindow(base(), 'calc').state
    s = movePanelToWindow(s, 'section', 'w1', { type: 'in', ci: 0, ii: 0 })
    // Dropped ABOVE calc in the same column.
    expect(s.winDock.w1.cols[0].items.map((i: { kind: string }) => i.kind)).toEqual(['section', 'calc'])
  })

  it('moves a panel back to the workspace at a drop target', () => {
    let s = detachToNewWindow(base(), 'calc').state
    s = movePanelToWindow(s, 'calc', DOCK, { type: 'newcol', ci: 0 })
    expect(s.hosts.calc).toBe('dock')
    expect(s.winOf.calc).toBeUndefined()
    expect(L(s.dock).cols[0].items.map((i: { kind: string }) => i.kind)).toEqual(['calc'])
    expect(windowIds(s.hosts, s.winOf)).toEqual([])
  })

  it('a move with no target appends rather than failing', () => {
    let s = detachToNewWindow(base(), 'calc').state
    s = movePanelToWindow(s, 'section', 'w1')          // menu route: no drop point
    expect(panelsOf(s.winDock.w1).sort()).toEqual(['calc', 'section'])
  })

  it('dropping a panel back where it already is does not duplicate it', () => {
    let s = detachToNewWindow(base(), 'calc').state
    s = movePanelToWindow(s, 'calc', 'w1', { type: 'in', ci: 0, ii: 0 })
    expect(panelsOf(s.winDock.w1)).toEqual(['calc'])
  })
})

describe('prune keeps the model honest', () => {
  it('drops layouts for emptied windows', () => {
    const s = prune({
      hosts: H({ calc: 'dock' }), winOf: {}, winDock: { w1: { cols: [{ w: 1, items: [{ kind: 'calc', h: 1 }] }] } }, dock: null,
    })
    expect(s.winDock).toEqual({})
  })

  it('a panel can never be in two windows at once', () => {
    // w1's layout still names `calc`, but calc has moved to w2.
    const s = prune({
      hosts: H({ calc: 'window', loads: 'window' }), winOf: W({ calc: 'w2', loads: 'w1' }),
      winDock: {
        w1: { cols: [{ w: 1, items: [{ kind: 'loads', h: 0.5 }, { kind: 'calc', h: 0.5 }] }] },
        w2: { cols: [] },
      },
      dock: null,
    })
    expect(panelsOf(s.winDock.w1)).toEqual(['loads'])
    expect(panelsOf(s.winDock.w2)).toEqual(['calc'])
  })

  it('repairs a "window" host with no window id by docking it', () => {
    const s = prune({ hosts: H({ calc: 'window' }), winOf: {}, winDock: {}, dock: null })
    expect(s.hosts.calc).toBe('dock')
  })

  it('drops a stale window id from a panel that is no longer detached', () => {
    const s = prune({ hosts: H({ calc: 'dock' }), winOf: W({ calc: 'w1' }), winDock: {}, dock: null })
    expect(s.winOf.calc).toBeUndefined()
  })
})

describe('screen hit-testing for cross-window drag', () => {
  const list = [
    { id: DOCK, x: 0, y: 0, w: 1400, h: 900 },
    { id: 'w1', x: 1500, y: 100, w: 800, h: 600 },
    { id: 'w2', x: 1600, y: 200, w: 800, h: 600 },   // overlaps w1, stacked above it
  ]

  it('finds the window under the pointer', () => {
    expect(hitTestWindows(list, 1550, 150, 'w2')).toBe('w1')
    expect(hitTestWindows(list, 200, 200, 'w1')).toBe(DOCK)
  })

  it('the LAST overlapping window wins — the one on top is the one you see', () => {
    expect(hitTestWindows(list, 1700, 300, 'dock')).toBe('w2')
  })

  it('excludes the window being dragged from, so a local drag is not a cross-window move', () => {
    expect(hitTestWindows(list, 1550, 150, 'w1')).toBe(null)
  })

  it('returns null over empty desktop', () => {
    expect(hitTestWindows(list, 5000, 5000, 'w1')).toBe(null)
    expect(hitTestWindows(null, 10, 10, 'w1')).toBe(null)
  })

  it('is half-open on the far edge, so touching windows never both match', () => {
    expect(hitTestWindows([{ id: 'w1', x: 0, y: 0, w: 100, h: 100 }], 100, 50, null)).toBe(null)
    expect(hitTestWindows([{ id: 'w1', x: 0, y: 0, w: 100, h: 100 }], 99, 50, null)).toBe('w1')
  })
})

describe('persisted winOf is validated', () => {
  it('accepts a good map and rejects junk', () => {
    expect(isWinOf({ calc: 'w1' })).toBe(true)
    expect(isWinOf({ calc: 'nope' })).toBe(false)
    expect(isWinOf([])).toBe(false)
    expect(isWinOf(null)).toBe(false)
  })
})

describe('a moved panel is re-sent to its new window', () => {
  // The bug this pins: `publish` deduped on props alone, so a panel dragged between
  // windows — which carries exactly the props it had — was never posted to the
  // destination. The window was told it held the panel and rendered an empty slot.
  const props = { memberId: 'B1', units: 'imperial' }

  it('posts nothing when neither the props nor the window changed', () => {
    expect(needsPost(props, 'w1', props, 'w1')).toBe(false)
  })

  it('posts when the props changed', () => {
    expect(needsPost(props, 'w1', { ...props, memberId: 'B2' }, 'w1')).toBe(true)
  })

  it('posts when the SAME props move to another window', () => {
    expect(needsPost(props, 'w1', props, 'w2')).toBe(true)
  })

  it('posts the first time a panel is published to a window', () => {
    expect(needsPost(undefined, undefined, props, 'w1')).toBe(true)
  })

  it('treats a differing key count as a change', () => {
    expect(needsPost({ a: 1 }, 'w1', { a: 1, b: 2 }, 'w1')).toBe(true)
  })
})

describe('closing a detached window closes what is in it', () => {
  it('CLOSES its panels rather than sending them back to the workspace', () => {
    let s = detachToNewWindow(base(), 'calc').state
    s = movePanelToWindow(s, 'loads', 'w1')      // two panels in one window
    const dockBefore = panelsOf(L(s.dock))

    const after = closeWindowPanels(s, 'w1')

    expect(after.hosts.calc).toBe(null)
    expect(after.hosts.loads).toBe(null)
    expect(after.winOf.calc).toBeUndefined()
    expect(after.winOf.loads).toBeUndefined()
    // The main workspace is untouched — shutting a window on the second monitor must
    // not rearrange the first one.
    expect(panelsOf(L(after.dock))).toEqual(dockBefore)
    expect(windowIds(after.hosts, after.winOf)).toEqual([])
    expect(after.winDock.w1).toBeUndefined()
  })

  it('leaves other windows alone', () => {
    let s = detachToNewWindow(base(), 'calc').state
    s = detachToNewWindow(s, 'section').state    // w2
    const after = closeWindowPanels(s, 'w1')
    expect(after.hosts.calc).toBe(null)
    expect(after.hosts.section).toBe('window')
    expect(after.winOf.section).toBe('w2')
    expect(windowIds(after.hosts, after.winOf)).toEqual(['w2'])
  })

  it('is a NO-OP for a window already emptied by a move', () => {
    // The ordinary sequence: the last panel is dragged to w2, w1 empties and closes
    // itself, and its `closed` arrives afterwards. That must not close the panel that
    // has just moved on.
    let s = detachToNewWindow(base(), 'calc').state
    s = detachToNewWindow(s, 'section').state
    s = movePanelToWindow(s, 'calc', 'w2')       // w1 is now empty
    const after = closeWindowPanels(s, 'w1')
    expect(after).toBe(s)                        // same object — nothing happened
    expect(after.hosts.calc).toBe('window')
    expect(after.winOf.calc).toBe('w2')
  })

  it('a closed panel can be reopened into the dock, as if it had never been detached', () => {
    let s = detachToNewWindow(base(), 'calc').state
    s = closeWindowPanels(s, 'w1')
    expect(s.hosts.calc).toBe(null)
    // What the toolbar chip does.
    s = prune({ ...s, hosts: { ...s.hosts, calc: 'dock' } })
    expect(s.hosts.calc).toBe('dock')
    expect(s.winOf.calc).toBeUndefined()
  })
})

describe('merging two detached windows into one', () => {
  /** main + w1(calc, loads) + w2(section, force) — three windows on screen. */
  const three = () => {
    let s = detachToNewWindow(base(), 'calc').state          // w1
    s = movePanelToWindow(s, 'loads', 'w1')
    s = detachToNewWindow(s, 'section').state                // w2
    s = movePanelToWindow(s, 'force', 'w2')
    return s
  }

  it('THE ASK: three windows become two', () => {
    const s = three()
    expect(windowIds(s.hosts, s.winOf)).toEqual(['w1', 'w2'])

    const after = mergeWindows(s, 'w2', 'w1')

    expect(windowIds(after.hosts, after.winOf)).toEqual(['w1'])
    expect(panelsInWindow(after.hosts, after.winOf, 'w1').sort())
      .toEqual(['calc', 'force', 'loads', 'section'])
    expect(after.winDock.w2).toBeUndefined()
    expect(panelsOf(after.winDock.w1).sort()).toEqual(['calc', 'force', 'loads', 'section'])
  })

  it('merging into the workspace folds a window back in — two screens become one', () => {
    const s = three()
    const after = mergeWindows(s, 'w2', DOCK)
    expect(windowIds(after.hosts, after.winOf)).toEqual(['w1'])
    expect(after.hosts.section).toBe('dock')
    expect(after.hosts.force).toBe('dock')
    expect(panelsOf(L(after.dock))).toEqual(expect.arrayContaining(['section', 'force']))
  })

  it('carries the SOURCE window order across, not key order', () => {
    let s = detachToNewWindow(base(), 'calc').state
    // Put loads ABOVE calc in w1, so layout order and key order disagree.
    s = movePanelToWindow(s, 'loads', 'w1', { type: 'in', ci: 0, ii: 0 })
    expect(panelsOf(s.winDock.w1)).toEqual(['loads', 'calc'])
    s = detachToNewWindow(s, 'section').state                // w2, the destination
    const after = mergeWindows(s, 'w1', 'w2')
    // section was already there; the two arrivals keep their relative order.
    const order = panelsOf(after.winDock.w2)
    expect(order.indexOf('loads')).toBeLessThan(order.indexOf('calc'))
  })

  it('leaves a third window untouched', () => {
    let s = three()
    s = detachToNewWindow(s, 'elevation').state              // w3
    const after = mergeWindows(s, 'w2', 'w1')
    expect(windowIds(after.hosts, after.winOf)).toEqual(['w1', 'w3'])
    expect(panelsInWindow(after.hosts, after.winOf, 'w3')).toEqual(['elevation'])
  })

  it('merging a window into itself, or an empty one, changes nothing', () => {
    const s = three()
    expect(mergeWindows(s, 'w1', 'w1')).toBe(s)
    expect(mergeWindows(s, 'w9', 'w1')).toBe(s)   // no such window
  })

  it('does not drop a panel the stored layout has not caught up with', () => {
    const s = three()
    // Simulate a stale layout: w2 holds section+force but its layout only names section.
    const stale = { ...s, winDock: { ...s.winDock, w2: { cols: [{ w: 1, items: [{ kind: 'section', h: 1 }] }] } } }
    const after = mergeWindows(stale, 'w2', 'w1')
    expect(panelsInWindow(after.hosts, after.winOf, 'w1').sort())
      .toEqual(['calc', 'force', 'loads', 'section'])
  })
})
