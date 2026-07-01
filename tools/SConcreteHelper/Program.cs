// SConcreteHelper — native replacement for the Python run_batch_reporter.py.
//
// Drives S-Concrete's BatchReporter.exe by Windows UI Automation, so the app can
// run a .SCO batch and get .SCRS results with NO Python / pywinauto / pywin32 —
// the machine only needs S-Concrete (S-FRAME Product Suite) installed.
//
// Ported 1:1 from Column_Design_DW/batch_reporter.py: same install-path scan,
// window title, control AutomationIds, Run-Batch → poll-status → Create-Report
// flow, and the background win32 dialog-dismiss watcher.
//
// CLI (one-shot; mirrors run_batch_reporter.py's args):
//   SConcreteHelper.exe --detect
//       → {"found":bool,"reporter":"...","sconcrete":"..."} on stdout, exit 0
//   SConcreteHelper.exe "<scoFolder>" --title "T" --engineer "E" [--no-pdf]
//       → runs the batch; {"ok":bool,"status":"...","pdf":"...","error":"..."} on
//         stdout; progress on stderr; exit 0 on success, 1 on failure.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Windows.Automation;

internal static class Program
{
    private const string WindowTitle = "Batch Processing and Reporting Utility";
    private static readonly string[] DismissButtons = { "OK", "Ok", "Yes", "Continue", "Ignore" };

    private const int StartupTimeout = 60;    // s to wait for the reporter window
    private const int FolderLoadTimeout = 20; // s for the file-count label to update
    private const int BatchTimeout = 1800;    // s for the batch to finish
    private const int ReportTimeout = 120;    // s for the PDF to appear

    private static volatile bool _watch;

    private sealed class BatchResult
    {
        public bool ok { get; set; }
        public string status { get; set; } = "";
        public string pdf { get; set; } = "";
        public string error { get; set; } = "";
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length >= 1 && args[0] == "--detect")
            {
                var (rep, sc) = FindSConcrete();
                WriteJson(new { found = rep != null, reporter = rep ?? "", sconcrete = sc ?? "" });
                return 0;
            }
            if (args.Length < 1 || args[0].StartsWith("--"))
            {
                WriteJson(new BatchResult { ok = false, error = "Usage: SConcreteHelper <scoFolder> [--title T] [--engineer E] [--no-pdf]" });
                return 1;
            }

            var folder = Path.GetFullPath(args[0]);
            var title = GetOpt(args, "--title") ?? "S-Concrete Batch";
            var engineer = GetOpt(args, "--engineer") ?? "";
            var makePdf = !args.Contains("--no-pdf");

