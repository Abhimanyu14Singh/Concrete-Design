/**
 * ETABS CSI OAPI bridge — runs in the Electron MAIN process (Windows only).
 *
 * Attaches to the currently running ETABS instance through COM using `winax`
 * (an optionalDependency — absent on macOS/Linux/web builds, in which case
 * every call rejects with a clear message telling the user to use file import).
 *
 * OAPI calls used (CSI API Reference Manual, ETABS v1):
 *   cHelper.GetObject("CSI.ETABS.API.ETABSObject")  — attach to active instance
 *   SapModel.GetModelFilename / GetPresentUnits
 *   SapModel.Story.GetNameList
 *   SapModel.GroupDef.GetNameList / GroupDef.GetAssignments
 *   SapModel.PropFrame.GetNameList / GetRectangle / GetMaterial
 *   SapModel.PropMaterial.GetOConcrete_1 / GetORebar_1
 *   SapModel.FrameObj.GetAllFrames (geometry + design orientation)
 *   SapModel.Results.Setup.DeselectAllCasesAndCombosForOutput
 *   SapModel.Results.Setup.SetComboSelectedForOutput
 *   SapModel.Results.FrameForce
 *
 * winax marshals COM by-ref out-parameters as a `Variant` you read back from
 * the argument object; the exact dance varies by winax version, so each
 * handler isolates one OAPI call to keep Windows-side debugging simple.
 * This module is exercised only on a Windows machine with ETABS open.
 */

let sapModel = null;
let winaxMod = null; // module reference kept for Variant construction

function attach() {
  if (sapModel) return sapModel;
  let winax;
  try {
    // Lazy require so non-Windows builds never load the native module
    // eslint-disable-next-line global-require
    winax = require('winax');
    winaxMod = winax;
  } catch (e) {
    if (process.platform !== 'win32') {
      throw new Error(
        'Live ETABS connection is only available in the Windows desktop app. ' +
        'Use the "ETABS tables file" import instead.'
      );
    }
    throw new Error(
      'The winax COM module could not be loaded in this build ' +
      `(${e && e.message ? e.message : 'not packaged or not compiled for Electron'}). ` +
      'Reinstall the app from a build that includes native modules, ' +
      'or use the "ETABS tables file" import instead.'
    );
  }
  // Per the CSI API docs (VBA example): Set myHelper = New ETABSv1.Helper.
  // "CSiAPIv1.Helper" is the SAP2000-family name, tried second for old installs.
  let helper = null;
  const helperProgIDs = ['ETABSv1.Helper', 'CSiAPIv1.Helper'];
  for (const progId of helperProgIDs) {
    try {
      helper = new winax.Object(progId);
      break;
    } catch { /* try next */ }
  }
  let etabsObject;
  if (!helper) {
    // No helper class registered — last resort: attach straight from the
    // Running Object Table (winax GetActiveObject path).
    try {
      etabsObject = new winax.Object('CSI.ETABS.API.ETABSObject', { activate: true });
    } catch {
      throw new Error(
        `CSI API helper is not registered on this machine (tried ${helperProgIDs.join(', ')}, ` +
        'and could not attach to a running ETABS via the Running Object Table). ' +
        'Make sure ETABS v18 or later is installed and has been run at least once, ' +
        'or use the "ETABS tables file" import instead.'
      );
    }
    sapModel = etabsObject.SapModel;
    return sapModel;
  }
  try {
    etabsObject = helper.GetObject('CSI.ETABS.API.ETABSObject');
  } catch (attachErr) {
    // GetObject attaches to an already-running instance. If none is found,
    // fall back to CreateObjectProgID which can start a new one
    // (only when the caller explicitly opts in via startIfNotRunning).
    if (attach._startIfNotRunning) {
      try {
        etabsObject = helper.CreateObjectProgID('CSI.ETABS.API.ETABSObject');
        etabsObject.ApplicationStart();
      } catch (startErr) {
        throw new Error(
          'Could not start ETABS automatically. ' +
          'Open ETABS, load your model, then try connecting again. ' +
          `(start error: ${startErr && startErr.message ? startErr.message : startErr})`
        );
      }
    } else {
      throw new Error(
        'No running ETABS instance found. ' +
        'Open ETABS and load your model, then try connecting again. ' +
        `(${attachErr && attachErr.message ? attachErr.message : attachErr})`
      );
    }
  }
  sapModel = etabsObject.SapModel;
  return sapModel;
}

