/**
 * io/ghimport.js — Grasshopper definition importer (.ghx XML archives).
 *
 * Reads a real Grasshopper file, maps its components (Karamba 2.x + common GH
 * natives) onto this replica's registry, restores slider values / panel text /
 * toggle states / Support DOF checkboxes / persistent data, reconstructs the
 * wires, and re-binds referenced Rhino geometry to the model imported via
 * File ▸ Import Model….
 *
 * Format notes (verified against real Karamba 2.x ghx files):
 *  - Karamba components are named "… (Karamba3D)", sometimes with a leading space.
 *  - Karamba "GUI components" (Loads, Cross Section, Line to Beam…) carry an
 *    ActiveUnit → unitname (the dropdown mode) and per-mode params in
 *    EvalUnits → unit → params → input/output → chunk "p".
 *  - Support's 6 DOF checkboxes live in RadioButtonGroup → Active → "button" items.
 *  - GH native components keep params in ParameterData → InputParam/OutputParam;
 *    older/parametric ones use param_input/param_output at Container level.
 *  - Persistent values sit deep inside PersistentData → Branch → Item chunks.
 *
 * Binary .gh files are the same archive in GH_IO's binary serialization —
 * not parseable here; the caller detects them and asks for a .ghx re-save.
 */

/* ---------------- name → registry-type mapping ---------------- */

const norm = (s) => (s || '')
  .toLowerCase()
  .replace(/\(karamba3d\)/g, '')
  .replace(/[^a-z0-9|]/g, '');

const NAME_MAP = new Map(Object.entries({
  // Karamba3D
  'linetobeam': 'LineToBeam',
  'linetotruss': 'LineToBeam',
  'meshtoshell': 'MeshToShell',
  'support': 'Support',
  'supports': 'Support',
  'assemblemodel': 'Assemble',
  'assemble': 'Assemble',
  'disassemblemodel': 'Disassemble',
  'disassemble': 'Disassemble',
  'analyze': 'AnalyzeThI',
  'analyzethi': 'AnalyzeThI',
  'analyzeth1': 'AnalyzeThI',
  'gravity': 'Gravity',
  'pointload': 'PointLoad',
  'loads': '@LOADS',                 // resolved via ActiveUnit
  'beamloads': '@LOADS',
  'lineload': 'LineLoad',
  'lineloadudl': 'LineLoad',
  'crosssection': '@CROSEC',         // resolved via ActiveUnit
  'crosssectionselector': 'CroSecSelect',
  'crosssectionrangeselector': 'CroSecRange',
  'circularhollowprofile': 'CroSecCircle',
  'tubeprofile': 'CroSecCircle',
  'boxprofile': 'CroSecRect',
  'trapezoidprofile': 'CroSecRect',
  'iprofile': 'CroSecI',
  'shellconst': 'ShellConst',
  'shellcrosssection': 'ShellConst',
  'materialselection': 'MatSelect',
  'materialselect': 'MatSelect',
  'matselect': 'MatSelect',
  'materialproperties': 'MatProps',
  'optimizecrosssection': 'OptiCroSec',
  'modelview': 'ModelView',
  'beamview': 'BeamView',
  'shellview': 'BeamView',
  'nodaldisplacements': 'NodalDisp',
  'reactionforces': 'ReactionForces',
  'utilizationofelements': 'Utilization',
  'utilization': 'Utilization',
  'beamresultantforces': 'BeamForces',
  'beamforces': 'BeamForces',
  // GH natives
  'numberslider': 'NumberSlider',
  'panel': 'Panel',
  'booleantoggle': 'BooleanToggle',
  'constructpoint': 'ConstructPoint',
  'series': 'Series',
  'addition': 'Addition',
  'subtraction': 'Subtraction',
  'multiplication': 'Multiplication',
  'division': 'Division',
  'negative': 'Negative',
  'deconstruct': 'Deconstruct',
  'deconstructpoint': 'Deconstruct',
  'move': 'Move',
  'explode': 'Explode',
  'listitem': 'ListItem',
  'polylinecomp': 'PolyLineComp',
  'unitz': 'UnitZ',
  'vectorxyz': 'VectorXYZ',
  'custompreview': 'CustomPreview',
  'colourswatch': 'ColourSwatch',
  'colorswatch': 'ColourSwatch',
  // geometry containers → pass-through param bound to the imported model
  'point': 'GeoParam',
  'curve': 'GeoParam',
  'line': 'GeoParam',
  'polyline': 'GeoParam',
  'geometry': 'GeoParam',
  'mesh': 'GeoParam',
  'brep': 'GeoParam',
}));