            var result = RunBatch(folder, title, engineer, makePdf);
            WriteJson(result);
            return result.ok ? 0 : 1;
        }
        catch (Exception e)
        {
            WriteJson(new BatchResult { ok = false, error = e.Message });
            return 1;
        }
    }

    // ── Locate S-Concrete ─────────────────────────────────────────────────────
    private static (string? reporter, string? sconcrete) FindSConcrete()
    {
        const string baseDir = @"C:\Program Files (x86)\S-FRAME Software";
        if (!Directory.Exists(baseDir)) return (null, null);
        // Newest "S-FRAME Product Suite <year>" first.
        foreach (var suite in Directory.GetDirectories(baseDir, "S-FRAME Product Suite *")
                     .OrderByDescending(d => d, StringComparer.OrdinalIgnoreCase))
        {
            var rep = Path.Combine(suite, "S-CONCRETE", "BatchReporter.exe");
            var sc = Path.Combine(suite, "S-CONCRETE", "Sconcrete.exe");
            if (File.Exists(rep)) return (rep, File.Exists(sc) ? sc : null);
        }
        return (null, null);
    }

    // ── Batch automation ──────────────────────────────────────────────────────
    private static BatchResult RunBatch(string folder, string title, string engineer, bool makePdf)
    {
        if (!Directory.Exists(folder))
            return new BatchResult { ok = false, error = $"SCO folder not found: {folder}" };
        var (reporter, _) = FindSConcrete();
        if (reporter == null)
            return new BatchResult { ok = false, error = "BatchReporter.exe not found. Is S-Concrete (S-FRAME Product Suite) installed?" };

        var scoCount = Directory.GetFiles(folder).Count(f => f.ToUpperInvariant().EndsWith(".SCO"));
        Log($"SCO folder : {folder} ({scoCount} files)");

        // Delete stale .SCRS so we never read an old result (Run Batch rewrites them).
        foreach (var f in Directory.GetFiles(folder))
            if (f.ToUpperInvariant().EndsWith(".SCRS")) { try { File.Delete(f); } catch { /* ignore */ } }

        _watch = true;
        var watcher = new Thread(DialogWatcher) { IsBackground = true };
        watcher.Start();

        Process? proc = null;
        try
        {
            Log($"Starting BatchReporter: {reporter}");
            proc = Process.Start(new ProcessStartInfo(reporter) { UseShellExecute = true });

            var win = FindTopWindow(WindowTitle, StartupTimeout);
            if (win == null) return new BatchResult { ok = false, error = "BatchReporter window did not appear within timeout." };
            Log("Window ready.");

            // Folder box: cboPath (ComboBox) → PART_EditableTextBox (Edit). TAB commits.
            var combo = FindById(win, "cboPath", 15);
            if (combo == null) return new BatchResult { ok = false, error = "Could not find the folder box (cboPath) in BatchReporter." };
            var edit = FindById(combo, "PART_EditableTextBox", 8) ?? combo;
            SetValue(edit, folder);
            Thread.Sleep(250);
            PressTab();
            WaitFolderLoaded(win);

            var runBtn = FindById(win, "btnRunBatch", 10);
            if (runBtn == null) return new BatchResult { ok = false, error = "Could not find the Run Batch button (btnRunBatch)." };
            Log("Clicking Run Batch...");
            Invoke(runBtn);

            Log("Waiting for batch to finish...");
            var status = PollStatus(win, BatchTimeout);
            if (!StatusHasResults(status))
                return new BatchResult { ok = false, status = status, error = $"Batch did not complete. Last status: '{status}'" };
            Log($"Batch done: {status}");

            // The .SCRS is now written into the folder; the PDF report is optional.
            var pdf = "";
            if (makePdf)
            {
                pdf = Path.Combine(folder, $"Report_{DateTime.Now:yyyyMMdd_HHmmss}.pdf");
                TrySet(win, "txtReportTitle", title);
                if (!string.IsNullOrEmpty(engineer)) TrySet(win, "txtEngineerName", engineer);
                TrySet(win, "txtReportName", pdf);
                Thread.Sleep(300);
                var createBtn = FindById(win, "btnCreateReport", 8);
                if (createBtn != null)
                {
                    Log("Creating PDF report...");
                    var before = File.Exists(pdf) ? File.GetLastWriteTimeUtc(pdf).Ticks : 0;
                    Invoke(createBtn);
                    var deadline = DateTime.UtcNow.AddSeconds(ReportTimeout);
                    while (DateTime.UtcNow < deadline)
                    {
                        Thread.Sleep(1000);
                        if (File.Exists(pdf) && File.GetLastWriteTimeUtc(pdf).Ticks > before) break;
                    }
                    if (!File.Exists(pdf)) pdf = "";
                }
                else pdf = "";
            }

            try { var close = FindById(win, "btnClose", 3); if (close != null) Invoke(close); } catch { /* best effort */ }
            return new BatchResult { ok = true, status = status, pdf = pdf };
        }
        finally
        {
            _watch = false;
            try
            {
                if (proc != null)
                {
                    if (!proc.WaitForExit(2000) && !proc.HasExited) proc.Kill(); // don't leave a GUI orphan
                }
            }
            catch { /* ignore */ }
        }
    }

    // ── UI Automation helpers ─────────────────────────────────────────────────
    private static AutomationElement? FindTopWindow(string name, int timeoutSec)
    {
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSec);
        var cond = new PropertyCondition(AutomationElement.NameProperty, name);
        while (DateTime.UtcNow < deadline)
        {
            try { var el = AutomationElement.RootElement.FindFirst(TreeScope.Children, cond); if (el != null) return el; }
            catch { /* transient */ }
            Thread.Sleep(300);
        }
        return null;
    }

    private static AutomationElement? FindById(AutomationElement root, string automationId, int timeoutSec)
    {
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSec);
        var cond = new PropertyCondition(AutomationElement.AutomationIdProperty, automationId);
        while (DateTime.UtcNow < deadline)
        {
            try { var el = root.FindFirst(TreeScope.Descendants, cond); if (el != null) return el; }
            catch { /* transient */ }
            Thread.Sleep(200);
        }
        return null;
    }

    private static void SetValue(AutomationElement el, string text)
    {
        try { el.SetFocus(); } catch { /* not always focusable */ }
        if (el.TryGetCurrentPattern(ValuePattern.Pattern, out var p)) ((ValuePattern)p).SetValue(text);
    }

    private static void Invoke(AutomationElement el)
    {
        if (el.TryGetCurrentPattern(InvokePattern.Pattern, out var p)) ((InvokePattern)p).Invoke();
        else if (el.TryGetCurrentPattern(TogglePattern.Pattern, out var t)) ((TogglePattern)t).Toggle();
    }

    private static void TrySet(AutomationElement win, string automationId, string text)
    {
        var el = FindById(win, automationId, 5);
        if (el != null) SetValue(el, text);
    }

    private static string LabelText(AutomationElement? el)
    {
        if (el == null) return "";
        try { if (el.TryGetCurrentPattern(ValuePattern.Pattern, out var p)) { var v = ((ValuePattern)p).Current.Value; if (!string.IsNullOrEmpty(v)) return v; } } catch { /* ignore */ }
        try { return el.Current.Name ?? ""; } catch { return ""; }
    }

    private static string PollStatus(AutomationElement win, int timeoutSec)
    {
        var last = "";
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSec);
        while (DateTime.UtcNow < deadline)
        {
            Thread.Sleep(1500);
            var s = LabelText(FindById(win, "lblResultStatus", 2)).Trim();
            if (s != last) { Log($"  Status: {s}"); last = s; }
            if (StatusHasResults(s)) return s;
        }
        return last;
    }

    private static bool StatusHasResults(string s)
    {
        if (string.IsNullOrEmpty(s)) return false;
        var sl = s.ToLowerInvariant();
        return !sl.Contains("no results") && !sl.Contains("click") && !sl.Contains("running") && s.Any(char.IsDigit);
    }

    private static void WaitFolderLoaded(AutomationElement win)
    {
        var deadline = DateTime.UtcNow.AddSeconds(FolderLoadTimeout);
        while (DateTime.UtcNow < deadline)
        {
            Thread.Sleep(500);
            var lbl = LabelText(FindById(win, "lblFilesInFolder", 1)).Trim();
            if (!string.IsNullOrEmpty(lbl) && lbl != "0") { Log($"Folder loaded: {lbl} files"); return; }
        }
        Log("Warning: folder file-count label didn't update — continuing anyway.");
    }

    // ── Background dialog watcher (win32; the pop-ups are #32770 dialogs) ──────
    private static void DialogWatcher()
    {
        var seen = new HashSet<IntPtr>();
        while (_watch)
        {
            Thread.Sleep(120);
            try
            {
                EnumWindows((h, _) =>
                {
                    if (!_watch) return false;
                    if (!IsWindowVisible(h) || seen.Contains(h)) return true;
                    if (ClassName(h) != "#32770") return true;
                    var title = WinText(h);
                    if (title == WindowTitle) return true;
                    if (!GetWindowRect(h, out var r)) return true;
                    int w = r.right - r.left, ht = r.bottom - r.top;
                    if (!(w > 50 && w < 900 && ht > 50 && ht < 700)) return true;

                    IntPtr btn = IntPtr.Zero; var btnText = "";
                    EnumChildWindows(h, (c, _) =>
                    {
                        if (ClassName(c) == "Button")
                        {
                            var t = WinText(c).Replace("&", "").Trim();
                            if (DismissButtons.Contains(t)) { btn = c; btnText = t; return false; }
                        }
                        return true;
                    }, IntPtr.Zero);

                    if (btn != IntPtr.Zero)
                    {
                        SendMessage(btn, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                        seen.Add(h);
                        Log($"[watcher] dismissed '{title}' via '{btnText}'");
                    }
                    return true;
                }, IntPtr.Zero);
            }
            catch { /* keep watching */ }
        }
    }

    // ── stdout / stderr ───────────────────────────────────────────────────────
    private static void WriteJson(object o) { Console.Out.WriteLine(JsonSerializer.Serialize(o)); Console.Out.Flush(); }
    private static void Log(string m) { Console.Error.WriteLine(m); Console.Error.Flush(); }
    private static string? GetOpt(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    // ── win32 P/Invoke ────────────────────────────────────────────────────────
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    private const uint BM_CLICK = 0x00F5;
    private const byte VK_TAB = 0x09;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int left, top, right, bottom; }

    private static void PressTab()
    {
        keybd_event(VK_TAB, 0, 0, UIntPtr.Zero);
        keybd_event(VK_TAB, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    private static string ClassName(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }
    private static string WinText(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
}
