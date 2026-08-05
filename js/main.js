/**
 * main.js — application shell: Grasshopper chrome (menus, ribbon, search),
 * the node canvas, the Rhino viewport, file import and examples.
 */

import { GraphEngine, formatValue } from './graph/engine.js';
import { registry, COMPONENT_TABS } from './graph/components.js';
import { Viewport } from './viewport/viewport.js';
import { parseGHX, buildGraph } from './io/ghimport.js';

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
        else if (v.kind === 'point' || v.kind === 'line' || v.kind === 'cpreview') previews.push(v);
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
    const nb = a.model.elements.length, ns = (a.model.shells || []).length;
    el.textContent =
      `Analyzed: ${nb ? nb + ' beams' : ''}${nb && ns ? ' · ' : ''}${ns ? ns + ' shell tris' : ''} · ${a.model.nodes.length} nodes · ` +
      `max disp ${(a.maxDisp * 100).toFixed(2)} cm · max utilization ${(a.maxUtil * 100).toFixed(1)}% · ` +
      `mass ${a.mass.toFixed(0)} kg`;
    el.style.color = a.maxUtil > 1 ? '#ff8080' : '#c8e6b0';
  } else if (engine.nodes.some(n => n.error)) {
    const bad = engine.nodes.find(n => n.error);
    el.textContent = `${bad.def.name}: ${bad.error}`;
    el.style.color = '#ff8080';
  } else if (statusNote) {
    el.textContent = statusNote;
    el.style.color = '#c8e6b0';
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

/* ================= Rhino document geometry: layers + picking ================= */

let graphDirty = false;   // true once the user has edited or loaded their own definition
engine.onGraphEdit = () => { graphDirty = true; };

const layersPanel = document.getElementById('layers-panel');
const layersList = document.getElementById('layers-list');
const layersDoc = document.getElementById('layers-doc');
const pickPrompt = document.getElementById('pick-prompt');
const pickText = document.getElementById('pick-text');
const pickCount = document.getElementById('pick-count');

const KIND_LABEL = { line: 'curves', point: 'points', mesh: 'meshes' };

function buildLayersPanel() {
  const g = window.__importedGeometry;
  if (!g || !viewport.docObjects.length) { layersPanel.style.display = 'none'; return; }
  layersPanel.style.display = 'block';
  layersDoc.textContent = g.name.length > 22 ? g.name.slice(0, 20) + '…' : g.name;
  layersDoc.title = g.name;
  layersList.innerHTML = '';
  for (const L of viewport.docLayers) {
    const kinds = {};
    for (const o of viewport.docObjects)
      if (o.layerIndex === L.index) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
    const kindTxt = Object.entries(kinds).map(([k, v]) => `${v} ${KIND_LABEL[k] || k}`).join(', ');
    const row = document.createElement('div');
    row.className = 'layer-row';
    row.title = `${L.path} — ${kindTxt}\nClick to select this layer's objects`;
    row.innerHTML =
      `<span class="layer-eye${L.visible === false ? ' off' : ''}">${L.visible === false ? '◌' : '👁'}</span>` +
      `<span class="layer-swatch" style="background:#${(L.color >>> 0).toString(16).padStart(6, '0')}"></span>` +
      `<span class="layer-name">${escapeHtml(L.name)}</span>` +
      `<span class="layer-count">${L.count}</span>`;
    row.querySelector('.layer-eye').onclick = (e) => {
      e.stopPropagation();
      viewport.setLayerVisible(L.index, L.visible === false);
      buildLayersPanel();
    };
    row.onclick = () => {
      viewport.selectLayer(L.index);
      if (viewport.pickState) updatePickCount();
      buildLayersPanel();
    };
    const selected = viewport.docObjects.some(o => o.layerIndex === L.index && viewport.selection.has(o.id));
    if (selected) row.classList.add('sel');
    layersList.appendChild(row);
  }
}

viewport.onSelectionChange = () => { buildLayersPanel(); updatePickCount(); };

function updatePickCount() {
  if (!viewport.pickState) return;
  const objs = viewport._selectedObjects();
  const kinds = {};
  for (const o of objs) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
  pickCount.textContent = objs.length
    ? Object.entries(kinds).map(([k, v]) => `${v} ${KIND_LABEL[k] || k}`).join(', ') + ' selected'
    : 'nothing selected yet';
}

/** Rhino-style pick session driven from a Grasshopper component. */
async function runSetGeometry(node, portIdx, mode) {
  const port = node.inputs[portIdx];
  const filter = port.geo && port.geo !== 'any' ? port.geo : 'any';
  if (!viewport.docObjects.length) {
    alert('No Rhino geometry loaded yet.\n\nUse File ▸ Import Model… to open a .3dm first, then set geometry on this component.');
    return;
  }
  closeCtxMenu();
  const what = filter === 'any' ? 'geometry' : KIND_LABEL[filter] || filter;
  pickPrompt.style.display = 'flex';
  layersPanel.classList.add('picking');
  pickText.textContent = mode === 'one'
    ? `Select one ${filter === 'any' ? 'object' : filter} for ${node.def.nick} ▸ ${port.name}`
    : `Select ${what} for ${node.def.nick} ▸ ${port.name} — click geometry (picks its whole layer), Alt+click for one object, or click a layer in the panel`;
  updatePickCount();

  const pickPromise = viewport.beginPick({
    mode, filter,
    onStatus: (msg) => { if (msg) pickText.textContent = msg; },
  });
  viewport.zoomExtents();          // frame the geometry being picked
  const picked = await pickPromise;
  pickPrompt.style.display = 'none';
  layersPanel.classList.remove('picking');
  if (!picked || !picked.length) return;

  // convert Rhino objects → Grasshopper values
  const vals = [];
  for (const o of picked) {
    if (o.kind === 'line') {
      for (const s of o.segments)
        vals.push({
          kind: 'line',
          a: { kind: 'point', x: s[0][0], y: s[0][1], z: s[0][2] },
          b: { kind: 'point', x: s[1][0], y: s[1][1], z: s[1][2] },
        });
    } else if (o.kind === 'point') {
      vals.push({ kind: 'point', x: o.point[0], y: o.point[1], z: o.point[2] });
    } else if (o.kind === 'mesh') {
      vals.push({ kind: 'mesh', vertices: o.mesh.vertices, faces: o.mesh.faces });
    }
  }
  // internalise: like Grasshopper, setting data removes incoming wires
  engine.disconnectInput(node, portIdx);
  node.state.__persist = node.state.__persist || {};
  node.state.__persist[portIdx] = vals;
  const kinds = {};
  for (const o of picked) kinds[o.kind] = (kinds[o.kind] || 0) + 1;
  const layerNames = [...new Set(picked.map(o => (viewport.docLayers.find(l => l.index === o.layerIndex) || {}).name).filter(Boolean))];
  node.state.__setLabel = node.state.__setLabel || {};
  node.state.__setLabel[portIdx] =
    `${Object.entries(kinds).map(([k, v]) => `${v} ${KIND_LABEL[k] || k}`).join(', ')}` +
    (layerNames.length ? ` from layer ${layerNames.join(' + ')}` : '');
  graphDirty = true;
  statusNote = null;
  engine._markDirty(node);
  engine.scheduleSolve();
  engine.draw();
}

document.getElementById('pick-accept').onclick = () => viewport.acceptPick();
document.getElementById('pick-cancel').onclick = () => viewport.cancelPick();
window.addEventListener('keydown', (e) => {
  if (!viewport.pickState) return;
  if (e.key === 'Enter') { e.preventDefault(); viewport.acceptPick(); }
  if (e.key === 'Escape') { e.preventDefault(); viewport.cancelPick(); }
});

/* ================= hover tooltips (GH-style) ================= */

const tooltip = document.createElement('div');
tooltip.id = 'gh-tooltip';
document.getElementById('gh-pane').appendChild(tooltip);

engine.onHover = (hit, cx, cy) => {
  if (!hit) { tooltip.style.display = 'none'; return; }
  const host = document.getElementById('gh-pane').getBoundingClientRect();
  const n = hit.node, d = n.def;
  let html = '';
  if (hit.kind === 'inport' || hit.kind === 'outport') {
    const isOut = hit.kind === 'outport';
    const p = (isOut ? n.outputs : n.inputs)[hit.port];
    html += `<div class="tt-title">${p.name}${p.nick && p.nick !== p.name ? ` <span class="tt-nick">(${p.nick})</span>` : ''}</div>`;
    html += `<div class="tt-sub">${isOut ? 'Output' : 'Input'} of ${d.name}</div>`;
    let vals;
    if (isOut) {
      const out = n.values ? n.values[p.name] : null;
      vals = out == null ? [] : (Array.isArray(out) ? out : [out]);
    } else {
      vals = engine.inputValues(n, hit.port);
      const setLbl = (n.state.__setLabel || {})[hit.port];
      if (setLbl) html += `<div class="tt-set">⛁ set geometry: ${escapeHtml(setLbl)}</div>`;
      if (!vals.length && p.default !== undefined) {
        html += `<div class="tt-data">default: ${formatValue(p.default)}</div>`;
      }
    }
    if (vals.length) {
      html += `<div class="tt-data">${vals.length} item${vals.length > 1 ? 's' : ''}</div>`;
      vals.slice(0, 4).forEach((v, i) => { html += `<div class="tt-item">${i}. ${escapeHtml(formatValue(v))}</div>`; });
      if (vals.length > 4) html += `<div class="tt-item">…</div>`;
    } else if (!isOut && p.required) {
      html += `<div class="tt-warn">No data collected — this input is required.</div>`;
    }
  } else {
    html += `<div class="tt-title">${d.name} <span class="tt-nick">(${d.nick})</span></div>`;
    if (n.state && n.state.origName && d.type !== undefined && n.type === 'Unsupported')
      html += `<div class="tt-sub">Original: ${escapeHtml(n.state.origName)}</div>`;
    if (d.desc) html += `<div class="tt-desc">${d.desc}</div>`;
    if (!n.enabled) html += `<div class="tt-warn">Disabled — right-click ▸ Enabled to reactivate.</div>`;
    if (n.error) html += `<div class="tt-error">✗ Error: ${escapeHtml(n.error)}</div>`;
    if (n.warning) html += `<div class="tt-warn">⚠ Warning: ${escapeHtml(n.warning)}</div>`;
    if (n.previewOff) html += `<div class="tt-sub">Preview off</div>`;
  }
  tooltip.innerHTML = html;
  tooltip.style.display = 'block';
  const x = Math.min(cx - host.left + 14, host.width - 290);
  const y = Math.min(cy - host.top + 16, host.height - tooltip.offsetHeight - 12);
  tooltip.style.left = Math.max(4, x) + 'px';
  tooltip.style.top = Math.max(4, y) + 'px';
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ================= right-click context menu (GH-style) ================= */

let ctxMenu = null;
function closeCtxMenu() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }
document.addEventListener('mousedown', (e) => { if (ctxMenu && !ctxMenu.contains(e.target)) closeCtxMenu(); });

engine.onNodeContext = (node, cx, cy) => {
  closeCtxMenu();
  tooltip.style.display = 'none';
  const menu = document.createElement('div');
  menu.id = 'ctx-menu';
  const add = (label, fn, opts = {}) => {
    const it = document.createElement('div');
    it.className = 'ctx-item' + (opts.header ? ' ctx-header' : '') + (opts.danger ? ' ctx-danger' : '');
    it.innerHTML = (opts.check !== undefined ? `<span class="ctx-check">${opts.check ? '✓' : ' '}</span>` : '') + label;
    if (fn) it.onclick = () => { fn(); closeCtxMenu(); };
    menu.appendChild(it);
    return it;
  };
  const sep = () => menu.appendChild(Object.assign(document.createElement('hr')));

  add(`${node.def.name}`, null, { header: true });
  if (node.error) add(`<span class="ctx-err">✗ ${escapeHtml(node.error)}</span>`, null, {});
  if (node.warning) add(`<span class="ctx-warntxt">⚠ ${escapeHtml(node.warning)}</span>`, null, {});
  sep();
  // ---- Set Geometry (Rhino picking), per geometry-capable input ----
  const geoPorts = node.inputs
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !!p.geo);
  if (geoPorts.length) {
    for (const { p, i } of geoPorts) {
      const suffix = geoPorts.length > 1 ? ` (${p.name})` : '';
      add(`Set one ${p.geo === 'any' ? 'Geometry' : p.geo}${suffix}`, () => runSetGeometry(node, i, 'one'));
      add(`Set multiple ${p.geo === 'any' ? 'Geometries' : (KIND_LABEL[p.geo] || p.geo)}${suffix}`, () => runSetGeometry(node, i, 'multi'));
      const has = node.state.__persist && node.state.__persist[i] && node.state.__persist[i].length;
      if (has) {
        const lbl = (node.state.__setLabel || {})[i];
        add(`<span class="ctx-sub">holds ${escapeHtml(lbl || node.state.__persist[i].length + ' items')}</span>`, null, {});
        add(`Clear ${p.name} data`, () => {
          delete node.state.__persist[i];
          if (node.state.__setLabel) delete node.state.__setLabel[i];
          graphDirty = true;
          engine._markDirty(node); engine.scheduleSolve(); engine.draw();
        });
      }
    }
    sep();
  }

  add('Preview', () => { node.previewOff = !node.previewOff; engine.scheduleSolve(); }, { check: !node.previewOff });
  add('Enabled', () => {
    node.enabled = !node.enabled;
    engine._markDirty(node);
    engine.scheduleSolve();
  }, { check: node.enabled });

  if (node.def.layout === 'panel') {
    sep();
    add('Edit text…', () => openPanelEditor(node));
    add('Font size ▸ smaller', () => { node.state.fontSize = Math.max(7, (node.state.fontSize || 9) - 1); engine.draw(); });
    add('Font size ▸ larger', () => { node.state.fontSize = Math.min(18, (node.state.fontSize || 9) + 1); engine.draw(); });
    const colours = [['Yellow', '#fff9bd'], ['White', '#f6f6f2'], ['Grey', '#d8d8d4'], ['Blue', '#cfe2f3'], ['Green', '#d9ead3'], ['Pink', '#f4cccc']];
    for (const [nm, hex] of colours)
      add(`Colour ▸ ${nm}`, () => { node.state.color = hex; engine.draw(); });
  }
  if (node.def.layout === 'slider') {
    sep();
    add('Edit slider…', () => {
      const s = node.state;
      const name = prompt('Slider name:', s.name); if (name === null) return;
      const min = parseFloat(prompt('Minimum:', s.min)); if (isNaN(min)) return;
      const max = parseFloat(prompt('Maximum:', s.max)); if (isNaN(max)) return;
      const step = parseFloat(prompt('Step:', s.step));
      Object.assign(s, { name, min, max, step: isNaN(step) ? s.step : step });
      s.value = Math.max(min, Math.min(max, s.value));
      engine._markDirty(node); engine.scheduleSolve();
    });
  }
  if (node.type === 'ColourSwatch') {
    sep();
    add('Set custom colour…', () => {
      const hex = prompt('Hex colour (e.g. #d03434):', node.state.items[node.state.index]);
      if (hex && /^#[0-9a-fA-F]{6}$/.test(hex.trim())) {
        node.state.items[node.state.index] = hex.trim();
        engine._markDirty(node); engine.scheduleSolve();
      }
    });
  }
  sep();
  add('Delete', () => engine.removeNodes([node]), { danger: true });

  document.body.appendChild(menu);
  menu.style.left = Math.min(cx, window.innerWidth - 240) + 'px';
  menu.style.top = Math.min(cy, window.innerHeight - menu.offsetHeight - 8) + 'px';
  ctxMenu = menu;
};

