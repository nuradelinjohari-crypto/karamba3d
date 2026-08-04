/**
 * graph/engine.js — Grasshopper-style canvas node editor.
 *
 * Faithful GH interactions:
 *  - pan (RMB/MMB drag or space+drag), wheel zoom to cursor
 *  - drag components; box select; shift-click multi select
 *  - drag wires output→input (and input→output); click input wire end to disconnect
 *  - double-click empty canvas → component search popup
 *  - Delete/Backspace removes selection
 *  - sliders draggable in place; panels display data
 *  - dataflow: dirty propagation + topological re-solve
 */

export class GraphEngine {
  constructor(canvas, registry) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.registry = registry;         // Map type → definition
    this.nodes = [];
    this.wires = [];                  // {from:{node,port}, to:{node,port}}
    this.pan = { x: 60, y: 40 };
    this.zoom = 1;
    this.selection = new Set();
    this.hover = null;
    this.dragState = null;
    this.onSolved = () => {};
    this.onSelectionInfo = () => {};
    this._solveScheduled = false;
    this._idCounter = 1;

    this._bind();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  /* ---------------- node management ---------------- */

  addNode(type, x, y, state = {}) {
    const def = this.registry.get(type);
    if (!def) return null;
    const node = {
      id: this._idCounter++,
      type, def,
      x, y,
      w: 0, h: 0,
      state: Object.assign({}, def.defaultState ? def.defaultState() : {}, state),
      inputs: def.inputs.map(p => ({ ...p })),
      outputs: def.outputs.map(p => ({ ...p })),
      values: null,      // solved outputs {portName: list}
      error: null,
      warning: null,
      dirty: true,
      previewOff: false,
    };
    this._layoutNode(node);
    this.nodes.push(node);
    this.scheduleSolve();
    return node;
  }

  removeNodes(nodes) {
    const set = new Set(nodes);
    this.wires = this.wires.filter(w => !set.has(w.from.node) && !set.has(w.to.node));
    this.nodes = this.nodes.filter(n => !set.has(n));
    for (const n of this.nodes) if (n) n.dirty = true;
    this.selection.clear();
    this.scheduleSolve();
  }

