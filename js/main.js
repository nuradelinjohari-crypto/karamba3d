/**
 * main.js — application shell: Grasshopper chrome (menus, ribbon, search),
 * the node canvas, the Rhino viewport, file import and examples.
 */

import { GraphEngine, formatValue } from './graph/engine.js';
import { registry, COMPONENT_TABS } from './graph/components.js';
import { Viewport } from './viewport/viewport.js';

const canvas = document.getElementById('gh-canvas');
const engine = new GraphEngine(canvas, registry);
const viewport = new Viewport(
  document.getElementById('viewport-container'),
  document.getElementById('legend'));

window.__importedGeometry = null;

/* ================= solve → viewport ================= */

engine.onSolved = () => {
  const views = [];
  const previews = [];
  for (const n of engine.nodes) {
    if (n.previewOff || !n.values) continue;
    for (const out of Object.values(n.values)) {
      const list = Array.isArray(out) ? out : [out];
      for (const v of list) {
        if (!v || typeof v !== 'object') continue;
        if (v.kind === 'view') views.push(v);
        else if (v.kind === 'point' || v.kind === 'line') previews.push(v);
      }
    }
  }
  viewport.update(views, previews);
  updateStatus(views);
};

function updateStatus(views) {
  const el = document.getElementById('status-text');
  const v = views.find(x => x.analysis);
  if (v && v.analysis.ok) {
    const a = v.analysis;
    el.textContent =
      `Analyzed: ${a.model.elements.length} elements · ${a.model.nodes.length} nodes · ` +
      `max disp ${(a.maxDisp * 100).toFixed(2)} cm · max utilization ${(a.maxUtil * 100).toFixed(1)}% · ` +
      `mass ${a.mass.toFixed(0)} kg`;
    el.style.color = a.maxUtil > 1 ? '#ff8080' : '#c8e6b0';
  } else {
    const anyModel = engine.nodes.some(n => n.type === 'Assemble');
    el.textContent = anyModel ? 'Model assembled — wire it into Analyze (Th.I) and a BeamView.' :
      'Place components (double-click canvas) and wire a model: LtoB → Assemble → Analyze → BeamView';
    el.style.color = '#9aa4ae';
  }
}

/* ================= ribbon ================= */

const tabsBar = document.getElementById('ribbon-tabs');
const groupsBar = document.getElementById('ribbon-groups');
let activeTab = 'Karamba3D';

function buildRibbon() {
  tabsBar.innerHTML = '';
  for (const t of COMPONENT_TABS) {
    const el = document.createElement('div');
    el.className = 'ribbon-tab' + (t.tab === activeTab ? ' active' : '');
    el.textContent = t.tab;
    el.onclick = () => { activeTab = t.tab; buildRibbon(); };
    tabsBar.appendChild(el);
  }
  groupsBar.innerHTML = '';
  const tab = COMPONENT_TABS.find(t => t.tab === activeTab);
  for (const g of tab.groups) {
    const grp = document.createElement('div');
    grp.className = 'ribbon-group';
    const items = document.createElement('div');
    items.className = 'ribbon-items';
    for (const type of g.items) {
      const d = registry.get(type);
      if (!d) continue;
      const btn = document.createElement('div');
      btn.className = 'ribbon-item';
      btn.title = d.name;
      btn.innerHTML = `<span class="ri-icon">${iconFor(d)}</span><span>${d.nick}</span>`;
      btn.onclick = () => placeAtCenter(type);
      items.appendChild(btn);
    }
    const label = document.createElement('div');
    label.className = 'ribbon-group-label';
    label.textContent = g.name + ' ▾';
    grp.appendChild(items);
    grp.appendChild(label);
    groupsBar.appendChild(grp);
  }
}

