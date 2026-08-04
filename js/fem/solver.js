/**
 * fem/solver.js — Linear elastic FEM (Theory I / first order), Karamba-style.
 *
 * Elements:
 *   - 3D Euler-Bernoulli beams: 6 DOF/node, 12×12 stiffness
 *   - Flat triangular shells: CST membrane + DKT plate bending (Batoz 1980),
 *     18×18 local stiffness with drilling-DOF stabilization
 *
 * Loads: point loads/moments, gravity (self weight), uniform line loads (UDL)
 *        on beams via fixed-end forces.
 *
 * Units follow Karamba defaults: geometry m, forces kN, E/fy in kN/cm²,
 * cross-section dims cm. Internally kN and m (E ×1e4 → kN/m²).
 */

const DOF = 6;

export class FemModel {
  /** @param tol node-weld limit distance in m (Karamba LDist default: 5 mm) */
  constructor(tol = 0.005) {
    this.nodes = [];          // [{x,y,z}]
    this.elements = [];       // beams [{n0,n1, crosec, material, id}]
    this.shells = [];         // [{n0,n1,n2, t (cm), material, id}]
    this.supports = [];       // [{node, fix:[tx,ty,tz,rx,ry,rz]}]
    this.pointLoads = [];     // [{node, force:[3], moment:[3]}]
    this.lineLoads = [];      // [{a:{x,y,z}, b:{x,y,z}, w:[wx,wy,wz] kN/m global}]
    this.gravity = null;      // {vec:[gx,gy,gz]} in multiples of g
    this.tol = tol;
    this._grid = new Map();   // spatial hash for tolerant node welding
  }

  addNode(x, y, z) {
    const t = this.tol;
    const gx = Math.round(x / t), gy = Math.round(y / t), gz = Math.round(z / t);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const cell = this._grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (!cell) continue;
          for (const idx of cell) {
            const p = this.nodes[idx];
            if (Math.hypot(p.x - x, p.y - y, p.z - z) <= t) return idx;
          }
        }
    const idx = this.nodes.length;
    this.nodes.push({ x, y, z });
    const key = `${gx},${gy},${gz}`;
    if (!this._grid.has(key)) this._grid.set(key, []);
    this._grid.get(key).push(idx);
    return idx;
  }

  addBeam(p0, p1, crosec, material, id = '') {
    const n0 = this.addNode(p0.x, p0.y, p0.z);
    const n1 = this.addNode(p1.x, p1.y, p1.z);
    this.elements.push({ n0, n1, crosec, material, id });
  }

  addShellTri(p0, p1, p2, t, material, id = '') {
    const n0 = this.addNode(p0.x, p0.y, p0.z);
    const n1 = this.addNode(p1.x, p1.y, p1.z);
    const n2 = this.addNode(p2.x, p2.y, p2.z);
    this.shells.push({ n0, n1, n2, t, material, id });
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

/* ---------------- cross sections (dims cm; A cm², I cm⁴, W cm³) ------------- */

export function rectangleCroSec(h = 10, b = 10, name = '') {
  const A = b * h;
  const Iy = (b * h ** 3) / 12;
  const Iz = (h * b ** 3) / 12;
  const a = Math.max(b, h) / 2, c = Math.min(b, h) / 2;
  const J = a * c ** 3 * (16 / 3 - 3.36 * (c / a) * (1 - c ** 4 / (12 * a ** 4)));
  return { shape: 'rect', name: name || `Rect ${h}x${b}`, h, b, A, Iy, Iz, J, Wy: Iy / (h / 2), Wz: Iz / (b / 2) };
}

export function circleCroSec(d = 10, t = 0, name = '') {
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

export const CROSEC_FAMILIES = {
  'IPE': Object.entries(CROSEC_TABLE).filter(([k]) => k.startsWith('IPE')).map(([, v]) => v),
  'HEA': Object.entries(CROSEC_TABLE).filter(([k]) => k.startsWith('HEA')).map(([, v]) => v),
  'CHS': Object.entries(CROSEC_TABLE).filter(([k]) => k.startsWith('CHS')).map(([, v]) => v),
  'All': Object.values(CROSEC_TABLE),
};

export const DEFAULT_CROSEC = circleCroSec(11.43, 0.4, 'CHS 114.3x4');
export const DEFAULT_MATERIAL = 'Steel S235';

/* ================= beam element ================= */

function localStiffness(E, G, A, Iy, Iz, J, L) {
  const k = Array.from({ length: 12 }, () => new Float64Array(12));
  const EA = E * A / L;
  const GJ = G * J / L;
  const a_y = 12 * E * Iz / L ** 3, b_y = 6 * E * Iz / L ** 2, c_y = 4 * E * Iz / L, d_y = 2 * E * Iz / L;
  const a_z = 12 * E * Iy / L ** 3, b_z = 6 * E * Iy / L ** 2, c_z = 4 * E * Iy / L, d_z = 2 * E * Iy / L;
  const S = (i, j, v) => { k[i][j] = v; k[j][i] = v; };
  S(0, 0, EA); S(6, 6, EA); S(0, 6, -EA);
  S(3, 3, GJ); S(9, 9, GJ); S(3, 9, -GJ);
  S(1, 1, a_y); S(7, 7, a_y); S(1, 7, -a_y);
  S(5, 5, c_y); S(11, 11, c_y); S(5, 11, d_y);
  S(1, 5, b_y); S(1, 11, b_y); S(7, 5, -b_y); S(7, 11, -b_y);
  S(2, 2, a_z); S(8, 8, a_z); S(2, 8, -a_z);
  S(4, 4, c_z); S(10, 10, c_z); S(4, 10, d_z);
  S(2, 4, -b_z); S(2, 10, -b_z); S(8, 4, b_z); S(8, 10, b_z);
  return k;
}

function beamAxes(p0, p1) {
  let ex = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
  const L = Math.hypot(...ex);
  ex = ex.map(v => v / L);
  let ref = Math.abs(ex[2]) > 0.999 ? [1, 0, 0] : [0, 0, 1];
  let ey = cross(ref, ex);
  const ln = Math.hypot(...ey);
  ey = ey.map(v => v / ln);
  const ez = cross(ex, ey);
  return { ex, ey, ez, L };
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function buildT12(ax) {
  const R = [ax.ex, ax.ey, ax.ez];
  const T = Array.from({ length: 12 }, () => new Float64Array(12));
  for (let b = 0; b < 4; b++)
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        T[b * 3 + i][b * 3 + j] = R[i][j];
  return T;
}

function matTmulKmulT(kLocal, T, n) {
  // kGlobal = Tᵀ kLocal T
  const tmp = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let m = 0; m < n; m++) s += kLocal[i][m] * T[m][j];
      tmp[i][j] = s;
    }
  const kG = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let m = 0; m < n; m++) s += T[m][i] * tmp[m][j];
      kG[i][j] = s;
    }
  return kG;
}

