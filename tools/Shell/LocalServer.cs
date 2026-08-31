using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SDashShell;

/// <summary>
/// A static file server for the built <c>dist/</c>, on loopback.
///
/// WHY A SERVER AT ALL. WebView2 can map a folder to a virtual host name
/// (<c>SetVirtualHostNameToFolderMapping</c>) with no server and no port, and for most
/// apps that is the better answer. This one serves over HTTP because the workspace is
/// built around a real ORIGIN: panels are separate documents that find each other with
/// <c>BroadcastChannel</c>, and a plain <c>file://</c> load gives every document an opaque
/// origin, which silently breaks that. A loopback origin behaves exactly like the dev
/// server the app is already developed against, so there is one behaviour to reason about
/// rather than two.
///
/// Bound to 127.0.0.1 on an EPHEMERAL port: nothing is reachable off the machine, and
/// nothing collides with whatever else the engineer has running.
/// </summary>
public sealed class LocalServer : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly string _root;
    private readonly CancellationTokenSource _cts = new();

    public string BaseUrl { get; }

    public LocalServer(string root)
    {
        _root = Path.GetFullPath(root);
        // Port 0 asks the OS for a free one; HttpListener needs a concrete prefix, so
        // take a socket, read the port it was given, and hand that to the listener.
        var port = FreePort();
        BaseUrl = $"http://127.0.0.1:{port}/";
        _listener.Prefixes.Add(BaseUrl);
    }

    private static int FreePort()
    {
        var l = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    public void Start()
    {
        _listener.Start();
        _ = Task.Run(LoopAsync);
    }

    private async Task LoopAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try { ctx = await _listener.GetContextAsync(); }
            catch { return; }   // listener stopped
            _ = Task.Run(() => Serve(ctx));
        }
    }

    /// <summary>Content types the app actually ships. A wrong one is not cosmetic: a
    /// module served as text/plain is refused by the browser and the app never boots.</summary>
    private static readonly Dictionary<string, string> Mime = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".mjs"] = "text/javascript; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".json"] = "application/json; charset=utf-8",
        [".svg"] = "image/svg+xml",
        [".woff2"] = "font/woff2",
        [".woff"] = "font/woff",
        [".ttf"] = "font/ttf",
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".ico"] = "image/x-icon",
        [".map"] = "application/json; charset=utf-8",
    };

    private void Serve(HttpListenerContext ctx)
    {
        try
        {
            var rel = Uri.UnescapeDataString(ctx.Request.Url?.AbsolutePath ?? "/").TrimStart('/');
            if (rel.Length == 0) rel = "index.html";

            var full = Path.GetFullPath(Path.Combine(_root, rel));
            // Path traversal guard. The only client is our own WebView2, but a server that
            // will serve anything under C:\ because a URL said "../.." is not something to
            // leave lying in a desktop app.
            if (!full.StartsWith(_root, StringComparison.OrdinalIgnoreCase)) { ctx.Response.StatusCode = 403; ctx.Response.Close(); return; }

            // SPA fallback. `?popout=w1` is a query, not a path, so it never reaches here —
            // but a future route would, and 404ing it would blank the window.
            if (!File.Exists(full)) full = Path.Combine(_root, "index.html");
            if (!File.Exists(full))
            {
                ctx.Response.StatusCode = 500;
                var msg = Encoding.UTF8.GetBytes($"dist/ not found at {_root}. Run `npm run build` first.");
                ctx.Response.OutputStream.Write(msg, 0, msg.Length);
                ctx.Response.Close();
                return;
            }

            var bytes = File.ReadAllBytes(full);
            ctx.Response.ContentType = Mime.TryGetValue(Path.GetExtension(full), out var m) ? m : "application/octet-stream";
            ctx.Response.ContentLength64 = bytes.Length;
            // The shell always serves what is on disk right now — a rebuilt dist/ must not
            // be masked by a cached response from the previous build.
            ctx.Response.Headers["Cache-Control"] = "no-store";
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
        }
        catch { /* a dropped connection is not worth taking the shell down for */ }
        finally { try { ctx.Response.Close(); } catch { } }
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener.Stop(); } catch { }
        try { _listener.Close(); } catch { }
    }
}