function iconFor(d) {
  const map = {
    NumberSlider: '⟷', Panel: '▤', BooleanToggle: '◑', ConstructPoint: '·',
    VectorXYZ: '↗', ImportGeometry: '⭱', Series: '⋯', Multiplication: '×', Line: '╱',
    LineToBeam: '⌶', Support: '▲', Assemble: '⚙', Disassemble: '⛏',
    PointLoad: '⇓', Gravity: 'g', CroSecRect: '▭', CroSecCircle: '◯', CroSecI: 'Ｉ',
    CroSecSelect: '☰', MatSelect: '☰', MatProps: '≡', AnalyzeThI: '∑',
    ModelView: '👁', BeamView: '🌈', NodalDisp: '↕', ReactionForces: '⤒',
    Utilization: '%', BeamForces: 'N', TrussGenerator: '◮', PortalFrame: '⌂',
  };
  return map[d.type] || '□';
}

function placeAtCenter(type) {
  const r = canvas.getBoundingClientRect();
  const p = engine.toWorld(r.width / 2 + (Math.random() * 60 - 30), r.height / 2 + (Math.random() * 60 - 30));
  const n = engine.addNode(type, p.x, p.y);
  engine.selection.clear();
  if (n) engine.selection.add(n);
  engine.draw();
}

/* ================= search popup (double-click canvas) ================= */

const search = document.getElementById('search-popup');
const searchInput = document.getElementById('search-input');
const searchList = document.getElementById('search-list');
let searchWorld = { x: 0, y: 0 };

engine.onOpenSearch = (cx, cy, wx, wy) => {
  searchWorld = { x: wx, y: wy };
  search.style.display = 'block';
  const host = document.getElementById('gh-pane').getBoundingClientRect();
  search.style.left = Math.min(cx - host.left, host.width - 240) + 'px';
  search.style.top = Math.min(cy - host.top, host.height - 260) + 'px';
  searchInput.value = '';
  fillSearch('');
  searchInput.focus();
};

function fillSearch(q) {
  searchList.innerHTML = '';
  const ql = q.toLowerCase();
  const matches = [...registry.values()]
    .filter(d => !q || d.name.toLowerCase().includes(ql) || d.nick.toLowerCase().includes(ql) || d.type.toLowerCase().includes(ql))
    .slice(0, 12);
  matches.forEach((d, i) => {
    const el = document.createElement('div');
    el.className = 'search-item' + (i === 0 ? ' first' : '');
    el.innerHTML = `<span class="ri-icon">${iconFor(d)}</span> ${d.name} <span class="search-cat">${d.category.replace('|', ' › ')}</span>`;
    el.onclick = () => { placeFromSearch(d.type); };
    searchList.appendChild(el);
  });
}

function placeFromSearch(type) {
  engine.addNode(type, searchWorld.x, searchWorld.y);
  closeSearch();
}

function closeSearch() { search.style.display = 'none'; }

searchInput.addEventListener('input', () => fillSearch(searchInput.value));
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const first = searchList.querySelector('.search-item');
    if (first) first.click();
  }
  if (e.key === 'Escape') closeSearch();
  e.stopPropagation();
});
document.addEventListener('mousedown', e => {
  if (search.style.display === 'block' && !search.contains(e.target)) closeSearch();
});

/* ================= menus ================= */

const MENUS = {
  File: [
    ['New Definition', () => { engine.nodes = []; engine.wires = []; engine.scheduleSolve(); }],
    ['Import Model… (OBJ / DXF / JSON)', () => fileInput.click()],
    ['—'],
    ['Save Definition (.ghjson)', saveDefinition],
    ['Open Definition…', () => defInput.click()],
  ],
  Edit: [
    ['Select All  (Ctrl+A)', () => { engine.nodes.forEach(n => engine.selection.add(n)); engine.draw(); }],
    ['Delete Selection  (Del)', () => engine.removeNodes([...engine.selection])],
  ],
  View: [
    ['Zoom Extents (canvas)', () => engine.zoomExtents()],
    ['Zoom Extents (viewport)', () => viewport.zoomExtents()],
  ],
  Display: [
    ['Recompute + Redraw', () => { engine.nodes.forEach(n => n.dirty = true); engine.scheduleSolve(); }],
  ],
  Solution: [
    ['Recompute', () => { engine.nodes.forEach(n => n.dirty = true); engine.scheduleSolve(); }],
  ],
  Examples: [
    ['Parametric Truss Bridge', () => loadExample('truss')],
    ['3D Portal Frame Tower', () => loadExample('frame')],
    ['Simple Cantilever', () => loadExample('cantilever')],
  ],
  Help: [
    ['About this replica', () => alert(
      'karamba3d-web — an educational, open-source replica of the Karamba3D ' +
      'parametric structural analysis workflow (karamba3d.com), rebuilt for the browser.\n\n' +
      'GH canvas (left): double-click to search & place components, drag ports to wire.\n' +
      'Rhino viewport (right): drag = orbit, Shift+drag = pan, wheel = zoom.\n\n' +
      'Solver: linear-elastic 3D frame FEM (Analyze Th.I), 6 DOF per node.\n' +
      'Not affiliated with Karamba GmbH — for learning only.')],
  ],
};