/** Fixed-end force vector (forces on element ends) for uniform local load w [kN/m]. */
function fixedEndForces(w, L) {
  const f0 = new Float64Array(12);
  const [wx, wy, wz] = w;
  // axial
  f0[0] = -wx * L / 2; f0[6] = -wx * L / 2;
  // local y bending (dofs 1,5,7,11)
  f0[1] = -wy * L / 2; f0[7] = -wy * L / 2;
  f0[5] = -wy * L * L / 12; f0[11] = +wy * L * L / 12;
  // local z bending (dofs 2,4,8,10) — θy dofs carry flipped sign convention
  f0[2] = -wz * L / 2; f0[8] = -wz * L / 2;
  f0[4] = +wz * L * L / 12; f0[10] = -wz * L * L / 12;
  return f0;
}

/* ================= shell element: CST membrane + DKT bending ================= */

/** Local axes of a triangle: e1 along first edge, e3 = normal. */
function triAxes(p0, p1, p2) {
  const v1 = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
  const v2 = [p2.x - p0.x, p2.y - p0.y, p2.z - p0.z];
  const L1 = Math.hypot(...v1);
  const e1 = v1.map(v => v / L1);
  let e3 = cross(v1, v2);
  const A2 = Math.hypot(...e3); // 2*area
  e3 = e3.map(v => v / A2);
  const e2 = cross(e3, e1);
  return { e1, e2, e3, area: A2 / 2 };
}

/**
 * 18×18 local stiffness of a flat shell triangle.
 * Local DOF order per node: [u, v, w, θx, θy, θz] (θx/θy = rotations about
 * local x/y axes; θz = drilling, penalty-stabilized).
 * E in kN/m², t in m, coordinates in the local plane.
 */
