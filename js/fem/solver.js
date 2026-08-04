/**
 * fem/solver.js — Linear elastic 3D frame solver (Theory I / first order).
 *
 * Replicates Karamba3D's "Analyze Th.I" behavior for beam models:
 *   - 3D Euler-Bernoulli beam elements, 6 DOF per node (ux uy uz rx ry rz)
 *   - Supports fix individual DOFs
 *   - Point loads + gravity (self-weight) load cases
 *   - Outputs: nodal displacements, member end forces, axial/bending stresses,
 *     utilization vs yield strength, reactions, max displacement, elastic energy.
 *
 * Units follow Karamba defaults: geometry in m, forces in kN, E/fy in kN/cm².
 * Internally converted to kN and m (E in kN/m² = kN/cm² * 1e4).
 */

const DOF = 6;

export class FemModel {
  constructor() {
    this.nodes = [];          // [{x,y,z}]
    this.elements = [];       // [{n0,n1, crosec, material, id}]
    this.supports = [];       // [{node, fix:[tx,ty,tz,rx,ry,rz]}]
    this.pointLoads = [];     // [{node, force:[fx,fy,fz], moment:[mx,my,mz]}]
    this.gravity = null;      // {vec:[gx,gy,gz]} multiples of g (Karamba: vector, usually (0,0,-1))
    this.nodeMap = new Map(); // "x,y,z" -> index
  }

  addNode(x, y, z) {
    const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
    if (this.nodeMap.has(key)) return this.nodeMap.get(key);
    const idx = this.nodes.length;
    this.nodes.push({ x, y, z });
    this.nodeMap.set(key, idx);
    return idx;
  }

  addBeam(p0, p1, crosec, material, id = '') {
    const n0 = this.addNode(p0.x, p0.y, p0.z);
    const n1 = this.addNode(p1.x, p1.y, p1.z);
    this.elements.push({ n0, n1, crosec, material, id });
  }

  findClosestNode(p, tol = 1e-3) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const d = Math.hypot(n.x - p.x, n.y - p.y, n.z - p.z);
      if (d < bestD) { bestD = d; best = i; }
    }
    return bestD <= tol ? best : -1;
  }
}

/* ---------------- default materials (Karamba defaults, kN/cm²) -------------- */

export const MATERIALS = {
  'Steel S235':    { E: 21000, G: 8076, gamma: 78.5, fy: 23.5, color: 0x8a9bb0 },
  'Steel S355':    { E: 21000, G: 8076, gamma: 78.5, fy: 35.5, color: 0x7a8ba0 },
  'Concrete C30/37': { E: 3300, G: 1375, gamma: 25.0, fy: 3.0,  color: 0xb5b0a8 },
  'Concrete C45/55': { E: 3600, G: 1500, gamma: 25.0, fy: 4.5,  color: 0xaaa59d },
  'Wood C24':      { E: 1100, G: 69,   gamma: 4.2,  fy: 2.4,  color: 0xc09a63 },
  'Aluminum 6061': { E: 7000, G: 2633, gamma: 27.0, fy: 24.0, color: 0xc4c9cf },
};
// E, G, fy in kN/cm²; gamma (unit weight) in kN/m³

/* ---------------- cross sections ------------------------------------------- */
// All section dims in cm (Karamba convention). Properties: A cm², Iy,Iz cm⁴, J cm⁴ (It), Wy,Wz cm³.

export function rectangleCroSec(h = 10, b = 10, name = '') {
  const A = b * h;
  const Iy = (b * h ** 3) / 12;  // bending about local y (strong if h>b)
  const Iz = (h * b ** 3) / 12;
  // torsion constant approximation for solid rectangle
  const a = Math.max(b, h) / 2, c = Math.min(b, h) / 2;
  const J = a * c ** 3 * (16 / 3 - 3.36 * (c / a) * (1 - c ** 4 / (12 * a ** 4)));
  return { shape: 'rect', name: name || `Rect ${h}x${b}`, h, b, A, Iy, Iz, J, Wy: Iy / (h / 2), Wz: Iz / (b / 2) };
}

