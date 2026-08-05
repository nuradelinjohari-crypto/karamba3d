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
  FemModel, analyze, optimizeCroSec, MATERIALS, CROSEC_TABLE, CROSEC_FAMILIES,
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
  desc: 'A panel for custom notes and text values. Wired: displays incoming data. Unwired: acts as a text source (double-click to edit; right-click for font size & colour).',
  inputs: [{ name: 'In', nick: '' }], outputs: [{ name: 'Out', nick: '' }],
  defaultState: () => ({ w: 130, h: 84, text: '', fontSize: 9, color: '#fff9bd' }),
  solve: (ins, node) => {
    if (ins[0].length) return { Out: ins[0] };
    const t = node.state.text ?? '';
    return { Out: t === '' ? [] : t.split('\n').filter(s => s !== '') };
  },
});

def({
  type: 'ColourSwatch', name: 'Colour Swatch', nick: 'Swatch',
  category: 'Params', layout: 'valuelist',
  desc: 'A colour picker for Custom Preview. Click ◂ ▸ to cycle the palette; right-click ▸ Set custom colour for any hex value.',
  inputs: [], outputs: [{ name: 'Colour', nick: 'C' }],
  defaultState: () => ({
    items: ['#d03434', '#e8890c', '#e8d20c', '#3fae3f', '#2196c9', '#3949ab', '#8e44ad', '#607d8b', '#212121'],
    index: 0,
  }),
  onClick(node, wx) {
    const n = node.state.items.length;
    if (wx < node.x + node.w * 0.35) node.state.index = (node.state.index - 1 + n) % n;
    else node.state.index = (node.state.index + 1) % n;
    return true;
  },
  solve: (ins, node) => ({ Colour: [{ kind: 'color', hex: node.state.items[node.state.index] }] }),
});

def({
  type: 'CustomPreview', name: 'Custom Preview', nick: 'Preview',
  category: 'Params',
  desc: 'Allows for customized geometry previews: displays the geometry in the given colour in the viewport (like Grasshopper\'s Custom Preview).',
  inputs: [
    { name: 'Geometry', nick: 'G', required: true, geo: 'any' },
    { name: 'Material / Colour', nick: 'M' },
  ],
  outputs: [],
  solve: (ins) => {
    const col = ins[1].find(v => v && v.kind === 'color');
    const items = ins[0].filter(v => v && (v.kind === 'point' || v.kind === 'line' || v.kind === 'mesh'));
    return { __preview: [{ kind: 'cpreview', color: col ? col.hex : '#d03434', items }] };
  },
});

def({
  type: 'UnitZ', name: 'Unit Z', nick: 'Z',
  category: 'Params',
  desc: 'Unit vector parallel to the world Z axis, scaled by Factor.',
  inputs: [{ name: 'Factor', nick: 'F', default: 1 }],
  outputs: [{ name: 'Unit vector', nick: 'V' }],
  solve: (ins) => ({ 'Unit vector': ins[0].map(f => V(0, 0, num(f, 1))) }),
});

def({
  type: 'GeoParam', name: 'Geometry', nick: 'Geo',
  category: 'Params',
  desc: 'Pass-through container for geometry (Curve / Point / Mesh param from an imported Grasshopper file). Referenced Rhino geometry is re-bound to the imported .3dm model.',
  inputs: [{ name: 'In', nick: '', geo: 'any' }], outputs: [{ name: 'Out', nick: '' }],
  defaultState: () => ({ paramKind: 'geometry', origName: '' }),
  solve: (ins) => ({ Out: ins[0] }),
});