export function shellLocalK(x, y, E, nu, t) {
  const K = Array.from({ length: 18 }, () => new Float64Array(18));
  const [x1, y1] = [x[0], y[0]], [x2, y2] = [x[1], y[1]], [x3, y3] = [x[2], y[2]];
  const A = 0.5 * ((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1));
  if (A <= 1e-12) return K;

  /* ---- CST membrane (u,v) ---- */
  const b1 = y2 - y3, b2 = y3 - y1, b3 = y1 - y2;
  const c1 = x3 - x2, c2 = x1 - x3, c3 = x2 - x1;
  const Dm = E * t / (1 - nu * nu);
  const Bm = [
    [b1, 0, b2, 0, b3, 0],
    [0, c1, 0, c2, 0, c3],
    [c1, b1, c2, b2, c3, b3],
  ].map(r => r.map(v => v / (2 * A)));
  const Dmat = [
    [Dm, Dm * nu, 0],
    [Dm * nu, Dm, 0],
    [0, 0, Dm * (1 - nu) / 2],
  ];
  // Km = A * Bmᵀ D Bm  (6×6), dofs [u1,v1,u2,v2,u3,v3]
  const Km = Array.from({ length: 6 }, () => new Float64Array(6));
  for (let i = 0; i < 6; i++)
    for (let j = 0; j < 6; j++) {
      let s = 0;
      for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++)
          s += Bm[a][i] * Dmat[a][b] * Bm[b][j];
      Km[i][j] = s * A;
    }

  /* ---- DKT plate bending (w, θx, θy) — Batoz explicit formulation ---- */
  const Db0 = E * t ** 3 / (12 * (1 - nu * nu));
  const Db = [
    [Db0, Db0 * nu, 0],
    [Db0 * nu, Db0, 0],
    [0, 0, Db0 * (1 - nu) / 2],
  ];
  // side quantities, sides k: 4↔(2,3), 5↔(3,1), 6↔(1,2)
  const xij = [x2 - x3, x3 - x1, x1 - x2];
  const yij = [y2 - y3, y3 - y1, y1 - y2];
  const l2 = xij.map((v, i) => v * v + yij[i] * yij[i]);
  const Pk = xij.map((v, i) => -6 * v / l2[i]);
  const pk = xij.map((v, i) => 3 * v * v / l2[i]);
  const tk = yij.map((v, i) => -6 * v / l2[i]);
  const qk = xij.map((v, i) => 3 * v * yij[i] / l2[i]);
  const rk = yij.map((v, i) => 3 * v * v / l2[i]);
  const [P4, P5, P6] = Pk, [t4, t5, t6] = tk, [q4, q5, q6] = qk, [r4, r5, r6] = rk;

  const Hxxi = (xi, eta) => [
    P6 * (1 - 2 * xi) + (P5 - P6) * eta,
    q6 * (1 - 2 * xi) - (q5 + q6) * eta,
    -4 + 6 * (xi + eta) + r6 * (1 - 2 * xi) - eta * (r5 + r6),
    -P6 * (1 - 2 * xi) + eta * (P4 + P6),
    q6 * (1 - 2 * xi) - eta * (q6 - q4),
    -2 + 6 * xi + r6 * (1 - 2 * xi) + eta * (r4 - r6),
    -eta * (P5 + P4),
    eta * (q4 - q5),
    -eta * (r5 - r4),
  ];
  const Hyxi = (xi, eta) => [
    t6 * (1 - 2 * xi) + eta * (t5 - t6),
    1 + r6 * (1 - 2 * xi) - eta * (r5 + r6),
    -q6 * (1 - 2 * xi) + eta * (q5 + q6),
    -t6 * (1 - 2 * xi) + eta * (t4 + t6),
    -1 + r6 * (1 - 2 * xi) + eta * (r4 - r6),
    -q6 * (1 - 2 * xi) - eta * (q4 - q6),
    -eta * (t4 + t5),
    eta * (r4 - r5),
    -eta * (q4 - q5),
  ];
  const Hxeta = (xi, eta) => [
    -P5 * (1 - 2 * eta) - xi * (P6 - P5),
    q5 * (1 - 2 * eta) - xi * (q5 + q6),
    -4 + 6 * (xi + eta) + r5 * (1 - 2 * eta) - xi * (r5 + r6),
    xi * (P4 + P6),
    xi * (q4 - q6),
    -xi * (r6 - r4),
    P5 * (1 - 2 * eta) - xi * (P4 + P5),
    q5 * (1 - 2 * eta) + xi * (q4 - q5),
    -2 + 6 * eta + r5 * (1 - 2 * eta) + xi * (r4 - r5),
  ];
  const Hyeta = (xi, eta) => [
    -t5 * (1 - 2 * eta) - xi * (t6 - t5),
    1 + r5 * (1 - 2 * eta) - xi * (r5 + r6),
    -q5 * (1 - 2 * eta) + xi * (q5 + q6),
    xi * (t4 + t6),
    xi * (r4 - r6),
    -xi * (q4 - q6),
    t5 * (1 - 2 * eta) - xi * (t4 + t5),
    -1 + r5 * (1 - 2 * eta) + xi * (r4 - r5),
    -q5 * (1 - 2 * eta) - xi * (q4 - q5),
  ];

  const y31 = y3 - y1, y12 = y1 - y2, x31 = x3 - x1, x12 = x1 - x2;
  const gauss = [[0.5, 0], [0, 0.5], [0.5, 0.5]];
  const Kb = Array.from({ length: 9 }, () => new Float64Array(9));
  for (const [xi, eta] of gauss) {
    const hxx = Hxxi(xi, eta), hyx = Hyxi(xi, eta);
    const hxe = Hxeta(xi, eta), hye = Hyeta(xi, eta);
    const B = [new Float64Array(9), new Float64Array(9), new Float64Array(9)];
    for (let i = 0; i < 9; i++) {
      B[0][i] = (y31 * hxx[i] + y12 * hxe[i]) / (2 * A);
      B[1][i] = (-x31 * hyx[i] - x12 * hye[i]) / (2 * A);
      B[2][i] = (-x31 * hxx[i] - x12 * hxe[i] + y31 * hyx[i] + y12 * hye[i]) / (2 * A);
    }
    for (let i = 0; i < 9; i++)
      for (let j = 0; j < 9; j++) {
        let s = 0;
        for (let a = 0; a < 3; a++)
          for (let b = 0; b < 3; b++)
            s += B[a][i] * Db[a][b] * B[b][j];
        Kb[i][j] += s * (2 * A) * (1 / 6);
      }
  }

  /* ---- scatter into 18×18 ----
   * Membrane dofs (u,v)  → slots 0,1 per node.
   * DKT dof triplet per node is (w, βθ1, βθ2) where in the Batoz convention
   * the rotational dofs are θx (about x) and θy (about y) with
   * θx = ∂w/∂y ... the H-arrays above are consistent with dof order
   * (w, θx, θy). Scattered into slots 2,3,4.
   */
  for (let a = 0; a < 3; a++)
    for (let b = 0; b < 3; b++) {
      // membrane
      for (let i = 0; i < 2; i++)
        for (let j = 0; j < 2; j++)
          K[a * 6 + i][b * 6 + j] += Km[a * 2 + i][b * 2 + j];
      // bending
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
          K[a * 6 + 2 + i][b * 6 + 2 + j] += Kb[a * 3 + i][b * 3 + j];
    }

  // drilling DOF stabilization (small stiffness on θz to avoid singularity)
  let kmax = 0;
  for (let i = 0; i < 18; i++) kmax = Math.max(kmax, Math.abs(K[i][i]));
  const kd = kmax * 1e-5 || 1;
  for (let a = 0; a < 3; a++) K[a * 6 + 5][a * 6 + 5] += kd;

  return K;
}

function shellB_membrane(x, y) {
  const [x1, y1] = [x[0], y[0]], [x2, y2] = [x[1], y[1]], [x3, y3] = [x[2], y[2]];
  const A = 0.5 * ((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1));
  const b1 = y2 - y3, b2 = y3 - y1, b3 = y1 - y2;
  const c1 = x3 - x2, c2 = x1 - x3, c3 = x2 - x1;
  return {
    A,
    B: [
      [b1, 0, b2, 0, b3, 0],
      [0, c1, 0, c2, 0, c3],
      [c1, b1, c2, b2, c3, b3],
    ].map(r => r.map(v => v / (2 * A))),
  };
}

/* ================= analyze ================= */

