// Cell build cost in Node (no rendering): THREE_PATH=... node web/tools/buildcost.js
global.window = global;
window.THREE = require(process.env.THREE_PATH || "three");
global.performance = require("perf_hooks").performance;
global.document = { getElementById: () => null, createElement: () => ({ getContext: () => null }) };
const J = __dirname + "/../js/";
for (const f of ["worldgen", "solarsystem", "shaders", "vegetation", "planetview"]) require(J + f + ".js");
const POC = global.POC, seed = +(process.env.SEED || 20261);
const sys = new POC.SolarSystem(); sys.generate(seed);
const w = new POC.WorldGen(); w.seed = seed; w.radiusKm = sys.home.radius * 6371; w.axialTiltDeg = sys.home.tilt; w.meanTempC = sys.home.meanC;
w.generateAll(); w.texW = 64; w.texH = 32; w.bakeBegin(); w.bakeStep(1e9);
const view = new POC.PlanetView(w);
const build = (c, lod) => { const it = view._buildCell(c, lod); let r; do { r = it.next(); } while (!r.done); return r.value; };
const sets = { mesa: [], river: [], plain: [] };
for (let c = 0; c < w.nCells; c++) {
	if (w.elev[c] <= 50) continue;
	if (w.mesaP[c] > 0.8 && sets.mesa.length < 6) sets.mesa.push(c);
	else if (w.hasRiver[c] && sets.river.length < 6) sets.river.push(c);
	else if (w.mesaP[c] < 0.2 && !w.hasRiver[c] && sets.plain.length < 6) sets.plain.push(c);
}
build(sets.plain[0], 1); // warm up
for (const [name, cells] of Object.entries(sets)) {
	const ms = [0, 1, 2].map((lod) => { const t0 = performance.now(); for (const c of cells) build(c, lod); return +((performance.now() - t0) / cells.length).toFixed(1); });
	console.log(`build ms per cell (${name}, LOD0/1/2):`, ms);
}
