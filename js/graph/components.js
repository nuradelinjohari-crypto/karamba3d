/**
 * graph/components.js — Component registry: GH primitives + the Karamba3D set.
 *
 * Component names/nicknames/ports mirror Karamba3D 2.x:
 *   Line To Beam (LtoB), Support (Supp), Point-Load (PLoad), Gravity (Grav),
 *   Assemble Model (Ass), Analyze Th.I (Analyze), Disassemble Model (Disass),
 *   Cross Sections (Rect/Circle/I + selector), Material Selection (MatSel),
 *   ModelView / BeamView, Nodal Displacements, Reaction Forces, Utilization.
 */

import {
  FemModel, analyze, MATERIALS, CROSEC_TABLE,
  rectangleCroSec, circleCroSec, iCroSec, DEFAULT_CROSEC, DEFAULT_MATERIAL,
} from '../fem/solver.js';

const P = (x, y, z) => ({ kind: 'point', x: +x || 0, y: +y || 0, z: +z || 0 });
const V = (x, y, z) => ({ kind: 'vector', x: +x || 0, y: +y || 0, z: +z || 0 });
const LN = (a, b) => ({ kind: 'line', a, b });

function num(v, fallback = 0) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const f = parseFloat(v);
  return isNaN(f) ? fallback : f;
}

function asPoint(v) {
  if (v && v.kind === 'point') return v;
  if (v && v.kind === 'vector') return P(v.x, v.y, v.z);
  if (typeof v === 'number') return P(v, 0, 0);
  return null;
}

function asLines(list) {
  const out = [];
  for (const v of list) {
    if (v && v.kind === 'line') out.push(v);
    else if (v && v.kind === 'beam' && v.line) out.push(v.line);
  }
  return out;
}

export const registry = new Map();
function def(d) { registry.set(d.type, d); return d; }

/* ================= GH: Params ================= */

def({
  type: 'NumberSlider', name: 'Number Slider', nick: 'Slider',
  category: 'Params', layout: 'slider',
  inputs: [], outputs: [{ name: 'N', nick: 'N' }],
  defaultState: () => ({ name: 'Slider', min: 0, max: 10, step: 0.1, value: 5 }),
  solve: (ins, node) => ({ N: [node.state.value] }),
});

def({
  type: 'Panel', name: 'Panel', nick: 'Panel',
  category: 'Params', layout: 'panel',
  inputs: [{ name: 'In', nick: '' }], outputs: [{ name: 'Out', nick: '' }],
  defaultState: () => ({ w: 130, h: 84 }),
  solve: (ins) => ({ Out: ins[0] }),
});

def({
  type: 'BooleanToggle', name: 'Boolean Toggle', nick: 'Toggle',
  category: 'Params', layout: 'toggle',
  inputs: [], outputs: [{ name: 'B', nick: 'B' }],
  defaultState: () => ({ name: 'Toggle', value: true }),
  onClick: (node) => { node.state.value = !node.state.value; return true; },
  solve: (ins, node) => ({ B: [!!node.state.value] }),
});

def({
  type: 'ConstructPoint', name: 'Construct Point', nick: 'Pt',
  category: 'Params',
  inputs: [
    { name: 'X', nick: 'X', default: 0 },
    { name: 'Y', nick: 'Y', default: 0 },
    { name: 'Z', nick: 'Z', default: 0 },
  ],
  outputs: [{ name: 'Pt', nick: 'Pt' }],
  solve: (ins) => {
    const n = Math.max(ins[0].length, ins[1].length, ins[2].length, 1);
    const pts = [];
    for (let i = 0; i < n; i++) {
      pts.push(P(
        num(ins[0][Math.min(i, ins[0].length - 1)] ?? 0),
        num(ins[1][Math.min(i, ins[1].length - 1)] ?? 0),
        num(ins[2][Math.min(i, ins[2].length - 1)] ?? 0),
      ));
    }
    return { Pt: pts };
  },
});

def({
  type: 'VectorXYZ', name: 'Vector XYZ', nick: 'Vec',
  category: 'Params',
  inputs: [
    { name: 'X', nick: 'X', default: 0 },
    { name: 'Y', nick: 'Y', default: 0 },
    { name: 'Z', nick: 'Z', default: -1 },
  ],
  outputs: [{ name: 'V', nick: 'V' }],
  solve: (ins) => {
    const n = Math.max(ins[0].length, ins[1].length, ins[2].length, 1);
    const vs = [];
    for (let i = 0; i < n; i++) {
      vs.push(V(
        num(ins[0][Math.min(i, ins[0].length - 1)] ?? 0),
        num(ins[1][Math.min(i, ins[1].length - 1)] ?? 0),
        num(ins[2][Math.min(i, ins[2].length - 1)] ?? 0),
      ));
    }
    return { V: vs };
  },
});

