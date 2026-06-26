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
    private static object? _sapModel;
    private static Type? _iSapInterface;
    private static Type? _iDbTablesInterface;

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
                    "getUnits"   => GetUnits(),
                    "getTable"   => GetTable(
                                        p?["key"]?.GetValue<string>()
                                            ?? throw new ArgumentException("getTable requires params.key"),
                                        p?["group"]?.GetValue<string>() ?? ""),
                    "selectCombos" => SelectCombos(p?["combos"]?.AsArray()),
                    "setGroupAssign" => SetGroupAssign(
                                        p?["groupName"]?.GetValue<string>()
                                            ?? throw new ArgumentException("setGroupAssign requires params.groupName"),
                                        p?["frameNames"]?.AsArray()),
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
        _sapModel = sap;
        _iSapInterface = iSap;

        _dbTables = iSap.GetProperty("DatabaseTables")?.GetValue(sap)
            ?? throw new InvalidOperationException("cSapModel.DatabaseTables returned null");
        _iDbTablesInterface = Iface("cDatabaseTables");
        _getTableMethod = _iDbTablesInterface.GetMethod("GetTableForDisplayArray")
            ?? throw new InvalidOperationException("cDatabaseTables.GetTableForDisplayArray not found");

        // Force display units to kip-ft so GetTableForDisplayArray returns consistent units.
        // eUnits.kip_ft_F = 4. Use reflection through the interface type.
        try
        {
            var setPU = iSap.GetMethod("SetPresentUnits");
            if (setPU != null)
            {
                var eUnitsType = asm.GetType("ETABSv1.eUnits");
                var val = eUnitsType != null ? Enum.ToObject(eUnitsType, 4) : (object)4;
                setPU.Invoke(sap, new[] { val });
            }
        }
        catch { /* best-effort — unit conversion will still work via string detection */ }

        string modelName = "ETABS model";
        try
        {
            var gmf = iSap.GetMethod("GetModelFilename", new[] { typeof(bool) });
            if (gmf?.Invoke(sap, new object[] { false }) is string s && s.Length > 0) modelName = s;
        }
        catch { /* optional */ }

        return new JsonObject { ["modelName"] = modelName, ["dll"] = dll };
    }

    // ── setGroupAssign: create an ETABS group and assign frame objects to it ──
    // Mirrors the column repo's write-back pattern (unlock → write). The CSI .NET
    // API is invoked through the c* interface types by reflection, like Connect.
    private static JsonNode SetGroupAssign(string groupName, JsonArray? frameNamesNode)
    {
        if (_sapModel is not object sap || _iSapInterface is not Type iSap)
            throw new InvalidOperationException("Not connected — call connect first.");
        var asm = iSap.Assembly;

        var frameNames = (frameNamesNode ?? new JsonArray())
            .Select(n => n?.GetValue<string>() ?? "")
            .Where(s => s.Length > 0).ToArray();
        if (frameNames.Length == 0)
            throw new ArgumentException("setGroupAssign requires a non-empty frameNames array");

        // Unlock the model so assignments can be written.
        try { iSap.GetMethod("SetModelIsLocked", new[] { typeof(bool) })?.Invoke(sap, new object[] { false }); }
        catch { /* best effort */ }

        // Ensure the group exists: SapModel.GroupDef.SetGroup(name, ...)
        var groupDef = iSap.GetProperty("GroupDef")?.GetValue(sap)
            ?? throw new InvalidOperationException("cSapModel.GroupDef not found");
        var iGroupDef = asm.GetType("ETABSv1.cGroupDef")
            ?? throw new InvalidOperationException("ETABSv1.cGroupDef not found");
        var setGroup = iGroupDef.GetMethods().FirstOrDefault(m => m.Name == "SetGroup")
            ?? throw new InvalidOperationException("cGroupDef.SetGroup not found");
        {
            var pars = setGroup.GetParameters();
            var args = new object[pars.Length];
            args[0] = groupName;
            // color (int) = -1 (auto); all "SpecifiedFor*" booleans = true so the group is usable.
            for (int k = 1; k < pars.Length; k++)
            {
                var pt = pars[k].ParameterType; if (pt.IsByRef) pt = pt.GetElementType()!;
                args[k] = pt == typeof(int) ? -1 : pt == typeof(bool) ? (object)true
                          : pt.IsEnum ? Enum.ToObject(pt, 0) : pt.IsValueType ? Activator.CreateInstance(pt)! : null!;
            }
            setGroup.Invoke(groupDef, args);
        }

        // Assign each frame: SapModel.FrameObj.SetGroupAssign(name, groupName, remove=false, itemType=Object)
        var frameObj = iSap.GetProperty("FrameObj")?.GetValue(sap)
            ?? throw new InvalidOperationException("cSapModel.FrameObj not found");
        var iFrameObj = asm.GetType("ETABSv1.cFrameObj")
            ?? throw new InvalidOperationException("ETABSv1.cFrameObj not found");
        var setGA = iFrameObj.GetMethods().FirstOrDefault(m => m.Name == "SetGroupAssign")
            ?? throw new InvalidOperationException("cFrameObj.SetGroupAssign not found");
        var gaPars = setGA.GetParameters();

        int assigned = 0;
        var failures = new JsonArray();
        foreach (var fn in frameNames)
        {
            try
            {
                var args = new object[gaPars.Length];
                args[0] = fn;
                if (gaPars.Length > 1) args[1] = groupName;
                for (int k = 2; k < gaPars.Length; k++)
                {
                    var pt = gaPars[k].ParameterType; if (pt.IsByRef) pt = pt.GetElementType()!;
                    // 3rd param is Remove (false); enum params (eItemType) = Object (0).
                    args[k] = pt == typeof(bool) ? (object)false : pt.IsEnum ? Enum.ToObject(pt, 0)
                              : pt.IsValueType ? Activator.CreateInstance(pt)! : null!;
                }
                var ret = setGA.Invoke(frameObj, args);
                if (ret is int rc && rc == 0) assigned++;
                else failures.Add((JsonNode)JsonValue.Create(fn));
            }
            catch (Exception ex)
            {
                var inner = (ex as TargetInvocationException)?.InnerException?.Message ?? ex.Message;
                failures.Add((JsonNode)JsonValue.Create($"{fn}: {inner}"));
            }
        }

        return new JsonObject
        {
            ["groupName"] = groupName,
            ["assigned"] = assigned,
            ["total"] = frameNames.Length,
            ["failures"] = failures,
        };
    }

    private static JsonNode Disconnect()
    {
        _dbTables = null;
        _getTableMethod = null;
        _sapModel = null;
        _iSapInterface = null;
        _iDbTablesInterface = null;
        return JsonValue.Create(true)!;
    }

    // ── selectCombos ─────────────────────────────────────────────────────────
    // Limits which load combinations/cases appear in subsequently fetched display
    // tables, so a model with 50 combos only ships the rows the user asked for.
    // Both setters are attempted (combos govern "Design Forces", cases govern
    // "Element Forces"); per-call failures are tolerated because the renderer
    // keeps its client-side row filter as the correctness backstop.

    private static JsonNode SelectCombos(JsonArray? combosNode)
    {
        var db = _dbTables ?? throw new InvalidOperationException("Not connected — call connect first.");
        var iDb = _iDbTablesInterface ?? throw new InvalidOperationException("Not connected — call connect first.");

        var names = (combosNode ?? new JsonArray())
            .Select(n => n?.GetValue<string>() ?? "")
            .Where(s => s.Length > 0)
            .ToArray();

        bool combosOk = false, casesOk = false;
        // int SetLoadCombinationsSelectedForDisplay(ref string[] names)
        try
        {
            var m = iDb.GetMethod("SetLoadCombinationsSelectedForDisplay");
            if (m != null)
            {
                var args = new object?[] { names };
                combosOk = (int)(m.Invoke(db, args) ?? -1) == 0;
            }
        }
        catch { /* tolerated */ }
        // int SetLoadCasesSelectedForDisplay(ref string[] names)
        try
        {
            var m = iDb.GetMethod("SetLoadCasesSelectedForDisplay");
            if (m != null)
            {
                var args = new object?[] { names };
                casesOk = (int)(m.Invoke(db, args) ?? -1) == 0;
            }
        }
        catch { /* tolerated */ }

        return new JsonObject { ["combos"] = combosOk, ["cases"] = casesOk, ["count"] = names.Length };
    }

    // ── getUnits ──────────────────────────────────────────────────────────────
    // Returns the eUnits enum integer that is currently active for display tables.
    // We call SetPresentUnits(4=kip_ft_F) at connect so this should always be 4.

    private static JsonNode GetUnits()
    {
        if (_sapModel == null || _iSapInterface == null)
            throw new InvalidOperationException("Not connected — call connect first.");

        // Attempt to read back via GetPresentUnits(ref eUnits)
        // Signature: int GetPresentUnits(ref eUnits units)
        try
        {
            var method = _iSapInterface.GetMethod("GetPresentUnits");
            if (method != null)
            {
                var args = new object?[] { 0 }; // ref eUnits — pass 0, read back
                method.Invoke(_sapModel, args);
                return JsonValue.Create(Convert.ToInt32(args[0]));
            }
        }
        catch { /* fall through */ }

        // If reflection failed, return the value we set at connect (4 = kip_ft_F)
        return JsonValue.Create(4);
    }

    // ── getTable ──────────────────────────────────────────────────────────

    private static JsonNode GetTable(string key, string group)
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
            group,                 // GroupName ("" = all objects)
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
