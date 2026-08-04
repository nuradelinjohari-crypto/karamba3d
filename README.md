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
| Karamba components | `js/graph/components.js` | Line To Beam, Support (6-DOF checkboxes), Point-Load, Gravity, Cross Sections (Rect / CHS / I / Selector with IPE-HEA-CHS table), Material Selection (S235 default), Assemble Model, Analyze Th.I, Disassemble, ModelView, BeamView, Nodal Displacements, Reaction Forces, Utilization, Beam Resultant Forces |
| FEM solver | `js/fem/solver.js` | Linear-elastic first-order (Th.I) 3D frame analysis: Euler-Bernoulli beams, 12×12 element stiffness, 6 DOF/node, supports, point loads + gravity, LDLᵀ solve, member forces, σ/fy utilization, reactions, mass |
| Rhino viewport | `js/viewport/viewport.js` | Perspective view, grid + axes, world-axes icon, shaded display, deformed model, rainbow legend blue→red |

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
4. **File → Import Model…** to upload your own geometry as **OBJ** (line/face edges),
   **DXF** (LINE entities) or **JSON** (`{"lines": [[[x,y,z],[x,y,z]], …]}`), then wire
   the *Import Geometry* component into *Line To Beam*.
5. Right-drag = pan canvas / orbit viewport · Shift+drag = pan viewport · wheel = zoom.
6. **File → Save Definition** exports the graph as `.ghjson`; reload it any time.

## Honest scope

This is a study/teaching replica, not the real thing: beams only (no shells yet),
one load case, first-order theory, simple σ/fy utilization (no EC3 buckling checks).
Not affiliated with or endorsed by Karamba GmbH — if you need real structural analysis,
[buy Karamba3D](https://karamba3d.com/); it's superb.

## License

MIT for the code in this repo. Three.js (MIT) vendored in `lib/`.