def({
  type: 'Series', name: 'Series', nick: 'Series',
  category: 'Maths',
  inputs: [
    { name: 'Start', nick: 'S', default: 0 },
    { name: 'Step', nick: 'N', default: 1 },
    { name: 'Count', nick: 'C', default: 10 },
  ],
  outputs: [{ name: 'Series', nick: 'S' }],
  solve: (ins) => {
    const s = num(ins[0][0], 0), st = num(ins[1][0], 1), c = Math.max(0, Math.floor(num(ins[2][0], 10)));
    const out = [];
    for (let i = 0; i < Math.min(c, 10000); i++) out.push(s + st * i);
    return { Series: out };
  },
});

def({
  type: 'Multiplication', name: 'Multiplication', nick: 'A×B',
  category: 'Maths',
  inputs: [{ name: 'A', nick: 'A', default: 1 }, { name: 'B', nick: 'B', default: 1 }],
  outputs: [{ name: 'Result', nick: 'R' }],
  solve: (ins) => {
    const n = Math.max(ins[0].length, ins[1].length, 1);
    const out = [];
    for (let i = 0; i < n; i++)
      out.push(num(ins[0][Math.min(i, ins[0].length - 1)] ?? 1) * num(ins[1][Math.min(i, ins[1].length - 1)] ?? 1));
    return { Result: out };
  },
});

def({
  type: 'Line', name: 'Line', nick: 'Ln',
  category: 'Curve',
  inputs: [
    { name: 'Start Point', nick: 'A', required: true },
    { name: 'End Point', nick: 'B', required: true },
  ],
  outputs: [{ name: 'Line', nick: 'L' }],
  solve: (ins) => {
    const n = Math.max(ins[0].length, ins[1].length);
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = asPoint(ins[0][Math.min(i, ins[0].length - 1)]);
      const b = asPoint(ins[1][Math.min(i, ins[1].length - 1)]);
      if (a && b) out.push(LN(a, b));
    }
    return { Line: out };
  },
});

def({
  type: 'ImportGeometry', name: 'Import Geometry', nick: 'Import',
  category: 'Params',
  inputs: [],
  outputs: [{ name: 'Lines', nick: 'L' }, { name: 'Points', nick: 'P' }, { name: 'Info', nick: 'I' }],
  defaultState: () => ({ fileName: null }),
  solve: (ins, node) => {
    const g = window.__importedGeometry;
    if (!g || !g.lines || !g.lines.length) {
      return { Lines: [], Points: [], Info: ['No file imported yet — use File ▸ Import Model…'] };
    }
    node.state.fileName = g.name;
    const lines = g.lines.map(l => LN(P(l[0][0], l[0][1], l[0][2]), P(l[1][0], l[1][1], l[1][2])));
    const pts = [];
    const seen = new Set();
    for (const l of lines) for (const p of [l.a, l.b]) {
      const k = `${p.x},${p.y},${p.z}`;
      if (!seen.has(k)) { seen.add(k); pts.push(p); }
    }
    return { Lines: lines, Points: pts, Info: [`${g.name}: ${lines.length} lines, ${pts.length} nodes`] };
  },
});

/* ================= Karamba3D: Utilities (parametric structure generators) ==== */

