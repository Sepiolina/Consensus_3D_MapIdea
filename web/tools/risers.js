// Riser (cliff wall) inspection, Node only:
//   THREE_PATH=/path/to/node_modules/three node web/tools/risers.js
// Walks straight profiles across tableland country on the surface function and
// measures every riser (a run steeper than 20 degrees, more than 40 m high, with a
// part steeper than 35 degrees): its horizontal width, its
// height, and how many vertex rows each level of detail puts on it (width over the
// mesh vertex spacing of that level).
global.window = global;
window.THREE = require(process.env.THREE_PATH || "three");
global.performance = require("perf_hooks").performance;
global.document = { getElementById: () => null, createElement: () => ({ getContext: () => null }) };
const J = __dirname + "/../js/";
for (const f of ["worldgen", "solarsystem", "shaders", "vegetation", "planetview"]) require(J + f + ".js");
const POC = global.POC, { norm, cross } = POC.vec;
const seed = +(process.env.SEED || 20261);
const sys = new POC.SolarSystem(); sys.generate(seed);
const w = new POC.WorldGen(); w.seed = seed; w.radiusKm = sys.home.radius * 6371; w.axialTiltDeg = sys.home.tilt; w.meanTempC = sys.home.meanC;
w.generateAll();
const disp = POC.PlanetView.disp, R = 100, LOD_SUB = POC.PlanetView.LOD_SUB || [40, 16, 8];
const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(f * a.length))] : NaN);
const fmt = (x) => +x.toFixed(3);
// Mean vertex spacing per level: cell "radius" (site to corner) over the subdivisions.
let rad = 0, nr = 0;
for (let c = 0; c < w.nCells; c += 7) for (const k of w.cellCorner[c]) { const p = w.cornerPos[k], s = w.sites[c]; rad += Math.acos(Math.min(1, s[0] * p[0] + s[1] * p[1] + s[2] * p[2])) * R; nr++; }
rad /= nr;
const spacing = LOD_SUB.map((s) => rad / s);
const cells = []; for (let c = 0; c < w.nCells; c++) if (w.elev[c] > 50 && w.mesaP[c] > 0.7) cells.push(c);
const RW = POC.PlanetView.RISER_W || [undefined, undefined, undefined];
const STEP = 0.004; // world units
const rows = [];
for (let lod = 0; lod < 3; lod++) {
const rng = new POC.RNG(7), widths = [], heights = [];
for (let t = 0; t < 240; t++) {
	const c = cells[rng.randi(cells.length)], s = w.sites[c];
	const e1 = norm(cross(s, [rng.randf() - 0.5, rng.randf() - 0.5, rng.randf() - 0.5]));
	let prev = null, run = null;
	for (let k = -400; k <= 400; k++) {
		const a = (k * STEP) / R, d = norm([s[0] + e1[0] * a, s[1] + e1[1] * a, s[2] + e1[2] * a]);
		w.surface(d, c, 1, RW[lod]);
		const r = disp(w.sH);
		if (prev !== null) {
			const sl = Math.abs(r - prev.r) / STEP, h = w.sH;
			if (sl > Math.tan((20 * Math.PI) / 180) && w.sRivD > 3) { if (!run) run = { n: 0, h0: prev.h, mx: 0 }; run.n++; run.h1 = h; run.mx = Math.max(run.mx, sl); }
			else if (run) { if (Math.abs(run.h1 - run.h0) > 40 && run.mx > Math.tan((35 * Math.PI) / 180)) { widths.push(run.n * STEP); heights.push(Math.abs(run.h1 - run.h0)); } run = null; }
		}
		prev = { r, h: w.sH };
	}
}
rows.push(widths.map((x) => x / spacing[lod]));
console.log(`LOD${lod} surface: risers ${widths.length}, width units p10/p50/p90:`, [q(widths, 0.1), q(widths, 0.5), q(widths, 0.9)].map(fmt), " height m p10/p50/p90:", [q(heights, 0.1), q(heights, 0.5), q(heights, 0.9)].map(fmt));
}
console.log("vertex spacing per LOD (units):", spacing.map(fmt));
rows.forEach((r, l) => console.log(`LOD${l} vertex rows across a riser p10/p50/p90:`, [q(r, 0.1), q(r, 0.5), q(r, 0.9)].map(fmt), ` under 1.5 rows: ${fmt((100 * r.filter((x) => x < 1.5).length) / Math.max(r.length, 1))}%`));