/* ================= panel text editor ================= */

let panelEditor = null;
function openPanelEditor(node) {
  if (panelEditor) panelEditor.remove();
  const host = document.getElementById('gh-pane');
  const ta = document.createElement('textarea');
  ta.id = 'panel-editor';
  ta.value = node.state.text || '';
  const tl = engine.toScreen(node.x, node.y);
  ta.style.left = Math.max(4, tl.x) + 'px';
  ta.style.top = Math.max(4, tl.y) + 'px';
  ta.style.width = Math.max(node.w * engine.zoom, 140) + 'px';
  ta.style.height = Math.max(node.h * engine.zoom, 70) + 'px';
  ta.style.fontSize = ((node.state.fontSize || 9) * engine.zoom) + 'px';
  const commit = () => {
    node.state.text = ta.value;
    ta.remove(); panelEditor = null;
    engine._markDirty(node);
    engine.scheduleSolve();
  };
  ta.addEventListener('blur', commit);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { ta.value = node.state.text || ''; ta.blur(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ta.blur();
  });
  host.appendChild(ta);
  ta.focus();
  panelEditor = ta;
}

engine.onPanelEdit = (node) => openPanelEditor(node);

/* ================= menus ================= */

const MENUS = {
  File: [
    ['Default Script — Imported-Model Analysis', () => loadExample('imported')],
    ['Default Script — Parametric Truss (startup)', () => loadExample('truss')],
    ['—'],
    ['New Definition', () => { engine.nodes = []; engine.wires = []; graphDirty = true; engine.scheduleSolve(); }],
    ['Import Model… (3DM / OBJ / DXF / JSON)', () => fileInput.click()],
    ['Open Grasshopper Definition… (.ghx)', () => ghInput.click()],
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
    ['Shell Canopy (Mesh → Shell)', () => loadExample('shell')],
    ['Optimize Cross Section', () => loadExample('opticrosec')],
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
const ghInput = document.getElementById('gh-input');

/* ---- Grasshopper definition import (.ghx) ---- */

ghInput.addEventListener('change', async () => {
  const f = ghInput.files[0];
  if (!f) return;
  ghInput.value = '';
  const buf = await f.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 64));
  const headText = new TextDecoder('utf-8', { fatal: false }).decode(head);
  const isXml = headText.trimStart().startsWith('<');
  if (!isXml) {
    alert(
      'This is a binary .gh file — its GH_IO binary archive cannot be read in the browser.\n\n' +
      'In Grasshopper: File ▸ Save As… and pick the file type\n' +
      '"Grasshopper XML (*.ghx)", then import that file here.\n\n' +
      'The .ghx contains exactly the same definition, just as XML.');
    return;
  }
  try {
    const parsed = parseGHX(new TextDecoder().decode(buf));
    const report = buildGraph(engine, parsed);
    graphDirty = true;   // the user's own definition — protected from import resets
    // report panel on the canvas, GH-style
    const lines = [
      `◂ ${f.name} ▸`,
      `${report.mapped} components mapped, ${report.wires} wires`,
      report.sliders ? `${report.sliders} sliders restored` : null,
      report.skipped ? `${report.skipped} annotations skipped (groups/scribbles→notes)` : null,
      report.rebound ? `${report.rebound} geometry inputs re-bound to Import` : null,
      report.dropped ? `${report.dropped} wires to unmatched params dropped` : null,
      report.unsupported.length
        ? `Unsupported (${report.unsupported.length}): ${[...new Set(report.unsupported)].join(', ')}`
        : 'All components recognized',
      window.__importedGeometry ? `running on: ${window.__importedGeometry.name}` : 'no model imported yet — File ▸ Import Model…',
    ].filter(Boolean);
    const rep = engine.addNode('Panel', -180, -140, {
      text: lines.join('\n'), w: 250, h: 16 + lines.length * 14, fontSize: 9,
      color: report.unsupported.length ? '#f4e5cc' : '#d9ead3',
    });
    rep.previewOff = true;
    for (const w of parsed.warnings) console.warn('ghx import:', w);
    setTimeout(() => { engine.zoomExtents(); viewport.zoomExtents(); }, 500);
  } catch (err) {
    alert('Could not read Grasshopper file: ' + err.message);
  }
});