def({
  type: 'TrussGenerator', name: 'Truss Generator', nick: 'Truss',
  category: 'Karamba3D|Utils',
  inputs: [
    { name: 'Span', nick: 'L', default: 12 },
    { name: 'Height', nick: 'H', default: 1.6 },
    { name: 'Divisions', nick: 'Div', default: 6 },
  ],
  outputs: [
    { name: 'Top Chord', nick: 'Top' }, { name: 'Bottom Chord', nick: 'Bot' },
    { name: 'Diagonals', nick: 'Diag' }, { name: 'All Lines', nick: 'Ln' },
    { name: 'Support Points', nick: 'SPt' }, { name: 'Load Points', nick: 'LPt' },
  ],
  solve: (ins) => {
    const L = Math.max(num(ins[0][0], 12), 0.1);
    const H = Math.max(num(ins[1][0], 1.6), 0.05);
    const div = Math.max(2, Math.min(40, Math.round(num(ins[2][0], 6))));
    const dx = L / div;
    const bot = [], top = [], diag = [];
    const botPts = [], topPts = [];
    for (let i = 0; i <= div; i++) botPts.push(P(i * dx, 0, 0));
    for (let i = 1; i < div; i++) topPts.push(P(i * dx, 0, H));
    for (let i = 0; i < div; i++) bot.push(LN(botPts[i], botPts[i + 1]));
    for (let i = 0; i < topPts.length - 1; i++) top.push(LN(topPts[i], topPts[i + 1]));
    // diagonals / verticals (Pratt-like)
    for (let i = 0; i < topPts.length; i++) {
      diag.push(LN(botPts[i], topPts[i]));
      diag.push(LN(botPts[i + 2], topPts[i]));
      diag.push(LN(botPts[i + 1], topPts[i]));
    }
    return {
      'Top Chord': top, 'Bottom Chord': bot, 'Diagonals': diag,
      'All Lines': [...bot, ...top, ...diag],
      'Support Points': [botPts[0], botPts[botPts.length - 1]],
      'Load Points': topPts.length ? topPts : botPts.slice(1, -1),
    };
  },
});

def({
  type: 'PortalFrame', name: 'Portal Frame 3D', nick: 'Frame',
  category: 'Karamba3D|Utils',
  inputs: [
    { name: 'Width X', nick: 'X', default: 8 },
    { name: 'Width Y', nick: 'Y', default: 6 },
    { name: 'Height', nick: 'H', default: 4 },
    { name: 'Storeys', nick: 'N', default: 2 },
  ],
  outputs: [
    { name: 'Columns', nick: 'Col' }, { name: 'Beams', nick: 'Bm' },
    { name: 'All Lines', nick: 'Ln' },
    { name: 'Support Points', nick: 'SPt' }, { name: 'Top Points', nick: 'TPt' },
  ],
  solve: (ins) => {
    const X = Math.max(num(ins[0][0], 8), 0.1), Y = Math.max(num(ins[1][0], 6), 0.1);
    const H = Math.max(num(ins[2][0], 4), 0.2);
    const N = Math.max(1, Math.min(12, Math.round(num(ins[3][0], 2))));
    const cols = [], beams = [];
    const base = [[0, 0], [X, 0], [X, Y], [0, Y]];
    for (let s = 0; s < N; s++) {
      const z0 = s * H, z1 = (s + 1) * H;
      for (const [x, y] of base) cols.push(LN(P(x, y, z0), P(x, y, z1)));
      for (let i = 0; i < 4; i++) {
        const [x0, y0] = base[i], [x1, y1] = base[(i + 1) % 4];
        beams.push(LN(P(x0, y0, z1), P(x1, y1, z1)));
      }
    }
    return {
      Columns: cols, Beams: beams, 'All Lines': [...cols, ...beams],
      'Support Points': base.map(([x, y]) => P(x, y, 0)),
      'Top Points': base.map(([x, y]) => P(x, y, N * H)),
    };
  },
});

/* ================= Karamba3D: 1. Model ================= */

def({
  type: 'LineToBeam', name: 'Line To Beam', nick: 'LtoB',
  category: 'Karamba3D|Model',
  inputs: [
    { name: 'Line', nick: 'Line', required: true },
    { name: 'Identifier', nick: 'Id', default: '' },
    { name: 'CroSec', nick: 'CroSec' },
  ],
  outputs: [{ name: 'Elem', nick: 'Elem' }, { name: 'Info', nick: 'Info' }],
  solve: (ins) => {
    const lines = asLines(ins[0]);
    const id = ins[1][0] || '';
    const crosec = ins[2].find(c => c && c.kind === 'crosec') || null;
    const beams = lines.map((l, i) => ({
      kind: 'beam', line: l, id: id ? `${id}` : `elem_${i}`,
      crosec: crosec ? crosec.data : null, material: crosec?.materialName || null,
    }));
    return { Elem: beams, Info: [`${beams.length} beams created`] };
  },
});