export function analyze(model) {
  const n = model.nodes.length;
  const nElems = model.elements.length + model.shells.length;
  if (n === 0 || nElems === 0) {
    return { ok: false, error: 'Model has no elements. Wire beams or shells into Assemble.' };
  }
  const ndof = n * DOF;

  /* ---- connectivity check: drop components that carry no support ----
   * (imported CAD models often contain a few stray members; real Karamba
   *  reports rigid-body modes — we exclude them and warn instead) */
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (const el of model.elements) union(el.n0, el.n1);
  for (const sh of model.shells) { union(sh.n0, sh.n1); union(sh.n1, sh.n2); }
  // per-component rigid-body restraint check: a component is only adequately
  // supported if its supports restrain all 6 rigid modes (e.g. a stray member
  // pinned at a single point can still spin — that's a mechanism, not support)
  const compSupports = new Map();   // root → [support,…]
  for (const s of model.supports) {
    if (s.node < 0 || s.node >= n) continue;
    const r = find(s.node);
    if (!compSupports.has(r)) compSupports.set(r, []);
    compSupports.get(r).push(s);
  }
  const compElems = new Map();      // root → element count (size proxy)
  for (const el of model.elements) {
    const r = find(el.n0);
    compElems.set(r, (compElems.get(r) || 0) + 1);
  }
  for (const sh of model.shells) {
    const r = find(sh.n0);
    compElems.set(r, (compElems.get(r) || 0) + 1);
  }
  const restrainedRoots = new Set();
  for (const [root, sups] of compSupports) {
    if (rigidModesRestrained(sups, model.nodes)) restrainedRoots.add(root);
  }
  if (compElems.size && restrainedRoots.size === 0) {
    return {
      ok: false,
      error: model.supports.length
        ? 'Supports are insufficient — rigid-body modes remain (a pinned point still allows rotation). Fix rotations at a support or add more support points.'
        : 'Model has no supports — structure is kinematic. Add a Support component.',
    };
  }
  // the biggest component must be properly restrained, otherwise the analysis is pointless
  let mainRoot = null, mainCount = -1;
  for (const [r, c] of compElems) if (c > mainCount) { mainCount = c; mainRoot = r; }
  if (!restrainedRoots.has(mainRoot)) {
    return {
      ok: false,
      error: 'The main structure is insufficiently supported — rigid-body modes remain. Add supports (or fix rotations at one).',
    };
  }

  const nodeActive = new Uint8Array(n);
  let excludedElems = 0;
  const isActive = (ni) => restrainedRoots.has(find(ni));
  for (const el of model.elements) {
    if (isActive(el.n0)) { el._excluded = false; nodeActive[el.n0] = nodeActive[el.n1] = 1; }
    else { el._excluded = true; excludedElems++; }
  }
  for (const sh of model.shells) {
    if (isActive(sh.n0)) { sh._excluded = false; nodeActive[sh.n0] = nodeActive[sh.n1] = nodeActive[sh.n2] = 1; }
    else { sh._excluded = true; excludedElems++; }
  }

  const F = new Float64Array(ndof);     // full rhs (incl. equivalent span loads)
  const Fext = new Float64Array(ndof);  // direct external loads only (for reactions)
  const elemData = [];
  const shellData = [];

  /* ---- beams ---- */
  for (const el of model.elements) {
    if (el._excluded) continue;
    const p0 = model.nodes[el.n0], p1 = model.nodes[el.n1];
    const ax = beamAxes(p0, p1);
    if (!isFinite(ax.L) || ax.L < 1e-9) continue;
    const mat = MATERIALS[el.material] || MATERIALS[DEFAULT_MATERIAL];
    const cs = el.crosec || DEFAULT_CROSEC;
    const E = mat.E * 1e4, G = mat.G * 1e4;
    const A = cs.A * 1e-4, Iy = cs.Iy * 1e-8, Iz = cs.Iz * 1e-8, J = cs.J * 1e-8;
    const kL = localStiffness(E, G, A, Iy, Iz, J, ax.L);
    const T = buildT12(ax);
    const kG = matTmulKmulT(kL, T, 12);
    const map = [];
    for (let d = 0; d < DOF; d++) map.push(el.n0 * DOF + d);
    for (let d = 0; d < DOF; d++) map.push(el.n1 * DOF + d);

    // uniform line loads on this element → local w, fixed-end forces
    const f0 = new Float64Array(12);
    let hasSpanLoad = false;
    const wGlobal = [0, 0, 0];
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2, z: (p0.z + p1.z) / 2 };
    for (const ll of model.lineLoads) {
      if (!pointOnSegment(mid, ll.a, ll.b, 1e-3)) continue;
      wGlobal[0] += ll.w[0]; wGlobal[1] += ll.w[1]; wGlobal[2] += ll.w[2];
      hasSpanLoad = true;
    }
    // gravity as distributed load along the member
    if (model.gravity) {
      const wg = mat.gamma * A; // kN/m
      const g = model.gravity.vec;
      wGlobal[0] += wg * g[0]; wGlobal[1] += wg * g[1]; wGlobal[2] += wg * g[2];
      hasSpanLoad = true;
    }
    if (hasSpanLoad) {
      const R = [T[0], T[1], T[2]];
      const wLocal = [
        R[0][0] * wGlobal[0] + R[0][1] * wGlobal[1] + R[0][2] * wGlobal[2],
        R[1][0] * wGlobal[0] + R[1][1] * wGlobal[1] + R[1][2] * wGlobal[2],
        R[2][0] * wGlobal[0] + R[2][1] * wGlobal[1] + R[2][2] * wGlobal[2],
      ];
      const fe = fixedEndForces(wLocal, ax.L);
      for (let i = 0; i < 12; i++) f0[i] = fe[i];
      // global equivalent nodal loads: F += −Tᵀ f0
      for (let i = 0; i < 12; i++) {
        let s = 0;
        for (let j = 0; j < 12; j++) s += T[j][i] * f0[j];
        F[map[i]] -= s;
      }
    }
    elemData.push({ el, ax, kL, T, kG, map, E, A, cs, mat, f0, wLocalMag: hasSpanLoad });
  }

  /* ---- shells ---- */
  for (const sh of model.shells) {
    if (sh._excluded) continue;
    const p = [model.nodes[sh.n0], model.nodes[sh.n1], model.nodes[sh.n2]];
    const ax = triAxes(p[0], p[1], p[2]);
    if (!(ax.area > 1e-10)) continue;
    const mat = MATERIALS[sh.material] || MATERIALS[DEFAULT_MATERIAL];
    const E = mat.E * 1e4;
    const nu = Math.max(0, Math.min(0.45, mat.E / (2 * mat.G) - 1));
    const t = sh.t / 100; // cm→m
    // local plane coordinates
    const x = [], y = [];
    for (const pt of p) {
      const d = [pt.x - p[0].x, pt.y - p[0].y, pt.z - p[0].z];
      x.push(d[0] * ax.e1[0] + d[1] * ax.e1[1] + d[2] * ax.e1[2]);
      y.push(d[0] * ax.e2[0] + d[1] * ax.e2[1] + d[2] * ax.e2[2]);
    }
    const kL = shellLocalK(x, y, E, nu, t);
    // T: blockdiag(R,R,...) 6 blocks of 3
    const R = [ax.e1, ax.e2, ax.e3];
    const T = Array.from({ length: 18 }, () => new Float64Array(18));
    for (let b = 0; b < 6; b++)
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
          T[b * 3 + i][b * 3 + j] = R[i][j];
    const kG = matTmulKmulT(kL, T, 18);
    const nodesIdx = [sh.n0, sh.n1, sh.n2];
    const map = [];
    for (const ni of nodesIdx) for (let d = 0; d < DOF; d++) map.push(ni * DOF + d);

    // gravity self weight lumped at nodes
    if (model.gravity) {
      const w = mat.gamma * t * ax.area; // kN
      const g = model.gravity.vec;
      for (const ni of nodesIdx) {
        for (let d = 0; d < 3; d++) {
          F[ni * DOF + d] += w * g[d] / 3;
          Fext[ni * DOF + d] += w * g[d] / 3;
        }
      }
    }
    shellData.push({ sh, ax, x, y, kL, T, kG, map, E, nu, t, mat, nodesIdx });
  }

  /* ---- point loads ---- */
  for (const pl of model.pointLoads) {
    if (pl.node < 0 || pl.node >= n) continue;
    const base = pl.node * DOF;
    for (let d = 0; d < 3; d++) { F[base + d] += pl.force[d]; Fext[base + d] += pl.force[d]; }
    if (pl.moment) for (let d = 0; d < 3; d++) { F[base + 3 + d] += pl.moment[d]; Fext[base + 3 + d] += pl.moment[d]; }
  }

  /* ---- supports ---- */
  const fixed = new Uint8Array(ndof);
  let anySupport = false;
  for (const s of model.supports) {
    if (s.node < 0 || s.node >= n) continue;
    anySupport = true;
    for (let d = 0; d < DOF; d++) if (s.fix[d]) fixed[s.node * DOF + d] = 1;
  }
  if (!anySupport) return { ok: false, error: 'Model has no supports — structure is kinematic. Add a Support component.' };

  // constrain every DOF of inactive/orphan nodes (excluded components, unused points)
  for (let i = 0; i < n; i++)
    if (!nodeActive[i])
      for (let d = 0; d < DOF; d++) fixed[i * DOF + d] = 1;

  /* ---- sparse skyline solve with RCM ordering + penalty BCs ----
   * Large imported models (1000s of DOFs) make a dense K infeasible;
   * RCM keeps the profile narrow, COLSOL (Bathe) factorizes it in place. */
  const adj = Array.from({ length: n }, () => new Set());
  for (const ed of elemData) { adj[ed.el.n0].add(ed.el.n1); adj[ed.el.n1].add(ed.el.n0); }
  for (const sd of shellData) {
    const [a, b, c] = sd.nodesIdx;
    adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
  }
  const nodeOrder = rcmOrder(n, adj);          // new index → old node
  const dofNew = new Int32Array(ndof);         // old dof → new dof
  nodeOrder.forEach((oldNode, newI) => {
    for (let d = 0; d < DOF; d++) dofNew[oldNode * DOF + d] = newI * DOF + d;
  });

  // column profile
  const fr = new Int32Array(ndof);
  for (let j = 0; j < ndof; j++) fr[j] = j;
  const allMaps = [];
  for (const ed of elemData) allMaps.push(ed.map);
  for (const sd of shellData) allMaps.push(sd.map);
  for (const map of allMaps) {
    let pmin = Infinity;
    for (const gi of map) pmin = Math.min(pmin, dofNew[gi]);
    for (const gi of map) {
      const j = dofNew[gi];
      if (pmin < fr[j]) fr[j] = pmin;
    }
  }
  const sky = new Array(ndof);
  for (let j = 0; j < ndof; j++) sky[j] = new Float64Array(j - fr[j] + 1);

  const scatter = (map, kG, sz) => {
    for (let i = 0; i < sz; i++) {
      const pi = dofNew[map[i]];
      for (let j = 0; j < sz; j++) {
        const pj = dofNew[map[j]];
        if (pi <= pj) sky[pj][pi - fr[pj]] += kG[i][j];
      }
    }
  };
  for (const ed of elemData) { scatter(ed.map, ed.kG, 12); ed.kG = null; }
  for (const sd of shellData) { scatter(sd.map, sd.kG, 18); sd.kG = null; }

  let diagMax = 0;
  for (let j = 0; j < ndof; j++) diagMax = Math.max(diagMax, sky[j][j - fr[j]]);
  const PEN = diagMax * 1e8;
  const b = new Float64Array(ndof);
  for (let i = 0; i < ndof; i++) {
    const j = dofNew[i];
    if (fixed[i]) { sky[j][j - fr[j]] += PEN; b[j] = 0; }
    else b[j] = F[i];
  }

  const fact = skyFactor(sky, fr, ndof, diagMax * 1e-12);
  if (fact.bad >= 0) {
    const newNode = Math.floor(fact.bad / DOF), dofIdx = fact.bad % DOF;
    const oldNode = nodeOrder[newNode];
    const p = model.nodes[oldNode];
    const dofName = ['Tx', 'Ty', 'Tz', 'Rx', 'Ry', 'Rz'][dofIdx];
    return {
      ok: false,
      error: `Structure is kinematic: free ${dofName} at node (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) m — check supports/connectivity there.`,
      badNode: oldNode, badDof: dofIdx, badPos: { ...p },
    };
  }
  const D = fact.D;
  const uPerm = skySolve(sky, fr, D, b);
  const u = new Float64Array(ndof);
  for (let i = 0; i < ndof; i++) u[i] = uPerm[dofNew[i]];

  // reactions are recovered from element end-force sums after member recovery
  const nodalSum = new Float64Array(ndof);

  /* ---- beam member forces + utilization ---- */
  const results = [];
  let maxUtil = 0, elasticEnergy = 0;
  for (const ed of elemData) {
    const uG = ed.map.map(i => u[i]);
    const uL = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      let s = 0;
      for (let j = 0; j < 12; j++) s += ed.T[i][j] * uG[j];
      uL[i] = s;
    }
    const fL = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      let s = 0;
      for (let j = 0; j < 12; j++) s += ed.kL[i][j] * uL[j];
      fL[i] = s + ed.f0[i]; // add fixed-end forces from span loads
    }
    // accumulate global end forces for reaction recovery: Tᵀ fL
    for (let i = 0; i < 12; i++) {
      let s = 0;
      for (let j = 0; j < 12; j++) s += ed.T[j][i] * fL[j];
      nodalSum[ed.map[i]] += s;
    }
    const L = ed.ax.L;
    const N = fL[6];
    const Vy = fL[7], Vz = fL[8];
    const Mt = fL[9];
    const My0 = -fL[4], My1 = fL[10];
    const Mz0 = -fL[5], Mz1 = fL[11];
    // midspan moments incl. span load: M(x) linear + parabolic correction
    let MyMid = (My0 + My1) / 2, MzMid = (Mz0 + Mz1) / 2;
    if (ed.wLocalMag) {
      // recover local w from fixed-end vector: f0[1] = -wy L/2 ; f0[2] = -wz L/2
      const wy = -2 * ed.f0[1] / L, wz = -2 * ed.f0[2] / L;
      MzMid += wy * L * L / 8;
      MyMid += wz * L * L / 8;
    }
    const cs = ed.cs, mat = ed.mat;
    const sigA = N / cs.A;
    const stations = [
      Math.abs(My0) * 100 / cs.Wy + Math.abs(Mz0) * 100 / cs.Wz,
      Math.abs(MyMid) * 100 / cs.Wy + Math.abs(MzMid) * 100 / cs.Wz,
      Math.abs(My1) * 100 / cs.Wy + Math.abs(Mz1) * 100 / cs.Wz,
    ];
    const sigMax = Math.abs(sigA) + Math.max(...stations);
    const util = sigMax / mat.fy;
    const utilSigned = util * (N >= 0 ? 1 : -1);
    maxUtil = Math.max(maxUtil, util);
    let en = 0;
    for (let i = 0; i < 12; i++) en += 0.5 * uL[i] * fL[i];
    elasticEnergy += Math.abs(en);
    results.push({
      el: ed.el, N, Vy, Vz, Mt, My: [My0, My1], Mz: [Mz0, Mz1],
      sigma: sigMax, util, utilSigned, L, axes: ed.ax,
    });
  }

  /* ---- shell results ---- */
  const shellResults = [];
  for (const sd of shellData) {
    const uG = sd.map.map(i => u[i]);
    const uL = new Float64Array(18);
    for (let i = 0; i < 18; i++) {
      let s = 0;
      for (let j = 0; j < 18; j++) s += sd.T[i][j] * uG[j];
      uL[i] = s;
    }
    // global end forces for reaction recovery: Tᵀ (kL uL)
    {
      const fL = new Float64Array(18);
      for (let i = 0; i < 18; i++) {
        let s = 0;
        for (let j = 0; j < 18; j++) s += sd.kL[i][j] * uL[j];
        fL[i] = s;
      }
      for (let i = 0; i < 18; i++) {
        let s = 0;
        for (let j = 0; j < 18; j++) s += sd.T[j][i] * fL[j];
        nodalSum[sd.map[i]] += s;
      }
    }
    // membrane strains/stresses (constant): dofs [u,v] per node
    const um = [uL[0], uL[1], uL[6], uL[7], uL[12], uL[13]];
    const { B } = shellB_membrane(sd.x, sd.y);
    const eps = [0, 0, 0];
    for (let a = 0; a < 3; a++)
      for (let i = 0; i < 6; i++) eps[a] += B[a][i] * um[i];
    const Efac = sd.E / (1 - sd.nu * sd.nu);
    const sm = [ // membrane stress kN/m²
      Efac * (eps[0] + sd.nu * eps[1]),
      Efac * (eps[1] + sd.nu * eps[0]),
      Efac * (1 - sd.nu) / 2 * eps[2],
    ];
    // bending curvatures at centroid via DKT B (approx: average of gauss pts)
    // for utilization use bending moments per unit width from curvature field.
    const kap = dktCurvatureAtCentroid(sd, uL);
    const D0 = sd.E * sd.t ** 3 / (12 * (1 - sd.nu * sd.nu));
    const Mx = D0 * (kap[0] + sd.nu * kap[1]);
    const My = D0 * (kap[1] + sd.nu * kap[0]);
    const Mxy = D0 * (1 - sd.nu) / 2 * kap[2];
    // fiber stresses top/bottom: σ = σm ± 6M/t²
    const t2 = sd.t * sd.t;
    let worst = 0;
    for (const sgn of [1, -1]) {
      const sx = sm[0] + sgn * 6 * Mx / t2;
      const sy = sm[1] + sgn * 6 * My / t2;
      const txy = sm[2] + sgn * 6 * Mxy / t2;
      const vm = Math.sqrt(sx * sx - sx * sy + sy * sy + 3 * txy * txy);
      worst = Math.max(worst, vm);
    }
    const vmCm2 = worst * 1e-4; // kN/m² → kN/cm²
    const util = vmCm2 / sd.mat.fy;
    maxUtil = Math.max(maxUtil, util);
    shellResults.push({ sh: sd.sh, nodesIdx: sd.nodesIdx, vonMises: vmCm2, util });
  }

  /* ---- reactions: R = Σ element end forces − external loads ---- */
  const reactions = [];
  for (const s of model.supports) {
    if (s.node < 0 || s.node >= n) continue;
    const r = { node: s.node, force: [0, 0, 0], moment: [0, 0, 0] };
    for (let d = 0; d < DOF; d++) {
      const gi = s.node * DOF + d;
      if (!fixed[gi]) continue;
      const val = nodalSum[gi] - Fext[gi];
      if (d < 3) r.force[d] = val; else r.moment[d - 3] = val;
    }
    reactions.push(r);
  }

  /* ---- nodal displacements ---- */
  const disp = [];
  let maxDisp = 0;
  for (let i = 0; i < n; i++) {
    const dx = u[i * DOF], dy = u[i * DOF + 1], dz = u[i * DOF + 2];
    const mag = Math.hypot(dx, dy, dz);
    maxDisp = Math.max(maxDisp, mag);
    disp.push({ dx, dy, dz, rx: u[i * DOF + 3], ry: u[i * DOF + 4], rz: u[i * DOF + 5], mag });
  }

  let mass = 0;
  for (const ed of elemData) mass += ed.mat.gamma * ed.A * ed.ax.L / 9.80665 * 1000;
  for (const sd of shellData) mass += sd.mat.gamma * sd.t * sd.ax.area / 9.80665 * 1000;

  return {
    ok: true, u, disp, maxDisp, results, shellResults, reactions, maxUtil,
    elasticEnergy, mass, model,
    warning: excludedElems
      ? `${excludedElems} disconnected element(s) carry no support — excluded from the analysis`
      : null,
  };
}

