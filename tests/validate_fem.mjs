import {
  FemModel, analyze, iCroSec, shellLocalK,
} from '../js/fem/solver.js';

let pass = 0, fail = 0;
function check(name, got, want, tolPct) {
  const err = Math.abs(got - want) / Math.max(Math.abs(want), 1e-12) * 100;
  const ok = err <= tolPct;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${got.toExponential(4)}, want ${want.toExponential(4)} (err ${err.toFixed(2)}%)`);
}

/* ---- 1. Simply supported beam with UDL: w=10 kN/m down, L=6m, IPE200 ---- */
{
  const m = new FemModel();
  const cs = iCroSec(20, 10, 0.85, 0.56); // IPE200-ish; use its actual Iy
  m.addBeam({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, cs, 'Steel S235');
  m.addBeam({ x: 3, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, cs, 'Steel S235');
  m.supports.push({ node: m.findClosestNode({ x: 0, y: 0, z: 0 }), fix: [1, 1, 1, 1, 0, 0] });
  m.supports.push({ node: m.findClosestNode({ x: 6, y: 0, z: 0 }), fix: [0, 1, 1, 1, 0, 0] });
  m.lineLoads.push({ a: { x: 0, y: 0, z: 0 }, b: { x: 6, y: 0, z: 0 }, w: [0, 0, -10] });
  const r = analyze(m);
  if (!r.ok) { console.log('FAIL ss-beam: ' + r.error); fail++; }
  else {
    const E = 21000e4, I = cs.Iy * 1e-8;
    const wMid = 5 * 10 * 6 ** 4 / (384 * E * I);
    const midNode = m.findClosestNode({ x: 3, y: 0, z: 0 });
    check('SS beam UDL midspan deflection', Math.abs(r.disp[midNode].dz), wMid, 2);
    // end moments should be ~0, so check max station stress corresponds to wL²/8 = 45 kNm
    const sigWant = (45 * 100) / cs.Wy; // kN/cm²
    const sigGot = r.results[0].sigma;
    check('SS beam UDL max bending stress (M=wL²/8)', sigGot, sigWant, 5);
  }
}

/* ---- 2. Cantilever beam with UDL: w=5, L=4 → tip defl wL⁴/8EI ---- */
{
  const m = new FemModel();
  const cs = iCroSec(20, 10, 0.85, 0.56);
  for (let i = 0; i < 4; i++)
    m.addBeam({ x: i, y: 0, z: 0 }, { x: i + 1, y: 0, z: 0 }, cs, 'Steel S235');
  m.supports.push({ node: m.findClosestNode({ x: 0, y: 0, z: 0 }), fix: [1, 1, 1, 1, 1, 1] });
  m.lineLoads.push({ a: { x: 0, y: 0, z: 0 }, b: { x: 4, y: 0, z: 0 }, w: [0, 0, -5] });
  const r = analyze(m);
  if (!r.ok) { console.log('FAIL cant-beam: ' + r.error); fail++; }
  else {
    const E = 21000e4, I = cs.Iy * 1e-8;
    const tip = m.findClosestNode({ x: 4, y: 0, z: 0 });
    check('Cantilever UDL tip deflection', Math.abs(r.disp[tip].dz), 5 * 4 ** 4 / (8 * E * I), 2);
    // support element end moment = wL²/2 = 40 kNm
    const M0 = Math.max(Math.abs(r.results[0].My[0]), Math.abs(r.results[0].My[1]));
    check('Cantilever UDL fixed-end moment', M0, 40, 3);
  }
}

/* ---- 3. shellLocalK: symmetry + rigid body ---- */
{
  const x = [0, 1.0, 0.3], y = [0, 0.1, 0.8];
  const K = shellLocalK(x, y, 2.1e8, 0.3, 0.02);
  let asym = 0, kmax = 0;
  for (let i = 0; i < 18; i++)
    for (let j = 0; j < 18; j++) {
      asym = Math.max(asym, Math.abs(K[i][j] - K[j][i]));
      kmax = Math.max(kmax, Math.abs(K[i][j]));
    }
  const symOk = asym / kmax < 1e-12;
  console.log(`${symOk ? 'PASS' : 'FAIL'} shell K symmetry: rel asym ${(asym / kmax).toExponential(2)}`);
  symOk ? pass++ : fail++;
  // rigid translation w: dofs slot2 per node =1 → K u = 0
  const u = new Float64Array(18);
  u[2] = u[8] = u[14] = 1;
  let r0 = 0;
  for (let i = 0; i < 18; i++) { let s = 0; for (let j = 0; j < 18; j++) s += K[i][j] * u[j]; r0 = Math.max(r0, Math.abs(s)); }
  console.log(`${r0 / kmax < 1e-8 ? 'PASS' : 'FAIL'} shell K rigid w-translation residual: ${(r0 / kmax).toExponential(2)}`);
  r0 / kmax < 1e-8 ? pass++ : fail++;
  // rigid rotation about x-axis: w = y·θ, θx = θ  (check plate part nullspace)
  const u2 = new Float64Array(18);
  const th = 0.01;
  for (let a = 0; a < 3; a++) { u2[a * 6 + 2] = y[a] * th; u2[a * 6 + 3] = th; }
  let r1 = 0;
  for (let i = 0; i < 18; i++) { let s = 0; for (let j = 0; j < 18; j++) s += K[i][j] * u2[j]; r1 = Math.max(r1, Math.abs(s)); }
  console.log(`rigid rot-x residual/kmax: ${(r1 / (kmax * th)).toExponential(2)} ${r1 / (kmax * th) < 1e-6 ? '(PASS)' : ''}`);
  const u3 = new Float64Array(18);
  for (let a = 0; a < 3; a++) { u3[a * 6 + 2] = -x[a] * th; u3[a * 6 + 4] = th; }
  let r2 = 0;
  for (let i = 0; i < 18; i++) { let s = 0; for (let j = 0; j < 18; j++) s += K[i][j] * u3[j]; r2 = Math.max(r2, Math.abs(s)); }
  console.log(`rigid rot-y residual/kmax (w=-x·θ, θy=θ): ${(r2 / (kmax * th)).toExponential(2)}`);
  const u4 = new Float64Array(18);
  for (let a = 0; a < 3; a++) { u4[a * 6 + 2] = +x[a] * th; u4[a * 6 + 4] = th; }
  let r3 = 0;
  for (let i = 0; i < 18; i++) { let s = 0; for (let j = 0; j < 18; j++) s += K[i][j] * u4[j]; r3 = Math.max(r3, Math.abs(s)); }
  console.log(`rigid rot-y residual/kmax (w=+x·θ, θy=θ): ${(r3 / (kmax * th)).toExponential(2)}`);
}

/* ---- 4. Cantilever plate strip vs beam theory ---- */
{
  // strip 2m long (x), 0.4m wide (y), t=10cm, fixed at x=0, tip load 10kN total
  const m = new FemModel();
  const NX = 8, NY = 2, LX = 2, LY = 0.4, t = 10; // t in cm
  const P = (i, j) => ({ x: i * LX / NX, y: j * LY / NY, z: 0 });
  for (let i = 0; i < NX; i++)
    for (let j = 0; j < NY; j++) {
      const p00 = P(i, j), p10 = P(i + 1, j), p01 = P(i, j + 1), p11 = P(i + 1, j + 1);
      m.addShellTri(p00, p10, p11, t, 'Steel S235');
      m.addShellTri(p00, p11, p01, t, 'Steel S235');
    }
  for (let j = 0; j <= NY; j++) {
    const ni = m.findClosestNode(P(0, j));
    m.supports.push({ node: ni, fix: [1, 1, 1, 1, 1, 1] });
  }
  for (let j = 0; j <= NY; j++) {
    const ni = m.findClosestNode(P(NX, j));
    m.pointLoads.push({ node: ni, force: [0, 0, -10 / (NY + 1)], moment: null });
  }
  const r = analyze(m);
  if (!r.ok) { console.log('FAIL plate: ' + r.error); fail++; }
  else {
    const E = 21000e4, I = LY * (t / 100) ** 3 / 12;
    const want = 10 * LX ** 3 / (3 * E * I);
    const tip = m.findClosestNode(P(NX, 1));
    check('Cantilever plate strip tip deflection (vs beam)', Math.abs(r.disp[tip].dz), want, 20);
    console.log('   plate maxUtil:', r.maxUtil.toFixed(4), ' (beam-theory σ/fy =', (10 * 2 * 100 / (LY * 100 * (t) ** 2 / 6) / 23.5).toFixed(4), ')');
  }
}

/* ---- 5. In-plane (membrane) patch: axial plate = bar ---- */
{
  const m = new FemModel();
  const t = 2; // cm
  // 1m × 0.5m plate, fixed at x=0 edge (u only + minimal), pulled +x with 100kN
  const NX = 4, NY = 2, LX = 1, LY = 0.5;
  const P = (i, j) => ({ x: i * LX / NX, y: j * LY / NY, z: 0 });
  for (let i = 0; i < NX; i++)
    for (let j = 0; j < NY; j++) {
      const p00 = P(i, j), p10 = P(i + 1, j), p01 = P(i, j + 1), p11 = P(i + 1, j + 1);
      m.addShellTri(p00, p10, p11, t, 'Steel S235');
      m.addShellTri(p00, p11, p01, t, 'Steel S235');
    }
  for (let j = 0; j <= NY; j++)
    m.supports.push({ node: m.findClosestNode(P(0, j)), fix: [1, 1, 1, 1, 1, 1] });
  for (let j = 0; j <= NY; j++)
    m.pointLoads.push({ node: m.findClosestNode(P(NX, j)), force: [100 / (NY + 1), 0, 0], moment: null });
  const r = analyze(m);
  if (!r.ok) { console.log('FAIL membrane: ' + r.error); fail++; }
  else {
    const E = 21000e4, A = LY * t / 100;
    const want = 100 * LX / (E * A);
    const tip = m.findClosestNode(P(NX, 1));
    check('Membrane axial stretch (vs bar, ν effects ≤ few %)', Math.abs(r.disp[tip].dx), want, 10);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