  connect(fromNode, fromPort, toNode, toPort) {
    if (fromNode === toNode) return;
    // one wire per input unless input allows multiple (GH merges lists; we allow multi)
    this.wires = this.wires.filter(w => !(w.to.node === toNode && w.to.port === toPort && w.from.node === fromNode && w.from.port === fromPort));
    this.wires.push({ from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } });
    this._markDirty(toNode);
    this.scheduleSolve();
  }

  disconnectInput(node, portIdx) {
    this.wires = this.wires.filter(w => !(w.to.node === node && w.to.port === portIdx));
    this._markDirty(node);
    this.scheduleSolve();
  }

  _markDirty(node) {
    node.dirty = true;
    for (const w of this.wires) if (w.from.node === node) this._markDirty(w.to.node);
  }

  /* ---------------- layout ---------------- */

  _layoutNode(node) {
    const d = node.def;
    if (d.layout === 'slider') { node.w = 180; node.h = 24; return; }
    if (d.layout === 'panel')  { node.w = node.state.w || 120; node.h = node.state.h || 80; return; }
    if (d.layout === 'toggle') { node.w = 110; node.h = 22; return; }
    if (d.layout === 'valuelist') { node.w = 130; node.h = 22; return; }
    const rows = Math.max(node.inputs.length, node.outputs.length, 1);
    const rowH = 15;
    node.h = Math.max(rows * rowH + 8, 26) + (d.extraH || 0);
    // width: name capsule + param labels
    const ctx = this.ctx;
    ctx.font = '10px "Segoe UI", Verdana, sans-serif';
    let inW = 0, outW = 0;
    for (const p of node.inputs) inW = Math.max(inW, ctx.measureText(p.nick || p.name).width);
    for (const p of node.outputs) outW = Math.max(outW, ctx.measureText(p.nick || p.name).width);
    node.w = Math.ceil(inW + outW + 34 + 8 * 2);
    node.capW = 20;
  }

  portPos(node, portIdx, isOutput) {
    const d = node.def;
    if (d.layout === 'slider' || d.layout === 'toggle' || d.layout === 'valuelist')
      return { x: node.x + node.w + 2, y: node.y + node.h / 2 };
    if (d.layout === 'panel') {
      if (isOutput) return { x: node.x + node.w + 2, y: node.y + node.h / 2 };
      return { x: node.x - 2, y: node.y + node.h / 2 };
    }
    const list = isOutput ? node.outputs : node.inputs;
    const rows = list.length || 1;
    const usableH = node.h - (d.extraH || 0);
    const y = node.y + usableH * (portIdx + 0.5) / rows;
    return { x: isOutput ? node.x + node.w + 2 : node.x - 2, y };
  }

  /* ---------------- coordinate transforms ---------------- */

  toWorld(sx, sy) { return { x: (sx - this.pan.x) / this.zoom, y: (sy - this.pan.y) / this.zoom }; }
  toScreen(wx, wy) { return { x: wx * this.zoom + this.pan.x, y: wy * this.zoom + this.pan.y }; }

  _resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = r.width * devicePixelRatio;
    this.canvas.height = r.height * devicePixelRatio;
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.draw();
  }

  /* ---------------- hit testing ---------------- */

  hitTest(wx, wy) {
    // ports first (larger halo)
    const halo = 7 / this.zoom;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      for (let p = 0; p < n.outputs.length; p++) {
        const pos = this.portPos(n, p, true);
        if (Math.hypot(pos.x - wx, pos.y - wy) < halo) return { kind: 'outport', node: n, port: p };
      }
      for (let p = 0; p < n.inputs.length; p++) {
        const pos = this.portPos(n, p, false);
        if (Math.hypot(pos.x - wx, pos.y - wy) < halo) return { kind: 'inport', node: n, port: p };
      }
    }
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) {
        if (n.def.layout === 'slider') {
          return { kind: 'slider', node: n };
        }
        return { kind: 'node', node: n };
      }
    }
    return null;
  }

  /* ---------------- events ---------------- */

  _bind() {
    const c = this.canvas;
    c.addEventListener('mousedown', e => this._onDown(e));
    window.addEventListener('mousemove', e => this._onMove(e));
    window.addEventListener('mouseup', e => this._onUp(e));
    c.addEventListener('wheel', e => this._onWheel(e), { passive: false });
    c.addEventListener('dblclick', e => this._onDbl(e));
    c.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', e => this._onKey(e));
  }

  _evt(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { sx, sy, ...this.toWorld(sx, sy) };
  }

  _onDown(e) {
    if (e.target !== this.canvas) return;
    const pt = this._evt(e);
    const hit = this.hitTest(pt.x, pt.y);

    if (e.button === 2 || e.button === 1) {
      this.dragState = { kind: 'pan', sx: pt.sx, sy: pt.sy, panX: this.pan.x, panY: this.pan.y, moved: false, hit };
      return;
    }
    if (e.button !== 0) return;

    if (hit && hit.kind === 'outport') {
      this.dragState = { kind: 'wire', from: { node: hit.node, port: hit.port }, x: pt.x, y: pt.y };
      return;
    }
    if (hit && hit.kind === 'inport') {
      // if wired: grab existing wire (disconnect + re-drag); else start reverse wire
      const existing = this.wires.filter(w => w.to.node === hit.node && w.to.port === hit.port);
      if (existing.length && !e.shiftKey) {
        const w = existing[existing.length - 1];
        this.disconnectInput(hit.node, hit.port);
        this.dragState = { kind: 'wire', from: { node: w.from.node, port: w.from.port }, x: pt.x, y: pt.y };
      } else {
        this.dragState = { kind: 'wireRev', to: { node: hit.node, port: hit.port }, x: pt.x, y: pt.y };
      }
      return;
    }
    if (hit && hit.kind === 'slider') {
      const n = hit.node;
      if (pt.x >= n.x + n.w * 0.42) {
        // grip zone: drag the slider value
        this.dragState = { kind: 'sliderDrag', node: n };
        this._sliderSet(n, pt.x);
      } else {
        // name zone: select + move like a normal component
        if (!this.selection.has(n)) { if (!e.shiftKey) this.selection.clear(); this.selection.add(n); }
        this.dragState = {
          kind: 'move', x: pt.x, y: pt.y,
          origins: [...this.selection].map(nn => ({ n: nn, x: nn.x, y: nn.y })),
        };
      }
      return;
    }
    if (hit && hit.kind === 'node') {
      if (hit.node.def.onClick && hit.node.def.onClick(hit.node, pt.x, pt.y, this)) {
        this._markDirty(hit.node);
        this.scheduleSolve();
        return;
      }
      if (!this.selection.has(hit.node)) {
        if (!e.shiftKey) this.selection.clear();
        this.selection.add(hit.node);
      } else if (e.shiftKey) {
        this.selection.delete(hit.node);
      }
      this.onSelectionInfo([...this.selection]);
      this.dragState = {
        kind: 'move', x: pt.x, y: pt.y,
        origins: [...this.selection].map(n => ({ n, x: n.x, y: n.y })),
      };
      return;
    }
    // empty canvas: box select
    if (!e.shiftKey) { this.selection.clear(); this.onSelectionInfo([]); }
    this.dragState = { kind: 'box', x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
  }

  _sliderSet(node, wx) {
    const s = node.state;
    const gripStart = node.x + node.w * 0.42;
    const gripEnd = node.x + node.w - 10;
    let t = (wx - gripStart) / (gripEnd - gripStart);
    t = Math.max(0, Math.min(1, t));
    let v = s.min + t * (s.max - s.min);
    if (s.step > 0) v = Math.round(v / s.step) * s.step;
    v = Math.max(s.min, Math.min(s.max, v));
    if (v !== s.value) {
      s.value = parseFloat(v.toFixed(6));
      this._markDirty(node);
      this.scheduleSolve();
    }
  }

  _onMove(e) {
    const pt = this._evt(e);
    const ds = this.dragState;
    if (!ds) {
      const hit = this.hitTest(pt.x, pt.y);
      const newHover = hit ? (hit.node.id + ':' + hit.kind + ':' + (hit.port ?? '')) : null;
      if (newHover !== this._hoverKey) { this._hoverKey = newHover; this.hover = hit; this.draw(); }
      this.canvas.style.cursor = hit ? (hit.kind === 'node' ? 'default' : 'crosshair') : 'default';
      return;
    }
    if (ds.kind === 'pan') {
      this.pan.x = ds.panX + (pt.sx - ds.sx);
      this.pan.y = ds.panY + (pt.sy - ds.sy);
      if (Math.abs(pt.sx - ds.sx) + Math.abs(pt.sy - ds.sy) > 3) ds.moved = true;
      this.draw();
      return;
    }
    if (ds.kind === 'move') {
      const dx = pt.x - ds.x, dy = pt.y - ds.y;
      for (const o of ds.origins) { o.n.x = o.x + dx; o.n.y = o.y + dy; }
      this.draw();
      return;
    }
    if (ds.kind === 'wire' || ds.kind === 'wireRev') {
      ds.x = pt.x; ds.y = pt.y;
      this.draw();
      return;
    }
    if (ds.kind === 'sliderDrag') { this._sliderSet(ds.node, pt.x); this.draw(); return; }
    if (ds.kind === 'box') { ds.x1 = pt.x; ds.y1 = pt.y; this.draw(); return; }
  }

  _onUp(e) {
    const ds = this.dragState;
    if (!ds) return;
    const pt = this._evt(e);
    if (ds.kind === 'wire') {
      const hit = this.hitTest(pt.x, pt.y);
      if (hit && hit.kind === 'inport') this.connect(ds.from.node, ds.from.port, hit.node, hit.port);
    } else if (ds.kind === 'wireRev') {
      const hit = this.hitTest(pt.x, pt.y);
      if (hit && hit.kind === 'outport') this.connect(hit.node, hit.port, ds.to.node, ds.to.port);
    } else if (ds.kind === 'box') {
      const x0 = Math.min(ds.x0, ds.x1), x1 = Math.max(ds.x0, ds.x1);
      const y0 = Math.min(ds.y0, ds.y1), y1 = Math.max(ds.y0, ds.y1);
      if (x1 - x0 > 4 || y1 - y0 > 4) {
        for (const n of this.nodes)
          if (n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0) this.selection.add(n);
        this.onSelectionInfo([...this.selection]);
      }
    } else if (ds.kind === 'pan' && !ds.moved && e.button === 2) {
      // right click without drag = context: toggle preview on node
      if (ds.hit && (ds.hit.kind === 'node' || ds.hit.kind === 'slider')) {
        ds.hit.node.previewOff = !ds.hit.node.previewOff;
        this.scheduleSolve();
      }
    }
    this.dragState = null;
    this.draw();
  }

  _onWheel(e) {
    e.preventDefault();
    const pt = this._evt(e);
    const factor = Math.pow(1.0015, -e.deltaY);
    const newZoom = Math.max(0.2, Math.min(3, this.zoom * factor));
    // zoom about cursor
    this.pan.x = pt.sx - pt.x * newZoom;
    this.pan.y = pt.sy - pt.y * newZoom;
    this.zoom = newZoom;
    this.draw();
  }

  _onDbl(e) {
    const pt = this._evt(e);
    const hit = this.hitTest(pt.x, pt.y);
    if (!hit) {
      if (this.onOpenSearch) this.onOpenSearch(e.clientX, e.clientY, pt.x, pt.y);
    } else if (hit.kind === 'slider') {
      const n = hit.node;
      const v = prompt(`${n.state.name || 'Slider'} — value (${n.state.min} … ${n.state.max}):`, n.state.value);
      if (v !== null && !isNaN(parseFloat(v))) {
        n.state.value = Math.max(n.state.min, Math.min(n.state.max, parseFloat(v)));
        this._markDirty(n); this.scheduleSolve();
      }
    }
  }

  _onKey(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection.size) {
      e.preventDefault();
      this.removeNodes([...this.selection]);
      this.draw();
    }
    if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      for (const n of this.nodes) this.selection.add(n);
      this.draw();
    }
  }

  /* ---------------- evaluation ---------------- */

  scheduleSolve() {
    if (this._solveScheduled) return;
    this._solveScheduled = true;
    requestAnimationFrame(() => {
      this._solveScheduled = false;
      this.solveGraph();
      this.draw();
      this.onSolved(this);
    });
  }

  inputValues(node, portIdx) {
    const vals = [];
    for (const w of this.wires) {
      if (w.to.node === node && w.to.port === portIdx) {
        const src = w.from.node;
        const out = src.values ? src.values[src.outputs[w.from.port].name] : null;
        if (out != null) vals.push(...(Array.isArray(out) ? out : [out]));
      }
    }
    return vals;
  }

  solveGraph() {
    // topological order via DFS
    const order = [];
    const seen = new Set(), inStack = new Set();
    const visit = (n) => {
      if (seen.has(n)) return;
      if (inStack.has(n)) { n.error = 'Cyclic dependency'; return; }
      inStack.add(n);
      for (const w of this.wires) if (w.to.node === n) visit(w.from.node);
      inStack.delete(n);
      seen.add(n);
      order.push(n);
    };
    for (const n of this.nodes) visit(n);

    for (const n of order) {
      if (!n.dirty && n.values) continue;
      n.error = null; n.warning = null;
      const ins = n.inputs.map((p, i) => {
        const v = this.inputValues(n, i);
        if (v.length === 0 && p.default !== undefined) return Array.isArray(p.default) ? p.default : [p.default];
        return v;
      });
      try {
        n.values = n.def.solve(ins, n, this) || {};
        // required-input warnings
        n.inputs.forEach((p, i) => {
          if (p.required && ins[i].length === 0) n.warning = `Input '${p.name}' failed to collect data`;
        });
      } catch (err) {
        n.error = err.message || String(err);
        n.values = {};
      }
      n.dirty = false;
    }
  }

  /* ---------------- drawing ---------------- */

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.width / devicePixelRatio, H = this.canvas.height / devicePixelRatio;
    ctx.save();
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

    // GH canvas background (verified GH default #D4D0C8)
    ctx.fillStyle = '#d4d0c8';
    ctx.fillRect(0, 0, W, H);
    this._drawGrid(ctx, W, H);
    // inner shadow at edges (GH canvas_shade)
    const sh = ctx.createLinearGradient(0, 0, 0, 26);
    sh.addColorStop(0, 'rgba(0,0,0,0.18)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh; ctx.fillRect(0, 0, W, 26);
    const shl = ctx.createLinearGradient(0, 0, 26, 0);
    shl.addColorStop(0, 'rgba(0,0,0,0.14)'); shl.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shl; ctx.fillRect(0, 0, 26, H);

    ctx.translate(this.pan.x, this.pan.y);
    ctx.scale(this.zoom, this.zoom);

    // wires
    for (const w of this.wires) this._drawWire(ctx, w);

    // dragging wire
    const ds = this.dragState;
    if (ds && (ds.kind === 'wire' || ds.kind === 'wireRev')) {
      const a = ds.kind === 'wire' ? this.portPos(ds.from.node, ds.from.port, true) : { x: ds.x, y: ds.y };
      const b = ds.kind === 'wire' ? { x: ds.x, y: ds.y } : this.portPos(ds.to.node, ds.to.port, false);
      this._bezier(ctx, a, b);
      ctx.strokeStyle = 'rgba(60,60,60,0.85)';
      ctx.lineWidth = 2 / this.zoom;
      ctx.setLineDash([6 / this.zoom, 4 / this.zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // nodes
    for (const n of this.nodes) this._drawNode(ctx, n);

    // box select
    if (ds && ds.kind === 'box') {
      ctx.fillStyle = 'rgba(120,160,90,0.12)';
      ctx.strokeStyle = 'rgba(90,130,60,0.8)';
      ctx.lineWidth = 1 / this.zoom;
      const x = Math.min(ds.x0, ds.x1), y = Math.min(ds.y0, ds.y1);
      ctx.fillRect(x, y, Math.abs(ds.x1 - ds.x0), Math.abs(ds.y1 - ds.y0));
      ctx.strokeRect(x, y, Math.abs(ds.x1 - ds.x0), Math.abs(ds.y1 - ds.y0));
    }

    ctx.restore();
  }

  _drawGrid(ctx, W, H) {
    // GH default: 150px square line grid, black @ ~12% alpha, fades when zoomed out
    const step = 150 * this.zoom;
    if (step < 20) return;
    const alpha = step < 45 ? 0.12 * (step - 20) / 25 : 0.12;
    ctx.strokeStyle = `rgba(0,0,0,${alpha})`;
    ctx.lineWidth = 1;
    const ox = ((this.pan.x % step) + step) % step;
    const oy = ((this.pan.y % step) + step) % step;
    ctx.beginPath();
    for (let x = ox; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = oy; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }

  _bezier(ctx, a, b) {
    const dx = Math.max(Math.abs(b.x - a.x) * 0.5, 30);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(a.x + dx, a.y, b.x - dx, b.y, b.x, b.y);
  }

  _drawWire(ctx, w) {
    const a = this.portPos(w.from.node, w.from.port, true);
    const b = this.portPos(w.to.node, w.to.port, false);
    const src = w.from.node;
    const val = src.values ? src.values[src.outputs[w.from.port].name] : null;
    const isList = Array.isArray(val) && val.length > 1;
    this._bezier(ctx, a, b);
    ctx.strokeStyle = 'rgba(70,70,70,0.35)';
    ctx.lineWidth = (isList ? 4.5 : 2.6);
    ctx.stroke();
    this._bezier(ctx, a, b);
    ctx.strokeStyle = isList ? '#e8e8e8' : '#4a4a4a';
    ctx.lineWidth = isList ? 2.2 : 1.2;
    ctx.stroke();
    if (isList) {
      this._bezier(ctx, a, b);
      ctx.strokeStyle = '#4a4a4a';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }

  _nodeColors(n) {
    if (n.error) return { body: '#e8a0a0', edge: '#7c2222', cap: '#c46060' };
    if (this.selection.has(n)) return { body: '#a8d08d', edge: '#3f6212', cap: '#7fb069' };
    if (n.warning) return { body: '#f2c689', edge: '#8a5a10', cap: '#e0a050' };
    if (n.previewOff) return { body: '#9a9aa0', edge: '#4a4a50', cap: '#77777d' };
    return { body: '#d9d9de', edge: '#3c3c40', cap: '#b0b0b8' };
  }

  _rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _drawNode(ctx, n) {
    const col = this._nodeColors(n);
    const d = n.def;

    if (d.layout === 'slider') return this._drawSlider(ctx, n, col);
    if (d.layout === 'panel') return this._drawPanel(ctx, n, col);
    if (d.layout === 'toggle') return this._drawToggle(ctx, n, col);
    if (d.layout === 'valuelist') return this._drawValueList(ctx, n, col);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    this._rr(ctx, n.x + 2.5, n.y + 2.5, n.w, n.h, 4); ctx.fill();

    // body
    const grad = ctx.createLinearGradient(n.x, n.y, n.x, n.y + n.h);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.12, col.body);
    grad.addColorStop(1, this._shade(col.body, -14));
    ctx.fillStyle = grad;
    this._rr(ctx, n.x, n.y, n.w, n.h, 4); ctx.fill();
    ctx.strokeStyle = col.edge;
    ctx.lineWidth = 1.1;
    this._rr(ctx, n.x, n.y, n.w, n.h, 4); ctx.stroke();

    // center capsule with vertical name
    const capW = 18;
    const cx = n.x + n.w / 2 - capW / 2;
    ctx.fillStyle = col.cap;
    this._rr(ctx, cx, n.y + 1.5, capW, n.h - 3, 3.5); ctx.fill();
    ctx.strokeStyle = col.edge; ctx.lineWidth = 0.8;
    this._rr(ctx, cx, n.y + 1.5, capW, n.h - 3, 3.5); ctx.stroke();

    ctx.save();
    ctx.translate(n.x + n.w / 2, n.y + n.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#1b1b1e';
    ctx.font = 'bold 10px "Segoe UI", Verdana, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const label = d.nick || d.name;
    ctx.fillText(label, 0, 0.5, n.h - 6);
    ctx.restore();

    // params
    ctx.font = '9.5px "Segoe UI", Verdana, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#26262a';
    n.inputs.forEach((p, i) => {
      const pos = this.portPos(n, i, false);
      ctx.textAlign = 'left';
      ctx.fillText(p.nick || p.name, n.x + 7, pos.y);
      this._drawPort(ctx, pos, n, col);
    });
    n.outputs.forEach((p, i) => {
      const pos = this.portPos(n, i, true);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#26262a';
      ctx.fillText(p.nick || p.name, n.x + n.w - 7, pos.y);
      this._drawPort(ctx, pos, n, col);
    });

    if (d.drawExtra) d.drawExtra(ctx, n, this);

    // error/warning balloon
    if (n.error || n.warning) {
      ctx.fillStyle = n.error ? '#cc2222' : '#e8981a';
      ctx.beginPath(); ctx.arc(n.x + n.w - 4, n.y - 4, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 8px Verdana';
      ctx.textAlign = 'center';
      ctx.fillText('!', n.x + n.w - 4, n.y - 3.5);
    }
  }

  _drawPort(ctx, pos, n, col) {
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = '#efefef';
    ctx.fill();
    ctx.strokeStyle = col.edge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  _drawSlider(ctx, n, col) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    this._rr(ctx, n.x + 2, n.y + 2, n.w, n.h, 6); ctx.fill();
    const grad = ctx.createLinearGradient(n.x, n.y, n.x, n.y + n.h);
    grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#c9c9cf');
    ctx.fillStyle = this.selection.has(n) ? '#bcd9a8' : grad;
    this._rr(ctx, n.x, n.y, n.w, n.h, 6); ctx.fill();
    ctx.strokeStyle = col.edge; ctx.lineWidth = 1.1;
    this._rr(ctx, n.x, n.y, n.w, n.h, 6); ctx.stroke();

    const s = n.state;
    ctx.font = 'bold 9.5px "Segoe UI", Verdana, sans-serif';
    ctx.fillStyle = '#1b1b1e';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const decimals = s.step >= 1 ? 0 : (s.step >= 0.1 ? 1 : 2);
    ctx.fillText(`${s.name} : ${(+s.value).toFixed(decimals)}`, n.x + 8, n.y + n.h / 2, n.w * 0.4 - 8);

    // rail
    const railX0 = n.x + n.w * 0.42, railX1 = n.x + n.w - 10;
    const railY = n.y + n.h / 2;
    ctx.strokeStyle = '#7a7a80'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(railX0, railY); ctx.lineTo(railX1, railY); ctx.stroke();
    // grip
    const t = (s.value - s.min) / (s.max - s.min || 1);
    const gx = railX0 + t * (railX1 - railX0);
    ctx.fillStyle = '#3a3a3e';
    ctx.beginPath(); ctx.arc(gx, railY, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e8e8e8';
    ctx.beginPath(); ctx.arc(gx, railY, 2, 0, Math.PI * 2); ctx.fill();

    const pos = this.portPos(n, 0, true);
    this._drawPort(ctx, pos, n, col);
  }

  _drawToggle(ctx, n, col) {
    const on = !!n.state.value;
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    this._rr(ctx, n.x + 2, n.y + 2, n.w, n.h, 5); ctx.fill();
    ctx.fillStyle = this.selection.has(n) ? '#bcd9a8' : '#dcdce0';
    this._rr(ctx, n.x, n.y, n.w, n.h, 5); ctx.fill();
    ctx.strokeStyle = col.edge; ctx.lineWidth = 1;
    this._rr(ctx, n.x, n.y, n.w, n.h, 5); ctx.stroke();
    ctx.fillStyle = on ? '#3f8f29' : '#8a8a90';
    ctx.beginPath(); ctx.arc(n.x + 13, n.y + n.h / 2, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1b1b1e';
    ctx.font = 'bold 9.5px "Segoe UI", Verdana';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`${n.state.name}: ${on}`, n.x + 24, n.y + n.h / 2);
    this._drawPort(ctx, this.portPos(n, 0, true), n, col);
  }

  _drawValueList(ctx, n, col) {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    this._rr(ctx, n.x + 2, n.y + 2, n.w, n.h, 4); ctx.fill();
    ctx.fillStyle = this.selection.has(n) ? '#bcd9a8' : '#e6e6ea';
    this._rr(ctx, n.x, n.y, n.w, n.h, 4); ctx.fill();
    ctx.strokeStyle = col.edge; ctx.lineWidth = 1;
    this._rr(ctx, n.x, n.y, n.w, n.h, 4); ctx.stroke();
    ctx.fillStyle = '#1b1b1e';
    ctx.font = '9.5px "Segoe UI", Verdana';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const items = n.state.items || [];
    const cur = items[n.state.index || 0] || '—';
    ctx.fillText('◂ ' + cur + ' ▸', n.x + 8, n.y + n.h / 2, n.w - 24);
    this._drawPort(ctx, this.portPos(n, 0, true), n, col);
  }

  _drawPanel(ctx, n, col) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    this._rr(ctx, n.x + 2.5, n.y + 2.5, n.w, n.h, 2); ctx.fill();
    ctx.fillStyle = '#fff9bd';
    this._rr(ctx, n.x, n.y, n.w, n.h, 2); ctx.fill();
    ctx.strokeStyle = this.selection.has(n) ? '#3f6212' : '#8a8455';
    ctx.lineWidth = this.selection.has(n) ? 1.6 : 1;
    this._rr(ctx, n.x, n.y, n.w, n.h, 2); ctx.stroke();
    // header strip
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    ctx.fillRect(n.x, n.y, n.w, 10);

    const vals = this.inputValues(n, 0);
    ctx.fillStyle = '#33301c';
    ctx.font = '9px "Consolas", "Menlo", monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    let y = n.y + 13;
    const maxLines = Math.floor((n.h - 16) / 11);
    const lines = [];
    if (vals.length === 0) lines.push('  <empty>');
    else vals.slice(0, maxLines).forEach((v, i) => lines.push(` ${i}. ${formatValue(v)}`));
    if (vals.length > maxLines) lines[maxLines - 1] = ` … ${vals.length} items`;
    for (const ln of lines.slice(0, maxLines)) {
      ctx.fillText(ln, n.x + 3, y, n.w - 6);
      y += 11;
    }
    this._drawPort(ctx, this.portPos(n, 0, false), n, col);
  }

  _shade(hex, amt) {
    const c = parseInt(hex.slice(1), 16);
    let r = (c >> 16) + amt, g = ((c >> 8) & 0xff) + amt, b = (c & 0xff) + amt;
    r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
    return `rgb(${r},${g},${b})`;
  }

  /* ---------------- serialization ---------------- */

  toJSON() {
    return {
      nodes: this.nodes.map(n => ({
        id: n.id, type: n.type, x: Math.round(n.x), y: Math.round(n.y),
        state: serializableState(n.state),
      })),
      wires: this.wires.map(w => ({
        from: [w.from.node.id, w.from.port], to: [w.to.node.id, w.to.port],
      })),
    };
  }

  loadJSON(data) {
    this.nodes = []; this.wires = []; this.selection.clear();
    const byId = new Map();
    let maxId = 0;
    for (const nd of data.nodes) {
      const n = this.addNode(nd.type, nd.x, nd.y, nd.state || {});
      if (!n) continue;
      n.id = nd.id;
      maxId = Math.max(maxId, nd.id);
      byId.set(nd.id, n);
    }
    this._idCounter = maxId + 1;
    for (const wd of data.wires) {
      const a = byId.get(wd.from[0]), b = byId.get(wd.to[0]);
      if (a && b) this.wires.push({ from: { node: a, port: wd.from[1] }, to: { node: b, port: wd.to[1] } });
    }
    for (const n of this.nodes) n.dirty = true;
    this.scheduleSolve();
  }

  zoomExtents() {
    if (!this.nodes.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h);
    }
    const W = this.canvas.width / devicePixelRatio, H = this.canvas.height / devicePixelRatio;
    const pad = 60;
    const z = Math.min((W - pad) / (x1 - x0), (H - pad) / (y1 - y0), 1.5);
    this.zoom = Math.max(0.2, z);
    this.pan.x = W / 2 - (x0 + x1) / 2 * this.zoom;
    this.pan.y = H / 2 - (y0 + y1) / 2 * this.zoom;
    this.draw();
  }
}

function serializableState(state) {
  const out = {};
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === 'function' || (v && typeof v === 'object' && v.isObject3D)) continue;
    out[k] = v;
  }
  return out;
}

export function formatValue(v) {
  if (v == null) return 'null';
  if (typeof v === 'number') return Math.abs(v) < 1e-9 ? '0' : (+v.toFixed(4)).toString();
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v.kind === 'point') return `{${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)}}`;
  if (v.kind === 'line') return `Line {${fmt(v.a.x)},${fmt(v.a.y)},${fmt(v.a.z)} → ${fmt(v.b.x)},${fmt(v.b.y)},${fmt(v.b.z)}}`;
  if (v.kind === 'vector') return `Vec {${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)}}`;
  if (v.kind === 'beam') return `Beam (${v.id || 'elem'})`;
  if (v.kind === 'mesh') return `Mesh (${v.vertices.length}V ${v.faces.length}F)`;
  if (v.kind === 'shell') return `Shell (${v.tris.length} tris, t=${v.t}cm)`;
  if (v.kind === 'support') return `Support @node`;
  if (v.kind === 'load') return `Load (${v.type})`;
  if (v.kind === 'crosec') return `CroSec: ${v.name}`;
  if (v.kind === 'material') return `Material: ${v.name}`;
  if (v.kind === 'model') return `Model (${v.elements?.length ?? 0} elems, ${v.nodes?.length ?? 0} nodes)`;
  if (v.kind === 'analysis') return v.ok ? `Analyzed Model (max disp ${fmt(v.maxDisp * 100)}cm)` : `Analysis failed`;
  return JSON.stringify(v).slice(0, 60);
}
function fmt(x) { return (+(+x).toFixed(3)).toString(); }