def({
  type: 'Unsupported', name: 'Unsupported Component', nick: '???',
  category: 'Params',
  desc: 'A component from the imported Grasshopper file that this replica does not implement. Data passes straight through untouched.',
  inputs: [{ name: 'In', nick: '' }], outputs: [{ name: 'Out', nick: '' }],
  defaultState: () => ({ origName: 'unknown' }),
  solve: (ins, node) => {
    node.warning = `'${node.state.origName}' is not implemented in this replica — data passes through unchanged`;
    return { Out: ins[0] };
  },
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

function numericBinop(type, name, nick, fn, defA = 0, defB = 0) {
  def({
    type, name, nick, category: 'Maths',
    desc: `Mathematical ${name.toLowerCase()}.`,
    inputs: [{ name: 'A', nick: 'A', default: defA }, { name: 'B', nick: 'B', default: defB }],
    outputs: [{ name: 'Result', nick: 'R' }],
    solve: (ins) => {
      const n = Math.max(ins[0].length, ins[1].length, 1);
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = ins[0][Math.min(i, ins[0].length - 1)];
        const b = ins[1][Math.min(i, ins[1].length - 1)];
        out.push(fn(a, b));
      }
      return { Result: out };
    },
  });
}

const vec3 = (v) => (v && (v.kind === 'vector' || v.kind === 'point')) ? [v.x, v.y, v.z] : null;

numericBinop('Addition', 'Addition', 'A+B', (a, b) => {
  const va = vec3(a), vb = vec3(b);
  if (va && vb) return { kind: a.kind === 'point' || b.kind === 'point' ? 'point' : 'vector', x: va[0] + vb[0], y: va[1] + vb[1], z: va[2] + vb[2] };
  return num(a, 0) + num(b, 0);
});
numericBinop('Subtraction', 'Subtraction', 'A−B', (a, b) => {
  const va = vec3(a), vb = vec3(b);
  if (va && vb) return { kind: 'vector', x: va[0] - vb[0], y: va[1] - vb[1], z: va[2] - vb[2] };
  return num(a, 0) - num(b, 0);
});
numericBinop('Division', 'Division', 'A÷B', (a, b) => {
  const va = vec3(a);
  const d = num(b, 1) || 1;
  if (va) return { kind: a.kind, x: va[0] / d, y: va[1] / d, z: va[2] / d };
  return num(a, 0) / d;
}, 0, 1);

def({
  type: 'Negative', name: 'Negative', nick: '−x',
  category: 'Maths',
  desc: 'Compute the negative of a value (numbers and vectors).',
  inputs: [{ name: 'Value', nick: 'x', default: 0 }],
  outputs: [{ name: 'Result', nick: 'y' }],
  solve: (ins) => ({
    Result: ins[0].map(v => {
      const vv = vec3(v);
      if (vv) return { kind: v.kind, x: -vv[0], y: -vv[1], z: -vv[2] };
      return -num(v, 0);
    }),
  }),
});

def({
  type: 'Deconstruct', name: 'Deconstruct', nick: 'pDecon',
  category: 'Maths',
  desc: 'Deconstruct a point into its {x, y, z} coordinates.',
  inputs: [{ name: 'Point', nick: 'P', required: true, geo: 'point' }],
  outputs: [{ name: 'X component', nick: 'X' }, { name: 'Y component', nick: 'Y' }, { name: 'Z component', nick: 'Z' }],
  solve: (ins) => {
    const pts = ins[0].map(asPoint).filter(Boolean);
    return {
      'X component': pts.map(p => p.x),
      'Y component': pts.map(p => p.y),
      'Z component': pts.map(p => p.z),
    };
  },
});

def({
  type: 'Move', name: 'Move', nick: 'Move',
  category: 'Curve',
  desc: 'Translate geometry along a vector (points, lines and meshes).',
  inputs: [
    { name: 'Geometry', nick: 'G', required: true, geo: 'any' },
    { name: 'Motion', nick: 'T' },
  ],
  outputs: [{ name: 'Geometry', nick: 'G' }],
  solve: (ins) => {
    const t = ins[1].find(v => v && v.kind === 'vector') || V(0, 0, 0);
    const mv = (p) => P(p.x + t.x, p.y + t.y, p.z + t.z);
    return {
      Geometry: ins[0].map(g => {
        if (!g || typeof g !== 'object') return g;
        if (g.kind === 'point') return mv(g);
        if (g.kind === 'line') return LN(mv(g.a), mv(g.b));
        if (g.kind === 'mesh') return { kind: 'mesh', vertices: g.vertices.map(v => [v[0] + t.x, v[1] + t.y, v[2] + t.z]), faces: g.faces };
        return g;
      }),
    };
  },
});

def({
  type: 'PolyLineComp', name: 'PolyLine', nick: 'PLine',
  category: 'Curve',
  desc: 'Create a polyline through a list of vertex points (output as line segments).',
  inputs: [
    { name: 'Vertices', nick: 'V', required: true, geo: 'point' },
    { name: 'Closed', nick: 'C', default: false },
  ],
  outputs: [{ name: 'Polyline', nick: 'Pl' }],
  solve: (ins) => {
    const pts = ins[0].map(asPoint).filter(Boolean);
    const closed = !!(ins[1][0]);
    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) segs.push(LN(pts[i], pts[i + 1]));
    if (closed && pts.length > 2) segs.push(LN(pts[pts.length - 1], pts[0]));
    return { Polyline: segs };
  },
});

