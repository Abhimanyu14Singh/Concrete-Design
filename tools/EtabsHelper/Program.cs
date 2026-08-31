// EtabsHelper — tiny sidecar spawned by the Electron main process.
//
// Attaches to the running ETABS instance through the .NET API
// (ETABSv1.dll loaded by reflection — no COM registration, no compile-time
// ETABS dependency) and answers JSON-line requests on stdin/stdout:
//
//   {"id":1,"method":"connect","params":{"dll":"optional path"}}
//   {"id":2,"method":"getTable","params":{"key":"Beam Object Connectivity"}}
//   {"id":3,"method":"listTables"}   -> every table key THIS build offers
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

// WHY EVERYTHING HERE IS REFLECTION: linking ETABSv1.dll at compile time would pin the
// app to one ETABS version and make the whole build fail on any machine without ETABS
// installed. Loading it at runtime by path means one binary works against whatever
// version the engineer has (v20+), and a machine with no ETABS still runs the app —
// `connect` simply returns a clear error.
//
// The cost is that every OAPI call is a MethodInfo lookup. Two consequences shape the
// code below: members must be invoked through the c* INTERFACE types (CSI implements
// them explicitly, so they are not public on the concrete classes), and CSI renames and
// re-signatures methods between versions — hence `OapiMethod`, which accepts several
// candidate names, and `FillDefaults`, which pads trailing optional parameters.
//
// The process is a long-lived, SINGLE-THREADED request loop: one JSON line in, one JSON
// line out, state held in the statics below between calls. Errors are returned as
// `{"id":n,"error":...}`, never thrown out of the loop — a crash here would take the
// connection down mid-import.
internal static class Program
{
    // The live connection, held between requests. All null until `connect` succeeds.
    private static object? _dbTables;
    private static MethodInfo? _getTableMethod;
    private static object? _sapModel;
    private static Type? _iSapInterface;
    private static Type? _iDbTablesInterface;

    /// Request loop: read a JSON line, dispatch on `method`, write exactly one JSON line
    /// back. Runs until stdin closes, which is how the Electron main process shuts it down.
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
                    "listTables" => ListTables(),
                    "selectCombos" => SelectCombos(p?["combos"]?.AsArray()),
                    "setGroupAssign" => SetGroupAssign(
                                        p?["groupName"]?.GetValue<string>()
                                            ?? throw new ArgumentException("setGroupAssign requires params.groupName"),
                                        p?["frameNames"]?.AsArray()),
                    // ── section write-back ───────────────────────────────────
                    // Dimensions arrive in the model's PRESENT units; the app
                    // converts, because SetPresentUnits would unlock the model
                    // (see the note above SelectCombos) and the caller may not
                    // want that yet.
                    "defineFrameSections" => DefineFrameSections(p?["sections"]?.AsArray()),
                    "assignSections"      => AssignSections(p?["assignments"]?.AsArray()),
                    "setRebarBeam"        => SetRebarBeam(p?["beams"]?.AsArray()),
                    "saveModelAs"         => SaveModelAs(
                                        p?["path"]?.GetValue<string>()
                                            ?? throw new ArgumentException("saveModelAs requires params.path")),
                    "runAnalysis"         => RunAnalysis(),
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

    /// Write one response line to stdout and flush. The protocol is line-delimited, so
    /// the JSON must never be indented and nothing else may be written to stdout.
    private static void Reply(JsonObject obj)
    {
        Console.WriteLine(obj.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
        Console.Out.Flush();
    }

    // ── connect ───────────────────────────────────────────────────────────

    /// Locate ETABSv1.dll, in falling order of explicitness: caller override → the
    /// ETABS_DLL environment variable → newest "ETABS *" under the standard install root.
    /// Throws with an actionable message when nothing is found; the app shows it verbatim.
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

    /// Attach to the RUNNING ETABS instance and cache the interface handles the other
    /// methods use. Attaches to an existing process rather than starting one: the whole
    /// workflow is "the engineer has their model open", and launching a second instance
    /// would attach to an empty model.
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

        // We do NOT change the model's units. SetPresentUnits would modify the
        // model (UNLOCKING an analysed one and discarding results) and force a unit
        // system the user didn't choose. Instead we READ the model's current units
        // — getUnits (GetPresentUnits) and the "Program Control" CurrUnits string —
        // and the app converts every table from those. The model is left untouched
        // and its SI/imperial unit system is respected.

        string modelName = "ETABS model";
        try
        {
            var gmf = iSap.GetMethod("GetModelFilename", new[] { typeof(bool) });
            if (gmf?.Invoke(sap, new object[] { false }) is string s && s.Length > 0) modelName = s;
        }
        catch { /* optional */ }

        return new JsonObject { ["modelName"] = modelName, ["dll"] = dll };
    }

