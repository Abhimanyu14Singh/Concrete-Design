# The usage log

A local flight recorder for the installed app. It answers one question — **where does the
workflow break down on someone else's machine** — and it answers it without collecting
anything a client would object to.

It is **not analytics**. There is no service, no account and no network call. Records are
appended to a file under the user's own profile and reach us only when the user exports
them and sends the file deliberately.

---

## Why it exists

Most of the app is deterministic and testable. Two parts are not, and neither can be
reproduced here:

| Surface | Depends on |
|---|---|
| `etabsBridge.cjs` + `EtabsHelper.exe` | their ETABS build, their .NET runtime, whether ETABS is even open |
| `sconcreteBridge.cjs` + `SConcreteHelper.exe` | their S-Concrete install, their output folder, their permissions |

"The import did nothing" is not a bug report. A timestamped record of what was clicked,
what it called, how long it took and what came back, is.

---

## Where the data lives

```
%APPDATA%\s-dashboard\usage\
    state.json               install id, consent flag, session count
    usage-2026-08-27.jsonl   one file per day
```

Bounded on every axis, because a recorder that fills someone's disk has done more harm
than the bug it was there to catch: 30 days' retention, 24 MB total, 8 MB per file, 500
events per event-name per session, 20 000 events per session.

---

## Architecture

```
  renderer  ──track()──▶  queue (1.2 s / 64 events)  ──IPC batch──┐
  (usage.ts)                errors flush immediately              │
                                                                  ▼
  main      ──logEvent()──────────────────────────────▶  buffer ──▶ usage-YYYY-MM-DD.jsonl
  (usageLog.cjs)                                        (1.5 s, sync on error/quit)
```

Three things are recorded with **no call sites at all**, which is why coverage does not
rot as the app changes:

- **Every IPC channel.** `instrumentIpc` wraps `ipcMain.handle` itself, so every handler —
  including ones added later — is timed and its outcome recorded. It must run *before* the
  first `handle` call, and is the second statement in `main.cjs` for that reason.
- **The activity log.** The app already narrates itself into `activity.ts` for the status
  bar; `usage.ts` subscribes and mirrors every line. Anything added to the status bar
  arrives here for free.
- **Crashes**, in both processes: `uncaughtException`, `unhandledRejection`,
  `render-process-gone`, `unresponsive`, preload failures, and React errors caught by
  `ErrorBoundary`.

---

## What is recorded, and what is not

**Recorded** — counts, durations, enums, booleans, error text, versions, screen geometry.

**Never recorded:**

- Project content: geometry, sections, materials, forces, results.
- Names: the project, members, groups, or the ETABS model. Status-bar lines are mirrored
  into the log and the app's own wording *does* name groups — `10 unresolved (LOWER ROOF ·
  B18X60-5KSI, …)` — so `stripLabels()` replaces those lists with `(9 names omitted)`
  before the line is recorded. It is a backstop, not the plan: anything worth analysing
  gets a structured event (`suggest.sweep`) that carries codes instead of prose.
- File paths — a path names a client. `scrub()` reduces them to `<path.edb>`, `<unc.sco>`,
  `<home.scrs>`.
- Review notes written when marking a member Reviewed.
- User name, e-mail, machine name, IP address.

Two rules keep it that way:

1. **IPC arguments are dropped by default.** A channel discloses fields only by naming
   them in `DESCRIBERS` (`usageLog.cjs`). Disclosure is opt-in, so a handler added later
   leaks nothing until someone decides what is safe to say about it.
2. **Everything that does get through is scrubbed.** `scrub()` runs on every string, at
   every depth, on arrival.

> **The spaces trap.** Windows paths are full of spaces — `Program Files`,
> `S-Concrete Batches`, and above all client directories like `Acme Tower`. A pattern
> built on `\S` stops at the first space and leaves the rest of the path in the message:
> `C:\Jobs\Acme Tower\Phase 2\model.edb` becomes `<path> Tower\Phase 2\model.edb`, which
> has published the client's name. The patterns in `usageLog.cjs` admit spaces inside
> segments for exactly this reason, and `usageLog.test.ts` holds the cases.

---

## Record shape

```json
{"t":"2026-08-27T22:33:12.632Z","sid":"7a243e7b","seq":3,
 "src":"renderer:main","lvl":"info","ev":"context","ms":6136,
 "p":{"code":"ACI318-19","members":2,"_n":2,"_dt":5911,"_t":5912}}