def({
  type: 'Support', name: 'Support', nick: 'Supp',
  category: 'Karamba3D|Model',
  extraH: 34,
  inputs: [{ name: 'Position', nick: 'Pos', required: true }],
  outputs: [{ name: 'Support', nick: 'Supp' }],
  defaultState: () => ({ fix: [true, true, true, false, false, false] }),
  drawExtra(ctx, n) {
    const labels = ['Tx', 'Ty', 'Tz', 'Rx', 'Ry', 'Rz'];
    const bx = n.x + 6, by = n.y + n.h - 30;
    ctx.font = '7.5px "Segoe UI", Verdana';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 6; i++) {
      const col = i % 3, row = Math.floor(i / 3);
      const x = bx + col * 27, y = by + row * 15;
      ctx.fillStyle = n.state.fix[i] ? '#3f8f29' : '#e8e8ec';
      ctx.fillRect(x, y, 9, 9);
      ctx.strokeStyle = '#3c3c40'; ctx.lineWidth = 0.7;
      ctx.strokeRect(x, y, 9, 9);
      if (n.state.fix[i]) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(x + 2, y + 4.5); ctx.lineTo(x + 4, y + 7); ctx.lineTo(x + 7.5, y + 2); ctx.stroke();
      }
      ctx.fillStyle = '#26262a';
      ctx.fillText(labels[i], x + 11, y + 5);
    }
  },
  onClick(node, wx, wy) {
    const bx = node.x + 6, by = node.y + node.h - 30;
    for (let i = 0; i < 6; i++) {
      const col = i % 3, row = Math.floor(i / 3);
      const x = bx + col * 27, y = by + row * 15;
      if (wx >= x - 1 && wx <= x + 24 && wy >= y - 2 && wy <= y + 11) {
        node.state.fix[i] = !node.state.fix[i];
        return true;
      }
    }
    return false;
  },
  solve: (ins, node) => {
    const sups = [];
    for (const v of ins[0]) {
      const p = asPoint(v);
      if (p) sups.push({ kind: 'support', pos: p, fix: node.state.fix.map(b => !!b) });
    }
    return { Support: sups };
  },
});

/* ================= Karamba3D: 2. Load ================= */

def({
  type: 'PointLoad', name: 'Point-Load', nick: 'PLoad',
  category: 'Karamba3D|Load',
  inputs: [
    { name: 'Position', nick: 'Pos', required: true },
    { name: 'Force [kN]', nick: 'Force' },
    { name: 'Moment [kNm]', nick: 'Moment' },
  ],
  outputs: [{ name: 'Load', nick: 'Load' }],
  solve: (ins) => {
    const loads = [];
    const forces = ins[1].filter(v => v && v.kind === 'vector');
    const moments = ins[2].filter(v => v && v.kind === 'vector');
    let i = 0;
    for (const v of ins[0]) {
      const p = asPoint(v);
      if (!p) continue;
      const f = forces[Math.min(i, forces.length - 1)] || V(0, 0, -1);
      const m = moments.length ? moments[Math.min(i, moments.length - 1)] : null;
      loads.push({
        kind: 'load', type: 'point', pos: p,
        force: [f.x, f.y, f.z],
        moment: m ? [m.x, m.y, m.z] : null,
      });
      i++;
    }
    return { Load: loads };
  },
});

def({
  type: 'Gravity', name: 'Gravity', nick: 'Grav',
  category: 'Karamba3D|Load',
  inputs: [{ name: 'Vector', nick: 'Vec' }],
  outputs: [{ name: 'Load', nick: 'Load' }],
  solve: (ins) => {
    const v = ins[0].find(x => x && x.kind === 'vector') || V(0, 0, -1);
    return { Load: [{ kind: 'load', type: 'gravity', vec: [v.x, v.y, v.z] }] };
  },
});

/* ================= Karamba3D: 3. Cross Section ================= */

function crosecValue(data, materialName) {
  return { kind: 'crosec', name: data.name, data, materialName: materialName || null };
}

def({
  type: 'CroSecRect', name: 'Rectangular Cross Section', nick: 'Rect',
  category: 'Karamba3D|CroSec',
  inputs: [
    { name: 'Height [cm]', nick: 'H', default: 10 },
    { name: 'Width [cm]', nick: 'B', default: 10 },
    { name: 'Material', nick: 'Mat' },
  ],
  outputs: [{ name: 'CroSec', nick: 'CroSec' }],
  solve: (ins) => {
    const mat = ins[2].find(m => m && m.kind === 'material');
    return { CroSec: [crosecValue(rectangleCroSec(num(ins[0][0], 10), num(ins[1][0], 10)), mat?.name)] };
  },
});

