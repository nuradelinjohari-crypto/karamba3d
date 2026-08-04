/**
 * io/ghimport.js — Grasshopper definition importer (.ghx XML archives).
 *
 * Reads a real Grasshopper file, maps its components (Karamba 2.x + common GH
 * natives) onto this replica's registry, restores slider values / panel text /
 * toggle states / persistent data, reconstructs the wires, and re-binds
 * referenced Rhino geometry to the model imported via File ▸ Import Model….
 *
 * Binary .gh files are the same archive serialized in GH_IO's binary format —
 * not parseable here; the importer detects them and asks for a .ghx re-save.
 */

/* ---------------- name → registry-type mapping ---------------- */

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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
  'loads': 'PointLoad',
  'beamloads': 'LineLoad',
  'lineload': 'LineLoad',
  'lineloadudl': 'LineLoad',
  'crosssection': 'CroSecCircle',
  'crosssectionselector': 'CroSecSelect',
  'crosssectionrangeselector': 'CroSecRange',
  'circularhollowprofile': 'CroSecCircle',
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
  'multiplication': 'Multiplication',
  'unitz': 'UnitZ',
  'vectorxyz': 'VectorXYZ',
  'custompreview': 'CustomPreview',
  'colourswatch': 'ColourSwatch',
  'colorswatch': 'ColourSwatch',
  // geometry containers → pass-through param bound to the imported model
  'point': 'GeoParam',
  'curve': 'GeoParam',
  'line': 'GeoParam',
  'geometry': 'GeoParam',
  'mesh': 'GeoParam',
  'brep': 'GeoParam',
}));

const POINTISH = new Set(['point']);
const MESHISH = new Set(['mesh']);

/* ---------------- ghx (XML) parsing ---------------- */

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

function chunksOf(el) {
  const out = [];
  for (const c of el.children) {
    if (c.tagName !== 'chunks') continue;
    for (const ch of c.children) out.push(ch);
  }
  return out;
}

function txt(item) { return item ? item.textContent.trim() : null; }
function numOf(item, fb = 0) { const v = parseFloat(txt(item)); return isNaN(v) ? fb : v; }