export function circleCroSec(d = 10, t = 0, name = '') {
  // t=0 → solid, t>0 → hollow (CHS)
  const ro = d / 2, ri = t > 0 ? Math.max(ro - t, 0) : 0;
  const A = Math.PI * (ro ** 2 - ri ** 2);
  const I = Math.PI * (ro ** 4 - ri ** 4) / 4;
  const J = 2 * I;
  return { shape: 'circle', name: name || (t > 0 ? `CHS ${d}x${t}` : `Circle ${d}`), d, t, A, Iy: I, Iz: I, J, Wy: I / ro, Wz: I / ro };
}

export function iCroSec(h = 20, b = 10, tf = 1.0, tw = 0.6, name = '') {
  const hw = h - 2 * tf;
  const A = 2 * b * tf + hw * tw;
  const Iy = (b * h ** 3) / 12 - ((b - tw) * hw ** 3) / 12;
  const Iz = (2 * tf * b ** 3) / 12 + (hw * tw ** 3) / 12;
  const J = (2 * b * tf ** 3 + hw * tw ** 3) / 3;
  return { shape: 'I', name: name || `I ${h}x${b}`, h, b, tf, tw, A, Iy, Iz, J, Wy: Iy / (h / 2), Wz: Iz / (b / 2) };
}

// Common catalogue entries (like Karamba's cross section selector / table)
export const CROSEC_TABLE = {
  'IPE 80':  iCroSec(8, 4.6, 0.52, 0.38, 'IPE 80'),
  'IPE 100': iCroSec(10, 5.5, 0.57, 0.41, 'IPE 100'),
  'IPE 160': iCroSec(16, 8.2, 0.74, 0.5, 'IPE 160'),
  'IPE 200': iCroSec(20, 10, 0.85, 0.56, 'IPE 200'),
  'IPE 240': iCroSec(24, 12, 0.98, 0.62, 'IPE 240'),
  'IPE 300': iCroSec(30, 15, 1.07, 0.71, 'IPE 300'),
  'IPE 360': iCroSec(36, 17, 1.27, 0.8, 'IPE 360'),
  'IPE 400': iCroSec(40, 18, 1.35, 0.86, 'IPE 400'),
  'HEA 100': iCroSec(9.6, 10, 0.8, 0.5, 'HEA 100'),
  'HEA 200': iCroSec(19, 20, 1.0, 0.65, 'HEA 200'),
  'HEA 300': iCroSec(29, 30, 1.4, 0.85, 'HEA 300'),
  'CHS 60.3x3.2': circleCroSec(6.03, 0.32, 'CHS 60.3x3.2'),
  'CHS 88.9x4':   circleCroSec(8.89, 0.4, 'CHS 88.9x4'),
  'CHS 114.3x5':  circleCroSec(11.43, 0.5, 'CHS 114.3x5'),
  'CHS 168.3x6.3': circleCroSec(16.83, 0.63, 'CHS 168.3x6.3'),
};

export const DEFAULT_CROSEC = circleCroSec(11.43, 0.4, 'CHS 114.3x4'); // Karamba-ish default
export const DEFAULT_MATERIAL = 'Steel S235';

/* ---------------- element stiffness ----------------------------------------- */