fileInput.addEventListener('change', async () => {
  const f = fileInput.files[0];
  if (!f) return;
  let geo = { lines: [], meshes: [], points: [] };
  try {
    if (/\.3dm$/i.test(f.name)) geo = await parse3dm(await f.arrayBuffer());
    else if (/\.obj$/i.test(f.name)) geo = parseOBJ(await f.text());
    else if (/\.dxf$/i.test(f.name)) geo = { lines: parseDXF(await f.text()), meshes: [], points: [] };
    else geo = parseJSONModel(await f.text());
  } catch (err) {
    alert('Could not read file: ' + err.message);
    return;
  }
  if (!geo.lines.length && !geo.meshes.length && !geo.points.length) {
    alert('No line, point or mesh geometry found in file.\nFor .3dm: keep curves/lines, points and meshes (breps/surfaces are skipped — Mesh them in Rhino first).');
    return;
  }
  if (!geo.objects) geo = synthesizeDocObjects(geo);
  window.__importedGeometry = { name: f.name, ...geo };

  // show it in the viewport as Rhino document geometry (layers, pickable)
  viewport.setDocument(geo);
  buildLayersPanel();

  const existing = engine.nodes.find(n => n.type === 'ImportGeometry');
  if (existing) {
    // refresh whatever the user has wired — never touch their definition
    engine.nodes.forEach(n => { if (n.type === 'ImportGeometry') { n.dirty = true; engine._markDirty(n); } });
    engine.scheduleSolve();
  } else if (!graphDirty) {
    // untouched startup example → drop in the ready-made analysis definition
    loadExample('imported');
  } else {
    // the user's own definition is on the canvas: leave it alone, just re-solve
    engine.nodes.forEach(n => { n.dirty = true; });
    engine.scheduleSolve();
    const lay = geo.layers.map(L => `${L.name} (${L.count})`).join(', ');
    setStatusNote(`Loaded ${f.name} — layers: ${lay}. Right-click a component ▸ Set Geometry to bind it.`);
  }
  setTimeout(() => viewport.zoomExtents(), 250);
  fileInput.value = '';
});