def({
  type: 'Explode', name: 'Explode', nick: 'Explode',
  category: 'Curve',
  desc: 'Explode curves into segments and vertices.',
  inputs: [{ name: 'Curve', nick: 'C', required: true, geo: 'line' }],
  outputs: [{ name: 'Segments', nick: 'S' }, { name: 'Vertices', nick: 'V' }],
  solve: (ins) => {
    const lines = asLines(ins[0]);
    const verts = [];
    const seen = new Set();
    for (const l of lines) for (const p of [l.a, l.b]) {
      const k = `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`;
      if (!seen.has(k)) { seen.add(k); verts.push(p); }
    }
    return { Segments: lines, Vertices: verts };
  },
});

def({
  type: 'ListItem', name: 'List Item', nick: 'Item',
  category: 'Maths',
  desc: 'Retrieve a specific item from a list (wrapping indices).',
  inputs: [
    { name: 'List', nick: 'L', required: true },
    { name: 'Index', nick: 'i', default: 0 },
    { name: 'Wrap', nick: 'W', default: true },
  ],
  outputs: [{ name: 'Item', nick: 'i' }],
  solve: (ins) => {
    const list = ins[0];
    if (!list.length) return { Item: [] };
    const idx = ins[1].length ? ins[1] : [0];
    return {
      Item: idx.map(iv => {
        let i = Math.round(num(iv, 0));
        i = ((i % list.length) + list.length) % list.length;
        return list[i];
      }),
    };
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
    { name: 'Start Point', nick: 'A', required: true, geo: 'point' },
    { name: 'End Point', nick: 'B', required: true, geo: 'point' },
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
  outputs: [
    { name: 'Lines', nick: 'L' }, { name: 'Points', nick: 'P' },
    { name: 'Mesh', nick: 'M' }, { name: 'Info', nick: 'I' },
  ],
  defaultState: () => ({ fileName: null }),
  solve: (ins, node) => {
    const g = window.__importedGeometry;
    if (!g || ((!g.lines || !g.lines.length) && (!g.meshes || !g.meshes.length) && (!g.points || !g.points.length))) {
      return { Lines: [], Points: [], Mesh: [], Info: ['No file imported yet — use File ▸ Import Model… (.3dm / .obj / .dxf / .json)'] };
    }
    node.state.fileName = g.name;
    const lines = (g.lines || []).map(l => LN(P(l[0][0], l[0][1], l[0][2]), P(l[1][0], l[1][1], l[1][2])));
    const pts = [];
    const seen = new Set();
    for (const l of lines) for (const p of [l.a, l.b]) {
      const k = `${p.x},${p.y},${p.z}`;
      if (!seen.has(k)) { seen.add(k); pts.push(p); }
    }
    for (const p of (g.points || [])) {
      const k = `${p[0]},${p[1]},${p[2]}`;
      if (!seen.has(k)) { seen.add(k); pts.push(P(p[0], p[1], p[2])); }
    }
    const meshes = (g.meshes || []).map(m => ({ kind: 'mesh', vertices: m.vertices, faces: m.faces }));
    const nFaces = meshes.reduce((s, m) => s + m.faces.length, 0);
    return {
      Lines: lines, Points: pts, Mesh: meshes,
      Info: [`${g.name}: ${lines.length} lines, ${pts.length} points, ${meshes.length} meshes (${nFaces} faces)`],
    };
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

def({
  type: 'ShellCanopy', name: 'Shell Canopy', nick: 'Canopy',
  category: 'Karamba3D|Utils',
  inputs: [
    { name: 'Span X', nick: 'X', default: 10 },
    { name: 'Span Y', nick: 'Y', default: 8 },
    { name: 'Rise', nick: 'R', default: 2 },
    { name: 'Divisions', nick: 'Div', default: 10 },
  ],
  outputs: [
    { name: 'Mesh', nick: 'M' },
    { name: 'Corner Points', nick: 'CPt' },
    { name: 'Center Point', nick: 'MPt' },
  ],
  solve: (ins) => {
    const LX = Math.max(num(ins[0][0], 10), 0.5), LY = Math.max(num(ins[1][0], 8), 0.5);
    const R = num(ins[2][0], 2);
    const N = Math.max(3, Math.min(24, Math.round(num(ins[3][0], 10))));
    const vertices = [], faces = [];
    // elliptic-paraboloid canopy: z = R·(1−u²)(1−v²), corners on the ground
    const idx = (i, j) => i * (N + 1) + j;
    for (let i = 0; i <= N; i++)
      for (let j = 0; j <= N; j++) {
        const u = 2 * i / N - 1, v = 2 * j / N - 1;
        vertices.push([(u + 1) / 2 * LX, (v + 1) / 2 * LY, R * (1 - u * u) * (1 - v * v)]);
      }
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++) {
        faces.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1)]);
        faces.push([idx(i, j), idx(i + 1, j + 1), idx(i, j + 1)]);
      }
    return {
      Mesh: [{ kind: 'mesh', vertices, faces }],
      'Corner Points': [P(0, 0, 0), P(LX, 0, 0), P(LX, LY, 0), P(0, LY, 0)],
      'Center Point': [P(LX / 2, LY / 2, R)],
    };
  },
});

