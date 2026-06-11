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

function attach() {
  if (sapModel) return sapModel;
  let winax;
  try {
    // Lazy require so non-Windows builds never load the native module
    // eslint-disable-next-line global-require
    winax = require('winax');
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
  let helper;
  try {
    helper = new winax.Object('CSiAPIv1.Helper');
  } catch {
    throw new Error(
      'CSI API helper (CSiAPIv1.Helper) is not registered on this machine. ' +
      'Make sure ETABS is installed and has been run at least once.'
    );
  }
  let etabsObject;
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
    const ret = sm.Story.GetNameList(0, []);
    return variantToArray(ret?.[1] ?? ret);
  },

  getGroups() {
    const sm = attach();
    const ret = sm.GroupDef.GetNameList(0, []);
    return variantToArray(ret?.[1] ?? ret);
  },

  getFrameSections() {
    const sm = attach();
    setUnits(sm, 3); // kip-in: T3/T2 in inches
    const names = variantToArray(sm.PropFrame.GetNameList(0, [])?.[1]);
    const out = [];
    for (const name of names) {
      try {
        // GetRectangle(Name, FileName, MatProp, T3[depth], T2[width], Color, Notes, GUID)
        const r = sm.PropFrame.GetRectangle(name, '', '', 0, 0, 0, '', '');
        out.push({
          name,
          material: String(r?.[2] ?? ''),
          shape: 'Rectangular',
          depth: Number(r?.[3] ?? 0), // T3 = depth (in)
          width: Number(r?.[4] ?? 0), // T2 = width (in)
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
    const names = variantToArray(sm.PropMaterial.GetNameList(0, [])?.[1]);
    const out = [];
    for (const name of names) {
      try {
        // GetOConcrete_1(Name, Fc, IsLightweight, FcsFactor, SSType, SSHysType,
        //               StrainAtFc, StrainUltimate, FinalSlope, FrictionAngle,
        //               DilatationalAngle [, Temp])
        const c = sm.PropMaterial.GetOConcrete_1(name, 0, false, 0, 0, 0, 0, 0, 0, 0, 0);
        out.push({ name, fc: Number(c?.[1] ?? 0) * 1000 }); // ksi → psi
        continue;
      } catch { /* not concrete */ }
      try {
        // GetORebar_1(Name, Fy, Fu, EFy, EFu, SSType, SSHysType,
        //             StrainAtHardening, StrainUltimate, FinalSlope,
        //             UseCaltransSSDefaults [, Temp])
        const r = sm.PropMaterial.GetORebar_1(name, 0, 0, 0, 0, 0, 0, 0, 0, 0, false);
        out.push({ name, fy: Number(r?.[1] ?? 0) * 1000 }); // ksi → psi
      } catch { /* not rebar */ }
    }
    return out;
  },

  getCombos() {
    const sm = attach();
    const ret = sm.RespCombo.GetNameList(0, []);
    return variantToArray(ret?.[1] ?? ret);
  },

  getBeams() {
    const sm = attach();
    setUnits(sm, 4); // kip-ft: coordinates in ft
    // GetAllFrames signature (20 required by-ref + optional csys):
    // NumberNames, MyName, PropName, StoryName, PointName1, PointName2,
    // Point1X, Point1Y, Point1Z, Point2X, Point2Y, Point2Z, Angle,
    // Offset1X, Offset2X, Offset1Y, Offset2Y, Offset1Z, Offset2Z, CardinalPoint
    const r = sm.FrameObj.GetAllFrames(
      0, [], [], [], [], [], [], [], [], [], [], [], [],
      [], [], [], [], [], [], [],
    );
    const names   = variantToArray(r?.[1]);
    const props   = variantToArray(r?.[2]);
    const stories = variantToArray(r?.[3]);
    const x1 = variantToArray(r?.[6]),  y1 = variantToArray(r?.[7]),  z1 = variantToArray(r?.[8]);
    const x2 = variantToArray(r?.[9]),  y2 = variantToArray(r?.[10]), z2 = variantToArray(r?.[11]);

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
    for (const frame of frameNames) {
      // FrameForce(Name, ItemTypeElm, NumberResults, Obj, ObjSta, Elm, ElmSta,
      //            LoadCase, StepType, StepNum, P, V2, V3, T, M2, M3)
      // Positional indices: ObjSta=4, LoadCase=7, P=10, V2=11, T=13, M3=15
      const r = sm.Results.FrameForce(
        frame, 0, 0, [], [], [], [], [], [], [], [], [], [], [], [], [],
      );
      const numResults = Number(r?.[2] ?? 0);
      if (numResults === 0) {
        throw new Error(
          `No results for frame "${frame}" — has the analysis been run? ` +
          'Open ETABS → Analyze → Run Analysis, then lock the model before connecting.'
        );
      }
      const objSta    = variantToArray(r?.[4]);  // ObjSta: station distances (ft)
      const combosOut = variantToArray(r?.[7]);  // LoadCase: combo name per row
      const P         = variantToArray(r?.[10]); // axial (kip)
      const V2        = variantToArray(r?.[11]); // shear (kip)
      const T         = variantToArray(r?.[13]); // torsion (kip-ft)
      const M3        = variantToArray(r?.[15]); // moment (kip-ft)

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
    return out;
  },
};

function groupsOf(sm, frameName) {
  try {
    const r = sm.FrameObj.GetGroupAssign(frameName, 0, []);
    return variantToArray(r?.[2] ?? r?.[1]).map(String);
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
