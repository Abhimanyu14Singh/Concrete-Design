/**
 * ACI 318-19 rectangular-column biaxial moment capacity by the rotating
 * neutral-axis (resultant-moment) method — ported from Column_Design_DW's
 * design_engine.py (`_biaxial_phi_mrtht`), which is calibrated against
 * S-Concrete.
 *
 * This replaces the Bresler reciprocal approximation in aciColumn.ts for the
 * rectangular biaxial path: given a factored axial load Pu and a resultant
 * moment direction θ = atan2(|M2|, |M3|), it returns φMr (kip-ft), the design
 * resultant-moment capacity on the P-M interaction surface in that direction.
 *
 * Units are ksi / in / kips / kip-ft to mirror the Python reference 1:1.
 * Sign convention (matching ETABS / the reference): Pu negative = compression.
 *
 * Solver: two nested loops —
 *   outer: bisection on neutral-axis depth c to hit the target axial load,
 *   inner: bisection on the NA angle so the produced moment vector points along
 *          θ (this captures the M3↔M2 coupling that Bresler cannot).
 */

const PHI = { tied: 0.65, spiral: 0.75 } as const;
const ALPHA = { tied: 0.8, spiral: 0.85 } as const;
const ES_KSI = 29000.0;
const ECU = 0.003;

export interface BiaxialParams {
  b: number; // width, in (z / M2 direction)
  h: number; // depth, in (y / M3 direction)
  fcKsi: number;
  fyKsi: number;
  cover: number; // clear cover, in
  AbLong: number; // area of one longitudinal bar, in²
  dbLong: number; // longitudinal bar diameter, in
  dsTie: number; // tie bar diameter, in
  nz: number; // bars per left/right face (incl. corners)
  ny: number; // bars per top/bottom face (incl. corners)
  tieType: 'tied' | 'spiral';
}

type Pt = [number, number]; // (u, v)

/** Sutherland-Hodgman clip of polygon to u <= uMax. poly = list of (u,v). */
export function clipPolyU(poly: Pt[], uMax: number): Pt[] {
  const result: Pt[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % n];
    const curIn = cur[0] <= uMax;
    const nxtIn = nxt[0] <= uMax;
    if (curIn) result.push(cur);
    if (curIn !== nxtIn) {
      const du = nxt[0] - cur[0];
      const t = (uMax - cur[0]) / du;
      result.push([uMax, cur[1] + t * (nxt[1] - cur[1])]);
    }
  }
  return result;
}

/** Shoelace: returns [area, uCentroid, vCentroid] of polygon [(u,v),...]. */
export function polyAreaCuv(poly: Pt[]): [number, number, number] {
  const n = poly.length;
  if (n < 3) return [0, 0, 0];
  let A = 0, Cu = 0, Cv = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cross = poly[i][0] * poly[j][1] - poly[j][0] * poly[i][1];
    A += cross;
    Cu += (poly[i][0] + poly[j][0]) * cross;
    Cv += (poly[i][1] + poly[j][1]) * cross;
  }
  A /= 2;
  if (Math.abs(A) < 1e-12) return [0, 0, 0];
  Cu /= 6 * A;
  Cv /= 6 * A;
  return [Math.abs(A), Cu, Cv];
}

function nBarsTotalRect(nz: number, ny: number): number {
  return 2 * (nz + ny) - 4;
}

/**
 * φMr (kip-ft) at axial load PuKip and resultant-moment direction thetaMoment
 * (radians, = atan2(|M2|, |M3|)). Returns null when Pu is outside the diagram
 * range, or (in the high-compression "OC" zone) when the interpolated capacity
 * is below ~1 kip-ft (treated as axially governed by the reference).
 */