    /// Find an OAPI method by name on whichever c* interface a live ETABS object
    /// implements. CSI implements the API explicitly on the interfaces, and the
    /// interface NAMES vary by ETABS version (e.g. SapModel.GroupDef is `cGroup`
    /// on some builds, `cGroupDef` on others), so locating the method is far more
    /// robust than hardcoding a type name. Tries the given names exactly first,
    /// then any method starting with names[0] (to catch versioned overloads such
    /// as SetGroup_1). The error lists what the object actually implements.
    private static MethodInfo OapiMethod(object obj, params string[] names)
    {
        var ifaces = obj.GetType().GetInterfaces();
        foreach (var name in names)
            foreach (var iface in ifaces)
            {
                var m = iface.GetMethods().FirstOrDefault(x => x.Name == name);
                if (m != null) return m;
            }
        foreach (var iface in ifaces)
        {
            var m = iface.GetMethods().FirstOrDefault(x => x.Name.StartsWith(names[0], StringComparison.Ordinal));
            if (m != null) return m;
        }
        throw new InvalidOperationException(
            $"{names[0]} method not found (object implements: " +
            $"{string.Join(", ", ifaces.Select(i => i.Name))})");
    }

    // ── setGroupAssign: create an ETABS group and assign frame objects to it ──
    // Mirrors the column repo's write-back pattern (unlock → write). The CSI .NET
    // API is invoked through the c* interface types by reflection, like Connect.
    private static JsonNode SetGroupAssign(string groupName, JsonArray? frameNamesNode)
    {
        if (_sapModel is not object sap || _iSapInterface is not Type iSap)
            throw new InvalidOperationException("Not connected — call connect first.");

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
        var setGroup = OapiMethod(groupDef, "SetGroup");
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
        var setGA = OapiMethod(frameObj, "SetGroupAssign");
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

    // ── section write-back ───────────────────────────────────────────────────
    //
    // The half of the round trip that changes the MODEL rather than labelling it:
    // define a frame-section property per resized design group, put that group's
    // frames on it, save the file under a new name and re-run. Same reflection
    // discipline as everything above — the CSI API is reached through the c*
    // interfaces so this compiles without an ETABS reference and tolerates the
    // signature drift between versions.
    //
    // EVERY ONE OF THESE UNLOCKS THE MODEL, which discards existing analysis
    // results. That is inherent to editing a section — ETABS will not let you
    // change a definition on a locked model — and it is why runAnalysis exists as
    // its own call rather than being assumed: the caller decides when the results
    // are worth the wait.
    //
    // Not verified against a live ETABS from this checkout. The reflection follows
    // the documented v1 signatures and the same shape as SetGroupAssign (which IS
    // exercised), but the first real run is the test that matters — see the
    // validation boundary in README.md.

    /** Unlock the model so definitions can be written. Best effort: a model that is
     *  already unlocked has nothing to do, and a build without the method should not
     *  fail the whole push. */
    private static void Unlock(Type iSap, object sap)
    {
        try { iSap.GetMethod("SetModelIsLocked", new[] { typeof(bool) })?.Invoke(sap, new object[] { false }); }
        catch { /* best effort */ }
    }

    /** A cSapModel property object (PropFrame, PropMaterial, FrameObj, File, Analyze). */
    private static object SapPart(string name)
    {
        if (_sapModel is not object sap || _iSapInterface is not Type iSap)
            throw new InvalidOperationException("Not connected — call connect first.");
        return iSap.GetProperty(name)?.GetValue(sap)
            ?? throw new InvalidOperationException($"cSapModel.{name} not found");
    }

    /** Fill the tail of an OAPI argument list with its documented defaults: colour −1
     *  (auto), notes/GUID empty, enums 0 (= the "Object"/default member), bools false. */
    private static void FillDefaults(ParameterInfo[] pars, object?[] args, int from)
    {
        for (int k = from; k < pars.Length; k++)
        {
            var pt = pars[k].ParameterType; if (pt.IsByRef) pt = pt.GetElementType()!;
            args[k] = pt == typeof(string) ? ""
                    : pt == typeof(int) ? -1
                    : pt == typeof(bool) ? (object)false
                    : pt.IsEnum ? Enum.ToObject(pt, 0)
                    : pt.IsValueType ? Activator.CreateInstance(pt)!
                    : null!;
        }
    }

    /**
     * Make sure a concrete material called `name` exists, creating it at f'c when it
     * does not. Returns the name that should be handed to SetRectangle.
     *
     * Best effort BY DESIGN: a model almost always already defines the grade its beams
     * use, and the caller passes that name. Inventing a material is the fallback for a
     * grade the model has never seen, and if the OAPI rejects our defaults it is better
     * to define the section against an existing material than to abort the push — the
     * geometry is the thing the engineer asked to change.
     */
    private static string EnsureConcreteMaterial(string name, double? fc)
    {
        var propMat = SapPart("PropMaterial");
        // Already defined? GetMaterial returns 0 for a known name.
        try
        {
            var get = OapiMethod(propMat, "GetMaterial");
            var gp = get.GetParameters();
            var gargs = new object?[gp.Length];
            gargs[0] = name;
            FillDefaults(gp, gargs, 1);
            if (get.Invoke(propMat, gargs) is int grc && grc == 0) return name;
        }
        catch { /* fall through and try to define it */ }

        try
        {
            var set = OapiMethod(propMat, "SetMaterial");
            var sp = set.GetParameters();
            var sargs = new object?[sp.Length];
            sargs[0] = name;
            // eMatType.Concrete == 2 in the v1 API.
            if (sp.Length > 1)
            {
                var pt = sp[1].ParameterType; if (pt.IsByRef) pt = pt.GetElementType()!;
                sargs[1] = pt.IsEnum ? Enum.ToObject(pt, 2) : (object)2;
            }
            FillDefaults(sp, sargs, 2);
            set.Invoke(propMat, sargs);

            if (fc is double f && f > 0)
            {
                // SetOConcrete_1(Name, Fc, IsLightweight, FcsFactor, SSType, SSHysType,
                //                StrainAtFc, StrainUltimate, FinalSlope, Temp)
                var oc = OapiMethod(propMat, "SetOConcrete_1", "SetOConcrete");
                var op = oc.GetParameters();
                var oargs = new object?[op.Length];
                oargs[0] = name;
                if (op.Length > 1) oargs[1] = f;
                FillDefaults(op, oargs, 2);
                // Sensible stress-strain defaults where the slots are doubles.
                if (op.Length > 6 && op[6].ParameterType == typeof(double)) oargs[6] = 0.0022;
                if (op.Length > 7 && op[7].ParameterType == typeof(double)) oargs[7] = 0.0052;
                oc.Invoke(propMat, oargs);
            }
        }
        catch { /* leave the name as-is; SetRectangle will report if it is unusable */ }
        return name;
    }

    /**
     * PropFrame.SetRectangle(Name, MatProp, T3, T2, …).
     *
     * T3 IS THE DEPTH AND T2 IS THE WIDTH. Transposing them is the single easiest way to
     * push a model that looks plausible and is wrong in every beam, so the JSON names the
     * two explicitly ("depth"/"width") rather than passing a positional pair.
     */
    private static JsonNode DefineFrameSections(JsonArray? sectionsNode)
    {
        if (_sapModel is not object sap || _iSapInterface is not Type iSap)
            throw new InvalidOperationException("Not connected — call connect first.");
        Unlock(iSap, sap);

        var propFrame = SapPart("PropFrame");
        var setRect = OapiMethod(propFrame, "SetRectangle");
        var pars = setRect.GetParameters();

        int defined = 0;
        var failures = new JsonArray();
        foreach (var node in sectionsNode ?? new JsonArray())
        {
            var s = node?.AsObject();
            var name = s?["name"]?.GetValue<string>() ?? "";
            if (name.Length == 0) continue;
            try
            {
                var matProp = EnsureConcreteMaterial(
                    s?["matProp"]?.GetValue<string>() ?? $"{name}-CONC",
                    s?["fc"]?.GetValue<double>());
                var args = new object?[pars.Length];
                args[0] = name;
                if (pars.Length > 1) args[1] = matProp;
                if (pars.Length > 2) args[2] = s?["depth"]?.GetValue<double>() ?? 0;   // T3
                if (pars.Length > 3) args[3] = s?["width"]?.GetValue<double>() ?? 0;   // T2
                FillDefaults(pars, args, 4);
                var ret = setRect.Invoke(propFrame, args);
                if (ret is int rc && rc == 0) defined++;
                else failures.Add((JsonNode)JsonValue.Create($"{name}: SetRectangle returned {ret}"));
            }
            catch (Exception ex)
            {
                var inner = (ex as TargetInvocationException)?.InnerException?.Message ?? ex.Message;
                failures.Add((JsonNode)JsonValue.Create($"{name}: {inner}"));
            }
        }
        return new JsonObject { ["defined"] = defined, ["failures"] = failures };
    }

    /** FrameObj.SetSection(Name, PropName, ItemType) — put frames on a property. */
    private static JsonNode AssignSections(JsonArray? assignmentsNode)
    {
        if (_sapModel is not object sap || _iSapInterface is not Type iSap)
            throw new InvalidOperationException("Not connected — call connect first.");
        Unlock(iSap, sap);

        var frameObj = SapPart("FrameObj");
        var setSection = OapiMethod(frameObj, "SetSection");
        var pars = setSection.GetParameters();

        int assigned = 0, total = 0;
        var failures = new JsonArray();
        foreach (var node in assignmentsNode ?? new JsonArray())
        {
            var a = node?.AsObject();
            var propName = a?["name"]?.GetValue<string>() ?? "";
            foreach (var fnNode in a?["frameNames"]?.AsArray() ?? new JsonArray())
            {
                var fn = fnNode?.GetValue<string>() ?? "";
                if (fn.Length == 0) continue;
                total++;
                try
                {
                    var args = new object?[pars.Length];
                    args[0] = fn;
                    if (pars.Length > 1) args[1] = propName;
                    FillDefaults(pars, args, 2);
                    var ret = setSection.Invoke(frameObj, args);
                    if (ret is int rc && rc == 0) assigned++;
                    else failures.Add((JsonNode)JsonValue.Create($"{fn} → {propName}: returned {ret}"));
                }
                catch (Exception ex)
                {
                    var inner = (ex as TargetInvocationException)?.InnerException?.Message ?? ex.Message;
                    failures.Add((JsonNode)JsonValue.Create($"{fn} → {propName}: {inner}"));
                }
            }
        }
        return new JsonObject { ["assigned"] = assigned, ["total"] = total, ["failures"] = failures };
    }

    /**
     * PropFrame.SetRebarBeam(Name, MatPropLong, MatPropConfine, CoverTop, CoverBot,
     *                        TopLeftArea, TopRightArea, BotLeftArea, BotRightArea).
     *
     * Optional: it carries the designed cage into the model so ETABS' own beam design
     * sees the steel this app chose, instead of re-sizing it. Areas are END areas — ETABS
     * has no notion of the app's per-third curtailment, so the ENVELOPE goes in and the
     * detail stays in the app's schedule.
     */
    private static JsonNode SetRebarBeam(JsonArray? beamsNode)
    {
        if (_sapModel is not object sap || _iSapInterface is not Type iSap)
            throw new InvalidOperationException("Not connected — call connect first.");
        Unlock(iSap, sap);

        var propFrame = SapPart("PropFrame");
        var setRebar = OapiMethod(propFrame, "SetRebarBeam");
        var pars = setRebar.GetParameters();

        int set = 0;
        var failures = new JsonArray();
        foreach (var node in beamsNode ?? new JsonArray())
        {
            var b = node?.AsObject();
            var name = b?["name"]?.GetValue<string>() ?? "";
            if (name.Length == 0) continue;
            try
            {
                var args = new object?[pars.Length];
                var d = new object?[]
                {
                    name,
                    b?["matLong"]?.GetValue<string>() ?? "",
                    b?["matConfine"]?.GetValue<string>() ?? "",
                    b?["coverTop"]?.GetValue<double>() ?? 0,
                    b?["coverBot"]?.GetValue<double>() ?? 0,
                    b?["topLeftArea"]?.GetValue<double>() ?? 0,
                    b?["topRightArea"]?.GetValue<double>() ?? 0,
                    b?["botLeftArea"]?.GetValue<double>() ?? 0,
                    b?["botRightArea"]?.GetValue<double>() ?? 0,
                };
                for (int k = 0; k < pars.Length; k++) args[k] = k < d.Length ? d[k] : null;
                FillDefaults(pars, args, Math.Min(d.Length, pars.Length));
                var ret = setRebar.Invoke(propFrame, args);
                if (ret is int rc && rc == 0) set++;
                else failures.Add((JsonNode)JsonValue.Create($"{name}: SetRebarBeam returned {ret}"));
            }
            catch (Exception ex)
            {
                var inner = (ex as TargetInvocationException)?.InnerException?.Message ?? ex.Message;
                failures.Add((JsonNode)JsonValue.Create($"{name}: {inner}"));
            }
        }
        return new JsonObject { ["set"] = set, ["failures"] = failures };
    }

    /** File.Save(path) — SaveAs when the path differs from the open model's. */
    private static JsonNode SaveModelAs(string path)
    {
        var file = SapPart("File");
        var save = OapiMethod(file, "Save");
        var pars = save.GetParameters();
        var args = new object?[pars.Length];
        if (pars.Length > 0) args[0] = path;
        FillDefaults(pars, args, 1);
        var ret = save.Invoke(file, args);
        if (ret is int rc && rc != 0)
            throw new InvalidOperationException($"File.Save returned {rc} for {path}");
        return new JsonObject { ["path"] = path };
    }

    /** Analyze.RunAnalysis() — the model must be saved first; ETABS refuses otherwise. */
    private static JsonNode RunAnalysis()
    {
        var analyze = SapPart("Analyze");
        var run = OapiMethod(analyze, "RunAnalysis");
        var pars = run.GetParameters();
        var args = new object?[pars.Length];
        FillDefaults(pars, args, 0);
        var ret = run.Invoke(analyze, args);
        if (ret is int rc && rc != 0)
            throw new InvalidOperationException($"Analyze.RunAnalysis returned {rc}");
        return new JsonObject { ["ran"] = true };
    }

    /// Drop the cached handles. Does NOT close ETABS — the app attached to the
    /// engineer's own session, so shutting it down would destroy their work.
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
    // tables, so a model with 50 combos only ships the rows the user asked for —
    // the key speed lever when importing forces from a large, many-combo model.
    // Both setters are attempted (combos govern "Design Forces", cases govern
    // "Element Forces"); per-call failures are tolerated because the renderer
    // keeps its client-side row filter as the correctness backstop.
    //
    // This runs even on a LOCKED (analysed) model, BY DESIGN. It used to be guarded
    // behind GetModelIsLocked on the ASSUMPTION that SetLoad*SelectedForDisplay
    // unlocks the model and discards results — but that was never verified (the
    // guarding commit asked for a smoke test that never happened, and this is a
    // display/output-selection call, not a model-definition edit). The guard is
    // removed to restore fast, combo-scoped force imports; if a particular ETABS
    // build DOES unlock on this call, re-run the analysis after importing.
    // (SetPresentUnits, which would definitely unlock, is deliberately never called —
    // connect reads the present units instead of setting them.)

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
    // Returns the eUnits enum integer for the API "present units" — the SAME
    // units GetTableForDisplayArray formats every table in. The app relies on
    // this as the authoritative source for converting table data (it can differ
    // from the model's GUI/"Program Control" units on a locked model). We do NOT
    // call SetPresentUnits (that would force a unit system the user didn't pick);
    // we just read whatever ETABS is presenting.

    private static JsonNode GetUnits()
    {
        if (_sapModel == null || _iSapInterface == null)
            throw new InvalidOperationException("Not connected — call connect first.");

        // ETABSv1: eUnits GetPresentUnits() — PARAMETERLESS, returns the active
        // units enum. (The old code invoked it with a dummy argument, which never
        // matched the zero-arg signature, so it always threw and fell back to a
        // hardcoded kip-ft — mis-scaling SI models once we stopped forcing units.)
        try
        {
            var method = _iSapInterface.GetMethod("GetPresentUnits", Type.EmptyTypes);
            if (method != null)
            {
                var result = method.Invoke(_sapModel, null);
                if (result != null) return JsonValue.Create(Convert.ToInt32(result));
            }
        }
        catch { /* fall through */ }

        // Could not read the enum — return -1 (not a valid eUnits) so the app
        // resolves units from the "Program Control" CurrUnits string instead of
        // assuming a default.
        return JsonValue.Create(-1);
    }

    // ── listTables ───────────────────────────────────────────

    /// Every display table THIS ETABS build offers, with the exact keys it wants.
    ///
    /// Exists because a wrong table key is indistinguishable from an empty model:
    /// GetTableForDisplayArray returns a non-zero code and no rows, and the app used to
    /// see only the absent rows. The area (wall/slab) layer is the case that prompted it
    /// — columns and beams import fine from "Column/Beam Object Connectivity", so when
    /// areas come back empty the question is whether "Area Object Connectivity" is what
    /// this build calls that table. This answers it rather than guessing at spellings.
    ///
    /// `IsImportable` is reported as ETABS gives it; the app only reads, but it is the
    /// cheapest way to tell a real table from a report-only one.
    private static JsonNode ListTables()
    {
        var db = _dbTables ?? throw new InvalidOperationException("Not connected — call connect first.");
        var iDb = _iDbTablesInterface ?? throw new InvalidOperationException("Not connected — call connect first.");

        // int GetAvailableTables(ref int NumberTables, ref string[] TableKey,
        //   ref string[] TableName, ref int[] ImportType)
        var mi = iDb.GetMethod("GetAvailableTables")
            ?? throw new InvalidOperationException("cDatabaseTables.GetAvailableTables not found");

        var args = new object?[]
        {
            0,                     // NumberTables (out)
            Array.Empty<string>(), // TableKey (out)
            Array.Empty<string>(), // TableName (out)
            Array.Empty<int>(),    // ImportType (out)
        };
        var ret = (int)(mi.Invoke(db, args) ?? -1);

        var count = args[0] is int n ? n : 0;
        var keys = args[1] as string[] ?? Array.Empty<string>();
        var names = args[2] as string[] ?? Array.Empty<string>();
        var types = args[3] as int[] ?? Array.Empty<int>();

        var list = new JsonArray();
        for (var i = 0; i < count && i < keys.Length; i++)
        {
            list.Add(new JsonObject
            {
                ["key"] = keys[i],
                ["name"] = i < names.Length ? names[i] : "",
                ["importType"] = i < types.Length ? types[i] : -1,
            });
        }
        return new JsonObject { ["tables"] = list, ["count"] = count, ["ret"] = ret };
    }

    // ── getTable ──────────────────────────────────────────────────────────

    /// Read one ETABS display table as {fields, rows}, optionally scoped to a group.
    ///
    /// Columnar on purpose: a table of station forces runs to tens of thousands of rows,
    /// and repeating the field names per row would multiply the JSON crossing the pipe.
    /// The renderer widens it back out (see `ComConnection.fetchTable`).
    ///
    /// Values come back as STRINGS in the model's present display units — no conversion
    /// happens here. `getUnits` reports what those units are and the app converts, so
    /// that all unit handling lives in one testable place instead of in the sidecar.
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