def({
  type: 'CroSecCircle', name: 'Circular Hollow Cross Section', nick: 'Circle',
  category: 'Karamba3D|CroSec',
  inputs: [
    { name: 'Diameter [cm]', nick: 'D', default: 11.4 },
    { name: 'Thickness [cm]', nick: 't', default: 0.4 },
    { name: 'Material', nick: 'Mat' },
  ],
  outputs: [{ name: 'CroSec', nick: 'CroSec' }],
  solve: (ins) => {
    const mat = ins[2].find(m => m && m.kind === 'material');
    return { CroSec: [crosecValue(circleCroSec(num(ins[0][0], 11.4), num(ins[1][0], 0.4)), mat?.name)] };
  },
});

def({
  type: 'CroSecI', name: 'I Profile Cross Section', nick: 'I-Sec',
  category: 'Karamba3D|CroSec',
  inputs: [
    { name: 'Height [cm]', nick: 'H', default: 20 },
    { name: 'Width [cm]', nick: 'B', default: 10 },
    { name: 'Flange [cm]', nick: 'tf', default: 0.85 },
    { name: 'Web [cm]', nick: 'tw', default: 0.56 },
    { name: 'Material', nick: 'Mat' },
  ],
  outputs: [{ name: 'CroSec', nick: 'CroSec' }],
  solve: (ins) => {
    const mat = ins[4].find(m => m && m.kind === 'material');
    return {
      CroSec: [crosecValue(
        iCroSec(num(ins[0][0], 20), num(ins[1][0], 10), num(ins[2][0], 0.85), num(ins[3][0], 0.56)), mat?.name)],
    };
  },
});

def({
  type: 'CroSecSelect', name: 'Cross Section Selector', nick: 'CroSecSel',
  category: 'Karamba3D|CroSec', layout: 'valuelist',
  inputs: [], outputs: [{ name: 'CroSec', nick: 'CS' }],
  defaultState: () => ({ items: Object.keys(CROSEC_TABLE), index: 3 }),
  onClick(node, wx) {
    const n = node.state.items.length;
    if (wx < node.x + node.w * 0.35) node.state.index = (node.state.index - 1 + n) % n;
    else node.state.index = (node.state.index + 1) % n;
    return true;
  },
  solve: (ins, node) => {
    const key = node.state.items[node.state.index];
    return { CroSec: [crosecValue(CROSEC_TABLE[key])] };
  },
});

/* ================= Karamba3D: 4. Material ================= */

def({
  type: 'MatSelect', name: 'Material Selection', nick: 'MatSel',
  category: 'Karamba3D|Material', layout: 'valuelist',
  inputs: [], outputs: [{ name: 'Material', nick: 'Mat' }],
  defaultState: () => ({ items: Object.keys(MATERIALS), index: 0 }),
  onClick(node, wx) {
    const n = node.state.items.length;
    if (wx < node.x + node.w * 0.35) node.state.index = (node.state.index - 1 + n) % n;
    else node.state.index = (node.state.index + 1) % n;
    return true;
  },
  solve: (ins, node) => {
    const name = node.state.items[node.state.index];
    const m = MATERIALS[name];
    return { Material: [{ kind: 'material', name, ...m }] };
  },
});

def({
  type: 'MatProps', name: 'Material Properties', nick: 'MatProps',
  category: 'Karamba3D|Material',
  inputs: [{ name: 'Material', nick: 'Mat', required: true }],
  outputs: [
    { name: 'E [kN/cm²]', nick: 'E' }, { name: 'G [kN/cm²]', nick: 'G' },
    { name: 'gamma [kN/m³]', nick: 'γ' }, { name: 'fy [kN/cm²]', nick: 'fy' },
  ],
  solve: (ins) => {
    const m = ins[0].find(x => x && x.kind === 'material');
    if (!m) return { 'E [kN/cm²]': [], 'G [kN/cm²]': [], 'gamma [kN/m³]': [], 'fy [kN/cm²]': [] };
    return { 'E [kN/cm²]': [m.E], 'G [kN/cm²]': [m.G], 'gamma [kN/m³]': [m.gamma], 'fy [kN/cm²]': [m.fy] };
  },
});

/* ================= Karamba3D: 5. Algorithms ================= */