/**
 * Switch the API's present units so all transmitted data has a known unit.
 * eUnits: kip_in_F=3 (depths/widths/fc/fy), kip_ft_F=4 (geometry/forces).
 * Errors are swallowed — if the call fails the model units remain unchanged.
 */
function setUnits(sm, eUnits) {
  try { sm.SetPresentUnits(eUnits); } catch { /* ignore */ }
}

/**
 * Invoke an OAPI method handling both winax out-parameter conventions.
 *
 * spec is an array of [kind, value] pairs in declared parameter order:
 *   ['in',  v]  — plain input argument
 *   ['out', v]  — by-ref out-parameter with initial value v
 *
 * Out-params are passed as `new winax.Variant(v, 'byref')` and read back
 * after the call (the documented winax mechanism). As a fallback — some
 * winax builds instead return all arguments positionally as an array —
 * any out slot that came back empty is filled from the return value at
 * the same index. Returns an array of resolved values, positionally
 * matching spec, so callers index it exactly like the OAPI signature.
 */
function invokeOAPI(target, method, spec) {
  const argv = spec.map(([kind, v]) => {
    if (kind === 'out' && winaxMod && winaxMod.Variant) {
      try { return new winaxMod.Variant(v, 'byref'); } catch { return v; }
    }
    return v;
  });
  const ret = target[method](...argv);
  const vals = spec.map(([kind, v], i) => {
    if (kind !== 'out') return v;
    const a = argv[i];
    if (a && typeof a.valueOf === 'function' && a !== v) {
      try {
        const got = a.valueOf();
        if (got !== undefined && got !== null) return got;
      } catch { /* fall through */ }
    }
    return undefined;
  });
  // Fallback: positional all-args return array
  if (ret != null && typeof ret === 'object' && typeof ret.length === 'number') {
    for (let i = 0; i < vals.length; i++) {
      const empty = vals[i] == null || (Array.isArray(vals[i]) && vals[i].length === 0);
      if (spec[i][0] === 'out' && empty && ret[i] !== undefined) vals[i] = ret[i];
    }
  }
  return vals;
}

/** GetNameList(NumberNames, MyName) — shared by Story/GroupDef/PropFrame/PropMaterial/RespCombo. */
function getNameList(target) {
  const r = invokeOAPI(target, 'GetNameList', [['out', 0], ['out', []]]);
  return variantToArray(r[1]);
}

/** Read a winax by-ref string-array out-parameter into a JS array. */
function variantToArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  // winax Variant with valueOf() → array
  const val = typeof v.valueOf === 'function' ? v.valueOf() : v;
  return Array.isArray(val) ? val : [val];
}