// canvas annotations / no-op display objects — silently skipped (not "unsupported")
const SKIP_TYPES = new Set(['group', 'legend', 'sketch', 'cluster']);

const POINTISH = new Set(['point']);
const MESHISH = new Set(['mesh']);

/* ---------------- ghx (XML) helpers ---------------- */

function itemsOf(el) {
  const out = {};
  for (const it of el.children) {
    if (it.tagName !== 'items') continue;
    for (const item of it.children) {
      const nm = item.getAttribute('name');
      if (!(nm in out)) out[nm] = item;
    }
  }
  return out;
}

function itemList(el, name) {
  const out = [];
  for (const it of el.children) {
    if (it.tagName !== 'items') continue;
    for (const item of it.children)
      if (item.getAttribute('name') === name) out.push(item);
  }
  return out;
}

function chunksOf(el) {
  const out = [];
  for (const c of el.children) {
    if (c.tagName !== 'chunks') continue;
    for (const ch of c.children) out.push(ch);
  }
  return out;
}

function* allChunks(el) {
  for (const ch of chunksOf(el)) {
    yield ch;
    yield* allChunks(ch);
  }
}

function txt(item) { return item ? item.textContent.trim() : null; }
function numOf(item, fb = 0) { const v = parseFloat(txt(item)); return isNaN(v) ? fb : v; }

function pivotOf(container) {
  for (const ch of chunksOf(container)) {
    if (ch.getAttribute('name') !== 'Attributes') continue;
    const its = itemsOf(ch);
    const piv = its['Pivot'] || its['Bounds'];
    if (piv) {
      const X = piv.querySelector('X'), Y = piv.querySelector('Y');
      if (X && Y) return { x: parseFloat(X.textContent), y: parseFloat(Y.textContent) };
    }
  }
  return null;
}

/** Extract persistent values from a param chunk — walks every descendant item. */
function persistentValues(paramChunk) {
  const vals = [];
  let referenced = 0;
  const pd = [...allChunks(paramChunk)].filter(c => (c.getAttribute('name') || '') === 'PersistentData');
  for (const root of pd) {
    const visit = (el) => {
      for (const itemsEl of el.children) {
        if (itemsEl.tagName === 'chunks') { for (const c of itemsEl.children) visit(c); continue; }
        if (itemsEl.tagName !== 'items') continue;
        for (const item of itemsEl.children) {
          const t = item.getAttribute('type_name') || '';
          const nm = item.getAttribute('name') || '';
          if (/count|path/i.test(nm)) continue;
          if (/gh_double|gh_single/.test(t)) vals.push(parseFloat(item.textContent));
          else if (/gh_int/.test(t)) vals.push(parseInt(item.textContent));
          else if (/gh_bool/.test(t)) { if (!/null/i.test(nm)) vals.push(item.textContent.trim() === 'true'); }
          else if (/gh_string/.test(t)) vals.push(item.textContent);
          else if (/gh_point3d|gh_vector3d/.test(t)) {
            const g = (s) => parseFloat(item.querySelector(s)?.textContent || 0);
            const v = { x: g('X'), y: g('Y'), z: g('Z') };
            // Karamba/GH store vectors as gh_point3d items named "vector"
            vals.push((/vector/.test(t) || /vector/i.test(nm)) ? { kind: 'vector', ...v } : { kind: 'point', ...v });
          } else if (/gh_line/.test(t)) {
            const g = (s) => parseFloat(item.querySelector(s)?.textContent || 0);
            vals.push({
              kind: 'line',
              a: { kind: 'point', x: g('Ax'), y: g('Ay'), z: g('Az') },
              b: { kind: 'point', x: g('Bx'), y: g('By'), z: g('Bz') },
            });
          } else if (/gh_guid/.test(t) && nm !== 'Source') {
            referenced++; // referenced Rhino geometry — must be re-bound to the import
          }
        }
      }
    };
    visit(root);
  }
  return { vals, referenced };
}

function parseParamChunk(ch) {
  const its = itemsOf(ch);
  const sources = itemList(ch, 'Source').map(i => i.textContent.trim());
  const { vals, referenced } = persistentValues(ch);
  return {
    guid: txt(its['InstanceGuid']),
    name: txt(its['Name']) || '',
    nick: txt(its['NickName']) || '',
    sources,
    persist: vals,
    referenced,
  };
}

/* ---------------- parse ---------------- */

