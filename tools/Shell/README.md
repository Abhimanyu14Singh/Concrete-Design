# SDashShell — WPF + WebView2 host

An alternative shell to Electron: a WPF window hosting WebView2, with the built `dist/`
served over loopback.

```
npm run build
dotnet run --project tools/Shell/Shell.csproj -c Release
```

## Why the app needs no changes

The workspace only ever asked the desktop for five things, through `window.desktop`
(see `electron/preload.cjs`). `HostBridge.BootstrapScript` injects the same five, so the
panel model, the cross-window drag and the merge menu all work untouched:

| | |
|---|---|
| `isDesktop` | the workspace may open real OS windows |
| `popout(id)` | open / focus a panel window |
| `popoutBounds()` | where every window is, for cross-window drag |
| `popoutFocus(id)` | bring one forward after a drop |
| `popoutClose(id)` | close one the renderer emptied |

**`window.electronAPI` is NOT provided.** Save/open, the ETABS bridge and the S-Concrete
batch hang off it and are Electron main-process code. Without it the app degrades exactly
as it does in a browser — dialogs become downloads, and the two native integrations say
they need the desktop app. Porting them is separate work; this shell is the windowing
half only.

## Two things it rests on

**One `CoreWebView2Environment` for every window.** Panels find each other with
`BroadcastChannel`, which only reaches same-origin contexts in the same browser process
group. A window built with its own environment gets its own group, the channel goes quiet,
and every detached panel sits on "Loading…". `ShellWindow` shares a single static
environment for exactly this reason — verify it first if panels ever stop talking.

**A real origin, which is why there is a server at all.** WebView2 can map a folder to a
virtual host with no server (`SetVirtualHostNameToFolderMapping`) and for most apps that
is the better answer. Here the app is several documents that must share an origin;
`file://` gives each an opaque one and silently breaks the bus. Loopback behaves exactly
like the Vite dev server the app is developed against, so there is one behaviour to reason
about instead of two.

## Known hazard: mixed-DPI cross-window drag

`HostBridge.ScreenRect` converts `GetWindowRect` (physical pixels) using the **source
window's** scale factor, because that is the space the page's `screenX`/`screenY` report
in. On a uniform-scale desktop this is correct. Across monitors at *different* scales it
is not — each window is divided by its own factor, so a drag from a 150% laptop panel onto
a 100% external can hit-test against a rectangle offset by a large fraction of the desktop.

The durable fix is not better arithmetic: it is to stop doing the arithmetic in the
renderer. Add `popoutHitTest(screenX, screenY)` to the bridge and answer it with
`WindowFromPoint` on the physical cursor position — the OS already knows the answer at any
mix of scales, and it is one call per drag instead of a rectangle list.