const menubar = document.getElementById('menubar');
let openMenu = null;
for (const [name, items] of Object.entries(MENUS)) {
  const m = document.createElement('div');
  m.className = 'menu';
  m.textContent = name;
  m.onclick = (e) => {
    e.stopPropagation();
    if (openMenu) { openMenu.remove(); openMenu = null; return; }
    const dd = document.createElement('div');
    dd.className = 'menu-dropdown';
    for (const it of items) {
      if (it[0] === '—') { dd.appendChild(Object.assign(document.createElement('hr'))); continue; }
      const item = document.createElement('div');
      item.className = 'menu-item';
      item.textContent = it[0];
      item.onclick = () => { it[1](); dd.remove(); openMenu = null; };
      dd.appendChild(item);
    }
    m.appendChild(dd);
    openMenu = dd;
  };
  menubar.appendChild(m);
}
document.addEventListener('click', () => { if (openMenu) { openMenu.remove(); openMenu = null; } });

/* ================= file import ================= */

const fileInput = document.getElementById('file-input');
const defInput = document.getElementById('def-input');

fileInput.addEventListener('change', async () => {
  const f = fileInput.files[0];
  if (!f) return;
  const text = await f.text();
  let lines = [];
  try {
    if (/\.obj$/i.test(f.name)) lines = parseOBJ(text);
    else if (/\.dxf$/i.test(f.name)) lines = parseDXF(text);
    else lines = parseJSONModel(text);
  } catch (err) {
    alert('Could not read file: ' + err.message);
    return;
  }
  if (!lines.length) { alert('No line/edge geometry found in file.'); return; }
  window.__importedGeometry = { name: f.name, lines };
  let node = engine.nodes.find(n => n.type === 'ImportGeometry');
  if (!node) {
    const r = canvas.getBoundingClientRect();
    const p = engine.toWorld(80, r.height / 2);
    node = engine.addNode('ImportGeometry', p.x, p.y);
  }
  engine.nodes.forEach(n => { if (n.type === 'ImportGeometry') n.dirty = true; });
  engine._markDirty(node);
  engine.scheduleSolve();
  fileInput.value = '';
});

function parseOBJ(text) {
  const verts = [];
  const lines = [];
  const seen = new Set();
  const addEdge = (a, b) => {
    if (!verts[a] || !verts[b]) return;
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seen.has(k)) return;
    seen.add(k);
    lines.push([verts[a], verts[b]]);
  };
  for (const raw of text.split('\n')) {
    const p = raw.trim().split(/\s+/);
    if (p[0] === 'v') verts.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === 'l') {
      const idx = p.slice(1).map(s => parseInt(s) - 1);
      for (let i = 0; i < idx.length - 1; i++) addEdge(idx[i], idx[i + 1]);
    } else if (p[0] === 'f') {
      const idx = p.slice(1).map(s => parseInt(s.split('/')[0]) - 1);
      for (let i = 0; i < idx.length; i++) addEdge(idx[i], idx[(i + 1) % idx.length]);
    }
  }
  return lines;
}

