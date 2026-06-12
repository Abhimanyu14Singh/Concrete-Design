"""
ETABS Bridge Server for S-Concrete Design
=========================================
Attaches to a running ETABS instance via the CSI .NET API (pythonnet +
ETABSv1.dll — no COM registration needed) and serves model data as JSON
on http://127.0.0.1:8744 for the app's "ETABS bridge server" import source.

REQUIREMENTS (one-time install):
    py -3.11 -m pip install pythonnet

USAGE:
    1. Open your model in ETABS and run the analysis
    2. py -3.11 tools/etabs_bridge.py            (auto-finds ETABSv1.dll)
       py -3.11 tools/etabs_bridge.py --dll "C:\\path\\to\\ETABSv1.dll"
    3. In the app: Import Beams from ETABS -> "ETABS bridge server (Python)"
"""

import argparse
import json
import os
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

PORT = 8744

# Default install locations searched for ETABSv1.dll (newest first)
DLL_CANDIDATES = [
    r"C:\Program Files\Computers and Structures\ETABS 23\ETABSv1.dll",
    r"C:\Program Files\Computers and Structures\ETABS 22\ETABSv1.dll",
    r"C:\Program Files\Computers and Structures\ETABS 21\ETABSv1.dll",
    r"C:\Program Files\Computers and Structures\ETABS 20\ETABSv1.dll",
]

state = {
    "connected": False,
    "model": None,
    "error": None,
    "SapModel": None,
    "DatabaseTables": None,
    "dll": None,
}


# ══════════════════════════════════════════════════════════════════
#  CONNECTION  (pythonnet + .NET API — the path proven to work)
# ══════════════════════════════════════════════════════════════════
def connect():
    try:
        from pythonnet import load as pnload
        pnload("coreclr")
        import clr

        dll = state["dll"]
        if not dll:
            for cand in DLL_CANDIDATES:
                if os.path.exists(cand):
                    dll = cand
                    break
        if not dll or not os.path.exists(dll):
            raise FileNotFoundError(
                "ETABSv1.dll not found — pass --dll \"C:\\Program Files\\Computers "
                "and Structures\\ETABS XX\\ETABSv1.dll\""
            )
        state["dll"] = dll

        clr.AddReference(dll)
        from ETABSv1 import cHelper, Helper, cOAPI, cSapModel, cDatabaseTables

        helper = cHelper(Helper())
        etabs = cOAPI(helper.GetObject("CSI.ETABS.API.ETABSObject"))
        sap = cSapModel(etabs.SapModel)
        db = cDatabaseTables(sap.DatabaseTables)

        try:
            model_file = str(sap.GetModelFilename(False))
        except Exception:
            model_file = "ETABS model"

        state.update(connected=True, SapModel=sap, DatabaseTables=db,
                     model=model_file.split("\\")[-1], error=None)
        print(f"[ETABS Bridge] Connected: {state['model']}  (via {dll})")
        return True, state["model"]
    except Exception as e:
        state.update(connected=False, error=str(e))
        print(f"[ETABS Bridge] Failed: {e}")
        return False, str(e)


def disconnect():
    state.update(connected=False, SapModel=None, DatabaseTables=None,
                 model=None, error=None)
    print("[ETABS Bridge] Disconnected.")


# ══════════════════════════════════════════════════════════════════
#  TABLE HELPER
# ══════════════════════════════════════════════════════════════════
def get_table(table_key):
    db = state["DatabaseTables"]
    if not db:
        return []
    try:
        GroupName = ""; TableVersion = 0; FieldsKeysIncluded = []
        NumberRecords = 0; TableData = []
        ret, GroupName, TableVersion, FieldsKeysIncluded, NumberRecords, TableData = \
            db.GetTableForDisplayArray(table_key, [], GroupName,
                TableVersion, FieldsKeysIncluded, NumberRecords, TableData)
        if ret != 0 or NumberRecords == 0:
            return []
        fields = list(FieldsKeysIncluded)
        nf = len(fields)
        td = list(TableData)
        return [{fields[j]: td[i * nf + j] for j in range(nf)}
                for i in range(NumberRecords)]
    except Exception as e:
        print(f"[ETABS Bridge] Table error '{table_key}': {e}")
        return []


# ══════════════════════════════════════════════════════════════════
#  DATA ENDPOINTS
# ══════════════════════════════════════════════════════════════════
def api_status():
    return {"connected": state["connected"], "model": state["model"],
            "error": state["error"]}


def api_cases():
    rows = get_table("Load Combination Definitions") \
         + get_table("Load Case Definitions - Summary")
    cases, seen = [], set()
    for r in rows:
        n = r.get("Name", "") or r.get("ComboName", "")
        t = r.get("DesignType", "") or r.get("ComboType", "")
        if n and n not in seen:
            seen.add(n); cases.append({"name": n, "type": t})
    for r in get_table("Base Reactions"):
        n = r.get("OutputCase", "")
        if n and n not in seen:
            seen.add(n); cases.append({"name": n, "type": r.get("CaseType", "")})
    return {"cases": cases}