let statusNote = null;
function setStatusNote(txt) {
  statusNote = txt;
  const el = document.getElementById('status-text');
  if (txt) { el.textContent = txt; el.style.color = '#c8e6b0'; }
}

/** OBJ/DXF/JSON have no layers: build one object per line/point/mesh on synthetic layers. */
function synthesizeDocObjects(geo) {
  const objects = [];
  const layers = [];
  const layerFor = (name, color) => {
    let L = layers.find(l => l.name === name);
    if (!L) { L = { index: layers.length, name, path: name, color, visible: true, count: 0 }; layers.push(L); }
    return L;
  };
  for (const l of geo.lines || []) {
    const L = layerFor('lines', 0x1f1f1f);
    objects.push({ id: objects.length, layerIndex: L.index, kind: 'line', segments: [l] });
  }
  for (const p of geo.points || []) {
    const L = layerFor('points', 0x2b6cb0);
    objects.push({ id: objects.length, layerIndex: L.index, kind: 'point', point: p });
  }
  for (const m of geo.meshes || []) {
    const L = layerFor('meshes', 0x8d5a3b);
    objects.push({ id: objects.length, layerIndex: L.index, kind: 'mesh', mesh: m });
  }
  for (const o of objects) layers[o.layerIndex].count++;
  return { ...geo, objects, layers };
}