```

| Field | Meaning |
|---|---|
| `t` | when the event **happened** — renderer events are stamped at creation, not on arrival, or batching would collapse an interaction onto one instant |
| `sid` | session id; `seq` is monotonic within it |
| `seq` | write order in the main process — **not** event order, see below |
| `src` | `main` (the main process) or `renderer:main` / `renderer:panel` / `renderer:dashboard` |
| `ms` | ms since the session started |
| `p._n` | renderer event number |
| `p._dt` | **ms since the previous renderer event** |
| `p._t` | ms since the renderer's first event |
| `p._bg` | present when the window was hidden — an alt-tab, not a stall |

`_dt` is the field the whole reading rests on. A 40-second gap on the Filter step followed
by `wizard.close` is a usability finding; the same two events without the gap are noise.

> **Sort by `t`, never by `seq`.** `seq` is assigned when the main process *writes* a
> record; `t` is when the event *happened*. Renderer events are batched, so a renderer
> event can carry a lower `t` than a main-process event with a lower `seq` — real
> example, one line after the other in the file:
>
> ```
> "seq":2 ... "t":"22:44:24.187" ... "ev":"ipc"
> "seq":3 ... "t":"22:44:23.965" ... "ev":"renderer.start"
> ```
>
> Reading in file order gives a subtly wrong timeline. `sort -t'"' -k4` or any
> `t`-keyed sort fixes it.

`session.start` carries everything constant about the run — versions, OS build, locale,
CPU/RAM, display list. `context` events carry sticky facts (design code, model size) and
are emitted **only when one changes**, so read the file as a stream and carry the last
value forward.

---

## Event vocabulary

| Event | Says |
|---|---|
| `session.start` / `session.end` | the run, its machine, its duration |
| `renderer.start` / `renderer.end` | a window's lifetime |
| `launch.choice` | demo · import · open — the first fork |
| `wizard.open` / `wizard.step` / `wizard.close` | the import funnel; `close` carries the step reached and whether it imported |
| `wizard.connected` | units read, and whether they had to be **assumed** |
| `wizard.filter` | the selection as it is narrowed — `combos: 1, ofCombos: 196` |
| `wizard.match` | beams matched, and how wide the filter was |
| `wizard.op` | one async step: which, how long, what error |
| `import.complete` | members, groups, frames, storeys |
| `design.summary` | **the model's state**: ok / warn / ng counts, worst DCR, which check governs how many members |
| `suggest.sweep` | resolved vs failed, and **why** each failure failed, by reason code |
| `export` | which export, how long, model size, and any failure |
| `project.open` / `project.save` | model size, whether it succeeded |
| `project.file-version` | the `.scdb` `FILE_VERSION` **actually on disk** |
| `sconcrete.batch` | mode, member count, duration, whether an `.SCRS` came back |
| `override.apply` / `override.clear` | which checks were waived, and by how much |
| `edit.undo` / `edit.redo` | where the app surprised someone |
| `view` | which screen; the gap to the next is the dwell |
| `milestone.imported` / `milestone.verified` | once per session — did this install ever get there |
| `error.*`, `renderer.*`, `main.*` | failures, with a compacted stack |
| `ipc` | every channel: name, method, duration, outcome |
| `activity` | mirrored status-bar lines, with name lists removed |

### `suggest.sweep` reason codes

`reasons` is keyed by `SuggestError['kind']` (`src/utils/suggestRebar.ts`). The two
families call for different things from the engineer:

| Code | Means | Fix |
|---|---|---|
| `section-limit` | shear + torsion crushes the concrete (ACI §22.7.7.1 / EC2 §6.3.2) | bigger section — **no cage helps** |
| `shear-section` | strut / `V_c + max V_s` exceeded | widen the web, raise f′c |
| `over-reinforced` | ρmax reached before a cage was found | enlarge the section |
| `flexure-ladder` | demand past the largest practical cage (#11/Ø32 × 3 layers) | enlarge the section |
| `torsion-ladder` | torsion past the tightest practical links | bigger section |
| `stirrup-spacing` | no ladder spacing meets a hard detailing limit | deepen / widen |
| `crack-limit` | EC2 §7.3.4 — strong enough, cracks too wide | smaller bars, less cover, relax exposure |
| `mixed-group` | no single cage satisfies every member | split the group |
| `bar-floor` | the size floor excluded every candidate | lower the floor |
| `no-beams` | nothing in the group to size | — |
| `design-threw` / `sweep-failure` | the engine raised or the verification sweep refused | **a bug — investigate** |
| `unclassified` | a refusal with no `kind` | **a bug — a return was added without one** |

`unclassified` appearing at all means someone added a `SuggestError` return without
tagging it; `suggestSweepStats.test.ts` asserts it stays empty.

---

## Reading an export

The export concatenates the retained files behind an `export.manifest` line and writes one
`.jsonl` — plain text, one record per line, no tool needed to open it.

```bash
# the funnel: how far did each session get?
grep -E '"ev":"(launch.choice|wizard.step|wizard.close|import.complete|milestone)' log.jsonl

# everything that failed
grep '"lvl":"error"' log.jsonl

# where people stall — the biggest gaps between events
grep -o '"_dt":[0-9]\{4,\}' log.jsonl | sort -t: -k2 -rn | head

# what state is the model actually in, and why did Suggest refuse?
grep -E '"ev":"(design.summary|suggest.sweep)"' log.jsonl
```

A file may begin mid-story: retention deletes the oldest days, and the manifest lists
which files survived so a partial log is self-describing rather than silently incomplete.

---

## Consent

Recording is **on by default**, which is only defensible because all four of these are
true — and they must stay true:

1. It never leaves the machine on its own.
2. Help → **Diagnostics** says exactly what is kept and what is not.
3. The user can read the file themselves in Notepad.
4. One click turns it off (Diagnostics → *Turn recording off*), and deleting the folder
   erases everything.

If the app is ever distributed outside a pilot group — particularly to EU/UK users — pair
this with a first-run notice rather than relying on the Diagnostics tab being found.

---

## Adding an event

```ts
import { track, trackOnce, trackTiming } from './utils/usage';

track('group.suggest', { members: 12, resolved: 9 });        // counts, not names
const done = trackTiming('design.sweep', { code });
done({ ok: true, members: 312 });                            // adds `ms`
trackOnce('milestone.verified');                             // once per session
```

- Name events `noun.verb` — the log is read by grouping on it.
- Pass counts, durations, enums and booleans. **Never** a name, a path or free text a user
  typed.
- No feature check needed: everything no-ops outside Electron.
- New fields that could carry user text need a case in `src/utils/__tests__/usageLog.test.ts`.
