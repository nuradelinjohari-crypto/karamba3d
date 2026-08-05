/**
 * viewport/viewport.js — Rhino-style perspective viewport rendering the
 * Karamba3D model + analysis results with three.js.
 *
 * Rhino look: bg gradient #C6CBD1→#9DA3AA, 70×70 grid (minor #AEB3B9,
 * major every 5 #8A8F96), X axis muted red / Y muted green, world-axes
 * icon bottom-left. Karamba look: rainbow legend blue→red, green support
 * cones, orange load arrows, deformed mesh + ghosted original wireframe.
 */

import * as THREE from '../../lib/three.module.js';
import { OrbitControls } from '../../lib/OrbitControls.js';

const RAINBOW = [
  [0.00, 0x0000ff], [0.25, 0x00ffff], [0.50, 0x00ff00],
  [0.75, 0xffff00], [0.875, 0xff7f00], [1.00, 0xff0000],
];

export function rainbow(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAINBOW.length; i++) {
    if (t <= RAINBOW[i][0]) {
      const [t0, c0] = RAINBOW[i - 1], [t1, c1] = RAINBOW[i];
      const f = (t - t0) / (t1 - t0);
      const a = new THREE.Color(c0), b = new THREE.Color(c1);
      return a.lerp(b, f);
    }
  }
  return new THREE.Color(0xff0000);
}

