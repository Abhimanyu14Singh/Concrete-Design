using System;
using System.IO;
using System.Windows;

namespace SDashShell;

/// <summary>
/// Entry point: serve the built app on loopback, then open the main window on it.
///
/// `dist/` is located relative to the executable first (a published shell ships it
/// alongside), then by walking up to the repo root, so the same binary runs from
/// `dotnet run` during development and from a published folder.
/// </summary>
public static class Program
{
    [STAThread]
    public static int Main()
    {
        var dist = FindDist();
        if (dist is null)
        {
            MessageBox.Show(
                "Could not find the built web app (dist/).\n\nRun `npm run build` in the repo first.",
                "S-Dashboard", MessageBoxButton.OK, MessageBoxImage.Error);
            return 1;
        }

        using var server = new LocalServer(dist);
        server.Start();
        HostBridge.BaseUrl = server.BaseUrl;

        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var main = new ShellWindow(HostBridge.Dock, server.BaseUrl, "S-Dashboard");
        main.Show();
        return app.Run();
    }

    private static string? FindDist()
    {
        var here = AppContext.BaseDirectory;
        var beside = Path.Combine(here, "dist");
        if (File.Exists(Path.Combine(beside, "index.html"))) return beside;

        var dir = new DirectoryInfo(here);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "dist");
            if (File.Exists(Path.Combine(candidate, "index.html"))) return candidate;
            dir = dir.Parent;
        }
        return null;
    }
}