function buildFem(modelVal) {
  const fem = new FemModel();
  for (const b of modelVal.beams) {
    const cs = b.crosec || (modelVal.defaultCroSec ? modelVal.defaultCroSec.data : DEFAULT_CROSEC);
    const mat = b.material || modelVal.defaultMaterial || DEFAULT_MATERIAL;
    fem.addBeam(b.line.a, b.line.b, cs, mat, b.id);
  }
  for (const s of modelVal.supports) {
    const ni = fem.findClosestNode(s.pos, 1e-3);
    if (ni >= 0) fem.supports.push({ node: ni, fix: s.fix.map(b => b ? 1 : 0) });
  }
  for (const l of modelVal.loads) {
    if (l.type === 'gravity') fem.gravity = { vec: l.vec };
    else if (l.type === 'point') {
      const ni = fem.findClosestNode(l.pos, 1e-3);
      if (ni >= 0) fem.pointLoads.push({ node: ni, force: l.force, moment: l.moment || null });
    }
  }
  return fem;
}

def({
  type: 'Assemble', name: 'Assemble Model', nick: 'Ass',
  category: 'Karamba3D|Model',
  inputs: [
    { name: 'Elem', nick: 'Elem', required: true },
    { name: 'Support', nick: 'Supp' },
    { name: 'Load', nick: 'Load' },
    { name: 'CroSec', nick: 'CroSec' },
    { name: 'Material', nick: 'Mat' },
  ],
  outputs: [
    { name: 'Model', nick: 'Model' }, { name: 'Info', nick: 'Info' },
    { name: 'Mass [kg]', nick: 'Mass' }, { name: 'COG', nick: 'COG' },
  ],
  solve: (ins) => {
    const beams = ins[0].filter(v => v && v.kind === 'beam');
    const supports = ins[1].filter(v => v && v.kind === 'support');
    const loads = ins[2].filter(v => v && v.kind === 'load');
    const defaultCroSec = ins[3].find(v => v && v.kind === 'crosec') || null;
    const defaultMaterial = (ins[4].find(v => v && v.kind === 'material') || {}).name || null;
    if (!beams.length) throw new Error('No elements to assemble');

    const modelVal = { kind: 'model', beams, supports, loads, defaultCroSec, defaultMaterial };
    const fem = buildFem(modelVal);
    modelVal.fem = fem;
    modelVal.elements = fem.elements;
    modelVal.nodes = fem.nodes;

    // mass + cog
    let mass = 0, cx = 0, cy = 0, cz = 0;
    for (const el of fem.elements) {
      const p0 = fem.nodes[el.n0], p1 = fem.nodes[el.n1];
      const L = Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
      const mat = MATERIALS[el.material] || MATERIALS[DEFAULT_MATERIAL];
      const cs = el.crosec || DEFAULT_CROSEC;
      const w = mat.gamma * (cs.A * 1e-4) * L / 9.80665 * 1000; // kg
      mass += w;
      cx += w * (p0.x + p1.x) / 2; cy += w * (p0.y + p1.y) / 2; cz += w * (p0.z + p1.z) / 2;
    }
    const cog = mass > 0 ? P(cx / mass, cy / mass, cz / mass) : P(0, 0, 0);
    const info = `${fem.elements.length} elements | ${fem.nodes.length} nodes | ${supports.length} supports | ${loads.length} loads`;
    return { Model: [modelVal], Info: [info], 'Mass [kg]': [mass], COG: [cog] };
  },
});

def({
  type: 'AnalyzeThI', name: 'Analyze Th.I', nick: 'Analyze',
  category: 'Karamba3D|Algorithms',
  inputs: [{ name: 'Model', nick: 'Model', required: true }],
  outputs: [
    { name: 'Model', nick: 'Model' },
    { name: 'Max Displacement [cm]', nick: 'Disp' },
    { name: 'Gravity Force [kN]', nick: 'G' },
    { name: 'Elastic Energy [kNm]', nick: 'Energy' },
    { name: 'Info', nick: 'Info' },
  ],
  solve: (ins) => {
    const mv = ins[0].find(v => v && v.kind === 'model');
    if (!mv) return { Model: [], 'Max Displacement [cm]': [], 'Gravity Force [kN]': [], 'Elastic Energy [kNm]': [], Info: [] };
    const res = analyze(mv.fem);
    if (!res.ok) throw new Error(res.error);
    const out = { kind: 'analysis', ...res, sourceModel: mv };
    let g = 0;
    if (mv.fem.gravity) g = res.mass * 9.80665 / 1000; // kN
    return {
      Model: [out],
      'Max Displacement [cm]': [res.maxDisp * 100],
      'Gravity Force [kN]': [g],
      'Elastic Energy [kNm]': [res.elasticEnergy],
      Info: [`max u = ${(res.maxDisp * 100).toFixed(3)} cm | max util = ${(res.maxUtil * 100).toFixed(1)}%`],
    };
  },
});