export function parseGHX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('not valid Grasshopper XML (.ghx)');
  const objects = [];
  const warnings = [];

  for (const objChunk of doc.querySelectorAll('chunk[name="Object"]')) {
    const objItems = itemsOf(objChunk);
    let typeName = txt(objItems['Name']) || '';
    const container = chunksOf(objChunk).find(c => c.getAttribute('name') === 'Container');
    if (!container) continue;
    const cItems = itemsOf(container);
    typeName = txt(cItems['Name']) || typeName;
    const instanceGuid = txt(cItems['InstanceGuid']);
    const pivot = pivotOf(container);

    const inputs = [], outputs = [];
    const seenGuids = new Set();
    const pushParam = (arr, p) => {
      if (p.guid && seenGuids.has(p.guid)) return;
      if (p.guid) seenGuids.add(p.guid);
      arr.push(p);
    };

    // container-level & ParameterData params
    for (const ch of allChunks(container)) {
      const nm = ch.getAttribute('name') || '';
      if (/^param_input$|^InputParam$/i.test(nm)) pushParam(inputs, parseParamChunk(ch));
      else if (/^param_output$|^OutputParam$/i.test(nm)) pushParam(outputs, parseParamChunk(ch));
    }

    // Karamba GUI components: ActiveUnit + EvalUnits → unit → params → input/output → "p"
    let activeUnit = null;
    for (const ch of chunksOf(container)) {
      if (ch.getAttribute('name') === 'ActiveUnit') activeUnit = txt(itemsOf(ch)['unitname']);
    }
    if (activeUnit) {
      for (const ch of allChunks(container)) {
        if (ch.getAttribute('name') !== 'unit') continue;
        if (txt(itemsOf(ch)['name']) !== activeUnit) continue;
        for (const pch of allChunks(ch)) {
          if (pch.getAttribute('name') !== 'p') continue;
          // classify by ancestor chunk: input vs output
          let anc = pch.parentElement;
          let side = null;
          while (anc && anc !== ch) {
            const an = anc.getAttribute && anc.getAttribute('name');
            if (an === 'input') { side = 'in'; break; }
            if (an === 'output') { side = 'out'; break; }
            anc = anc.parentElement;
          }
          const p = parseParamChunk(pch);
          if (side === 'out') pushParam(outputs, p);
          else pushParam(inputs, p);
        }
      }
    }

    // Support DOF checkboxes: RadioButtonGroup → Active → button bools
    let dofButtons = null;
    for (const ch of allChunks(container)) {
      if (ch.getAttribute('name') !== 'Active') continue;
      const btns = itemList(ch, 'button').map(i => i.textContent.trim() === 'true');
      if (btns.length === 6) dofButtons = btns;
    }

    // slider state
    let slider = null;
    for (const ch of allChunks(container)) {
      if ((ch.getAttribute('name') || '') !== 'Slider') continue;
      const s = itemsOf(ch);
      slider = {
        min: numOf(s['Min'], 0), max: numOf(s['Max'], 10),
        value: numOf(s['Value'], 5), digits: numOf(s['Digits'], 2),
      };
    }

    const panelText = txt(cItems['UserText']);
    const scribble = txt(cItems['Text']);      // Scribble stores its note in "Text"
    const scribbleSize = numOf(cItems['Size'], 12);

    let toggleValue = null;
    if (cItems['Value'] && /gh_bool/.test(cItems['Value'].getAttribute('type_name') || ''))
      toggleValue = txt(cItems['Value']) === 'true';

    const selfParam = parseParamChunk(container);

    objects.push({
      typeName, instanceGuid, pivot, inputs, outputs, slider,
      panelText, scribble, scribbleSize, toggleValue, selfParam,
      activeUnit, dofButtons,
      nickName: txt(cItems['NickName']) || '',
    });
  }

  if (!objects.length) warnings.push('No components found — is this a Grasshopper .ghx file?');
  return { objects, warnings };
}

/* ---------------- type resolution (incl. GUI-component modes) ---------------- */

function resolveType(o, report) {
  const key = norm(o.typeName);
  if (SKIP_TYPES.has(key)) return null;                       // annotation — skip silently
  if (key === 'scribble') return 'Panel';                     // note → text panel

  // GH name collisions: "Line" / "PolyLine" are both a param container AND a
  // constructor component — the component variant has its own input params.
  if (key === 'line' && o.inputs.length >= 2) return 'Line';
  if (key === 'polyline' && o.inputs.length >= 1) return 'PolyLineComp';

  let type = NAME_MAP.get(key);
  const unit = norm(o.activeUnit || '');

  if (type === '@LOADS') {
    if (unit.includes('gravity')) type = 'Gravity';
    else if (unit.startsWith('point')) type = 'PointLoad';
    else if (unit.includes('line') || unit.includes('block') || unit.includes('distributed')) type = 'LineLoad';
    else { report.unsupported.push(`Loads: ${o.activeUnit || 'unknown mode'}`); return 'Unsupported'; }
  }
  if (type === '@CROSEC') {
    if (unit.includes('circle') || unit.includes('tube') || unit.includes('hollow')) type = 'CroSecCircle';
    else if (unit.includes('i') && unit.includes('profile')) type = 'CroSecI';
    else type = 'CroSecRect';   // trapezoid / box / default
  }
  return type;
}

