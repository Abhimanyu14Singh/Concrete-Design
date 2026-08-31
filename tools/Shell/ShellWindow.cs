using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace SDashShell;

/// <summary>
/// One WPF window hosting one WebView2 — the main workspace, or a torn-off panel window.
///
/// ONE CLASS FOR BOTH, deliberately. The two differ only in the URL they load and in
/// whether closing them ends the app; making a separate PanelWindow would be two copies
/// of the WebView2 setup to keep in step, and the setup is the part that matters.
///
/// EVERY WINDOW SHARES ONE CoreWebView2Environment. That is not an optimisation, it is
/// the requirement the workspace rests on: panels find each other with `BroadcastChannel`,
/// which only reaches contexts in the same browser process group at the same origin. A
/// window created with its own environment would get its own process group, the channel
/// would go quiet, and every detached panel would sit on "Loading…" forever.
/// </summary>
public class ShellWindow : Window
{
    private static CoreWebView2Environment? _env;
    private readonly WebView2 _web = new();
    private readonly string _id;
    private readonly string _url;

    public ShellWindow(string id, string url, string title)
    {
        _id = id;
        _url = url;
        Title = title;
        Width = id == HostBridge.Dock ? 1400 : 900;
        Height = id == HostBridge.Dock ? 900 : 660;
        MinWidth = 360; MinHeight = 300;
        // Match the app's shell background so a window never flashes white while the
        // bundle boots — the same reason the Electron windows set it.
        Background = System.Windows.Media.Brushes.WhiteSmoke;
        Content = _web;
        HostBridge.Register(id, this);
        Closed += (_, _) => HostBridge.Unregister(id);
        Loaded += async (_, _) => await InitAsync();
    }

    private async Task InitAsync()
    {
        // One environment for the whole app, in a per-user folder. The default location is
        // beside the executable, which fails outright in Program Files.
        _env ??= await CoreWebView2Environment.CreateAsync(
            userDataFolder: Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "S-Dashboard", "WebView2"));

        await _web.EnsureCoreWebView2Async(_env);
        var core = _web.CoreWebView2;

        // Before ANY app script — the workspace reads `window.desktop` during its first
        // render to decide whether it can detach at all.
        await core.AddScriptToExecuteOnDocumentCreatedAsync(HostBridge.BootstrapScript);
        core.WebMessageReceived += OnWebMessage;

        // A panel window is opened by the HOST, never by the page: the workspace calls
        // `window.desktop.popout(...)`. Anything that still reaches window.open is denied,
        // for the reason the Electron shell denies it — the default is a second complete
        // copy of the application.
        core.NewWindowRequested += (_, e) => { e.Handled = true; };

        var s = core.Settings;
        s.AreDefaultContextMenusEnabled = false;   // the app has its own right-click menus
        s.IsStatusBarEnabled = false;
        s.AreBrowserAcceleratorKeysEnabled = false; // no Ctrl+P / F5 over the app's own keys

        core.Navigate(_url);
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonNode? msg;
        try { msg = JsonNode.Parse(e.TryGetWebMessageAsString()); }
        catch { return; }
        if (msg?["__host"]?.GetValue<bool>() != true) return;

        var id = msg["id"]?.GetValue<int>() ?? 0;
        var method = msg["method"]?.GetValue<string>() ?? "";
        var args = msg["args"] as JsonArray ?? new JsonArray();

        JsonNode? result = null;
        try { result = HostBridge.Handle(method, args); }
        catch (Exception ex) { Console.Error.WriteLine($"host {method} failed: {ex.Message}"); }

        var reply = new JsonObject { ["__hostReply"] = true, ["id"] = id, ["result"] = result };
        try { _web.CoreWebView2.PostWebMessageAsJson(reply.ToJsonString()); } catch { }
    }

    protected override void OnClosed(EventArgs e)
    {
        base.OnClosed(e);
        // Closing the main window ends the session, panels included — they are views of a
        // model that lives in it and mean nothing without it.
        if (_id == HostBridge.Dock) Application.Current?.Shutdown();
    }
}
