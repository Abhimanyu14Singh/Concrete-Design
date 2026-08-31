using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Interop;

namespace SDashShell;

/// <summary>
/// The host half of the workspace's desktop bridge.
///
/// The renderer already talks to a NARROW, named surface — `window.desktop` with five
/// members (see electron/preload.cjs). Providing exactly that shape here is what lets the
/// whole panel workspace run under WPF with no change to a line of app code: the drag
/// controller, the window model and the merge menu all call these and do not care what is
/// behind them.
///
///   isDesktop      · so the workspace knows it can make real OS windows
///   popout(id)     · open (or focus) a panel window
///   popoutBounds() · where every dockable window is on screen, for cross-window drag
///   popoutFocus(id)· bring one forward after a drop
///   popoutClose(id)· close one the renderer has emptied
///
/// WHAT IS NOT HERE: `window.electronAPI`. Save/open, the ETABS bridge and the S-Concrete
/// batch all hang off that, and they are Electron main-process code. Absent it, the app
/// degrades exactly as it does in a browser — file dialogs become downloads, and the two
/// native integrations report that they need the desktop app. Porting them is a separate
/// piece of work; this shell is the WINDOWING half only.
/// </summary>
public static class HostBridge
{
    /// <summary>Reserved id for the main window, matching `DOCK` in windowDock.js.</summary>
    public const string Dock = "dock";

    private static readonly Dictionary<string, ShellWindow> Windows = new();

    public static string? BaseUrl { get; set; }

    public static void Register(string id, ShellWindow w) => Windows[id] = w;
    public static void Unregister(string id) => Windows.Remove(id);

    /// <summary>
    /// Injected into every document before any app script runs.
    ///
    /// Request/response over `postMessage` needs correlation ids because the channel is
    /// one-way in both directions — this is the same trick the app's own popout bus uses
    /// for its menu round trip, for the same reason.
    /// </summary>
    public const string BootstrapScript = """
    (function () {
      if (window.desktop) return;
      const pending = new Map(); let seq = 0;
      function call(method, args) {
        return new Promise(resolve => {
          const id = ++seq;
          pending.set(id, resolve);
          // A host that never answers must not hang a drag — resolve empty instead.
          setTimeout(() => { if (pending.delete(id)) resolve(null); }, 4000);
          window.chrome.webview.postMessage(JSON.stringify({ __host: true, id, method, args }));
        });
      }
      window.chrome.webview.addEventListener('message', e => {
        let m; try { m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
        if (!m || !m.__hostReply) return;
        const r = pending.get(m.id);
        if (r) { pending.delete(m.id); r(m.result); }
      });
      window.desktop = {
        isDesktop: true,
        popout: (winId, title) => call('popout', [winId, title]),
        popoutBounds: () => call('popoutBounds', []),
        popoutFocus: id => call('popoutFocus', [id]),
        popoutClose: id => call('popoutClose', [id]),
      };
    })();
    """;

    /// <summary>Dispatch one `window.desktop` call. Returns the JSON reply payload.</summary>
    public static JsonNode? Handle(string method, JsonArray args)
    {
        switch (method)
        {
            case "popout":
            {
                var id = args.ElementAtOrDefault(0)?.GetValue<string>();
                var title = args.ElementAtOrDefault(1)?.GetValue<string>();
                if (string.IsNullOrEmpty(id)) return JsonValue.Create(false);
                if (Windows.TryGetValue(id, out var existing)) { existing.Activate(); return JsonValue.Create(true); }
                var w = new ShellWindow(id, $"{BaseUrl}?popout={Uri.EscapeDataString(id)}", title ?? id);
                w.Show();
                return JsonValue.Create(true);
            }
            case "popoutBounds":
            {
                var arr = new JsonArray();
                foreach (var (id, w) in Windows.OrderBy(kv => kv.Key == Dock ? 0 : 1))
                {
                    var r = ScreenRect(w);
                    if (r is null) continue;
                    arr.Add(new JsonObject
                    {
                        ["id"] = id, ["x"] = r.Value.x, ["y"] = r.Value.y,
                        ["w"] = r.Value.w, ["h"] = r.Value.h,
                    });
                }
                return arr;
            }
            case "popoutFocus":
            {
                var id = args.ElementAtOrDefault(0)?.GetValue<string>();
                if (id is not null && Windows.TryGetValue(id, out var w))
                {
                    if (w.WindowState == WindowState.Minimized) w.WindowState = WindowState.Normal;
                    w.Activate();
                }
                return JsonValue.Create(true);
            }
            case "popoutClose":
            {
                var id = args.ElementAtOrDefault(0)?.GetValue<string>();
                if (id is not null && id != Dock && Windows.TryGetValue(id, out var w)) w.Close();
                return JsonValue.Create(true);
            }
        }
        return null;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

    /// <summary>
    /// A window's rectangle in the coordinate space the RENDERER measures its drag in.
    ///
    /// This is the subtle part, and the one to verify on a mixed-DPI desk. `GetWindowRect`
    /// answers in PHYSICAL pixels; the page's `screenX`/`screenY` are CSS pixels, i.e.
    /// physical divided by that window's scale factor. On a uniform-scale setup the two
    /// agree once divided. Across monitors at DIFFERENT scales they do not, because each
    /// window is divided by its OWN factor — so a drag from a 150% laptop screen onto a
    /// 100% external can hit-test against a rectangle offset by a third of the desktop.
    ///
    /// Dividing by the source window's scale is right for the common case and wrong for
    /// the mixed one. The durable fix is not to do this arithmetic at all — see the note
    /// on native hit-testing in the shell's README.
    /// </summary>
    private static (double x, double y, double w, double h)? ScreenRect(ShellWindow w)
    {
        try
        {
            var hwnd = new WindowInteropHelper(w).Handle;
            if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out var r)) return null;
            var src = PresentationSource.FromVisual(w);
            var scale = src?.CompositionTarget?.TransformToDevice.M11 ?? 1.0;
            if (scale <= 0) scale = 1.0;
            return (r.Left / scale, r.Top / scale, (r.Right - r.Left) / scale, (r.Bottom - r.Top) / scale);
        }
        catch { return null; }
    }
}