/* ---------------- build ---------------- */

function matchPort(ghName, ghNick, ports) {
  const gn = norm(ghName), gk = norm(ghNick);
  let best = -1, bestScore = 0;
  ports.forEach((p, i) => {
    const pn = norm(p.name), pk = norm(p.nick);
    let score = 0;
    if (gn && (gn === pn || gn === pk)) score = 5;
    else if (gk && (gk === pn || gk === pk)) score = 4;
    else if (gn && pn && gn.length >= 3 && pn.length >= 3 && (pn.startsWith(gn.slice(0, 4)) || gn.startsWith(pn.slice(0, 4)))) score = 3;
    else if (gn && pn && (pn.includes(gn) || gn.includes(pn))) score = 2;
    else if (gk && pk && gk.length >= 2 && (pk.includes(gk) || gk.includes(pk))) score = 1;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

export function buildGraph(engine, parsed, options = {}) {
  const report = { mapped: 0, unsupported: [], skipped: 0, wires: 0, dropped: 0, rebound: 0, sliders: 0 };
  engine.nodes = []; engine.wires = []; engine.selection.clear();

  const pivots = parsed.objects.map(o => o.pivot).filter(Boolean);
  const minX = pivots.length ? Math.min(...pivots.map(p => p.x)) : 0;
  const minY = pivots.length ? Math.min(...pivots.map(p => p.y)) : 0;

  const byGuid = new Map();
  const built = [];

  parsed.objects.forEach((o, idx) => {
    let type = resolveType(o, report);
    if (type === null) { report.skipped++; return; }
    const x = o.pivot ? (o.pivot.x - minX) + 40 : 40 + (idx % 6) * 190;
    const y = o.pivot ? (o.pivot.y - minY) + 40 : 40 + Math.floor(idx / 6) * 110;

    let state = {};
    if (type === 'NumberSlider' && o.slider) {
      const step = Math.pow(10, -Math.min(o.slider.digits ?? 2, 4));
      state = { name: o.nickName || 'Slider', min: o.slider.min, max: o.slider.max, value: o.slider.value, step };
      report.sliders++;
    }
    if (type === 'Panel') {
      const isScribble = norm(o.typeName) === 'scribble';
      const text = isScribble ? (o.scribble || '') : (o.panelText || '');
      const fontSize = isScribble ? Math.min(Math.max(Math.round(o.scribbleSize * 0.55), 9), 16) : 9;
      const lines = text.split('\n');
      const w = Math.max(120, Math.min(300, 12 + (fontSize * 0.62) * Math.max(...lines.map(l => l.length), 8)));
      state = {
        text, w, h: Math.max(50, 20 + lines.length * (fontSize + 3)), fontSize,
        color: isScribble ? '#efece2' : '#fff9bd',
      };
    }
    if (type === 'BooleanToggle' && o.toggleValue != null) state = { name: o.nickName || 'Toggle', value: o.toggleValue };
    if (type === 'GeoParam') state = { paramKind: norm(o.typeName), origName: o.typeName };
    if (type === 'Support' && o.dofButtons) state = { fix: o.dofButtons };
    if (!type) {
      type = 'Unsupported';
      state = { origName: o.typeName || 'unknown' };
      report.unsupported.push(o.typeName || 'unknown');
    } else if (type === 'Unsupported') {
      state = { origName: `${o.typeName}${o.activeUnit ? ' ▸ ' + o.activeUnit : ''}` };
    } else {
      report.mapped++;
    }

    const node = engine.addNode(type, x, y, state);
    if (!node) return;
    built.push({ o, node, type });

    if (o.instanceGuid) byGuid.set(o.instanceGuid, { node, port: 0 });
    o.outputs.forEach((p, i) => {
      let pi = matchPort(p.name, p.nick, node.outputs);
      if (pi < 0) pi = Math.min(i, Math.max(node.outputs.length - 1, 0));
      if (p.guid) byGuid.set(p.guid, { node, port: pi });
    });
  });

  /* ---- wires + persistent data ---- */
  for (const { o, node } of built) {
    const applyParam = (ghParam, portIdx, matched) => {
      for (const src of ghParam.sources) {
        const from = byGuid.get(src);
        if (from && matched) {
          engine.wires.push({ from: { node: from.node, port: from.port }, to: { node, port: portIdx } });
          report.wires++;
        } else if (from && !matched) {
          report.dropped++;
        }
      }
      if (matched && !ghParam.sources.length && ghParam.persist.length) {
        node.state.__persist = node.state.__persist || {};
        node.state.__persist[portIdx] = ghParam.persist;
      }
      if (ghParam.referenced) node._hasReferenced = true;
    };
    if (o.inputs.length && node.inputs.length) {
      o.inputs.forEach((p, i) => {
        let pi = matchPort(p.name, p.nick, node.inputs);
        let matched = pi >= 0;
        if (!matched && node.inputs.length === 1 && o.inputs.length === 1) { pi = 0; matched = true; }
        if (!matched && node.type === 'Unsupported') { pi = 0; matched = true; }
        applyParam(p, Math.max(pi, 0), matched);
      });
    } else if (node.inputs.length && (o.selfParam.sources.length || o.selfParam.persist.length || o.selfParam.referenced)) {
      applyParam(o.selfParam, 0, true);
    }
  }

  /* ---- re-bind geometry to the imported .3dm model ---- */
  if (options.bindImport !== false) {
    const hasWire = (n, port) => engine.wires.some(w => w.to.node === n && w.to.port === port);
    const hasPersist = (n, port) => n.state.__persist && n.state.__persist[port] && n.state.__persist[port].length;
    let importNode = null;
    const getImport = () => {
      if (!importNode) {
        importNode = engine.nodes.find(n => n.type === 'ImportGeometry')
          || engine.addNode('ImportGeometry', -180, 40);
        importNode.previewOff = true;
      }
      return importNode;
    };
    const IMP_OUT = { lines: 0, points: 1, mesh: 2 };

    const ltobEarly = engine.nodes.find(n => n.type === 'LineToBeam');
    for (const n of [...engine.nodes]) {
      if (n.type === 'GeoParam' && !hasWire(n, 0) && !hasPersist(n, 0)) {
        const kind = n.state.paramKind || '';
        // point params that ONLY feed Support components must lie on the
        // structure — take the structure's bottom nodes, not the raw import
        // (support points are often doc-referenced while lines are internalized)
        const consumers = engine.wires.filter(w => w.from.node === n).map(w => w.to.node);
        if (POINTISH.has(kind) && consumers.length && consumers.every(c => c.type === 'Support') && ltobEarly) {
          const bot = engine.addNode('BottomPoints', n.x - 150, n.y + 40);
          engine.wires.push({ from: { node: ltobEarly, port: 1 }, to: { node: bot, port: 0 } });
          engine.wires.push({ from: { node: bot, port: 0 }, to: { node: n, port: 0 } });
          report.rebound++;
          continue;
        }
        const out = POINTISH.has(kind) ? IMP_OUT.points : MESHISH.has(kind) ? IMP_OUT.mesh : IMP_OUT.lines;
        engine.wires.push({ from: { node: getImport(), port: out }, to: { node: n, port: 0 } });
        report.rebound++;
      }
      if (n.type === 'LineToBeam' && !hasWire(n, 0) && !hasPersist(n, 0)) {
        engine.wires.push({ from: { node: getImport(), port: IMP_OUT.lines }, to: { node: n, port: 0 } });
        report.rebound++;
      }
      if (n.type === 'MeshToShell' && !hasWire(n, 0) && !hasPersist(n, 0)) {
        engine.wires.push({ from: { node: getImport(), port: IMP_OUT.mesh }, to: { node: n, port: 0 } });
        report.rebound++;
      }
    }
    const ltob = engine.nodes.find(n => n.type === 'LineToBeam');
    for (const n of engine.nodes) {
      if (n.type === 'Support' && !hasWire(n, 0) && !hasPersist(n, 0) && ltob) {
        const bot = engine.addNode('BottomPoints', n.x - 170, n.y + 10);
        engine.wires.push({ from: { node: ltob, port: 1 }, to: { node: bot, port: 0 } });
        engine.wires.push({ from: { node: bot, port: 0 }, to: { node: n, port: 0 } });
        report.rebound++;
      }
    }
  }

  for (const n of engine.nodes) n.dirty = true;
  engine.scheduleSolve();
  return report;
}