function parseOBJ(text) {
  const verts = [];
  const lines = [];
  const faces = [];
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
      // fan-triangulate polygons into mesh faces
      for (let i = 1; i < idx.length - 1; i++) faces.push([idx[0], idx[i], idx[i + 1]]);
    }
  }
  const meshes = faces.length ? [{ vertices: verts, faces }] : [];
  return { lines, meshes, points: [] };
}

/* ---- .3dm (Rhino) via rhino3dm wasm ---- */

let rhino3dmPromise = null;
function loadRhino3dm() {
  if (!rhino3dmPromise) {
    rhino3dmPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'lib/rhino3dm/rhino3dm.min.js';
      s.onload = () => window.rhino3dm({ locateFile: (f) => 'lib/rhino3dm/' + f }).then(resolve, reject);
      s.onerror = () => reject(new Error('could not load rhino3dm library'));
      document.head.appendChild(s);
    });
  }
  return rhino3dmPromise;
}

const pt3 = (v) => (Array.isArray(v) ? v : [v[0] ?? v.x ?? 0, v[1] ?? v.y ?? 0, v[2] ?? v.z ?? 0]);

/** Unit scale to meters from the 3dm's declared unit system. */
function unitScale(rh, us) {
  const table = [
    [rh.UnitSystem.Millimeters, 0.001],
    [rh.UnitSystem.Centimeters, 0.01],
    [rh.UnitSystem.Decimeters, 0.1],
    [rh.UnitSystem.Meters, 1],
    [rh.UnitSystem.Kilometers, 1000],
    [rh.UnitSystem.Inches, 0.0254],
    [rh.UnitSystem.Feet, 0.3048],
  ];
  for (const [sys, s] of table) if (us === sys || (us && sys && us.value === sys.value)) return s;
  return null;
}