const handlers = {
  connect() {
    const sm = attach();
    let name = 'ETABS model';
    try { name = String(sm.GetModelFilename(false)); } catch { /* optional */ }
    // Report whatever units the model is currently using
    let units = 'kip-ft';
    try {
      const u = Number(sm.GetPresentUnits());
      const UNIT_LABELS = { 1:'lb-in', 2:'lb-ft', 3:'kip-in', 4:'kip-ft', 5:'kN-mm', 6:'kN-m', 7:'kgf-mm', 8:'kgf-m' };
      units = UNIT_LABELS[u] ?? `eUnits(${u})`;
    } catch { /* optional */ }
    return { modelName: name, units };
  },

  getStories() {
    const sm = attach();
    return getNameList(sm.Story);
  },

  getGroups() {
    const sm = attach();
    return getNameList(sm.GroupDef);
  },

  getFrameSections() {
    const sm = attach();
    setUnits(sm, 3); // kip-in: T3/T2 in inches
    const names = getNameList(sm.PropFrame);
    const out = [];
    for (const name of names) {
      try {
        // GetRectangle(Name, FileName, MatProp, T3[depth], T2[width], Color, Notes, GUID)
        const r = invokeOAPI(sm.PropFrame, 'GetRectangle', [
          ['in', name], ['out', ''], ['out', ''], ['out', 0], ['out', 0],
          ['out', 0], ['out', ''], ['out', ''],
        ]);
        out.push({
          name,
          material: String(r[2] ?? ''),
          shape: 'Rectangular',
          depth: Number(r[3] ?? 0), // T3 = depth (in)
          width: Number(r[4] ?? 0), // T2 = width (in)
        });
      } catch {
        // non-rectangular sections skipped (steel shapes, etc.)
      }
    }
    return out;
  },

  getMaterials() {
    const sm = attach();
    setUnits(sm, 3); // kip-in: Fc/Fy in ksi; ×1000 below converts to psi
    const names = getNameList(sm.PropMaterial);
    const out = [];
    for (const name of names) {
      try {
        // GetOConcrete_1(Name, Fc, IsLightweight, FcsFactor, SSType, SSHysType,
        //               StrainAtFc, StrainUltimate, FinalSlope, FrictionAngle,
        //               DilatationalAngle [, Temp])
        const c = invokeOAPI(sm.PropMaterial, 'GetOConcrete_1', [
          ['in', name], ['out', 0], ['out', false], ['out', 0], ['out', 0],
          ['out', 0], ['out', 0], ['out', 0], ['out', 0], ['out', 0], ['out', 0],
        ]);
        const fc = Number(c[1] ?? 0);
        if (fc > 0) { out.push({ name, fc: fc * 1000 }); continue; } // ksi → psi
      } catch { /* not concrete */ }
      try {
        // GetORebar_1(Name, Fy, Fu, EFy, EFu, SSType, SSHysType,
        //             StrainAtHardening, StrainUltimate, FinalSlope,
        //             UseCaltransSSDefaults [, Temp])
        const r = invokeOAPI(sm.PropMaterial, 'GetORebar_1', [
          ['in', name], ['out', 0], ['out', 0], ['out', 0], ['out', 0],
          ['out', 0], ['out', 0], ['out', 0], ['out', 0], ['out', 0], ['out', false],
        ]);
        const fy = Number(r[1] ?? 0);
        if (fy > 0) out.push({ name, fy: fy * 1000 }); // ksi → psi
      } catch { /* not rebar */ }
    }
    return out;
  },

  getCombos() {
    const sm = attach();
    return getNameList(sm.RespCombo);
  },

  getBeams() {
    const sm = attach();
    setUnits(sm, 4); // kip-ft: coordinates in ft
    // GetAllFrames signature (20 required by-ref + optional csys):
    // NumberNames, MyName, PropName, StoryName, PointName1, PointName2,
    // Point1X, Point1Y, Point1Z, Point2X, Point2Y, Point2Z, Angle,
    // Offset1X, Offset2X, Offset1Y, Offset2Y, Offset1Z, Offset2Z, CardinalPoint
    const r = invokeOAPI(sm.FrameObj, 'GetAllFrames', [
      ['out', 0],                                              // NumberNames
      ['out', []], ['out', []], ['out', []],                   // MyName, PropName, StoryName
      ['out', []], ['out', []],                                // PointName1, PointName2
      ['out', []], ['out', []], ['out', []],                   // Point1 X/Y/Z
      ['out', []], ['out', []], ['out', []],                   // Point2 X/Y/Z
      ['out', []],                                             // Angle
      ['out', []], ['out', []], ['out', []], ['out', []],      // Offset1X/2X/1Y/2Y
      ['out', []], ['out', []],                                // Offset1Z/2Z
      ['out', []],                                             // CardinalPoint
    ]);
    const names   = variantToArray(r[1]);
    const props   = variantToArray(r[2]);
    const stories = variantToArray(r[3]);
    const x1 = variantToArray(r[6]),  y1 = variantToArray(r[7]),  z1 = variantToArray(r[8]);
    const x2 = variantToArray(r[9]),  y2 = variantToArray(r[10]), z2 = variantToArray(r[11]);

    const beams = [];
    for (let i = 0; i < names.length; i++) {
      const pt1 = { x: Number(x1[i]), y: Number(y1[i]), z: Number(z1[i]) };
      const pt2 = { x: Number(x2[i]), y: Number(y2[i]), z: Number(z2[i]) };
      // Horizontal members = beams (columns are vertical, braces inclined)
      const dz = Math.abs(pt2.z - pt1.z);
      const planLen = Math.hypot(pt2.x - pt1.x, pt2.y - pt1.y);
      if (planLen < 0.5 || dz > 0.1 * planLen) continue;
      beams.push({
        name: String(names[i]),
        story: String(stories[i] ?? ''),
        section: String(props[i] ?? ''),
        pt1, pt2,
        groups: groupsOf(sm, String(names[i])),
        lengthFt: Math.hypot(pt2.x - pt1.x, pt2.y - pt1.y, pt2.z - pt1.z),
      });
    }
    return beams;
  },

  getStationForces({ frameNames, combos }) {
    const sm = attach();
    setUnits(sm, 4); // kip-ft: V in kip, M/T in kip-ft
    sm.Results.Setup.DeselectAllCasesAndCombosForOutput();
    for (const combo of combos) sm.Results.Setup.SetComboSelectedForOutput(combo, true);

    const out = {};
    const emptyFrames = [];
    for (const frame of frameNames) {
      // FrameForce(Name, ItemTypeElm, NumberResults, Obj, ObjSta, Elm, ElmSta,
      //            LoadCase, StepType, StepNum, P, V2, V3, T, M2, M3)
      // Positional indices: ObjSta=4, LoadCase=7, P=10, V2=11, T=13, M3=15
      const r = invokeOAPI(sm.Results, 'FrameForce', [
        ['in', frame], ['in', 0],                 // Name, ItemTypeElm=ObjectElm
        ['out', 0],                               // NumberResults
        ['out', []], ['out', []],                 // Obj, ObjSta
        ['out', []], ['out', []],                 // Elm, ElmSta
        ['out', []], ['out', []], ['out', []],    // LoadCase, StepType, StepNum
        ['out', []], ['out', []], ['out', []],    // P, V2, V3
        ['out', []], ['out', []], ['out', []],    // T, M2, M3
      ]);
      const numResults = Number(r[2] ?? 0);
      if (numResults === 0) {
        // Skip frames with no output (e.g. added after the analysis ran);
        // only fail if NOTHING has results — that means analysis wasn't run.
        emptyFrames.push(frame);
        out[frame] = [];
        continue;
      }
      const objSta    = variantToArray(r[4]);  // ObjSta: station distances (ft)
      const combosOut = variantToArray(r[7]);  // LoadCase: combo name per row
      const P         = variantToArray(r[10]); // axial (kip)
      const V2        = variantToArray(r[11]); // shear (kip)
      const T         = variantToArray(r[13]); // torsion (kip-ft)
      const M3        = variantToArray(r[15]); // moment (kip-ft)

      const byCombo = new Map();
      for (let i = 0; i < objSta.length; i++) {
        const combo = String(combosOut[i] ?? '');
        if (!byCombo.has(combo)) byCombo.set(combo, { combo, stations: [] });
        byCombo.get(combo).stations.push({
          x: Number(objSta[i]),
          V: Number(V2[i]),
          M: Number(M3[i]),
          P: Number(P[i]),
          T: Number(T[i]),
        });
      }
      for (const cf of byCombo.values()) cf.stations.sort((a, b) => a.x - b.x);
      out[frame] = [...byCombo.values()];
    }
    if (frameNames.length && emptyFrames.length === frameNames.length) {
      throw new Error(
        'No analysis results for any requested frame — has the analysis been run? ' +
        'Open ETABS → Analyze → Run Analysis, then try the import again.'
      );
    }
    return out;
  },
};

function groupsOf(sm, frameName) {
  try {
    // GetGroupAssign(Name, NumberGroups, Groups)
    const r = invokeOAPI(sm.FrameObj, 'GetGroupAssign', [
      ['in', frameName], ['out', 0], ['out', []],
    ]);
    return variantToArray(r[2]).map(String);
  } catch {
    return [];
  }
}

/** Register the single 'etabs' IPC channel. */
function registerEtabsBridge(ipcMain) {
  ipcMain.handle('etabs', async (_event, { method, args }) => {
    const fn = handlers[method];
    if (!fn) throw new Error(`Unknown ETABS bridge method: ${method}`);
    return fn(args);
  });
}

module.exports = { registerEtabsBridge };