function pivotOf(container) {
  // Attributes → Pivot {X,Y} (or Bounds fallback)
  for (const ch of allChunks(container)) {
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

function* allChunks(el) {
  for (const ch of chunksOf(el)) {
    yield ch;
    yield* allChunks(ch);
  }
}

/** Extract persistent data values from a param chunk (typed leaf items). */
function persistentValues(paramChunk) {
  const vals = [];
  let referenced = 0;
  for (const ch of allChunks(paramChunk)) {
    if (!/persistentdata|branch/i.test(ch.getAttribute('name') || '')) continue;
    for (const itemsEl of ch.children) {
      if (itemsEl.tagName !== 'items') continue;
      for (const item of itemsEl.children) {
        const t = item.getAttribute('type_name') || '';
        if (/gh_double|gh_single/.test(t)) vals.push(parseFloat(item.textContent));
        else if (/gh_int/.test(t)) vals.push(parseInt(item.textContent));
        else if (/gh_bool/.test(t)) vals.push(item.textContent.trim() === 'true');
        else if (/gh_string/.test(t)) vals.push(item.textContent);
        else if (/gh_point3d|gh_vector3d/.test(t)) {
          const g = (s) => parseFloat(item.querySelector(s)?.textContent || 0);
          const v = { x: g('X'), y: g('Y'), z: g('Z') };
          vals.push(/vector/.test(t) ? { kind: 'vector', ...v } : { kind: 'point', ...v });
        } else if (/gh_line/.test(t)) {
          const g = (s) => parseFloat(item.querySelector(s)?.textContent || 0);
          vals.push({
            kind: 'line',
            a: { kind: 'point', x: g('Ax'), y: g('Ay'), z: g('Az') },
            b: { kind: 'point', x: g('Bx'), y: g('By'), z: g('Bz') },
          });
        } else if (/gh_guid/.test(t) && item.getAttribute('name') !== 'Source') {
          referenced++; // referenced Rhino geometry — must be re-bound to the import
        }
      }
    }
  }
  return { vals, referenced };
}

function parseParamChunk(ch) {
  const its = itemsOf(ch);
  const sources = [];
  for (const itemsEl of ch.children) {
    if (itemsEl.tagName !== 'items') continue;
    for (const item of itemsEl.children) {
      if (item.getAttribute('name') === 'Source') sources.push(item.textContent.trim());
    }
  }
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

/**
 * Parse a .ghx document into a neutral object list.
 * @returns {objects: [{typeName, instanceGuid, pivot, inputs[], outputs[], slider, panelText, toggleValue, selfParam}], warnings}
 */
export function parseGHX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('not valid Grasshopper XML (.ghx)');
  const objects = [];
  const warnings = [];

  for (const objChunk of doc.querySelectorAll('chunk[name="Object"]')) {
    const objItems = itemsOf(objChunk);
    let typeName = txt(objItems['Name']) || '';
    const container = [...allChunks(objChunk)].find(c => c.getAttribute('name') === 'Container');
    if (!container) continue;
    const cItems = itemsOf(container);
    typeName = txt(cItems['Name']) || typeName;
    const instanceGuid = txt(cItems['InstanceGuid']);
    const pivot = pivotOf(container);

    const inputs = [], outputs = [];
    for (const ch of allChunks(container)) {
      const nm = ch.getAttribute('name') || '';
      if (/^param_input$|^InputParam$/i.test(nm)) inputs.push(parseParamChunk(ch));
      else if (/^param_output$|^OutputParam$/i.test(nm)) outputs.push(parseParamChunk(ch));
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

    // panel text
    const panelText = txt(cItems['UserText']);

    // toggle / persistent bool value directly on container
    let toggleValue = null;
    if (cItems['Value'] && /gh_bool/.test(cItems['Value'].getAttribute('type_name') || ''))
      toggleValue = txt(cItems['Value']) === 'true';

    // standalone params carry sources / persistent data on the container itself
    const selfParam = parseParamChunk(container);

    objects.push({ typeName, instanceGuid, pivot, inputs, outputs, slider, panelText, toggleValue, selfParam });
  }

  if (!objects.length) warnings.push('No components found — is this a Grasshopper .ghx file?');
  return { objects, warnings };
}

/* ---------------- build the graph in the engine ---------------- */

function matchPort(ghName, ghNick, ports) {
  const gn = norm(ghName), gk = norm(ghNick);
  let best = -1, bestScore = 0;
  ports.forEach((p, i) => {
    const pn = norm(p.name), pk = norm(p.nick);
    let score = 0;
    if (gn && (gn === pn || gn === pk)) score = 5;
    else if (gk && (gk === pn || gk === pk)) score = 4;
    else if (gn && pn && (pn.startsWith(gn.slice(0, 4)) || gn.startsWith(pn.slice(0, 4)))) score = 3;
    else if (gn && pn && (pn.includes(gn) || gn.includes(pn))) score = 2;
    else if (gk && pk && (pk.includes(gk) || gk.includes(pk))) score = 1;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/**
 * Instantiate a parsed GH definition into the engine.
 * Returns a report {mapped, unsupported: [names], wires, rebound}.
 */
export function buildGraph(engine, parsed, options = {}) {
  const report = { mapped: 0, unsupported: [], wires: 0, rebound: 0, sliders: 0 };
  engine.nodes = []; engine.wires = []; engine.selection.clear();

  // normalize positions
  const pivots = parsed.objects.map(o => o.pivot).filter(Boolean);
  const minX = pivots.length ? Math.min(...pivots.map(p => p.x)) : 0;
  const minY = pivots.length ? Math.min(...pivots.map(p => p.y)) : 0;

  const byGuid = new Map();   // param/instance guid → {node, port}
  const built = [];

  parsed.objects.forEach((o, idx) => {
    const key = norm(o.typeName);
    let type = NAME_MAP.get(key);
    const x = o.pivot ? (o.pivot.x - minX) + 40 : 40 + (idx % 6) * 190;
    const y = o.pivot ? (o.pivot.y - minY) + 40 : 40 + Math.floor(idx / 6) * 110;

    let state = {};
    if (type === 'NumberSlider' && o.slider) {
      const step = Math.pow(10, -Math.min(o.slider.digits ?? 2, 4));
      state = { name: o.selfParam.nick || 'Slider', min: o.slider.min, max: o.slider.max, value: o.slider.value, step };
      report.sliders++;
    }
    if (type === 'Panel') state = { text: o.panelText || '', w: 130, h: 84 };
    if (type === 'BooleanToggle' && o.toggleValue != null) state = { name: o.selfParam.nick || 'Toggle', value: o.toggleValue };
    if (type === 'GeoParam') state = { paramKind: key, origName: o.typeName };
    if (!type) {
      type = 'Unsupported';
      state = { origName: o.typeName || 'unknown' };
      report.unsupported.push(o.typeName || 'unknown');
    } else {
      report.mapped++;
    }

    const node = engine.addNode(type, x, y, state);
    if (!node) return;
    built.push({ o, node, type });

    // register guids
    if (o.instanceGuid) byGuid.set(o.instanceGuid, { node, port: 0, isOutput: true });
    o.outputs.forEach((p) => {
      const pi = matchPort(p.name, p.nick, node.outputs);
      if (p.guid) byGuid.set(p.guid, { node, port: pi >= 0 ? pi : 0, isOutput: true });
    });
  });

  // wires + persistent data
  for (const { o, node, type } of built) {
    const wireInput = (ghParam, portIdx) => {
      if (portIdx < 0 || portIdx >= node.inputs.length) portIdx = Math.min(Math.max(portIdx, 0), node.inputs.length - 1);
      for (const src of ghParam.sources) {
        const from = byGuid.get(src);
        if (from) {
          engine.wires.push({ from: { node: from.node, port: from.port }, to: { node, port: portIdx } });
          report.wires++;
        }
      }
      if (!ghParam.sources.length && ghParam.persist.length) {
        node.state.__persist = node.state.__persist || {};
        node.state.__persist[portIdx] = ghParam.persist;
      }
      if (ghParam.referenced) node._hasReferenced = true;
    };
    if (o.inputs.length) {
      o.inputs.forEach((p, i) => {
        let pi = matchPort(p.name, p.nick, node.inputs);
        if (pi < 0) pi = Math.min(i, node.inputs.length - 1);
        if (node.inputs.length) wireInput(p, pi);
      });
    } else if (node.inputs.length && (o.selfParam.sources.length || o.selfParam.persist.length || o.selfParam.referenced)) {
      wireInput(o.selfParam, 0);
    }
    void type;
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

    for (const n of [...engine.nodes]) {
      if (n.type === 'GeoParam' && !hasWire(n, 0) && !hasPersist(n, 0)) {
        const kind = n.state.paramKind || '';
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
    // supports with nothing to stand on → bottom points of the first LineToBeam
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