/** 12x12 local stiffness matrix of a 3D beam. Units kN, m. */
function localStiffness(E, G, A, Iy, Iz, J, L) {
  const k = Array.from({ length: 12 }, () => new Float64Array(12));
  const EA = E * A / L;
  const GJ = G * J / L;
  const a_y = 12 * E * Iz / L ** 3, b_y = 6 * E * Iz / L ** 2, c_y = 4 * E * Iz / L, d_y = 2 * E * Iz / L;
  const a_z = 12 * E * Iy / L ** 3, b_z = 6 * E * Iy / L ** 2, c_z = 4 * E * Iy / L, d_z = 2 * E * Iy / L;

  const S = (i, j, v) => { k[i][j] = v; k[j][i] = v; };
  // axial (local x): dofs 0,6
  S(0, 0, EA); S(6, 6, EA); S(0, 6, -EA);
  // torsion (rx): dofs 3,9
  S(3, 3, GJ); S(9, 9, GJ); S(3, 9, -GJ);
  // bending in local x-y plane (v = uy, θz): dofs 1,5,7,11
  S(1, 1, a_y); S(7, 7, a_y); S(1, 7, -a_y);
  S(5, 5, c_y); S(11, 11, c_y); S(5, 11, d_y);
  S(1, 5, b_y); S(1, 11, b_y); S(7, 5, -b_y); S(7, 11, -b_y);
  // bending in local x-z plane (w = uz, θy): dofs 2,4,8,10 (note sign convention)
  S(2, 2, a_z); S(8, 8, a_z); S(2, 8, -a_z);
  S(4, 4, c_z); S(10, 10, c_z); S(4, 10, d_z);
  S(2, 4, -b_z); S(2, 10, -b_z); S(8, 4, b_z); S(8, 10, b_z);
  return k;
}