def({
  type: 'Disassemble', name: 'Disassemble Model', nick: 'Disass',
  category: 'Karamba3D|Model',
  inputs: [{ name: 'Model', nick: 'Model', required: true }],
  outputs: [
    { name: 'Nodes', nick: 'Pt' }, { name: 'Lines', nick: 'Ln' },
    { name: 'Supports', nick: 'Supp' }, { name: 'Loads', nick: 'Load' },
  ],
  solve: (ins) => {
    const mv = ins[0].find(v => v && (v.kind === 'model' || v.kind === 'analysis'));
    const m = mv && mv.kind === 'analysis' ? mv.sourceModel : mv;
    if (!m) return { Nodes: [], Lines: [], Supports: [], Loads: [] };
    return {
      Nodes: m.fem.nodes.map(n => P(n.x, n.y, n.z)),
      Lines: m.fem.elements.map(e => LN(P(m.fem.nodes[e.n0].x, m.fem.nodes[e.n0].y, m.fem.nodes[e.n0].z), P(m.fem.nodes[e.n1].x, m.fem.nodes[e.n1].y, m.fem.nodes[e.n1].z))),
      Supports: m.supports,
      Loads: m.loads,
    };
  },
});

/* ================= Karamba3D: 6. Results ================= */

def({
  type: 'ModelView', name: 'Model View', nick: 'ModelView',
  category: 'Karamba3D|Results',
  inputs: [
    { name: 'Model', nick: 'Model', required: true },
    { name: 'Deformation Scale', nick: 'Def', default: 1 },
  ],
  outputs: [{ name: 'Model', nick: 'Model' }],
  defaultState: () => ({}),
  solve: (ins) => {
    const mv = ins[0].find(v => v && (v.kind === 'analysis' || v.kind === 'model'));
    if (!mv) return { Model: [] };
    const view = {
      kind: 'view', mode: 'model',
      analysis: mv.kind === 'analysis' ? mv : null,
      model: mv.kind === 'analysis' ? mv.sourceModel : mv,
      defScale: num(ins[1][0], 1),
    };
    return { Model: [view] };
  },
});

def({
  type: 'BeamView', name: 'Beam View', nick: 'BeamView',
  category: 'Karamba3D|Results',
  extraH: 20,
  inputs: [
    { name: 'Model', nick: 'Model', required: true },
    { name: 'Deformation Scale', nick: 'Def', default: 1 },
  ],
  outputs: [{ name: 'Model', nick: 'Model' }],
  defaultState: () => ({ colorModes: ['Utilization', 'Displacement', 'Axial Force', 'Bending Moment'], colorIndex: 0 }),
  drawExtra(ctx, n) {
    const y = n.y + n.h - 15;
    ctx.fillStyle = '#efefe4';
    ctx.fillRect(n.x + 5, y - 2, n.w - 10, 13);
    ctx.strokeStyle = '#3c3c40'; ctx.lineWidth = 0.6;
    ctx.strokeRect(n.x + 5, y - 2, n.w - 10, 13);
    ctx.fillStyle = '#26262a';
    ctx.font = '8px "Segoe UI", Verdana';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('◂ ' + n.state.colorModes[n.state.colorIndex] + ' ▸', n.x + n.w / 2, y + 4.5);
  },
  onClick(node, wx, wy) {
    const y = node.y + node.h - 15;
    if (wy < y - 2 || wy > y + 11) return false;
    const n = node.state.colorModes.length;
    if (wx < node.x + node.w / 2) node.state.colorIndex = (node.state.colorIndex - 1 + n) % n;
    else node.state.colorIndex = (node.state.colorIndex + 1) % n;
    return true;
  },
  solve: (ins, node) => {
    const mv = ins[0].find(v => v && v.kind === 'analysis');
    if (!mv) return { Model: [] };
    const view = {
      kind: 'view', mode: 'beam',
      analysis: mv, model: mv.sourceModel,
      defScale: num(ins[1][0], 1),
      colorMode: node.state.colorModes[node.state.colorIndex],
    };
    return { Model: [view] };
  },
});

def({
  type: 'NodalDisp', name: 'Nodal Displacements', nick: 'NodeDisp',
  category: 'Karamba3D|Results',
  inputs: [{ name: 'Model', nick: 'Model', required: true }],
  outputs: [{ name: 'Translations [cm]', nick: 'Trans' }, { name: 'Rotations [rad]', nick: 'Rot' }],
  solve: (ins) => {
    const a = ins[0].find(v => v && v.kind === 'analysis');
    if (!a) return { 'Translations [cm]': [], 'Rotations [rad]': [] };
    return {
      'Translations [cm]': a.disp.map(d => V(d.dx * 100, d.dy * 100, d.dz * 100)),
      'Rotations [rad]': a.disp.map(d => V(d.rx, d.ry, d.rz)),
    };
  },
});