/**
 * Parse a Rhino .3dm, preserving object identity and layer membership.
 * Returns flat lines/points/meshes (in meters, for the Import component) plus
 * `objects` (one entry per Rhino object, layer-tagged, for viewport picking)
 * and the document's `layers` table.
 */
async function parse3dm(buffer) {
  const rh = await loadRhino3dm();
  const doc = rh.File3dm.fromByteArray(new Uint8Array(buffer));
  if (!doc) throw new Error('not a valid Rhino .3dm file');
  let scale = unitScale(rh, doc.settings().modelUnitSystem);

  // ---- layer table ----
  const layerTable = [];
  try {
    const lt = doc.layers();
    for (let i = 0; i < lt.count; i++) {
      const L = lt.get(i);
      const c = L.color || { r: 0, g: 0, b: 0 };
      layerTable.push({
        index: i,
        name: L.name || `Layer ${i}`,
        path: L.fullPath || L.name || `Layer ${i}`,
        color: (c.r << 16) | (c.g << 8) | c.b,
        visible: L.visible !== false,
        count: 0,
      });
    }
  } catch { /* older files may lack a layer table */ }

  const objects = [];   // {id, layerIndex, kind, segments|point|mesh}
  let skipped = 0;
  const objs = doc.objects();

  // ---- pass 1: raw extraction in document units, keeping object identity ----
  const raw = [];
  for (let i = 0; i < objs.count; i++) {
    let geom, layerIndex = 0, objName = '';
    try {
      const o = objs.get(i);
      geom = o.geometry();
      const at = o.attributes();
      layerIndex = at.layerIndex ?? 0;
      objName = at.name || '';
    } catch { continue; }
    if (!geom) continue;
    try {
      if (geom instanceof rh.Point) {
        raw.push({ kind: 'point', layerIndex, name: objName, pt: pt3(geom.location) });
      } else if (geom instanceof rh.LineCurve) {
        const a = typeof geom.pointAtStart === 'function' ? geom.pointAtStart() : geom.pointAtStart;
        const b = typeof geom.pointAtEnd === 'function' ? geom.pointAtEnd() : geom.pointAtEnd;
        raw.push({ kind: 'poly', layerIndex, name: objName, pts: [pt3(a), pt3(b)] });
      } else if (geom instanceof rh.PolylineCurve) {
        const pts = [];
        for (let k = 0; k < geom.pointCount; k++) pts.push(pt3(geom.point(k)));
        raw.push({ kind: 'poly', layerIndex, name: objName, pts });
      } else if (geom instanceof rh.Mesh) {
        const vl = geom.vertices(), fl = geom.faces();
        const vertices = [];
        for (let k = 0; k < vl.count; k++) vertices.push(pt3(vl.get(k)));
        const faces = [];
        for (let k = 0; k < fl.count; k++) {
          const f = fl.get(k);
          if (f[2] !== f[3]) faces.push([f[0], f[1], f[2]], [f[0], f[2], f[3]]);
          else faces.push([f[0], f[1], f[2]]);
        }
        raw.push({ kind: 'mesh', layerIndex, name: objName, vertices, faces });
      } else if (geom instanceof rh.Curve) {
        // arcs, nurbs, polycurves: adaptive sample — estimate length first
        const dom = geom.domain;
        const t0 = dom[0] ?? dom.t0 ?? 0, t1 = dom[1] ?? dom.t1 ?? 1;
        const probe = [];
        for (let k = 0; k <= 16; k++) probe.push(pt3(geom.pointAt(t0 + (t1 - t0) * k / 16)));
        let len = 0;
        for (let k = 1; k < probe.length; k++)
          len += Math.hypot(probe[k][0] - probe[k - 1][0], probe[k][1] - probe[k - 1][1], probe[k][2] - probe[k - 1][2]);
        raw.push({ kind: 'curve', layerIndex, name: objName, curve: geom, t0, t1, len });
      } else {
        skipped++;
      }
    } catch { skipped++; }
  }

  // ---- unit fallback heuristic when the file declares no usable unit system ----
  if (!scale) {
    let maxAbs = 0;
    const upd = p => { maxAbs = Math.max(maxAbs, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])); };
    for (const r of raw) {
      if (r.pts) r.pts.forEach(upd);
      else if (r.pt) upd(r.pt);
      else if (r.vertices) r.vertices.forEach(upd);
    }
    scale = maxAbs > 5000 ? 0.001 : maxAbs > 500 ? 0.01 : 1;
    console.warn(`3dm import: unit system unknown — assuming scale ${scale} (→ m)`);
  }

  // ---- pass 2: convert to meters; sample curves by arc length (~0.35 m target) ----
  const S = scale;
  const targetSeg = 0.35;
  const lines = [], points = [], meshes = [];

  for (const r of raw) {
    const layerIndex = r.layerIndex;
    if (r.kind === 'point') {
      const p = [r.pt[0] * S, r.pt[1] * S, r.pt[2] * S];
      points.push(p);
      objects.push({ id: objects.length, layerIndex, name: r.name, kind: 'point', point: p });
    } else if (r.kind === 'mesh') {
      const mesh = {
        vertices: r.vertices.map(p => [p[0] * S, p[1] * S, p[2] * S]),
        faces: r.faces,
      };
      meshes.push(mesh);
      objects.push({ id: objects.length, layerIndex, name: r.name, kind: 'mesh', mesh });
    } else {
      const segs = [];
      if (r.kind === 'poly') {
        for (let k = 0; k < r.pts.length - 1; k++) {
          segs.push([
            [r.pts[k][0] * S, r.pts[k][1] * S, r.pts[k][2] * S],
            [r.pts[k + 1][0] * S, r.pts[k + 1][1] * S, r.pts[k + 1][2] * S],
          ]);
        }
      } else {
        const lenM = r.len * S;
        const N = Math.max(2, Math.min(32, Math.ceil(lenM / targetSeg)));
        let prev = pt3(r.curve.pointAt(r.t0)).map(v => v * S);
        for (let k = 1; k <= N; k++) {
          const p = pt3(r.curve.pointAt(r.t0 + (r.t1 - r.t0) * k / N)).map(v => v * S);
          segs.push([prev, p]);
          prev = p;
        }
      }
      if (!segs.length) continue;
      for (const s of segs) lines.push(s);
      objects.push({ id: objects.length, layerIndex, name: r.name, kind: 'line', segments: segs });
    }
  }

  // per-layer object counts
  for (const o of objects) {
    const L = layerTable[o.layerIndex];
    if (L) L.count++;
  }
  const usedLayers = layerTable.filter(L => L.count > 0);

  if (doc.delete) doc.delete();
  if (skipped) console.warn(`3dm import: skipped ${skipped} unsupported objects (breps/surfaces — mesh them in Rhino first)`);
  return {
    lines, meshes, points, scale: S,
    objects,
    layers: usedLayers.length ? usedLayers : layerTable,
  };
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
  if (Array.isArray(data)) return { lines: data, meshes: [], points: [] };
  return {
    lines: data.lines || [],
    meshes: data.meshes || [],
    points: data.points || [],
  };
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
    graphDirty = true;
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

  if (which === 'shell') {
    const sx = N('NumberSlider', 30, 40, { name: 'Span X', min: 4, max: 20, step: 0.5, value: 12 });
    const sy = N('NumberSlider', 30, 80, { name: 'Span Y', min: 4, max: 20, step: 0.5, value: 9 });
    const sr = N('NumberSlider', 30, 120, { name: 'Rise', min: 0.5, max: 6, step: 0.25, value: 2.5 });
    const sd = N('NumberSlider', 30, 160, { name: 'Divisions', min: 4, max: 18, step: 1, value: 10 });
    const canopy = N('ShellCanopy', 250, 80);
    W(sx, 0, canopy, 0); W(sy, 0, canopy, 1); W(sr, 0, canopy, 2); W(sd, 0, canopy, 3);

    const st = N('NumberSlider', 30, 230, { name: 'Thick cm', min: 5, max: 40, step: 1, value: 12 });
    const mat = N('MatSelect', 30, 270, { index: 2 });   // Concrete C30/37
    const shc = N('ShellConst', 250, 240);
    W(st, 0, shc, 0); W(mat, 0, shc, 1);

    const mtos = N('MeshToShell', 440, 90);
    W(canopy, 0, mtos, 0); W(shc, 0, mtos, 2);

    const supp = N('Support', 440, 220, { fix: [true, true, true, false, false, false] });
    W(canopy, 1, supp, 0);
    const grav = N('Gravity', 440, 350);

    const ass = N('Assemble', 620, 150);
    W(mtos, 0, ass, 0); W(supp, 0, ass, 1); W(grav, 0, ass, 2);
    const ana = N('AnalyzeThI', 790, 150);
    W(ass, 0, ana, 0);
    const defS = N('NumberSlider', 620, 330, { name: 'Def Scale', min: 0, max: 500, step: 5, value: 100 });
    const bview = N('BeamView', 950, 150);
    W(ana, 0, bview, 0); W(defS, 0, bview, 1);
    const p1 = N('Panel', 950, 280, { w: 155, h: 60 });
    W(ana, 1, p1, 0);
    const p2 = N('Panel', 950, 360, { w: 155, h: 60 });
    W(ass, 2, p2, 0);
  }

  if (which === 'opticrosec') {
    const sx = N('NumberSlider', 30, 40, { name: 'Width X', min: 3, max: 16, step: 0.5, value: 9 });
    const sy = N('NumberSlider', 30, 80, { name: 'Width Y', min: 3, max: 16, step: 0.5, value: 7 });
    const sh2 = N('NumberSlider', 30, 120, { name: 'Storey H', min: 2.5, max: 6, step: 0.25, value: 3.5 });
    const sn = N('NumberSlider', 30, 160, { name: 'Storeys', min: 1, max: 8, step: 1, value: 4 });
    const frame = N('PortalFrame', 250, 80);
    W(sx, 0, frame, 0); W(sy, 0, frame, 1); W(sh2, 0, frame, 2); W(sn, 0, frame, 3);

    const ltob = N('LineToBeam', 440, 80);
    W(frame, 2, ltob, 0);
    const supp = N('Support', 440, 200, { fix: [true, true, true, true, true, true] });
    W(frame, 3, supp, 0);

    // wind as UDL on the columns + gravity
    const wvec = N('VectorXYZ', 250, 330);
    const wkn = N('NumberSlider', 30, 340, { name: 'Wind kN/m', min: 0, max: 15, step: 0.5, value: 4 });
    W(wkn, 0, wvec, 0);
    const lload = N('LineLoad', 440, 320);
    W(frame, 0, lload, 0); W(wvec, 0, lload, 1);
    const grav = N('Gravity', 440, 410);

    const ass = N('Assemble', 620, 150);
    W(ltob, 0, ass, 0); W(supp, 0, ass, 1); W(lload, 0, ass, 2); W(grav, 0, ass, 2);

    const range = N('CroSecRange', 620, 280, { index: 0 });   // IPE family
    const maxu = N('NumberSlider', 620, 320, { name: 'MaxUtil', min: 0.2, max: 1.2, step: 0.05, value: 0.8 });
    const opti = N('OptiCroSec', 800, 150);
    W(ass, 0, opti, 0); W(range, 0, opti, 1); W(maxu, 0, opti, 2);

    const defS = N('NumberSlider', 800, 330, { name: 'Def Scale', min: 0, max: 500, step: 5, value: 50 });
    const bview = N('BeamView', 985, 150);
    W(opti, 0, bview, 0); W(defS, 0, bview, 1);
    const p1 = N('Panel', 985, 280, { w: 210, h: 74 });
    W(opti, 1, p1, 0);
    const p2 = N('Panel', 985, 375, { w: 210, h: 46 });
    W(opti, 2, p2, 0);
  }

  if (which === 'imported') {
    const imp = N('ImportGeometry', 30, 60);
    imp.previewOff = true;      // BeamView displays the model — hide raw preview
    const pInfo = N('Panel', 30, 150, { w: 185, h: 46 });
    W(imp, 3, pInfo, 0);

    const sd = N('NumberSlider', 30, 250, { name: 'Diam cm', min: 1, max: 30, step: 0.5, value: 6 });
    const st2 = N('NumberSlider', 30, 290, { name: 'Wall cm', min: 0.1, max: 3, step: 0.1, value: 0.4 });
    const mat = N('MatSelect', 30, 330, { index: 0 });
    const cro = N('CroSecCircle', 235, 260);
    W(sd, 0, cro, 0); W(st2, 0, cro, 1); W(mat, 0, cro, 2);

    const ltob = N('LineToBeam', 430, 60);
    W(imp, 0, ltob, 0); W(cro, 0, ltob, 2);

    const tol = N('NumberSlider', 30, 420, { name: 'Base Tol m', min: 0.01, max: 1, step: 0.01, value: 0.08 });
    const bot = N('BottomPoints', 235, 400);
    W(ltob, 1, bot, 0); W(tol, 0, bot, 1);
    const supp = N('Support', 430, 390, { fix: [true, true, true, false, false, false] });
    W(bot, 0, supp, 0);
    const grav = N('Gravity', 430, 500);

    const ass = N('Assemble', 625, 140);
    W(ltob, 0, ass, 0); W(supp, 0, ass, 1); W(grav, 0, ass, 2);
    const ana = N('AnalyzeThI', 780, 140);
    W(ass, 0, ana, 0);
    const defS = N('NumberSlider', 625, 330, { name: 'Def Scale', min: 0, max: 1000, step: 5, value: 50 });
    const bview = N('BeamView', 945, 140);
    W(ana, 0, bview, 0); W(defS, 0, bview, 1);

    const p1 = N('Panel', 945, 270, { w: 160, h: 50 });
    W(ana, 1, p1, 0);
    const p2 = N('Panel', 945, 340, { w: 160, h: 50 });
    W(ass, 2, p2, 0);
  }

  setTimeout(() => { engine.zoomExtents(); viewport.zoomExtents(); }, which === 'imported' ? 500 : 150);
  // a freshly-loaded example is "pristine" — importing a model may replace it,
  // but once the user edits it or loads their own definition it is protected
  graphDirty = false;
}

/* ================= boot ================= */

buildRibbon();
loadExample('truss');
document.getElementById('btn-zoom-ext').onclick = () => viewport.zoomExtents();

// exposed for debugging / testing
window.__engine = engine;
window.__viewport = viewport;
window.__loadExample = loadExample;
window.__parseGHX = parseGHX;