def _derive_rect_dims_mm(area, i33):
    """Derive b,h (mm) from Area and I33 assuming a rectangular section.
    Handles both mm-unit and m-unit ETABS models automatically."""
    if area <= 0 or i33 <= 0:
        return 0, 0
    h = (12.0 * i33 / area) ** 0.5
    b = area / h
    if h < 5.0:          # values look like metres -> convert to mm
        h *= 1000.0
        b *= 1000.0
    return round(b), round(h)


def api_joint_coords():
    return {"data": get_table("Point Object Connectivity")}


def api_beams():
    """Merged beam geometry + section assignments + derived b x h (mm)."""
    connectivity = get_table("Beam Object Connectivity")
    assignments = get_table("Frame Assignments - Section Properties")
    sect_summary = get_table("Frame Section Property Definitions - Summary")

    sect_dims = {}
    for s in sect_summary:
        name = s.get("Name", "")
        try:
            area = float(s.get("Area", 0) or 0)
            i33 = float(s.get("I33", 0) or 0)
            b, h = _derive_rect_dims_mm(area, i33)
        except Exception:
            b, h = 0, 0
        sect_dims[name] = {"b": b, "h": h,
                           "material": s.get("Material", ""),
                           "shape": s.get("Shape", "")}

    assign_map = {a.get("UniqueName", ""): a.get("SectProp", "")
                  for a in assignments}

    beams = []
    for row in connectivity:
        un = row.get("UniqueName", "")
        sect = assign_map.get(un, "")
        d = sect_dims.get(sect, {"b": 0, "h": 0, "material": "", "shape": ""})
        beams.append({
            "uniqueName": un,
            "story":      row.get("Story", ""),
            "beamBay":    row.get("BeamBay", ""),
            "ptI":        row.get("UniquePtI", ""),
            "ptJ":        row.get("UniquePtJ", ""),
            "length":     row.get("Length", ""),
            "section":    sect,
            "b":          d["b"],
            "h":          d["h"],
            "material":   d["material"],
        })

    stories = sorted({b["story"] for b in beams if b["story"]})
    return {"beams": beams, "stories": stories}


def api_beam_forces():
    """Design Forces - Beams (per-station P, V2, M3, T per combo)."""
    rows = get_table("Design Forces - Beams")
    cap = 100_000
    return {"data": rows[:cap], "total": len(rows), "capped": len(rows) > cap}


def api_table(table_key):
    rows = get_table(table_key)
    return {"key": table_key, "rows": rows, "count": len(rows)}


# ══════════════════════════════════════════════════════════════════
#  HTTP SERVER
# ══════════════════════════════════════════════════════════════════
class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200); self._cors(); self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        qs = parse_qs(parsed.query)

        routes = {
            "/status":       api_status,
            "/cases":        api_cases,
            "/joint-coords": api_joint_coords,
            "/beams":        api_beams,
            "/beam-forces":  api_beam_forces,
        }

        if path == "/table":
            key = qs.get("key", [None])[0]
            if not key:
                self._json(400, {"error": "?key= required"}); return
            try:
                self._json(200, api_table(key))
            except Exception as e:
                self._json(500, {"error": str(e)})
            return

        fn = routes.get(path)
        if fn:
            try:
                self._json(200, fn())
            except Exception as e:
                self._json(500, {"error": str(e),
                                 "trace": traceback.format_exc()})
        else:
            self._json(404, {"error": f"Unknown: {path}"})

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        if path == "/connect":
            ok, msg = connect()
            self._json(200 if ok else 500, {"ok": ok, "message": msg})
        elif path == "/disconnect":
            disconnect(); self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "Unknown endpoint"})

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, data):
        body = json.dumps(data, default=str).encode("utf-8")
        self.send_response(code); self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"[ETABS Bridge] {self.address_string()} {fmt % args}")


# ══════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════
def main():
    ap = argparse.ArgumentParser(description="ETABS bridge server")
    ap.add_argument("--dll", help="Path to ETABSv1.dll (auto-detected if omitted)")
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()
    if args.dll:
        state["dll"] = args.dll

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    print("=" * 60)
    print("  ETABS Bridge Server — S-Concrete Design")
    print("=" * 60)
    print(f"  Listening on  http://127.0.0.1:{args.port}")
    print()
    print("  POST /connect          attach to running ETABS")
    print("  POST /disconnect       detach")
    print("  GET  /status           connection status")
    print("  GET  /cases            load cases + combos")
    print("  GET  /beams            beam geometry + sections")
    print("  GET  /joint-coords     point coordinates")
    print("  GET  /beam-forces      Design Forces - Beams table")
    print("  GET  /table?key=...    any ETABS table by key")
    print()
    print("  In the app: Import Beams from ETABS ->")
    print("  \"ETABS bridge server (Python)\" -> Connect")
    print("  Press Ctrl+C to stop.")
    print("=" * 60)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[ETABS Bridge] Stopped.")
        server.shutdown()


if __name__ == "__main__":
    main()