/** 3x3 rotation matrix: local axes (x along beam, z as close to global Z). */
function beamAxes(p0, p1) {
  let ex = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
  const L = Math.hypot(...ex);
  ex = ex.map(v => v / L);
  // reference vector: global Z unless beam is (near) vertical → use global X (Karamba convention)
  let ref = Math.abs(ex[2]) > 0.999 ? [1, 0, 0] : [0, 0, 1];
  // ey = ref × ex normalized... build ez in plane of ex,ref
  let ey = cross(ref, ex);
  const ln = Math.hypot(...ey);
  ey = ey.map(v => v / ln);
  const ez = cross(ex, ey);
  return { ex, ey, ez, L };
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Expand 3x3 direction cosines into 12x12 transformation T (block diagonal). */
function transformK(kLocal, ax) {
  const R = [ax.ex, ax.ey, ax.ez]; // rows: local axes in global coords
  // T maps global → local: uLocal = T uGlobal, with T = blockdiag(R,R,R,R)
  // kGlobal = Tᵀ kLocal T
  const T = Array.from({ length: 12 }, () => new Float64Array(12));
  for (let b = 0; b < 4; b++)
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        T[b * 3 + i][b * 3 + j] = R[i][j];
  // temp = kLocal * T
  const tmp = Array.from({ length: 12 }, () => new Float64Array(12));
  for (let i = 0; i < 12; i++)
    for (let j = 0; j < 12; j++) {
      let s = 0;
      for (let m = 0; m < 12; m++) s += kLocal[i][m] * T[m][j];
      tmp[i][j] = s;
    }
  const kG = Array.from({ length: 12 }, () => new Float64Array(12));
  for (let i = 0; i < 12; i++)
    for (let j = 0; j < 12; j++) {
      let s = 0;
      for (let m = 0; m < 12; m++) s += T[m][i] * tmp[m][j];
      kG[i][j] = s;
    }
  return { kG, T };
}

/* ---------------- solve ------------------------------------------------------ */

export function analyze(model) {
  const n = model.nodes.length;
  if (n === 0 || model.elements.length === 0) {
    return { ok: false, error: 'Model has no elements. Wire beams into Assemble.' };
  }
  const ndof = n * DOF;

  // Global stiffness (dense — fine up to a few thousand DOFs; typical GH-scale models)
  const K = Array.from({ length: ndof }, () => new Float64Array(ndof));
  const F = new Float64Array(ndof);
  const elemData = [];

  for (const el of model.elements) {
    const p0 = model.nodes[el.n0], p1 = model.nodes[el.n1];
    const ax = beamAxes(p0, p1);
    if (!isFinite(ax.L) || ax.L < 1e-9) continue;
    const mat = MATERIALS[el.material] || MATERIALS[DEFAULT_MATERIAL];
    const cs = el.crosec || DEFAULT_CROSEC;
    // convert: E [kN/cm²]→[kN/m²] ×1e4 ; A [cm²]→[m²] ×1e-4 ; I,J [cm⁴]→[m⁴] ×1e-8
    const E = mat.E * 1e4, G = mat.G * 1e4;
    const A = cs.A * 1e-4, Iy = cs.Iy * 1e-8, Iz = cs.Iz * 1e-8, J = cs.J * 1e-8;
    const kL = localStiffness(E, G, A, Iy, Iz, J, ax.L);
    const { kG, T } = transformK(kL, ax);
    const map = [];
    for (let d = 0; d < DOF; d++) map.push(el.n0 * DOF + d);
    for (let d = 0; d < DOF; d++) map.push(el.n1 * DOF + d);
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++)
        K[map[i]][map[j]] += kG[i][j];
    elemData.push({ el, ax, kL, T, map, E, A, cs, mat });

    // gravity as lumped nodal load: w = gamma * A * L (kN), split to both nodes
    if (model.gravity) {
      const w = mat.gamma * A * ax.L; // kN total self weight
      const g = model.gravity.vec;
      for (const nd of [el.n0, el.n1]) {
        F[nd * DOF + 0] += 0.5 * w * g[0];
        F[nd * DOF + 1] += 0.5 * w * g[1];
        F[nd * DOF + 2] += 0.5 * w * g[2];
      }
    }
  }

  // point loads
  for (const pl of model.pointLoads) {
    if (pl.node < 0 || pl.node >= n) continue;
    const base = pl.node * DOF;
    F[base] += pl.force[0]; F[base + 1] += pl.force[1]; F[base + 2] += pl.force[2];
    if (pl.moment) { F[base + 3] += pl.moment[0]; F[base + 4] += pl.moment[1]; F[base + 5] += pl.moment[2]; }
  }

  // supports: penalty-free elimination via big-number method is fragile; use row/col elimination
  const fixed = new Uint8Array(ndof);
  let anySupport = false;
  for (const s of model.supports) {
    if (s.node < 0 || s.node >= n) continue;
    anySupport = true;
    for (let d = 0; d < DOF; d++) if (s.fix[d]) fixed[s.node * DOF + d] = 1;
  }
  if (!anySupport) return { ok: false, error: 'Model has no supports — structure is kinematic. Add a Support component.' };

  // build reduced system
  const freeIdx = [];
  for (let i = 0; i < ndof; i++) if (!fixed[i]) freeIdx.push(i);
  const m = freeIdx.length;
  const Kr = Array.from({ length: m }, () => new Float64Array(m));
  const Fr = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    Fr[i] = F[freeIdx[i]];
    const Ki = K[freeIdx[i]];
    const Kri = Kr[i];
    for (let j = 0; j < m; j++) Kri[j] = Ki[freeIdx[j]];
  }

  const u_r = choleskySolve(Kr, Fr);
  if (!u_r) return { ok: false, error: 'Stiffness matrix is singular — structure is kinematic (under-constrained). Check supports.' };

  const u = new Float64Array(ndof);
  for (let i = 0; i < m; i++) u[freeIdx[i]] = u_r[i];

  // reactions: R = K u − F at fixed dofs
  const reactions = [];
  for (const s of model.supports) {
    const r = { node: s.node, force: [0, 0, 0], moment: [0, 0, 0] };
    for (let d = 0; d < DOF; d++) {
      const gi = s.node * DOF + d;
      if (!fixed[gi]) continue;
      let s2 = 0;
      const Kgi = K[gi];
      for (let j = 0; j < ndof; j++) s2 += Kgi[j] * u[j];
      const val = s2 - F[gi];
      if (d < 3) r.force[d] = val; else r.moment[d - 3] = val;
    }
    reactions.push(r);
  }

  // member forces + utilization
  const results = [];
  let maxUtil = 0, elasticEnergy = 0;
  for (const ed of elemData) {
    // local displacements: uL = T uG_elem
    const uG = ed.map.map(i => u[i]);
    const uL = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      let s = 0;
      for (let j = 0; j < 12; j++) s += (ed.T[i][j] || 0) * uG[j];
      uL[i] = s;
    }
    // local end forces fL = kL uL
    const fL = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      let s = 0;
      for (let j = 0; j < 12; j++) s += ed.kL[i][j] * uL[j];
      fL[i] = s;
    }
    // sign convention: N>0 tension. At node j (end 1) axial force +fL[6]
    const N = fL[6];                       // kN
    const Vy = fL[7], Vz = fL[8];          // kN
    const Mt = fL[9];                      // kNm torsion
    const My0 = -fL[4], My1 = fL[10];      // kNm bending about local y
    const Mz0 = -fL[5], Mz1 = fL[11];      // kNm bending about local z
    const cs = ed.cs, mat = ed.mat;
    // stresses in kN/cm²: N/A + M/W  (M kNm→kNcm ×100)
    const sigA = N / cs.A;
    const sigM0 = Math.abs(My0) * 100 / cs.Wy + Math.abs(Mz0) * 100 / cs.Wz;
    const sigM1 = Math.abs(My1) * 100 / cs.Wy + Math.abs(Mz1) * 100 / cs.Wz;
    const sigMax = Math.max(Math.abs(sigA) + sigM0, Math.abs(sigA) + sigM1);
    const util = sigMax / mat.fy;          // Karamba utilization: |σ|/fy (signed by N)
    const utilSigned = util * (N >= 0 ? 1 : -1);
    maxUtil = Math.max(maxUtil, util);
    // elastic energy 0.5 uᵀ f
    let en = 0;
    for (let i = 0; i < 12; i++) en += 0.5 * uL[i] * fL[i];
    elasticEnergy += Math.abs(en);
    results.push({
      el: ed.el, N, Vy, Vz, Mt, My: [My0, My1], Mz: [Mz0, Mz1],
      sigma: sigMax, util, utilSigned, L: ed.ax.L, axes: ed.ax,
    });
  }

  // nodal displacement magnitudes (m)
  const disp = [];
  let maxDisp = 0;
  for (let i = 0; i < n; i++) {
    const dx = u[i * DOF], dy = u[i * DOF + 1], dz = u[i * DOF + 2];
    const mag = Math.hypot(dx, dy, dz);
    maxDisp = Math.max(maxDisp, mag);
    disp.push({ dx, dy, dz, rx: u[i * DOF + 3], ry: u[i * DOF + 4], rz: u[i * DOF + 5], mag });
  }

  // total gravity force (mass feedback like Karamba's "Mass" output)
  let mass = 0;
  for (const ed of elemData) mass += ed.mat.gamma * ed.A * ed.ax.L / 9.80665 * 1000; // kg

  return {
    ok: true, u, disp, maxDisp, results, reactions, maxUtil,
    elasticEnergy, mass, model,
  };
}

/** Dense Cholesky LDLᵀ solve; returns null if not positive definite. */
function choleskySolve(A, b) {
  const nn = b.length;
  if (nn === 0) return new Float64Array(0);
  const L = Array.from({ length: nn }, () => new Float64Array(nn));
  const D = new Float64Array(nn);
  for (let j = 0; j < nn; j++) {
    let d = A[j][j];
    for (let k = 0; k < j; k++) d -= L[j][k] * L[j][k] * D[k];
    if (d < 1e-10) return null;
    D[j] = d;
    L[j][j] = 1;
    for (let i = j + 1; i < nn; i++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k] * D[k];
      L[i][j] = s / d;
    }
  }
  // forward: L y = b
  const y = new Float64Array(nn);
  for (let i = 0; i < nn; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s;
  }
  // diag
  for (let i = 0; i < nn; i++) y[i] /= D[i];
  // back: Lᵀ x = y
  const x = new Float64Array(nn);
  for (let i = nn - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < nn; k++) s -= L[k][i] * x[k];
    x[i] = s;
  }
  return x;
}