function parseDXF(text) {
  // minimal DXF: LINE entities (codes 10/20/30 = start, 11/21/31 = end)
  const rows = text.split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].trim() === 'LINE') {
      const pt = { 10: 0, 20: 0, 30: 0, 11: 0, 21: 0, 31: 0 };
      for (let j = i; j < Math.min(i + 60, rows.length - 1); j += 2) {
        const code = rows[j].trim(), val = parseFloat(rows[j + 1]);
        if (code === '0' && j > i) break;
        if (code in pt) pt[code] = val || 0;
      }
      lines.push([[pt[10], pt[20], pt[30]], [pt[11], pt[21], pt[31]]]);
    }
  }
  return lines;
}

function parseJSONModel(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data.lines)) return data.lines;
  if (Array.isArray(data)) return data;
  throw new Error('Expected {"lines": [[[x,y,z],[x,y,z]], …]}');
}

/* ================= definition save/load ================= */

function saveDefinition() {
  const blob = new Blob([JSON.stringify(engine.toJSON(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'definition.ghjson';
  a.click();
}

defInput.addEventListener('change', async () => {
  const f = defInput.files[0];
  if (!f) return;
  try {
    engine.loadJSON(JSON.parse(await f.text()));
    setTimeout(() => engine.zoomExtents(), 100);
  } catch (err) { alert('Could not load definition: ' + err.message); }
  defInput.value = '';
});

/* ================= splitter ================= */

const splitter = document.getElementById('splitter');
const ghPane = document.getElementById('gh-pane');
splitter.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const move = (ev) => {
    const w = document.body.clientWidth;
    const pct = Math.max(25, Math.min(75, ev.clientX / w * 100));
    ghPane.style.width = pct + '%';
    engine._resize();
  };
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

/* ================= examples ================= */

function loadExample(which) {
  const N = (type, x, y, state) => {
    const n = engine.addNode(type, x, y, state);
    return n;
  };
  const W = (a, ap, b, bp) => engine.connect(a, ap, b, bp);
  engine.nodes = []; engine.wires = []; engine.selection.clear();

  if (which === 'truss') {
    const s1 = N('NumberSlider', 30, 40, { name: 'Span', min: 4, max: 30, step: 0.5, value: 14 });
    const s2 = N('NumberSlider', 30, 80, { name: 'Height', min: 0.5, max: 5, step: 0.1, value: 1.8 });
    const s3 = N('NumberSlider', 30, 120, { name: 'Divisions', min: 2, max: 16, step: 1, value: 7 });
    const truss = N('TrussGenerator', 260, 60);
    W(s1, 0, truss, 0); W(s2, 0, truss, 1); W(s3, 0, truss, 2);

    const croSel = N('CroSecSelect', 260, 210, { index: 12 });
    const ltob = N('LineToBeam', 430, 60);
    W(truss, 3, ltob, 0); W(croSel, 0, ltob, 2);

    // planar truss: also fix Rx so the model can't spin about the support axis
    const supp = N('Support', 430, 190, { fix: [true, true, true, true, false, false] });
    W(truss, 4, supp, 0);

    const fvec = N('VectorXYZ', 260, 300);
    const fz = N('NumberSlider', 30, 320, { name: 'Load kN', min: -60, max: 0, step: 1, value: -12 });
    W(fz, 0, fvec, 2);
    const pload = N('PointLoad', 430, 300);
    W(truss, 5, pload, 0); W(fvec, 0, pload, 1);
    const grav = N('Gravity', 430, 385);

    const ass = N('Assemble', 620, 130);
    W(ltob, 0, ass, 0); W(supp, 0, ass, 1); W(pload, 0, ass, 2); W(grav, 0, ass, 2);

    const ana = N('AnalyzeThI', 790, 130);
    W(ass, 0, ana, 0);

    const defS = N('NumberSlider', 620, 320, { name: 'Def Scale', min: 0, max: 200, step: 1, value: 25 });
    const bview = N('BeamView', 950, 130);
    W(ana, 0, bview, 0); W(defS, 0, bview, 1);

    const p1 = N('Panel', 950, 260, { w: 150, h: 60 });
    W(ana, 1, p1, 0);
    const p2 = N('Panel', 950, 340, { w: 150, h: 60 });
    W(ass, 2, p2, 0);
  }

  if (which === 'frame') {
    const sx = N('NumberSlider', 30, 40, { name: 'Width X', min: 3, max: 16, step: 0.5, value: 8 });
    const sy = N('NumberSlider', 30, 80, { name: 'Width Y', min: 3, max: 16, step: 0.5, value: 6 });
    const sh = N('NumberSlider', 30, 120, { name: 'Storey H', min: 2.5, max: 6, step: 0.25, value: 3.5 });
    const sn = N('NumberSlider', 30, 160, { name: 'Storeys', min: 1, max: 8, step: 1, value: 3 });
    const frame = N('PortalFrame', 250, 80);
    W(sx, 0, frame, 0); W(sy, 0, frame, 1); W(sh, 0, frame, 2); W(sn, 0, frame, 3);

    const cro = N('CroSecI', 250, 250);
    const ltob = N('LineToBeam', 440, 80);
    W(frame, 2, ltob, 0); W(cro, 0, ltob, 2);

    const supp = N('Support', 440, 210, { fix: [true, true, true, true, true, true] });
    W(frame, 3, supp, 0);

    const wvec = N('VectorXYZ', 250, 390);
    const wx = N('NumberSlider', 30, 400, { name: 'Wind X kN', min: 0, max: 80, step: 1, value: 25 });
    W(wx, 0, wvec, 0);
    const pload = N('PointLoad', 440, 330);
    W(frame, 4, pload, 0); W(wvec, 0, pload, 1);
    const grav = N('Gravity', 440, 430);

    const ass = N('Assemble', 630, 150);
    W(ltob, 0, ass, 0); W(supp, 0, ass, 1); W(pload, 0, ass, 2); W(grav, 0, ass, 2);
    const ana = N('AnalyzeThI', 800, 150);
    W(ass, 0, ana, 0);
    const defS = N('NumberSlider', 630, 330, { name: 'Def Scale', min: 0, max: 500, step: 5, value: 60 });
    const bview = N('BeamView', 960, 150);
    W(ana, 0, bview, 0); W(defS, 0, bview, 1);
    const p1 = N('Panel', 960, 290, { w: 150, h: 60 });
    W(ana, 1, p1, 0);
  }

  if (which === 'cantilever') {
    const len = N('NumberSlider', 30, 60, { name: 'Length', min: 1, max: 10, step: 0.5, value: 5 });
    const pA = N('ConstructPoint', 240, 40);
    const pB = N('ConstructPoint', 240, 130);
    W(len, 0, pB, 0);
    const line = N('Line', 420, 70);
    W(pA, 0, line, 0); W(pB, 0, line, 1);
    const cro = N('CroSecI', 240, 230);
    const ltob = N('LineToBeam', 570, 70);
    W(line, 0, ltob, 0); W(cro, 0, ltob, 2);
    const supp = N('Support', 420, 180, { fix: [true, true, true, true, true, true] });
    W(pA, 0, supp, 0);
    const fvec = N('VectorXYZ', 420, 330);
    const fz = N('NumberSlider', 240, 350, { name: 'Tip kN', min: -100, max: 0, step: 1, value: -10 });
    W(fz, 0, fvec, 2);
    const pl = N('PointLoad', 570, 300);
    W(pB, 0, pl, 0); W(fvec, 0, pl, 1);
    const ass = N('Assemble', 740, 140);
    W(ltob, 0, ass, 0); W(supp, 0, ass, 1); W(pl, 0, ass, 2);
    const ana = N('AnalyzeThI', 890, 140);
    W(ass, 0, ana, 0);
    const defS = N('NumberSlider', 740, 300, { name: 'Def Scale', min: 0, max: 100, step: 1, value: 10 });
    const bview = N('BeamView', 1040, 140);
    W(ana, 0, bview, 0); W(defS, 0, bview, 1);
    const p1 = N('Panel', 1040, 270, { w: 150, h: 60 });
    W(ana, 1, p1, 0);
  }

  setTimeout(() => { engine.zoomExtents(); viewport.zoomExtents(); }, 150);
}

/* ================= boot ================= */

buildRibbon();
loadExample('truss');
document.getElementById('btn-zoom-ext').onclick = () => viewport.zoomExtents();
