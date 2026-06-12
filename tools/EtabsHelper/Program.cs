// EtabsHelper — tiny sidecar spawned by the Electron main process.
//
// Attaches to the running ETABS instance through the .NET API
// (ETABSv1.dll loaded by reflection — no COM registration, no compile-time
// ETABS dependency) and answers JSON-line requests on stdin/stdout:
//
//   {"id":1,"method":"connect","params":{"dll":"optional path"}}
//   {"id":2,"method":"getTable","params":{"key":"Beam Object Connectivity"}}
//   {"id":3,"method":"disconnect"}   {"id":4,"method":"ping"}
//
// Responses: {"id":n,"result":...} or {"id":n,"error":"message"}.
// getTable returns {fields:[...], rows:[[...],...]} in the model's current
// display units — unit conversion happens in the app.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class Program
{
    private static object? _dbTables;
    private static MethodInfo? _getTableMethod;

    private static int Main()
    {
        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            long id = 0;
            try
            {
                var req = JsonNode.Parse(line)!.AsObject();
                id = req["id"]?.GetValue<long>() ?? 0;
                var method = req["method"]?.GetValue<string>() ?? "";
                var p = req["params"]?.AsObject();

                JsonNode? result = method switch
                {
                    "ping"       => JsonValue.Create("pong"),
                    "connect"    => Connect(p?["dll"]?.GetValue<string>()),
                    "getTable"   => GetTable(p?["key"]?.GetValue<string>()
                                        ?? throw new ArgumentException("getTable requires params.key")),
                    "disconnect" => Disconnect(),
                    _ => throw new ArgumentException($"Unknown method: {method}"),
                };
                Reply(new JsonObject { ["id"] = id, ["result"] = result });
            }
            catch (Exception e)
            {
                var msg = (e as TargetInvocationException)?.InnerException?.Message ?? e.Message;
                Reply(new JsonObject { ["id"] = id, ["error"] = msg });
            }
        }
        return 0;
    }

    private static void Reply(JsonObject obj)
    {
        Console.WriteLine(obj.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
        Console.Out.Flush();
    }

    // ── connect ───────────────────────────────────────────────────────────

    private static string FindDll(string? overridePath)
    {
        if (!string.IsNullOrEmpty(overridePath))
        {
            if (File.Exists(overridePath)) return overridePath;
            throw new FileNotFoundException($"ETABSv1.dll not found at: {overridePath}");
        }
        var env = Environment.GetEnvironmentVariable("ETABS_DLL");
        if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;

        const string root = @"C:\Program Files\Computers and Structures";
        if (Directory.Exists(root))
        {
            // "ETABS 23", "ETABS 22", … newest first
            var candidates = Directory.GetDirectories(root, "ETABS *")
                .OrderByDescending(d => d, StringComparer.OrdinalIgnoreCase)
                .Select(d => Path.Combine(d, "ETABSv1.dll"))
                .Where(File.Exists)
                .ToList();
            if (candidates.Count > 0) return candidates[0];
        }
        throw new FileNotFoundException(
            "ETABSv1.dll not found under C:\\Program Files\\Computers and Structures — " +
            "is ETABS (v20 or later) installed? Set the ETABS_DLL environment variable " +
            "to the full DLL path if ETABS is installed elsewhere.");
    }

    private static JsonNode Connect(string? dllOverride)
    {
        var dll = FindDll(dllOverride);
        var asm = Assembly.LoadFrom(dll);

        // CSI implements the API explicitly on the c* interfaces, so members are
        // NOT public on the concrete classes — every call must go through the
        // interface types (same reason the Python bridges cast cHelper(Helper())).
        Type Iface(string name) => asm.GetType($"ETABSv1.{name}")
            ?? throw new InvalidOperationException($"ETABSv1.{name} type not found in {dll}");

        var helperType = Iface("Helper");
        object helper = Activator.CreateInstance(helperType)
            ?? throw new InvalidOperationException("Could not create ETABSv1.Helper");

        object etabs;
        try
        {
            var getObject = Iface("cHelper").GetMethod("GetObject", new[] { typeof(string) })
                ?? throw new InvalidOperationException("cHelper.GetObject not found");
            etabs = getObject.Invoke(helper, new object[] { "CSI.ETABS.API.ETABSObject" })
                ?? throw new InvalidOperationException("GetObject returned null");
        }
        catch (Exception e)
        {
            var inner = (e as TargetInvocationException)?.InnerException?.Message ?? e.Message;
            throw new InvalidOperationException(
                "Could not attach to a running ETABS instance — open ETABS and load " +
                $"your model first. ({inner})");
        }

        object sap = Iface("cOAPI").GetProperty("SapModel")?.GetValue(etabs)
            ?? throw new InvalidOperationException("cOAPI.SapModel returned null");

        var iSap = Iface("cSapModel");
        _dbTables = iSap.GetProperty("DatabaseTables")?.GetValue(sap)
            ?? throw new InvalidOperationException("cSapModel.DatabaseTables returned null");
        _getTableMethod = Iface("cDatabaseTables").GetMethod("GetTableForDisplayArray")
            ?? throw new InvalidOperationException("cDatabaseTables.GetTableForDisplayArray not found");

        string modelName = "ETABS model";
        try
        {
            var gmf = iSap.GetMethod("GetModelFilename", new[] { typeof(bool) });
            if (gmf?.Invoke(sap, new object[] { false }) is string s && s.Length > 0) modelName = s;
        }
        catch { /* optional */ }

        return new JsonObject { ["modelName"] = modelName, ["dll"] = dll };
    }

    private static JsonNode Disconnect()
    {
        _dbTables = null;
        _getTableMethod = null;
        return JsonValue.Create(true)!;
    }

    // ── getTable ──────────────────────────────────────────────────────────

    private static JsonNode GetTable(string key)
    {
        var db = _dbTables ?? throw new InvalidOperationException("Not connected — call connect first.");

        // int GetTableForDisplayArray(string TableKey, ref string[] FieldKeyList,
        //   string GroupName, ref int TableVersion, ref string[] FieldsKeysIncluded,
        //   ref int NumberRecords, ref string[] TableData)
        // Resolved from the cDatabaseTables INTERFACE at connect time (explicit impl).
        var mi = _getTableMethod
            ?? throw new InvalidOperationException("Not connected — call connect first.");

        var args = new object?[]
        {
            key,
            Array.Empty<string>(), // FieldKeyList (all fields)
            "",                    // GroupName (all objects)
            0,                     // TableVersion
            Array.Empty<string>(), // FieldsKeysIncluded (out)
            0,                     // NumberRecords (out)
            Array.Empty<string>(), // TableData (out)
        };
        var ret = (int)(mi.Invoke(db, args) ?? -1);

        var fields = args[4] as string[] ?? Array.Empty<string>();
        var numRecords = args[5] is int n ? n : 0;
        var data = args[6] as string[] ?? Array.Empty<string>();

        var fieldsJson = new JsonArray(fields.Select(f => (JsonNode?)JsonValue.Create(f)).ToArray());
        var rowsJson = new JsonArray();
        if (ret == 0 && numRecords > 0 && fields.Length > 0)
        {
            var nf = fields.Length;
            for (var i = 0; i < numRecords; i++)
            {
                var row = new JsonArray();
                for (var j = 0; j < nf; j++)
                {
                    var idx = i * nf + j;
                    row.Add(JsonValue.Create(idx < data.Length ? data[idx] : ""));
                }
                rowsJson.Add(row);
            }
        }
        return new JsonObject { ["fields"] = fieldsJson, ["rows"] = rowsJson, ["ret"] = ret };
    }
}