/* ================= Karamba3D: 1. Model ================= */

def({
  type: 'LineToBeam', name: 'Line To Beam', nick: 'LtoB',
  category: 'Karamba3D|Model',
  inputs: [
    { name: 'Line', nick: 'Line', required: true, geo: 'line' },
    { name: 'Identifier', nick: 'Id', default: '' },
    { name: 'CroSec', nick: 'CroSec' },
  ],
  outputs: [{ name: 'Elem', nick: 'Elem' }, { name: 'Pts', nick: 'Pts' }, { name: 'Info', nick: 'Info' }],
  solve: (ins) => {
    const lines = asLines(ins[0]);
    const id = ins[1][0] || '';
    const crosec = ins[2].find(c => c && c.kind === 'crosec') || null;
    const beams = lines.map((l, i) => ({
      kind: 'beam', line: l, id: id ? `${id}` : `elem_${i}`,
      crosec: crosec ? crosec.data : null, material: crosec?.materialName || null,
    }));
    // unique endpoints (welded at 5 mm, like Karamba's LDist)
    const pts = [];
    const seen = new Set();
    for (const l of lines) for (const p of [l.a, l.b]) {
      const k = `${Math.round(p.x / 0.005)},${Math.round(p.y / 0.005)},${Math.round(p.z / 0.005)}`;
      if (!seen.has(k)) { seen.add(k); pts.push(p); }
    }
    return { Elem: beams, Pts: pts, Info: [`${beams.length} beams created, ${pts.length} nodes`] };
  },
});

def({
  type: 'BottomPoints', name: 'Bottom Points', nick: 'BotPts',
  category: 'Karamba3D|Utils',
  inputs: [
    { name: 'Points', nick: 'Pts', required: true, geo: 'point' },
    { name: 'Tolerance [m]', nick: 'Tol', default: 0.05 },
  ],
  outputs: [{ name: 'Bottom Points', nick: 'Bot' }, { name: 'Count', nick: 'N' }],
  solve: (ins) => {
    const pts = ins[0].map(asPoint).filter(Boolean);
    if (!pts.length) return { 'Bottom Points': [], Count: [0] };
    const tol = Math.max(num(ins[1][0], 0.05), 1e-4);
    const zmin = Math.min(...pts.map(p => p.z));
    const bot = pts.filter(p => p.z <= zmin + tol);
    return { 'Bottom Points': bot, Count: [bot.length] };
  },
});