function dktCurvatureAtCentroid(sd, uL) {
  // plate dofs per node: slots 2,3,4 → 9-vector
  const ub = [uL[2], uL[3], uL[4], uL[8], uL[9], uL[10], uL[14], uL[15], uL[16]];
  const [x1, y1, x2, y2, x3, y3] = [sd.x[0], sd.y[0], sd.x[1], sd.y[1], sd.x[2], sd.y[2]];
  const A = 0.5 * ((x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1));
  const xij = [x2 - x3, x3 - x1, x1 - x2];
  const yij = [y2 - y3, y3 - y1, y1 - y2];
  const l2 = xij.map((v, i) => v * v + yij[i] * yij[i]);
  const Pk = xij.map((v, i) => -6 * v / l2[i]);
  const tk = yij.map((v, i) => -6 * v / l2[i]);
  const qk = xij.map((v, i) => 3 * v * yij[i] / l2[i]);
  const rk = yij.map((v, i) => 3 * v * v / l2[i]);
  const [P4, P5, P6] = Pk, [t4, t5, t6] = tk, [q4, q5, q6] = qk, [r4, r5, r6] = rk;
  const y31 = y3 - y1, y12 = y1 - y2, x31 = x3 - x1, x12 = x1 - x2;
  const kap = [0, 0, 0];
  const gauss = [[0.5, 0], [0, 0.5], [0.5, 0.5]];
  for (const [xi, eta] of gauss) {
    const hxx = [
      P6 * (1 - 2 * xi) + (P5 - P6) * eta, q6 * (1 - 2 * xi) - (q5 + q6) * eta,
      -4 + 6 * (xi + eta) + r6 * (1 - 2 * xi) - eta * (r5 + r6),
      -P6 * (1 - 2 * xi) + eta * (P4 + P6), q6 * (1 - 2 * xi) - eta * (q6 - q4),
      -2 + 6 * xi + r6 * (1 - 2 * xi) + eta * (r4 - r6),
      -eta * (P5 + P4), eta * (q4 - q5), -eta * (r5 - r4)];
    const hyx = [
      t6 * (1 - 2 * xi) + eta * (t5 - t6), 1 + r6 * (1 - 2 * xi) - eta * (r5 + r6),
      -q6 * (1 - 2 * xi) + eta * (q5 + q6), -t6 * (1 - 2 * xi) + eta * (t4 + t6),
      -1 + r6 * (1 - 2 * xi) + eta * (r4 - r6), -q6 * (1 - 2 * xi) - eta * (q4 - q6),
      -eta * (t4 + t5), eta * (r4 - r5), -eta * (q4 - q5)];
    const hxe = [
      -P5 * (1 - 2 * eta) - xi * (P6 - P5), q5 * (1 - 2 * eta) - xi * (q5 + q6),
      -4 + 6 * (xi + eta) + r5 * (1 - 2 * eta) - xi * (r5 + r6),
      xi * (P4 + P6), xi * (q4 - q6), -xi * (r6 - r4),
      P5 * (1 - 2 * eta) - xi * (P4 + P5), q5 * (1 - 2 * eta) + xi * (q4 - q5),
      -2 + 6 * eta + r5 * (1 - 2 * eta) + xi * (r4 - r5)];
    const hye = [
      -t5 * (1 - 2 * eta) - xi * (t6 - t5), 1 + r5 * (1 - 2 * eta) - xi * (r5 + r6),
      -q5 * (1 - 2 * eta) + xi * (q5 + q6), xi * (t4 + t6), xi * (r4 - r6), -xi * (q4 - q6),
      t5 * (1 - 2 * eta) - xi * (t4 + t5), -1 + r5 * (1 - 2 * eta) + xi * (r4 - r5),
      -q5 * (1 - 2 * eta) - xi * (q4 - q5)];
    for (let i = 0; i < 9; i++) {
      kap[0] += (y31 * hxx[i] + y12 * hxe[i]) / (2 * A) * ub[i] / 3;
      kap[1] += (-x31 * hyx[i] - x12 * hye[i]) / (2 * A) * ub[i] / 3;
      kap[2] += (-x31 * hxx[i] - x12 * hxe[i] + y31 * hyx[i] + y12 * hye[i]) / (2 * A) * ub[i] / 3;
    }
  }
  return kap;
}

