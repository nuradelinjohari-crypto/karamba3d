# karamba3d — web replica

An educational, browser-native replica of **[Karamba3D](https://karamba3d.com/)**, the parametric
structural engineering plugin for Grasshopper / Rhino — rebuilt from scratch as a static web app.

**Left half of the screen:** a faithful Grasshopper canvas — components, wires, sliders,
panels, the double-click search popup, the ribbon with a *Karamba3D* tab.
**Right half:** a Rhino-style perspective viewport showing the live structural analysis
result: deformed geometry, rainbow utilization/displacement coloring, support cones,
load arrows and the Karamba HUD legend.

![workflow](https://img.shields.io/badge/workflow-LtoB%20%E2%86%92%20Assemble%20%E2%86%92%20Analyze%20Th.I%20%E2%86%92%20BeamView-d0021b)

## Run it

No build step. Serve the folder with any static server:

```bash
cd karamba3d
python3 -m http.server 8642
# open http://localhost:8642
```

## What's inside

| Piece | File | What it replicates |
|---|---|---|
| GH node editor | `js/graph/engine.js` | Canvas, wires (fancy-wire list rendering), sliders, panels, toggles, search popup, box select, pan/zoom |
| Karamba components | `js/graph/components.js` | Line To Beam, **Mesh To Shell**, Support (6-DOF checkboxes), Point-Load, **Line-Load (UDL)**, Gravity, Cross Sections (Rect / CHS / I / Selector / **Range Selector** / **Shell Const**), Material Selection (S235 default), Assemble Model, Analyze Th.I, **Optimize Cross Section**, Disassemble, ModelView, BeamView, Nodal Displacements, Reaction Forces, Utilization, Beam Resultant Forces |
| FEM solver | `js/fem/solver.js` | Linear-elastic first-order (Th.I) analysis: Euler-Bernoulli 3D beams (12×12 stiffness) **+ flat triangular shells (CST membrane + DKT plate bending, Batoz)**, 6 DOF/node, supports, point loads, **uniform line loads via fixed-end forces**, gravity, LDLᵀ solve, member forces, σ/fy & von-Mises utilization, reactions, mass. Validated against closed-form beam/plate solutions (see `scratchpad` tests) |
| Cross-section optimizer | `js/fem/solver.js` | Karamba's OptiCroSec loop: analyze → re-size each member to the lightest catalogue section with util ≤ target → re-analyze until stable |
| Rhino viewport | `js/viewport/viewport.js` | Perspective view, grid + axes, world-axes icon, shaded display, deformed beams **and shells**, rainbow legend blue→red |
| .3dm import | `lib/rhino3dm/` + `js/main.js` | McNeel's official **rhino3dm** WebAssembly library — upload native Rhino files: lines/polylines/curves → beams, meshes → shells, points |

### Units (Karamba conventions)
Geometry **m** · cross-section dims **cm** · forces **kN** · moments **kNm** ·
stresses & strengths **kN/cm²** · displacements reported in **cm**.

### Defaults (matching Karamba3D)
Material **Steel S235** (E = 21000 kN/cm², γ = 78.5 kN/m³, fy = 23.5 kN/cm²);
beam section **CHS Ø 114.3 × 4 mm** when nothing is wired in.

## Using it

1. **Examples menu** → Parametric Truss Bridge / 3D Portal Frame Tower / Simple Cantilever.
2. Drag any **slider** — the whole pipeline re-solves live and the viewport updates.
3. **Double-click** empty canvas → search popup → place components; drag from an output
   nub to an input nub to wire them.
4. **File → Import Model…** to upload your own design:
   - **`.3dm` (Rhino)** — the native format. Lines/polylines/arcs/NURBS curves become
     beam axes, meshes become shells, points come through as points. Breps/surfaces are
     skipped — run `Mesh` on them in Rhino first. Model in **meters**.
   - **`.obj`** — `l` line entities and face wireframes → beams; `f` faces → shell mesh.
   - **`.dxf`** — LINE entities.
   - **`.json`** — `{"lines": [[[x,y,z],[x,y,z]],…], "meshes":[{"vertices":[…],"faces":[…]}]}`.
   Then wire *Import ▸ Lines → Line To Beam* and/or *Import ▸ Mesh → Mesh To Shell*.
   Importing into an empty canvas **auto-loads a ready analysis definition**: Import →
   Line To Beam (+CHS section sliders) → Bottom Points → Support → Gravity → Assemble →
   Analyze → BeamView — your model appears analyzed in the viewport immediately, and
   every slider re-runs the pipeline on it. Units are read from the .3dm header
   (mm/cm/m/in/ft) and converted to meters; curved members (arcs/NURBS) are sampled
   into beam segments by arc length; endpoints are welded at 5 mm (Karamba's LDist).
   Disconnected fragments that carry no adequate support are excluded with a warning,
   and genuinely under-supported structures get a precise diagnostic naming the free
   DOF and its node position.
5. Right-drag = pan canvas / orbit viewport · Shift+drag = pan viewport · wheel = zoom.
6. **File → Save Definition** exports the graph as `.ghjson`; reload it any time.

## Honest scope

This is a study/teaching replica, not the real thing: one load case, first-order
theory, simple σ/fy (beams) and von-Mises/fy (shells) utilization — no EC3 buckling
or lateral-torsional checks, no Th.II, no eigenmodes.
Not affiliated with or endorsed by Karamba GmbH — if you need real structural analysis,
[buy Karamba3D](https://karamba3d.com/); it's superb.

## License

MIT for the code in this repo. Three.js (MIT) vendored in `lib/`.