def({
  type: 'Support', name: 'Support', nick: 'Supp',
  category: 'Karamba3D|Model',
  extraH: 34,
  inputs: [{ name: 'Position', nick: 'Pos', required: true, geo: 'point' }],
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

def({
  type: 'MeshToShell', name: 'Mesh To Shell', nick: 'MtoS',
  category: 'Karamba3D|Model',
  inputs: [
    { name: 'Mesh', nick: 'Mesh', required: true, geo: 'mesh' },
    { name: 'Identifier', nick: 'Id', default: '' },
    { name: 'CroSec', nick: 'CroSec' },
  ],
  outputs: [{ name: 'Elem', nick: 'Elem' }, { name: 'Info', nick: 'Info' }],
  solve: (ins) => {
    const meshes = ins[0].filter(v => v && v.kind === 'mesh');
    const id = ins[1][0] || '';
    const cs = ins[2].find(c => c && c.kind === 'crosec' && c.shell);
    const t = cs ? cs.t : 1;                  // Karamba default shell: 1 cm
    const mat = cs?.materialName || null;
    const shells = [];
    let nTris = 0;
    for (const m of meshes) {
      const tris = [];
      for (const f of m.faces) {
        // split quads
        if (f.length >= 4 && f[2] !== f[3]) {
          tris.push([f[0], f[1], f[2]], [f[0], f[2], f[3]]);
        } else tris.push([f[0], f[1], f[2]]);
      }
      nTris += tris.length;
      shells.push({ kind: 'shell', vertices: m.vertices, tris, t, material: mat, id: id || 'shell' });
    }
    return { Elem: shells, Info: [`${shells.length} shells (${nTris} triangles, t = ${t} cm)`] };
  },
});

/* ================= Karamba3D: 2. Load ================= */

def({
  type: 'PointLoad', name: 'Point-Load', nick: 'PLoad',
  category: 'Karamba3D|Load',
  inputs: [
    { name: 'Position', nick: 'Pos', required: true, geo: 'point' },
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
  type: 'LineLoad', name: 'Line-Load (UDL)', nick: 'LLoad',
  category: 'Karamba3D|Load',
  desc: 'Uniformly distributed load [kN/m]. With lines wired in it loads the beams on those lines; with no lines it applies to ALL elements (like Karamba with an empty Elems|Ids).',
  inputs: [
    { name: 'Line', nick: 'Line', geo: 'line' },
    { name: 'Force [kN/m]', nick: 'Vec' },
  ],
  outputs: [{ name: 'Load', nick: 'Load' }],
  solve: (ins) => {
    const lines = asLines(ins[0]);
    const vecs = ins[1].filter(v => v && v.kind === 'vector');
    const loads = [];
    if (!lines.length) {
      // Karamba semantics: no element selection → the load acts on all elements
      const v = vecs[0] || V(0, 0, -1);
      loads.push({ kind: 'load', type: 'line', all: true, w: [v.x, v.y, v.z] });
    } else {
      lines.forEach((l, i) => {
        const v = vecs[Math.min(i, vecs.length - 1)] || V(0, 0, -1);
        loads.push({ kind: 'load', type: 'line', a: l.a, b: l.b, w: [v.x, v.y, v.z] });
      });
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
  type: 'ShellConst', name: 'Shell Cross Section (Const)', nick: 'ShellConst',
  category: 'Karamba3D|CroSec',
  inputs: [
    { name: 'Height [cm]', nick: 'H', default: 1 },
    { name: 'Material', nick: 'Mat' },
  ],
  outputs: [{ name: 'CroSec', nick: 'CroSec' }],
  solve: (ins) => {
    const t = Math.max(num(ins[0][0], 1), 0.05);
    const mat = ins[1].find(m => m && m.kind === 'material');
    return { CroSec: [{ kind: 'crosec', shell: true, t, name: `Shell t=${t}cm`, materialName: mat?.name || null }] };
  },
});

def({
  type: 'CroSecRange', name: 'Cross Section Range Selector', nick: 'CroSecRange',
  category: 'Karamba3D|CroSec', layout: 'valuelist',
  inputs: [], outputs: [{ name: 'CroSecs', nick: 'CS' }],
  defaultState: () => ({ items: Object.keys(CROSEC_FAMILIES), index: 0 }),
  onClick(node, wx) {
    const n = node.state.items.length;
    if (wx < node.x + node.w * 0.35) node.state.index = (node.state.index - 1 + n) % n;
    else node.state.index = (node.state.index + 1) % n;
    return true;
  },
  solve: (ins, node) => {
    const fam = node.state.items[node.state.index];
    return { CroSecs: CROSEC_FAMILIES[fam].map(cs => crosecValue(cs)) };
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
  for (const sh of modelVal.shellElems || []) {
    const mat = sh.material || modelVal.defaultMaterial || DEFAULT_MATERIAL;
    for (const tri of sh.tris) {
      const p = tri.map(i => {
        const v = sh.vertices[i];
        return { x: v[0], y: v[1], z: v[2] };
      });
      fem.addShellTri(p[0], p[1], p[2], sh.t, mat, sh.id);
    }
  }
  for (const s of modelVal.supports) {
    const ni = fem.findClosestNode(s.pos, 0.03);
    if (ni >= 0) fem.supports.push({ node: ni, fix: s.fix.map(b => b ? 1 : 0) });
  }
  for (const l of modelVal.loads) {
    if (l.type === 'gravity') fem.gravity = { vec: l.vec };
    else if (l.type === 'point') {
      const ni = fem.findClosestNode(l.pos, 0.03);
      if (ni >= 0) fem.pointLoads.push({ node: ni, force: l.force, moment: l.moment || null });
    } else if (l.type === 'line') {
      fem.lineLoads.push({ a: l.a, b: l.b, w: l.w, all: !!l.all });
    }
  }
  return fem;
}

/** Shallow-clone a FemModel so an optimizer can mutate element cross sections safely. */
function cloneFem(fem) {
  const c = new FemModel();
  c.nodes = fem.nodes;
  c.elements = fem.elements.map(e => ({ ...e }));
  c.shells = fem.shells;
  c.supports = fem.supports;
  c.pointLoads = fem.pointLoads;
  c.lineLoads = fem.lineLoads;
  c.gravity = fem.gravity;
  return c;
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
    const shellElems = ins[0].filter(v => v && v.kind === 'shell');
    const supports = ins[1].filter(v => v && v.kind === 'support');
    const loads = ins[2].filter(v => v && v.kind === 'load');
    const defaultCroSec = ins[3].find(v => v && v.kind === 'crosec' && !v.shell) || null;
    const defaultMaterial = (ins[4].find(v => v && v.kind === 'material') || {}).name || null;
    if (!beams.length && !shellElems.length) throw new Error('No elements to assemble');

    const modelVal = { kind: 'model', beams, shellElems, supports, loads, defaultCroSec, defaultMaterial };
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
    // include shell mass
    for (const sh of fem.shells) {
      const p0 = fem.nodes[sh.n0], p1 = fem.nodes[sh.n1], p2 = fem.nodes[sh.n2];
      const v1 = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
      const v2 = [p2.x - p0.x, p2.y - p0.y, p2.z - p0.z];
      const cx2 = [v1[1] * v2[2] - v1[2] * v2[1], v1[2] * v2[0] - v1[0] * v2[2], v1[0] * v2[1] - v1[1] * v2[0]];
      const area = Math.hypot(...cx2) / 2;
      const mat = MATERIALS[sh.material] || MATERIALS[DEFAULT_MATERIAL];
      const w = mat.gamma * (sh.t / 100) * area / 9.80665 * 1000;
      mass += w;
      cx += w * (p0.x + p1.x + p2.x) / 3; cy += w * (p0.y + p1.y + p2.y) / 3; cz += w * (p0.z + p1.z + p2.z) / 3;
    }
    const cog = mass > 0 ? P(cx / mass, cy / mass, cz / mass) : P(0, 0, 0);
    const info = `${fem.elements.length} beams | ${fem.shells.length} shell tris | ${fem.nodes.length} nodes | ${supports.length} supports | ${loads.length} loads`;
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
  solve: (ins, node) => {
    const mv = ins[0].find(v => v && v.kind === 'model');
    if (!mv) return { Model: [], 'Max Displacement [cm]': [], 'Gravity Force [kN]': [], 'Elastic Energy [kNm]': [], Info: [] };
    const res = analyze(mv.fem);
    if (!res.ok) throw new Error(res.error);
    if (res.warning) node.warning = res.warning;
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
  type: 'OptiCroSec', name: 'Optimize Cross Section', nick: 'OptiCroSec',
  category: 'Karamba3D|Algorithms',
  inputs: [
    { name: 'Model', nick: 'Model', required: true },
    { name: 'CroSecs', nick: 'CroSecs' },
    { name: 'Max Utilization', nick: 'MaxUtil', default: 1.0 },
    { name: 'Iterations', nick: 'Iter', default: 5 },
  ],
  outputs: [
    { name: 'Model', nick: 'Model' },
    { name: 'Info', nick: 'Info' },
    { name: 'Mass [kg]', nick: 'Mass' },
    { name: 'Max Utilization', nick: 'MaxUtil' },
  ],
  solve: (ins) => {
    const mv = ins[0].find(v => v && v.kind === 'model');
    if (!mv) return { Model: [], Info: [], 'Mass [kg]': [], 'Max Utilization': [] };
    let candidates = ins[1].filter(v => v && v.kind === 'crosec' && !v.shell).map(c => c.data);
    if (!candidates.length) candidates = CROSEC_FAMILIES['All'];
    const maxUtil = Math.max(0.05, num(ins[2][0], 1.0));
    const iter = Math.max(1, Math.min(20, Math.round(num(ins[3][0], 5))));

    const fem = cloneFem(mv.fem);
    const res = optimizeCroSec(fem, candidates, maxUtil, iter);
    if (!res.ok) throw new Error(res.error);
    // synthesize an analysis value like AnalyzeThI's, on the optimized model
    const optModelVal = { ...mv, fem };
    const out = { kind: 'analysis', ...res, sourceModel: optModelVal };
    const secCount = {};
    for (const el of fem.elements) {
      const nm = (el.crosec && el.crosec.name) || 'default';
      secCount[nm] = (secCount[nm] || 0) + 1;
    }
    const secSummary = Object.entries(secCount).map(([k, v]) => `${k}×${v}`).join(', ');
    return {
      Model: [out],
      Info: [`optimized (${res.changed} swaps) → ${secSummary} | max util ${(res.maxUtil * 100).toFixed(1)}%`],
      'Mass [kg]': [res.mass],
      'Max Utilization': [res.maxUtil],
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

/* ================= component descriptions (tooltips) ================= */

const DESCS = {
  NumberSlider: 'Numeric slider for single values. Drag the grip; double-click for exact entry; right-click ▸ Edit for name/domain.',
  BooleanToggle: 'Boolean (true/false) toggle — click to flip.',
  ConstructPoint: 'Construct a point from {x, y, z} coordinates [m].',
  VectorXYZ: 'Create a vector from {x, y, z} components.',
  ImportGeometry: 'Outputs the geometry of the model imported via File ▸ Import Model… (.3dm / .obj / .dxf / .json): lines, points and meshes in meters.',
  Series: 'Create a series of numbers from start, step size and count.',
  Multiplication: 'Mathematical multiplication A × B.',
  Line: 'Create a line between two points.',
  LineToBeam: 'Karamba3D: converts lines to beam elements. Coincident endpoints (within 5 mm) become shared, rigidly connected nodes. Defaults: steel S235, CHS 114.3×4.',
  MeshToShell: 'Karamba3D: converts a triangle/quad mesh to shell elements (CST membrane + DKT bending). Default thickness 1 cm.',
  Support: 'Karamba3D: defines how the structure connects to the ground. Click the six checkboxes to fix translations Tx/Ty/Tz and rotations Rx/Ry/Rz at the given positions.',
  Assemble: 'Karamba3D: assembles elements, supports and loads into one Model — merges coincident nodes, attaches loads/supports, computes mass and centre of gravity.',
  Disassemble: 'Karamba3D: decomposes a model into its nodes, element lines, supports and loads.',
  PointLoad: 'Karamba3D: concentrated force [kN] and/or moment [kNm] at a point or node.',
  LineLoad: 'Karamba3D: uniformly distributed load [kN/m] on the beams lying on the given lines (applied via exact fixed-end forces).',
  Gravity: 'Karamba3D: self-weight of all elements. |vector| = 1 equals 1 g; direction sets the pull (usually (0,0,−1)).',
  CroSecRect: 'Karamba3D: solid rectangular cross section (height/width in cm).',
  CroSecCircle: 'Karamba3D: circular hollow (CHS) cross section — diameter and wall thickness in cm.',
  CroSecI: 'Karamba3D: I-profile cross section (height, width, flange and web thickness in cm).',
  CroSecSelect: 'Karamba3D: pick a catalogue cross section (IPE / HEA / CHS tables). Click ◂ ▸ to browse.',
  CroSecRange: 'Karamba3D: outputs a whole cross-section family (IPE / HEA / CHS / All) as candidates for Optimize Cross Section.',
  ShellConst: 'Karamba3D: constant-thickness shell cross section [cm] with optional material.',
  MatSelect: 'Karamba3D: select a material from the built-in table (steel, concrete, timber, aluminum). Default: Steel S235 — E 21000, fy 23.5 kN/cm².',
  MatProps: 'Karamba3D: outputs the mechanical properties (E, G, γ, fy) of a material.',
  AnalyzeThI: 'Karamba3D: linear-elastic first-order-theory analysis. Outputs the result model, max nodal displacement [cm], resultant gravity force [kN] and elastic energy [kNm].',
  OptiCroSec: 'Karamba3D: iteratively selects the lightest candidate cross section per element such that utilization ≤ target, re-analyzing between passes.',
  ModelView: 'Karamba3D: displays the (analyzed) model in the viewport with a deformation display-scale factor.',
  BeamView: 'Karamba3D: renders beams/shells coloured by result — Utilization, Displacement, Axial Force or Bending Moment. Click ◂ ▸ to switch. Blue = min/compression, red = max/tension.',
  NodalDisp: 'Karamba3D: nodal translations [cm] and rotations [rad] of the analyzed model.',
  ReactionForces: 'Karamba3D: support reaction forces [kN] and moments [kNm].',
  Utilization: 'Karamba3D: per-element utilization σ/fy (signed: − compression / + tension). |1.0| = 100%.',
  BeamForces: 'Karamba3D: resultant beam section forces — N [kN], V [kN], M [kNm].',
  TrussGenerator: 'Utility: parametric planar truss (Pratt-like) with support and load points.',
  PortalFrame: 'Utility: parametric multi-storey 3D portal frame.',
  ShellCanopy: 'Utility: parametric paraboloid canopy mesh with corner support points.',
  BottomPoints: 'Utility: selects the lowest points of a set (z ≤ zmin + tolerance) — handy for auto-placing supports under an imported model.',
};
for (const [t, d] of Object.entries(DESCS)) {
  const dd = registry.get(t);
  if (dd && !dd.desc) dd.desc = d;
}

/* ================= toolbar structure ================= */

export const COMPONENT_TABS = [
  {
    tab: 'Params',
    groups: [
      { name: 'Input', items: ['NumberSlider', 'Panel', 'BooleanToggle', 'ColourSwatch'] },
      { name: 'Geometry', items: ['ConstructPoint', 'VectorXYZ', 'UnitZ', 'ImportGeometry'] },
      { name: 'Display', items: ['CustomPreview'] },
    ],
  },
  {
    tab: 'Maths',
    groups: [
      { name: 'Operators', items: ['Addition', 'Subtraction', 'Multiplication', 'Division', 'Negative'] },
      { name: 'Sets', items: ['Series', 'ListItem', 'Deconstruct'] },
    ],
  },
  {
    tab: 'Curve',
    groups: [{ name: 'Primitive', items: ['Line', 'Move', 'Explode'] }],
  },
  {
    tab: 'Karamba3D',
    groups: [
      { name: '1.Model', items: ['LineToBeam', 'MeshToShell', 'Support', 'Assemble', 'Disassemble'] },
      { name: '2.Load', items: ['PointLoad', 'LineLoad', 'Gravity'] },
      { name: '3.Cross Section', items: ['CroSecRect', 'CroSecCircle', 'CroSecI', 'CroSecSelect', 'CroSecRange', 'ShellConst'] },
      { name: '4.Material', items: ['MatSelect', 'MatProps'] },
      { name: '5.Algorithms', items: ['AnalyzeThI', 'OptiCroSec'] },
      { name: '6.Results', items: ['ModelView', 'BeamView', 'NodalDisp', 'ReactionForces', 'Utilization', 'BeamForces'] },
      { name: 'Utils', items: ['TrussGenerator', 'PortalFrame', 'ShellCanopy', 'BottomPoints'] },
    ],
  },
];