function pointOnSegment(p, a, b, tol) {
  const ab = [b.x - a.x, b.y - a.y, b.z - a.z];
  const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  if (L2 < 1e-12) return false;
  const ap = [p.x - a.x, p.y - a.y, p.z - a.z];
  const t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L2;
  if (t < -0.01 || t > 1.01) return false;
  const cx = a.x + t * ab[0], cy = a.y + t * ab[1], cz = a.z + t * ab[2];
  return Math.hypot(p.x - cx, p.y - cy, p.z - cz) <= tol;
}

/* ================= optimize cross section ================= */

/**
 * Karamba-style OptiCroSec: iteratively re-size each beam to the lightest
 * candidate whose stress utilization ≤ maxUtil, re-analyzing between passes.
 */
export function optimizeCroSec(model, candidates, maxUtil = 1.0, iterations = 5) {
  if (!candidates || !candidates.length) return { ok: false, error: 'No candidate cross sections supplied.' };
  const sorted = [...candidates].sort((a, b) => a.A - b.A);
  let res = null;
  let changedTotal = 0;
  for (let it = 0; it < Math.max(1, iterations); it++) {
    res = analyze(model);
    if (!res.ok) return res;
    let changed = 0;
    for (const r of res.results) {
      const el = r.el;
      const mat = MATERIALS[el.material] || MATERIALS[DEFAULT_MATERIAL];
      // pick smallest candidate satisfying σ(candidate) ≤ maxUtil·fy with current forces
      const Mmax_y = Math.max(Math.abs(r.My[0]), Math.abs(r.My[1]));
      const Mmax_z = Math.max(Math.abs(r.Mz[0]), Math.abs(r.Mz[1]));
      let chosen = sorted[sorted.length - 1];
      for (const cs of sorted) {
        const sig = Math.abs(r.N) / cs.A + Mmax_y * 100 / cs.Wy + Mmax_z * 100 / cs.Wz;
        if (sig / mat.fy <= maxUtil) { chosen = cs; break; }
      }
      if (chosen !== el.crosec) { el.crosec = chosen; changed++; }
    }
    changedTotal += changed;
    if (changed === 0) break;
  }
  res = analyze(model);
  res.changed = changedTotal;
  return res;
}