export function biaxialPhiMr(PuKip: number, thetaMoment: number, p: BiaxialParams): number | null {
  const { b, h, fcKsi, fyKsi, cover, AbLong: Ab, dbLong: db, dsTie: ds, nz, ny, tieType } = p;

  const fyCap = Math.min(fyKsi, 80.0);
  const fcPsi = fcKsi * 1000.0;
  const beta1 = fcPsi <= 4000.0 ? 0.85 : Math.max(0.65, 0.85 - 0.05 * (fcPsi - 4000.0) / 1000.0);

  const edge = cover + ds + db / 2.0;
  const phiC = PHI[tieType];
  const phiT = 0.9;
  const kCap = ALPHA[tieType];
  const ey = fyKsi / ES_KSI;

  const Ag = b * h;
  const nB = nBarsTotalRect(nz, ny);
  const Ast = nB * Ab;
  const b2 = b / 2.0;
  const h2 = h / 2.0;

  const Po = 0.85 * fcKsi * (Ag - Ast) + fyKsi * Ast;
  const phiPnMax = -phiC * kCap * Po; // negative (compression)
  const phiPnt = phiT * fyKsi * Ast; // positive (tension)
  const phiPo = -phiC * Po; // negative

  const phi = (et: number): number => {
    const etTc = ey + 0.003;
    if (et <= ey) return phiC;
    if (et >= etTc) return phiT;
    return phiC + (phiT - phiC) * (et - ey) / 0.003;
  };

  // Bar positions in section coords (z = b direction, y = h direction).
  const barZy: Pt[] = [];
  const zL = -(b2 - edge), zR = +(b2 - edge);
  for (let i = 0; i < nz; i++) {
    const yi = nz > 1 ? -(h2 - edge) + i * (h - 2 * edge) / (nz - 1) : 0.0;
    barZy.push([zL, yi]);
    barZy.push([zR, yi]);
  }
  const nTb = ny - 2;
  if (nTb > 0) {
    for (let j = 1; j <= nTb; j++) {
      const zj = -(b2 - edge) + j * (b - 2 * edge) / (ny - 1);
      barZy.push([zj, h2 - edge]);
      barZy.push([zj, -(h2 - edge)]);
    }
  }
  const rectCornersZy: Pt[] = [[b2, h2], [-b2, h2], [-b2, -h2], [b2, -h2]];

  /** Strain-compat at depth c, NA angle th. Returns [Pn, M3_kin, M2_kin, et]. */
  const sc = (c: number, th: number): [number, number, number, number] => {
    const ct = Math.cos(th), st = Math.sin(th);
    const dMax = b2 * Math.abs(st) + h2 * Math.abs(ct);
    const DFull = b * Math.abs(st) + h * Math.abs(ct);

    const buv: Pt[] = barZy.map(([bz, by]) => [dMax - (bz * st + by * ct), bz * ct - by * st]);
    let dt = -Infinity;
    for (const [u] of buv) if (u > dt) dt = u;
    const a = Math.min(beta1 * c, DFull);

    let compArea: number, uC: number, vC: number;
    if (a >= DFull) {
      compArea = Ag; uC = DFull / 2.0; vC = 0.0;
    } else {
      const cornersUv: Pt[] = rectCornersZy.map(([bz, by]) => [dMax - (bz * st + by * ct), bz * ct - by * st]);
      const clipped = clipPolyU(cornersUv, a);
      if (clipped.length < 3) { compArea = 0; uC = 0; vC = 0; }
      else [compArea, uC, vC] = polyAreaCuv(clipped);
    }

    const Cc = 0.85 * fcKsi * compArea;
    const yc = ct * (dMax - uC) - st * vC;
    const zc = st * (dMax - uC) + ct * vC;
    const M3c = Cc * yc;
    const M2c = Cc * zc;

    let Ps = 0, M3s = 0, M2s = 0;
    for (let k = 0; k < barZy.length; k++) {
      const [bz, by] = barZy[k];
      const ui = buv[k][0];
      const epsI = c > 1e-9 ? ECU * (c - ui) / c : (ui < dMax ? 0.005 : -0.005);
      const fsI = Math.max(-fyCap, Math.min(fyCap, ES_KSI * epsI));
      const fsNet = fsI - (ui <= a ? 0.85 * fcKsi : 0.0);
      const F = Ab * fsNet;
      M3s += F * by;
      M2s += F * bz;
      Ps += F;
    }

    const Pn = Cc + Ps;
    const M3 = M3c + M3s;
    const M2 = M2c + M2s;
    const et = c > 1e-9 ? ECU * (dt - c) / c : 0.005;
    return [Pn, M3, M2, et];
  };

  const thetaActual = (c: number, th: number): number => {
    const [, M3, M2] = sc(c, th);
    if (Math.abs(M3) < 1e-6) return Math.PI / 2.0;
    return Math.atan2(Math.abs(M2), Math.abs(M3));
  };

  const findTh = (c: number): number => {
    let lo = 1e-9, hi = Math.PI / 2.0 - 1e-9;
    if (thetaActual(c, hi) < thetaMoment) return hi;
    if (thetaActual(c, lo) > thetaMoment) return lo;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2.0;
      if (thetaActual(c, mid) < thetaMoment) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2.0;
  };

  // Boundary checks
  if (PuKip < phiPo) return null; // more compression than φPo
  if (PuKip > phiPnt) return null; // more tension than φPnt

  const phinAtC = (c: number): number => {
    const th = findTh(c);
    const [Pn, , , et] = sc(c, th);
    return -phi(et) * Pn; // negative = compression
  };

  const DRef = b * Math.sin(thetaMoment) + h * Math.cos(thetaMoment);
  const cLo = Math.max(edge * 0.4, 0.01);

  const pnLo = phinAtC(cLo); // ≈ φPnt (tension side, positive)
  const pnDref = phinAtC(DRef);

  let cclLo: number, cclHi: number;
  if (pnDref >= phiPnMax) { cclLo = DRef; cclHi = DRef * 6.0; }
  else { cclLo = cLo; cclHi = DRef; }
  for (let i = 0; i < 45; i++) {
    const cMid = (cclLo + cclHi) / 2.0;
    if (phinAtC(cMid) > phiPnMax) cclLo = cMid;
    else cclHi = cMid;
  }
  const cCL = (cclLo + cclHi) / 2.0;

  const thCL = findTh(cCL);
  const [, M3CL, M2CL, etCL] = sc(cCL, thCL);
  const phiMrCL = phi(etCL) * Math.sqrt(M3CL * M3CL + M2CL * M2CL) / 12.0;

  // OC zone: φPo ≤ Pu ≤ φPn,max (high compression) — straight line.
  if (phiPo <= PuKip && PuKip <= phiPnMax) {
    if (Math.abs(phiPnMax - phiPo) < 1e-9) return null;
    const t = (PuKip - phiPo) / (phiPnMax - phiPo);
    const result = Math.max(0.0, t * phiMrCL);
    return result < 1.0 ? null : result;
  }

  // Non-OC zone: bisect c in [cLo, cCL] to find c where φPn(c) = Pu.
  if (PuKip > pnLo) return null; // beyond tension limit
  let cbLo = cLo, cbHi = cCL;
  for (let i = 0; i < 50; i++) {
    const cMid = (cbLo + cbHi) / 2.0;
    if (phinAtC(cMid) > PuKip) cbLo = cMid;
    else cbHi = cMid;
  }
  const cExact = (cbLo + cbHi) / 2.0;
  const thE = findTh(cExact);
  const [, M3e, M2e, etE] = sc(cExact, thE);
  return Math.max(0.0, phi(etE) * Math.sqrt(M3e * M3e + M2e * M2e) / 12.0);
}