export class Viewport {
  constructor(container, legendEl) {
    this.container = container;
    this.legendEl = legendEl;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    // Rhino-ish background gradient via large canvas texture
    const bg = document.createElement('canvas');
    bg.width = 2; bg.height = 256;
    const bctx = bg.getContext('2d');
    const grad = bctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#c6cbd1');
    grad.addColorStop(1, '#8f959d');
    bctx.fillStyle = grad;
    bctx.fillRect(0, 0, 2, 256);
    const bgTex = new THREE.CanvasTexture(bg);
    bgTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = bgTex;

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
    this.camera.up.set(0, 0, 1); // Rhino: Z up
    this.camera.position.set(16, -14, 10);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(5, 0, 1);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    // Rhino nav: RMB orbit, Shift+RMB pan, wheel zoom
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    window.addEventListener('keydown', e => {
      if (e.key === 'Shift') {
        this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
        this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
      }
    });
    window.addEventListener('keyup', e => {
      if (e.key === 'Shift') {
        this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
        this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      }
    });
    this.renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

    // lights: simple headlight + ambient (Rhino shaded mode feel)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(this.headlight);

    this._buildGrid();
    this._buildAxesIcon();

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    // Rhino "document" geometry (the imported .3dm) — always present & pickable
    this.docGroup = new THREE.Group();
    this.scene.add(this.docGroup);
    this.doc = null;
    this.docObjects = [];
    this.docLayers = [];
    this.docVisible = true;
    this.selection = new Set();      // selected doc-object ids
    this.pickState = null;           // active Set-Geometry pick session
    this.onSelectionChange = () => {};

    this.raycaster = new THREE.Raycaster();
    this._initPicking();

    this._resize();
    new ResizeObserver(() => this._resize()).observe(container);

    const loop = () => {
      requestAnimationFrame(loop);
      this.controls.update();
      this.headlight.position.copy(this.camera.position);
      this.renderer.render(this.scene, this.camera);
      this._renderAxesIcon();
    };
    loop();
  }

  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _buildGrid() {
    const size = 35, step = 1;
    const minor = [], major = [];
    for (let i = -size; i <= size; i += step) {
      const arr = (i % 5 === 0 && i !== 0) ? major : (i === 0 ? null : minor);
      if (arr) {
        arr.push(-size, i, 0, size, i, 0);
        arr.push(i, -size, 0, i, size, 0);
      }
    }
    const mk = (verts, color) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }));
    };
    this.scene.add(mk(minor, 0xaeb3b9));
    this.scene.add(mk(major, 0x8a8f96));
    // axis lines through origin (muted red X / green Y — Rhino defaults)
    this.scene.add(mk([-size, 0, 0, size, 0, 0], 0xb34a4a));
    this.scene.add(mk([0, -size, 0, 0, size, 0], 0x4ab34a));
  }

  _buildAxesIcon() {
    this.axesScene = new THREE.Scene();
    this.axesCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
    this.axesCamera.up.set(0, 0, 1);
    const mkArrow = (dir, color) => {
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 1, 6),
        new THREE.MeshBasicMaterial({ color }));
      shaft.position.y = 0.5;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.28, 8), new THREE.MeshBasicMaterial({ color }));
      head.position.y = 1.1;
      g.add(shaft, head);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      return g;
    };
    this.axesScene.add(mkArrow(new THREE.Vector3(1, 0, 0), 0xd22b2b));
    this.axesScene.add(mkArrow(new THREE.Vector3(0, 1, 0), 0x3cb43c));
    this.axesScene.add(mkArrow(new THREE.Vector3(0, 0, 1), 0x3b6fd2));
  }

  _renderAxesIcon() {
    const s = 92;
    const h = this.container.clientHeight;
    this.axesCamera.position.copy(this.camera.position).sub(this.controls.target).normalize().multiplyScalar(4);
    this.axesCamera.lookAt(0, 0, 0);
    this.renderer.setViewport(8, 8, s, s);
    this.renderer.setScissor(8, 8, s, s);
    this.renderer.setScissorTest(true);
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.axesScene, this.axesCamera);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.container.clientWidth, h);
    this.renderer.autoClear = true;
  }

  /* ================= Rhino document geometry + picking ================= */

  /**
   * Install the imported .3dm as the viewport's document geometry.
   * @param geo {objects, layers, name} from parse3dm
   */
  setDocument(geo) {
    this.doc = geo || null;
    this.docObjects = (geo && geo.objects) || [];
    this.docLayers = (geo && geo.layers) || [];
    this.selection.clear();
    this._buildDocGroup();
    this.onSelectionChange([...this.selection]);
  }

  _disposeGroup(g) {
    g.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
    g.clear();
  }

  _buildDocGroup() {
    this._disposeGroup(this.docGroup);
    this.docLineObj = null;
    this.docPointObj = null;
    if (!this.docObjects.length) return;

    // model size → picking thresholds and point size
    const bb = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const o of this.docObjects) {
      if (o.kind === 'line') for (const s of o.segments) { bb.expandByPoint(v.set(...s[0])); bb.expandByPoint(v.set(...s[1])); }
      else if (o.kind === 'point') bb.expandByPoint(v.set(...o.point));
      else if (o.kind === 'mesh') for (const p of o.mesh.vertices) bb.expandByPoint(v.set(...p));
    }
    const diag = bb.isEmpty() ? 10 : bb.getSize(new THREE.Vector3()).length();
    this.docDiag = diag;
    this.raycaster.params.Line = { threshold: diag * 0.006 };
    this.raycaster.params.Points = { threshold: diag * 0.010 };

    const layerColor = (li) => {
      const L = this.docLayers.find(l => l.index === li);
      let c = L ? L.color : 0x1a1a1a;
      // Rhino draws pure-black layers as black wires; keep them visible on gray
      if (c === 0xffffff) c = 0x2a2a2a;
      return new THREE.Color(c === 0 ? 0x1f1f1f : c);
    };

    /* ---- lines: one merged LineSegments, vertex-coloured, seg→object map ---- */
    const lp = [], lc = [], segObj = [];
    for (const o of this.docObjects) {
      if (o.kind !== 'line') continue;
      const col = layerColor(o.layerIndex);
      for (const s of o.segments) {
        lp.push(s[0][0], s[0][1], s[0][2], s[1][0], s[1][1], s[1][2]);
        lc.push(col.r, col.g, col.b, col.r, col.g, col.b);
        segObj.push(o.id);
      }
    }
    if (lp.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
      const mesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
      mesh.userData = { docKind: 'line', segObj };
      mesh.renderOrder = 1;
      this.docGroup.add(mesh);
      this.docLineObj = mesh;
    }

    /* ---- points ---- */
    const pp = [], pc = [], ptObj = [];
    for (const o of this.docObjects) {
      if (o.kind !== 'point') continue;
      const col = layerColor(o.layerIndex);
      pp.push(o.point[0], o.point[1], o.point[2]);
      pc.push(col.r, col.g, col.b);
      ptObj.push(o.id);
    }
    if (pp.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(pc, 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({
        vertexColors: true, size: 6, sizeAttenuation: false,
      }));
      pts.userData = { docKind: 'point', ptObj };
      pts.renderOrder = 2;
      this.docGroup.add(pts);
      this.docPointObj = pts;
    }

    /* ---- meshes (one per object, so picking maps directly) ---- */
    for (const o of this.docObjects) {
      if (o.kind !== 'mesh') continue;
      const pos = [];
      for (const f of o.mesh.faces)
        for (const i of f) pos.push(o.mesh.vertices[i][0], o.mesh.vertices[i][1], o.mesh.vertices[i][2]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
        color: layerColor(o.layerIndex), side: THREE.DoubleSide,
        transparent: true, opacity: 0.75,
      }));
      m.userData = { docKind: 'mesh', objId: o.id };
      this.docGroup.add(m);
    }

    this.docGroup.visible = this.docVisible;
    this._applyLayerVisibility();
  }

  setDocVisible(on) {
    this.docVisible = !!on;
    this.docGroup.visible = this.docVisible;
  }

  setLayerVisible(layerIndex, on) {
    const L = this.docLayers.find(l => l.index === layerIndex);
    if (L) L.visible = !!on;
    this._applyLayerVisibility();
  }

  /** Hidden layers are collapsed to zero-length segments / off-screen points. */
  _applyLayerVisibility() {
    const hidden = new Set(this.docLayers.filter(l => l.visible === false).map(l => l.index));
    const objHidden = (id) => hidden.has(this.docObjects[id]?.layerIndex);
    if (this.docLineObj) {
      const { segObj } = this.docLineObj.userData;
      const posAttr = this.docLineObj.geometry.getAttribute('position');
      if (!this.docLineObj.userData.origPos) this.docLineObj.userData.origPos = posAttr.array.slice();
      const orig = this.docLineObj.userData.origPos;
      const arr = posAttr.array;
      for (let s = 0; s < segObj.length; s++) {
        const base = s * 6;
        if (objHidden(segObj[s])) {
          for (let k = 0; k < 6; k++) arr[base + k] = orig[base];   // degenerate → invisible
        } else {
          for (let k = 0; k < 6; k++) arr[base + k] = orig[base + k];
        }
      }
      posAttr.needsUpdate = true;
      this.docLineObj.geometry.computeBoundingSphere();
    }
    if (this.docPointObj) {
      const { ptObj } = this.docPointObj.userData;
      const posAttr = this.docPointObj.geometry.getAttribute('position');
      if (!this.docPointObj.userData.origPos) this.docPointObj.userData.origPos = posAttr.array.slice();
      const orig = this.docPointObj.userData.origPos;
      const arr = posAttr.array;
      for (let p = 0; p < ptObj.length; p++) {
        const h = objHidden(ptObj[p]);
        for (let k = 0; k < 3; k++) arr[p * 3 + k] = h ? NaN : orig[p * 3 + k];
      }
      posAttr.needsUpdate = true;
    }
    for (const child of this.docGroup.children) {
      if (child.userData && child.userData.docKind === 'mesh')
        child.visible = !objHidden(child.userData.objId);
    }
  }

  _initPicking() {
    const el = this.renderer.domElement;
    let downX = 0, downY = 0, downT = 0;
    el.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; downT = Date.now(); });
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved > 4 || Date.now() - downT > 600) return;   // orbiting, not clicking
      this._handleClick(e);
    });
  }

  _pickAt(clientX, clientY) {
    if (!this.docObjects.length) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.docGroup.children, false);
    const hiddenLayer = new Set(this.docLayers.filter(l => l.visible === false).map(l => l.index));
    for (const h of hits) {
      const ud = h.object.userData || {};
      let objId = null;
      if (ud.docKind === 'line') objId = ud.segObj[Math.floor(h.index / 2)];
      else if (ud.docKind === 'point') objId = ud.ptObj[h.index];
      else if (ud.docKind === 'mesh') objId = ud.objId;
      if (objId == null) continue;
      const o = this.docObjects[objId];
      if (!o || hiddenLayer.has(o.layerIndex)) continue;
      return o;
    }
    return null;
  }

  /** All doc objects on the same layer with the same kind as `o` (Rhino-ish group select). */
  _layerGroup(o) {
    return this.docObjects
      .filter(d => d.layerIndex === o.layerIndex && d.kind === o.kind)
      .map(d => d.id);
  }

  _handleClick(e) {
    const hit = this._pickAt(e.clientX, e.clientY);
    const ps = this.pickState;

    if (!ps) {
      // normal browsing: click selects the clicked object's layer group
      if (!hit) { this.selection.clear(); }
      else {
        const grp = this._layerGroup(hit);
        const already = grp.every(id => this.selection.has(id));
        if (!e.shiftKey) this.selection.clear();
        if (already && e.shiftKey) grp.forEach(id => this.selection.delete(id));
        else grp.forEach(id => this.selection.add(id));
      }
      this._applySelection();
      this.onSelectionChange([...this.selection]);
      return;
    }

    // active Set-Geometry pick
    if (!hit) return;
    if (ps.filter !== 'any' && hit.kind !== ps.filter) {
      ps.onStatus(`That is a ${hit.kind}; this input needs ${ps.filter} geometry.`);
      return;
    }
    if (ps.mode === 'one') {
      this.selection.clear();
      this.selection.add(hit.id);
      this._applySelection();
      ps.resolve(this._selectedObjects());
      this.endPick();
      return;
    }
    // multiple: clicking takes the whole layer group; Alt/Shift+click takes just
    // the clicked object (so a few base points can be picked out of a layer)
    const grp = (e.altKey || e.shiftKey) ? [hit.id] : this._layerGroup(hit);
    const all = grp.every(id => this.selection.has(id));
    if (all) grp.forEach(id => this.selection.delete(id));
    else grp.forEach(id => this.selection.add(id));
    this._applySelection();
    ps.onStatus(null);
    this.onSelectionChange([...this.selection]);
  }

  _selectedObjects() {
    return [...this.selection].map(id => this.docObjects[id]).filter(Boolean);
  }

  _applySelection() {
    const SEL = new THREE.Color(0xffe000);
    const layerColor = (li) => {
      const L = this.docLayers.find(l => l.index === li);
      let c = L ? L.color : 0x1a1a1a;
      if (c === 0xffffff) c = 0x2a2a2a;
      return new THREE.Color(c === 0 ? 0x1f1f1f : c);
    };
    if (this.docLineObj) {
      const { segObj } = this.docLineObj.userData;
      const colAttr = this.docLineObj.geometry.getAttribute('color');
      for (let s = 0; s < segObj.length; s++) {
        const o = this.docObjects[segObj[s]];
        const c = this.selection.has(segObj[s]) ? SEL : layerColor(o.layerIndex);
        colAttr.setXYZ(s * 2, c.r, c.g, c.b);
        colAttr.setXYZ(s * 2 + 1, c.r, c.g, c.b);
      }
      colAttr.needsUpdate = true;
    }
    if (this.docPointObj) {
      const { ptObj } = this.docPointObj.userData;
      const colAttr = this.docPointObj.geometry.getAttribute('color');
      for (let p = 0; p < ptObj.length; p++) {
        const o = this.docObjects[ptObj[p]];
        const c = this.selection.has(ptObj[p]) ? SEL : layerColor(o.layerIndex);
        colAttr.setXYZ(p, c.r, c.g, c.b);
      }
      colAttr.needsUpdate = true;
    }
    for (const child of this.docGroup.children) {
      if (child.userData && child.userData.docKind === 'mesh')
        child.material.color.set(this.selection.has(child.userData.objId)
          ? SEL : layerColor(this.docObjects[child.userData.objId].layerIndex));
    }
  }

  /**
   * Start a Set-Geometry pick session (Rhino-style "select objects" prompt).
   * @returns Promise<Array<docObject>|null>  null = cancelled
   */
  beginPick({ mode = 'multi', filter = 'any', onStatus = () => {} } = {}) {
    this.endPick(true);
    this.selection.clear();
    this._applySelection();
    // GH hides its own preview while you pick document geometry
    this.modelGroup.visible = false;
    this._pickDocWasVisible = this.docVisible;
    this.setDocVisible(true);
    return new Promise((resolve) => {
      this.pickState = { mode, filter, onStatus, resolve };
      this.renderer.domElement.style.cursor = 'crosshair';
    });
  }

  acceptPick() {
    if (!this.pickState) return;
    const sel = this._selectedObjects();
    const res = this.pickState.resolve;
    this.endPick();
    res(sel);
  }

  cancelPick() {
    if (!this.pickState) return;
    const res = this.pickState.resolve;
    this.selection.clear();
    this._applySelection();
    this.endPick();
    res(null);
  }

  endPick() {
    this.pickState = null;
    this.modelGroup.visible = true;
    if (this._pickDocWasVisible !== undefined) {
      this.setDocVisible(this._pickDocWasVisible);
      this._pickDocWasVisible = undefined;
    }
    this.renderer.domElement.style.cursor = '';
  }

  selectLayer(layerIndex, kind = null) {
    this.selection.clear();
    for (const o of this.docObjects)
      if (o.layerIndex === layerIndex && (!kind || o.kind === kind)) this.selection.add(o.id);
    this._applySelection();
    this.onSelectionChange([...this.selection]);
    return this._selectedObjects();
  }

  /* ------------- content ------------- */

  clear() {
    this.modelGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
    this.modelGroup.clear();
  }

  /**
   * @param views    list of {mode, analysis, model, defScale, colorMode} from ModelView/BeamView
   * @param previews list of raw geometry values (points/lines/models) from preview-enabled nodes
   */
  update(views, previews) {
    this.clear();
    let legend = null;

    // symbol scale ∝ model size (like Karamba's ModelView size sliders)
    const bb = new THREE.Box3();
    const bbp = (x, y, z) => bb.expandByPoint(new THREE.Vector3(x, y, z));
    for (const v of previews) {
      if (v && v.kind === 'line') { bbp(v.a.x, v.a.y, v.a.z); bbp(v.b.x, v.b.y, v.b.z); }
      else if (v && v.kind === 'point') bbp(v.x, v.y, v.z);
      else if (v && v.kind === 'mesh') for (const p of v.vertices) bbp(p[0], p[1], p[2]);
      else if (v && v.kind === 'cpreview') for (const it of v.items) {
        if (it.kind === 'line') { bbp(it.a.x, it.a.y, it.a.z); bbp(it.b.x, it.b.y, it.b.z); }
        else if (it.kind === 'point') bbp(it.x, it.y, it.z);
        else if (it.kind === 'mesh') for (const p of it.vertices) bbp(p[0], p[1], p[2]);
      }
    }
    for (const view of views) {
      const fem = view.model && view.model.fem;
      if (fem) for (const nd of fem.nodes) bbp(nd.x, nd.y, nd.z);
    }
    if (bb.isEmpty() && this.docDiag) bb.expandByPoint(new THREE.Vector3(this.docDiag, this.docDiag, this.docDiag));
    const diag = bb.isEmpty() ? 10 : bb.getSize(new THREE.Vector3()).length();
    this.symScale = Math.max(0.02, Math.min(diag * 0.022, 0.6));

    // raw geometry previews — GH-style maroon
    const previewMat = new THREE.LineBasicMaterial({ color: 0x8d2323 });
    const lineVerts = [];
    for (const v of previews) {
      if (v && v.kind === 'line') {
        lineVerts.push(v.a.x, v.a.y, v.a.z, v.b.x, v.b.y, v.b.z);
      } else if (v && v.kind === 'point') {
        const m = new THREE.Mesh(new THREE.SphereGeometry(this.symScale * 0.22, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0x8d2323 }));
        m.position.set(v.x, v.y, v.z);
        this.modelGroup.add(m);
      }
    }
    if (lineVerts.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
      this.modelGroup.add(new THREE.LineSegments(g, previewMat));
    }
    // mesh previews — GH-style shaded maroon-ish with wireframe
    for (const v of previews) {
      if (v && v.kind === 'mesh') this._drawMeshPreview(v);
    }
    // Custom Preview: geometry in a user colour
    for (const v of previews) {
      if (!v || v.kind !== 'cpreview') continue;
      const col = new THREE.Color(v.color);
      const cVerts = [];
      for (const it of v.items) {
        if (it.kind === 'line') cVerts.push(it.a.x, it.a.y, it.a.z, it.b.x, it.b.y, it.b.z);
        else if (it.kind === 'point') {
          const m = new THREE.Mesh(new THREE.SphereGeometry((this.symScale || 0.2) * 0.25, 8, 8),
            new THREE.MeshBasicMaterial({ color: col }));
          m.position.set(it.x, it.y, it.z);
          this.modelGroup.add(m);
        } else if (it.kind === 'mesh') {
          this._drawMeshPreview(it, col);
        }
      }
      if (cVerts.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(cVerts, 3));
        this.modelGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: col })));
      }
    }

    for (const view of views) {
      if (view.analysis) legend = this._drawAnalyzed(view) || legend;
      else if (view.model) this._drawModel(view.model, 0xbfbfbf);
    }

    this._updateLegend(legend);
  }

  _beamMesh(p0, p1, radius, color) {
    const dir = new THREE.Vector3(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z);
    const len = dir.length();
    if (len < 1e-9) return null;
    const geo = new THREE.CylinderGeometry(radius, radius, len, 8, 1);
    const mat = new THREE.MeshLambertMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, (p0.z + p1.z) / 2);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return mesh;
  }

  _drawMeshPreview(v, color) {
    const g = new THREE.BufferGeometry();
    const pos = [];
    for (const f of v.faces) {
      const tris = (f.length >= 4 && f[2] !== f[3])
        ? [[f[0], f[1], f[2]], [f[0], f[2], f[3]]] : [[f[0], f[1], f[2]]];
      for (const t of tris)
        for (const i of t) pos.push(v.vertices[i][0], v.vertices[i][1], v.vertices[i][2]);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
      color: color || 0xb05a5a, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
    this.modelGroup.add(mesh);
    const wf = new THREE.LineSegments(new THREE.WireframeGeometry(g),
      new THREE.LineBasicMaterial({ color: 0x5a2323, transparent: true, opacity: 0.3 }));
    this.modelGroup.add(wf);
  }

  _drawModel(model, color) {
    const fem = model.fem;
    if (!fem) return;
    for (const el of fem.elements) {
      const p0 = fem.nodes[el.n0], p1 = fem.nodes[el.n1];
      const r = this._radiusFor(el);
      const m = this._beamMesh(p0, p1, r, color);
      if (m) this.modelGroup.add(m);
    }
    if (fem.shells.length) {
      const pos = fem.nodes.map(n => [n.x, n.y, n.z]);
      this._drawShellTris(fem.shells.map(sh => ({ nodesIdx: [sh.n0, sh.n1, sh.n2] })),
        pos, null, 0, 0, () => new THREE.Color(color));
    }
    this._drawSupports(model, fem.nodes.map(n => [n.x, n.y, n.z]));
    this._drawLoads(model);
  }

  /** Draw shell triangles with per-face colors. colorFn(i) → THREE.Color */
  _drawShellTris(shellResults, nodePos, _a, _b, _c, colorFn) {
    const pos = [], col = [];
    shellResults.forEach((sr, i) => {
      const c = colorFn(i);
      for (const ni of sr.nodesIdx) {
        const p = nodePos[ni];
        pos.push(p[0], p[1], p[2]);
        col.push(c.r, c.g, c.b);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({
      vertexColors: true, side: THREE.DoubleSide }));
    this.modelGroup.add(mesh);
    const wf = new THREE.LineSegments(new THREE.WireframeGeometry(g),
      new THREE.LineBasicMaterial({ color: 0x222426, transparent: true, opacity: 0.18 }));
    this.modelGroup.add(wf);
  }

  _radiusFor(el) {
    const cs = el.crosec;
    if (!cs) return 0.05;
    if (cs.shape === 'circle') return Math.max(cs.d / 200, 0.02);       // cm→m
    return Math.max(Math.max(cs.h || 10, cs.b || 10) / 200, 0.02);
  }

  _drawAnalyzed(view) {
    const a = view.analysis;
    const fem = a.model;
    const scale = view.defScale ?? 1;

    // deformed node positions
    const defNodes = fem.nodes.map((n, i) => [
      n.x + a.disp[i].dx * scale,
      n.y + a.disp[i].dy * scale,
      n.z + a.disp[i].dz * scale,
    ]);

    // color range (beams + shells share one legend)
    const mode = view.colorMode || 'Utilization';
    const shellRes = a.shellResults || [];
    let values, shellValues = null, unit, lo, hi;
    if (mode === 'Displacement') {
      values = a.results.map(r => (a.disp[r.el.n0].mag + a.disp[r.el.n1].mag) / 2 * 100);
      shellValues = shellRes.map(sr =>
        sr.nodesIdx.reduce((s, ni) => s + a.disp[ni].mag, 0) / 3 * 100);
      unit = 'cm'; lo = 0; hi = Math.max(a.maxDisp * 100, 1e-9);
    } else if (mode === 'Axial Force') {
      values = a.results.map(r => r.N);
      unit = 'kN';
      const mx = Math.max(...values.map(Math.abs), 1e-9);
      lo = -mx; hi = mx;
    } else if (mode === 'Bending Moment') {
      values = a.results.map(r => Math.max(Math.abs(r.My[0]), Math.abs(r.My[1]), Math.abs(r.Mz[0]), Math.abs(r.Mz[1])));
      unit = 'kNm'; lo = 0; hi = Math.max(...values, 1e-9);
    } else {
      values = a.results.map(r => r.utilSigned * 100);
      shellValues = shellRes.map(sr => sr.util * 100);
      unit = '%';
      const mx = Math.max(...values.map(Math.abs), ...(shellValues || []).map(Math.abs), 1e-9);
      lo = -mx; hi = mx;
    }

    // ghost of undeformed geometry — skipped when the Rhino document geometry
    // is on screen (it already shows the undeformed model, like Rhino + GH)
    const showGhost = !(this.docVisible && this.docObjects.length);
    const ghostVerts = [];
    for (const el of fem.elements) {
      const p0 = fem.nodes[el.n0], p1 = fem.nodes[el.n1];
      ghostVerts.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    }
    for (const sh of fem.shells) {
      const p = [fem.nodes[sh.n0], fem.nodes[sh.n1], fem.nodes[sh.n2]];
      for (let i = 0; i < 3; i++) {
        const q = p[(i + 1) % 3];
        ghostVerts.push(p[i].x, p[i].y, p[i].z, q.x, q.y, q.z);
      }
    }
    if (showGhost && ghostVerts.length) {
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute(ghostVerts, 3));
      this.modelGroup.add(new THREE.LineSegments(gg,
        new THREE.LineBasicMaterial({ color: 0x606468, transparent: true, opacity: 0.35 })));
    }

    // deformed colored beams
    a.results.forEach((r, i) => {
      const el = r.el;
      const p0 = defNodes[el.n0], p1 = defNodes[el.n1];
      const t = (values[i] - lo) / (hi - lo || 1);
      const col = rainbow(t);
      const m = this._beamMesh(
        { x: p0[0], y: p0[1], z: p0[2] }, { x: p1[0], y: p1[1], z: p1[2] },
        this._radiusFor(el), col);
      if (m) this.modelGroup.add(m);
    });

    // deformed colored shells
    if (shellRes.length) {
      this._drawShellTris(shellRes, defNodes, null, 0, 0, (i) => {
        if (!shellValues) return new THREE.Color(0x9aa0a6); // mode not defined for shells
        return rainbow((shellValues[i] - lo) / (hi - lo || 1));
      });
    }

    this._drawSupports(view.model, defNodes);
    this._drawLoads(view.model);
    return { mode, unit, lo, hi };
  }

  _drawSupports(model, nodePos) {
    if (!model || !model.fem) return;
    const s0 = this.symScale || 0.2;
    for (const s of model.fem.supports) {
      const p = nodePos[s.node];
      if (!p) continue;
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(s0 * 0.9, s0 * 2, 4),
        new THREE.MeshLambertMaterial({ color: 0x2ea82e }));
      cone.position.set(p[0], p[1], p[2] - s0 * 1.1);
      cone.rotation.x = Math.PI / 2;
      cone.rotation.y = Math.PI / 4;
      this.modelGroup.add(cone);
      // fixed-rotation supports get a small ring
      if (s.fix[3] || s.fix[4] || s.fix[5]) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(s0 * 0.65, s0 * 0.12, 6, 16),
          new THREE.MeshLambertMaterial({ color: 0x1f7a1f }));
        ring.position.set(p[0], p[1], p[2] - s0 * 2.3);
        this.modelGroup.add(ring);
      }
    }
  }

  _drawLoads(model) {
    if (!model || !model.fem) return;
    const fem = model.fem;
    const s0 = this.symScale || 0.2;
    for (const pl of fem.pointLoads) {
      const n = fem.nodes[pl.node];
      if (!n) continue;
      const f = new THREE.Vector3(...pl.force);
      const mag = f.length();
      if (mag < 1e-9) continue;
      const len = Math.min(s0 * 1.6 + mag * 0.03 * s0, s0 * 10);
      const dir = f.clone().normalize();
      const origin = new THREE.Vector3(n.x, n.y, n.z).sub(dir.clone().multiplyScalar(len));
      const arrow = new THREE.ArrowHelper(dir, origin, len, 0xe8590c, len * 0.35, len * 0.16);
      this.modelGroup.add(arrow);
    }
    if (fem.gravity) {
      // gravity glyph floating above the model
      let zTop = 0, cx = 0, cy = 0;
      for (const nd of fem.nodes) { zTop = Math.max(zTop, nd.z); cx += nd.x; cy += nd.y; }
      cx /= Math.max(fem.nodes.length, 1); cy /= Math.max(fem.nodes.length, 1);
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(...fem.gravity.vec).normalize(),
        new THREE.Vector3(cx, cy, zTop + s0 * 5), s0 * 4, 0x9932cc, s0 * 1.4, s0 * 0.7);
      this.modelGroup.add(arrow);
    }
  }

  _updateLegend(legend) {
    if (!this.legendEl) return;
    if (!legend) { this.legendEl.style.display = 'none'; return; }
    this.legendEl.style.display = 'block';
    const ticks = 7;
    let rows = '';
    for (let i = 0; i < ticks; i++) {
      const t = 1 - i / (ticks - 1);
      const v = legend.lo + t * (legend.hi - legend.lo);
      rows += `<div class="legend-tick">${fmtLegend(v)}</div>`;
    }
    this.legendEl.innerHTML = `
      <div class="legend-title">${legend.mode} [${legend.unit}]</div>
      <div class="legend-body">
        <div class="legend-bar"></div>
        <div class="legend-ticks">${rows}</div>
      </div>`;
  }

  zoomExtents(views, previews) {
    const box = new THREE.Box3();
    let has = false;
    const scan = (root) => root.traverse(o => {
      if (o.geometry) {
        o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        if (bb && !bb.isEmpty() && isFinite(bb.min.x) && isFinite(bb.max.x)) {
          const b = bb.clone().applyMatrix4(o.matrixWorld);
          box.union(b); has = true;
        }
      }
    });
    if (this.modelGroup.visible) scan(this.modelGroup);
    if (this.docVisible) scan(this.docGroup);
    if (!has) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 10;
    this.controls.target.copy(c);
    const dir = new THREE.Vector3(1.1, -1, 0.65).normalize();
    this.camera.position.copy(c).add(dir.multiplyScalar(size * 1.1 + 2));
  }
}

function fmtLegend(v) {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