/**
 * True iff the given supports restrain all 6 rigid-body modes.
 * Each fixed translational DOF at point p contributes the constraint row
 * [e, (p−c)×e] on the rigid motion (t, ω); each fixed rotation contributes
 * [0, e]. Restrained ⇔ the rows have rank 6.
 */
function rigidModesRestrained(sups, nodes) {
  // centroid of support points for conditioning
  let cx = 0, cy = 0, cz = 0, np = 0;
  for (const s of sups) { const p = nodes[s.node]; cx += p.x; cy += p.y; cz += p.z; np++; }
  if (!np) return false;
  cx /= np; cy /= np; cz /= np;
  const rows = [];
  const E = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const s of sups) {
    const p = nodes[s.node];
    const r = [p.x - cx, p.y - cy, p.z - cz];
    for (let d = 0; d < 3; d++) {
      if (s.fix[d]) {
        const e = E[d];
        rows.push([...e,
          r[1] * e[2] - r[2] * e[1],
          r[2] * e[0] - r[0] * e[2],
          r[0] * e[1] - r[1] * e[0]]);
      }
      if (s.fix[3 + d]) rows.push([0, 0, 0, ...E[d]]);
    }
  }
  if (rows.length < 6) return false;
  // Gaussian elimination rank with partial pivoting
  const m = rows.map(r => [...r]);
  let rank = 0;
  for (let col = 0; col < 6 && rank < m.length; col++) {
    let piv = -1, best = 1e-9;
    for (let i = rank; i < m.length; i++)
      if (Math.abs(m[i][col]) > best) { best = Math.abs(m[i][col]); piv = i; }
    if (piv < 0) continue;
    [m[rank], m[piv]] = [m[piv], m[rank]];
    for (let i = 0; i < m.length; i++) {
      if (i === rank || Math.abs(m[i][col]) < 1e-12) continue;
      const f = m[i][col] / m[rank][col];
      for (let k = col; k < 6; k++) m[i][k] -= f * m[rank][k];
    }
    rank++;
  }
  return rank >= 6;
}