def({
  type: 'ReactionForces', name: 'Reaction Forces', nick: 'Reaction',
  category: 'Karamba3D|Results',
  inputs: [{ name: 'Model', nick: 'Model', required: true }],
  outputs: [
    { name: 'Positions', nick: 'Pos' },
    { name: 'Forces [kN]', nick: 'Force' },
    { name: 'Moments [kNm]', nick: 'Moment' },
  ],
  solve: (ins) => {
    const a = ins[0].find(v => v && v.kind === 'analysis');
    if (!a) return { Positions: [], 'Forces [kN]': [], 'Moments [kNm]': [] };
    const nodes = a.model.nodes;
    return {
      Positions: a.reactions.map(r => P(nodes[r.node].x, nodes[r.node].y, nodes[r.node].z)),
      'Forces [kN]': a.reactions.map(r => V(r.force[0], r.force[1], r.force[2])),
      'Moments [kNm]': a.reactions.map(r => V(r.moment[0], r.moment[1], r.moment[2])),
    };
  },
});

def({
  type: 'Utilization', name: 'Utilization of Elements', nick: 'Util',
  category: 'Karamba3D|Results',
  inputs: [{ name: 'Model', nick: 'Model', required: true }],
  outputs: [{ name: 'Utilization [-]', nick: 'Util' }, { name: 'Max [-]', nick: 'Max' }],
  solve: (ins) => {
    const a = ins[0].find(v => v && v.kind === 'analysis');
    if (!a) return { 'Utilization [-]': [], 'Max [-]': [] };
    return { 'Utilization [-]': a.results.map(r => r.utilSigned), 'Max [-]': [a.maxUtil] };
  },
});

def({
  type: 'BeamForces', name: 'Beam Resultant Forces', nick: 'B-Forces',
  category: 'Karamba3D|Results',
  inputs: [{ name: 'Model', nick: 'Model', required: true }],
  outputs: [
    { name: 'Normal Force N [kN]', nick: 'N' },
    { name: 'Shear V [kN]', nick: 'V' },
    { name: 'Moment M [kNm]', nick: 'M' },
  ],
  solve: (ins) => {
    const a = ins[0].find(v => v && v.kind === 'analysis');
    if (!a) return { 'Normal Force N [kN]': [], 'Shear V [kN]': [], 'Moment M [kNm]': [] };
    return {
      'Normal Force N [kN]': a.results.map(r => r.N),
      'Shear V [kN]': a.results.map(r => Math.hypot(r.Vy, r.Vz)),
      'Moment M [kNm]': a.results.map(r => Math.max(
        Math.abs(r.My[0]), Math.abs(r.My[1]), Math.abs(r.Mz[0]), Math.abs(r.Mz[1]))),
    };
  },
});

/* ================= toolbar structure ================= */

export const COMPONENT_TABS = [
  {
    tab: 'Params',
    groups: [
      { name: 'Input', items: ['NumberSlider', 'Panel', 'BooleanToggle'] },
      { name: 'Geometry', items: ['ConstructPoint', 'VectorXYZ', 'ImportGeometry'] },
    ],
  },
  {
    tab: 'Maths',
    groups: [{ name: 'Operators', items: ['Series', 'Multiplication'] }],
  },
  {
    tab: 'Curve',
    groups: [{ name: 'Primitive', items: ['Line'] }],
  },
  {
    tab: 'Karamba3D',
    groups: [
      { name: '1.Model', items: ['LineToBeam', 'Support', 'Assemble', 'Disassemble'] },
      { name: '2.Load', items: ['PointLoad', 'Gravity'] },
      { name: '3.Cross Section', items: ['CroSecRect', 'CroSecCircle', 'CroSecI', 'CroSecSelect'] },
      { name: '4.Material', items: ['MatSelect', 'MatProps'] },
      { name: '5.Algorithms', items: ['AnalyzeThI'] },
      { name: '6.Results', items: ['ModelView', 'BeamView', 'NodalDisp', 'ReactionForces', 'Utilization', 'BeamForces'] },
      { name: 'Utils', items: ['TrussGenerator', 'PortalFrame'] },
    ],
  },
];