/* ================= sparse skyline solve ================= */

/** Reverse Cuthill-McKee node ordering. Returns array: new index → old node. */
function rcmOrder(n, adj) {
  const deg = i => adj[i].size;
  const visited = new Uint8Array(n);
  const order = [];
  while (order.length < n) {
    // start each component at its min-degree unvisited node
    let start = -1, best = Infinity;
    for (let i = 0; i < n; i++)
      if (!visited[i] && deg(i) < best) { best = deg(i); start = i; }
    visited[start] = 1;
    const queue = [start];
    order.push(start);
    for (let q = 0; q < queue.length; q++) {
      const neigh = [...adj[queue[q]]].filter(v => !visited[v]).sort((a, b) => deg(a) - deg(b));
      for (const v of neigh) { visited[v] = 1; queue.push(v); order.push(v); }
    }
  }
  return order.reverse();
}

/** In-place LDLᵀ skyline factorization (Bathe's COLSOL). Returns {D} or {bad: failing column}. */
function skyFactor(sky, fr, ndof, tolAbs) {
  const D = new Float64Array(ndof);
  for (let j = 0; j < ndof; j++) {
    const cj = sky[j], fj = fr[j];
    for (let i = fj + 1; i < j; i++) {
      const fi = fr[i], ci = sky[i];
      const m0 = Math.max(fi, fj);
      let s = cj[i - fj];
      for (let m = m0; m < i; m++) s -= ci[m - fi] * cj[m - fj];
      cj[i - fj] = s;
    }
    let d = cj[j - fj];
    for (let m = fj; m < j; m++) {
      const g = cj[m - fj];
      const l = g / D[m];
      d -= l * g;
      cj[m - fj] = l;
    }
    if (!(d > tolAbs)) return { bad: j };
    D[j] = d;
  }
  return { D, bad: -1 };
}

function skySolve(sky, fr, D, b) {
  const nn = b.length;
  const x = Float64Array.from(b);
  for (let j = 0; j < nn; j++) {          // L z = b
    const cj = sky[j], fj = fr[j];
    let s = x[j];
    for (let m = fj; m < j; m++) s -= cj[m - fj] * x[m];
    x[j] = s;
  }
  for (let j = 0; j < nn; j++) x[j] /= D[j];
  for (let j = nn - 1; j >= 0; j--) {     // Lᵀ x = w
    const cj = sky[j], fj = fr[j], xj = x[j];
    for (let m = fj; m < j; m++) x[m] -= cj[m - fj] * xj;
  }
  return x;
}
