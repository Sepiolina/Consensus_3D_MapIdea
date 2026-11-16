// Numeric regression checks for the terrain (run in Node, no browser):
//   THREE_PATH=/path/to/node_modules/three node web/tools/checks.js [cliffs] [veg] [rivers]
// cliffs: triangle quality on steep faces of the finest cells in tableland country.
// veg:    every vegetation instance against the surface (slope, river, rim, spacing).
// rivers: water level monotonicity, bank clearance, water against the terrain grid.
global.window = global;
window.THREE = require(process.env.THREE_PATH || "three");
global.performance = require("perf_hooks").performance;
global.document = { getElementById: () => null, createElement: () => ({ getContext: () => null }) };
const J = __dirname + "/../js/";
for (const f of ["worldgen", "solarsystem", "shaders", "vegetation", "planetview"]) require(J + f + ".js");
const POC = global.POC, { dot, norm, cross } = POC.vec;
const seed = +(process.env.SEED || 20261);
const sys = new POC.SolarSystem(); sys.generate(seed);
const w = new POC.WorldGen(); w.seed = seed; w.radiusKm = sys.home.radius * 6371; w.axialTiltDeg = sys.home.tilt; w.meanTempC = sys.home.meanC;
w.generateAll(); w.texW = 64; w.texH = 32; w.bakeBegin(); w.bakeStep(1e9);
const view = new POC.PlanetView(w);
const build = (c, lod) => { const it = view._buildCell(c, lod); let r; do { r = it.next(); } while (!r.done); return r.value; };
const disp = POC.PlanetView.disp, R = 100;
const q = (a, f) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(f * a.length))] : NaN);
const fmt = (x) => (Number.isFinite(x) ? +x.toFixed(3) : x);
const which = process.argv.slice(2); const want = (k) => !which.length || which.includes(k);
const mesaCells = []; for (let c = 0; c < w.nCells && mesaCells.length < 6; c++) if (w.elev[c] > 50 && w.mesaP[c] > 0.8) mesaCells.push(c);

if (want("cliffs")) for (const lod of [0, 1]) {
	let steep = 0, single = 0; const aspect = [], hstep = [];
	for (const c of mesaCells) {
		const e = build(c, lod), g = e.terrain.geometry, P = g.getAttribute("position").array, D = g.getAttribute("adata").array, N = g.getAttribute("anormal").array, C = g.getAttribute("acolor").array, I = g.index.array;
		const pos = (i) => { const r = (R + disp(D[i * 4])) / R; return [P[i * 3] * r, P[i * 3 + 1] * r, P[i * 3 + 2] * r]; };
		for (let t = 0; t < I.length; t += 3) {
			const a = I[t], b = I[t + 1], cc = I[t + 2];
			if (C[a * 4 + 3] < -0.5 || C[b * 4 + 3] < -0.5 || C[cc * 4 + 3] < -0.5) continue;
			const pa = pos(a), pb = pos(b), pc = pos(cc), u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
			const n = cross(u, v), area2 = Math.hypot(...n), up = norm(pa);
			if (Math.abs(dot(n, up)) / area2 > 0.64) continue; // only faces steeper than ~50 degrees
			steep++;
			const l = [Math.hypot(...u), Math.hypot(...v), Math.hypot(pc[0] - pb[0], pc[1] - pb[1], pc[2] - pb[2])], L = Math.max(...l);
			aspect.push((L * L) / area2);
			hstep.push(Math.max(D[a * 4], D[b * 4], D[cc * 4]) - Math.min(D[a * 4], D[b * 4], D[cc * 4]));
			const flat = (i) => N[i * 4] * P[i * 3] / R + N[i * 4 + 1] * P[i * 3 + 1] / R + N[i * 4 + 2] * P[i * 3 + 2] / R > 0.93;
			if (flat(a) && flat(b) && flat(cc)) single++;
		}
	}
	console.log(`cliffs lod${lod}:`, JSON.stringify({ cells: mesaCells.length, steepTris: steep, singleRowWallPct: fmt((100 * single) / Math.max(steep, 1)), aspectMedian: fmt(q(aspect, 0.5)), aspectP95: fmt(q(aspect, 0.95)), aspectMax: fmt(q(aspect, 1)), heightStepMedianM: fmt(q(hstep, 0.5)), heightStepMaxM: fmt(q(hstep, 1)) }));
}

if (want("veg")) {
	// Every instance against the surface: slope (degrees, displaced space, from the
	// surface normal), distance beyond the channel edge in river half widths and in
	// world units, distance beyond the nearest riser (rim or foot), under water, and a
	// nearest-neighbour spacing histogram per class. Also: does a cell carry the same
	// instances (positions) at LOD0 and LOD1 (LOD1 a subset)?
	const K = view.kindIndex, names = Object.keys(K), eps = 0.0006;
	const cells = mesaCells.slice(0, 4); for (let c = 0; c < w.nCells && cells.length < 10; c++) if (w.hasRiver[c] && w.precip[c] > 700 && w.elev[c] < 1200) cells.push(c);
	const stat = {}; let subsetOK = 0, subsetBad = 0;
	for (const c of cells) {
		const e = build(c, 0); if (!e.veg) continue;
		const e1v = build(c, 1).veg;
		e.veg.forEach((arr, ki) => {
			const name = names.find((n) => K[n] === ki); if (name === "blob") return;
			const key = (a, i) => a[i].toFixed(6) + "," + a[i + 1].toFixed(6) + "," + a[i + 2].toFixed(6);
			const set0 = new Set(); for (let i = 0; i < arr.length; i += 12) set0.add(key(arr, i));
			const a1 = e1v ? e1v[ki] : []; for (let i = 0; i < a1.length; i += 12) { if (set0.has(key(a1, i))) subsetOK++; else subsetBad++; }
			const cls = /rock|boulder/.test(name) ? "boulder" : name === "shrub" ? "shrub" : name === "tuft" ? "tuft" : "tree";
			const s = (stat[cls] = stat[cls] || { n: 0, slope: [], chanX: [], chanHW: [], cliff: [], under: 0, inChannel: 0, nn: [] });
			const pts = [];
			for (let i = 0; i < arr.length; i += 12) {
				const d = [arr[i], arr[i + 1], arr[i + 2]], h = arr[i + 3]; if (h < -9e4) continue;
				w.surface(d, c, 1); const h0 = w.sH, rl = w.sRivL, rx = w.sRivX, rhw = w.sRivHW, cl = w.sRisHW > 0 && (w.sRisH * 0.0018) / (2 * w.sRisHW) > 0.45 ? Math.abs(w.sRisD) - w.sRisHW : 99; // walls only (mean slope > ~25 deg)
				const [e1, e2] = [norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))].map((x) => [x, cross(d, x)])[0];
				w.surface(norm([d[0] + e1[0] * eps, d[1] + e1[1] * eps, d[2] + e1[2] * eps]), c, 1); const h1 = w.sH;
				w.surface(norm([d[0] + e2[0] * eps, d[1] + e2[1] * eps, d[2] + e2[2] * eps]), c, 1); const h2 = w.sH;
				const gx = (disp(h1) - disp(h0)) / (eps * R), gy = (disp(h2) - disp(h0)) / (eps * R);
				s.n++; s.slope.push((Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI);
				if (rhw > 0) { s.chanX.push(rx); s.chanHW.push(rx / rhw); if (rx < 0) s.inChannel++; }
				s.cliff.push(cl); if (h0 < rl) s.under++;
				pts.push(d);
			}
			for (let i = 0; i < pts.length; i++) { let best = 9; for (let j = 0; j < pts.length; j++) if (i !== j) { const dd = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]) * R; if (dd < best) best = dd; } if (best < 9) s.nn.push(best); }
		});
	}
	const hist = (a, edges) => edges.map((e, i) => a.filter((x) => x >= (i ? edges[i - 1] : 0) && x < e).length);
	for (const [k, s] of Object.entries(stat)) console.log(`veg ${k}:`, JSON.stringify({ n: s.n, slopeDeg_p50_p95_max: [fmt(q(s.slope, 0.5)), fmt(q(s.slope, 0.95)), fmt(q(s.slope, 1))], nearRiver: s.chanX.length, inChannel: s.inChannel, beyondChannelEdgeUnits_min_p5: [fmt(q(s.chanX, 0)), fmt(q(s.chanX, 0.05))], beyondChannelEdgeHalfWidths_min: fmt(q(s.chanHW, 0)), beyondRiserUnits_min_p5: [fmt(q(s.cliff, 0)), fmt(q(s.cliff, 0.05))], underRiverWater: s.under, nnSpacingUnits_p5_p50_p95: [fmt(q(s.nn, 0.05)), fmt(q(s.nn, 0.5)), fmt(q(s.nn, 0.95))], nnHist_lt_0p02_0p04_0p06_0p08_0p12_0p2_0p4: hist(s.nn, [0.02, 0.04, 0.06, 0.08, 0.12, 0.2, 0.4]) }));
	console.log("veg LOD1 instances found at LOD0 (same position):", subsetOK, " not found:", subsetBad);
}

if (want("rivers")) {
	let segs = 0, rises = 0, maxRise = 0, pathsN = 0, joins = 0, maxJoin = 0; const clearance = [], slope = [], widthJump = [];
	let ribV = 0, ribFloat = 0, ribBuried = 0, centreDry = 0; const levee = [], leveeCalm = [];
	for (let c = 0; c < w.nCells; c++) {
		if (!w.hasRiver[c]) continue;
		for (const p of w.riverPaths(c)) {
			pathsN++;
			const n = p.pts.length;
			for (let k = 0; k < n; k++) {
				if (k) { segs++; const dz = p.bed[k] - p.bed[k - 1]; if (dz > 1e-6) { rises++; maxRise = Math.max(maxRise, dz); } const len = Math.acos(Math.min(1, dot(p.pts[k], p.pts[k - 1]))) * R; slope.push(-dz / Math.max(len, 1e-6)); widthJump.push(Math.abs(p.w[k] - p.w[k - 1]) / Math.max(len, 1e-6)); }
				const d = p.pts[k], a = p.pts[Math.min(k + 1, n - 1)], b = p.pts[Math.max(k - 1, 0)], ac = norm(cross(d, norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]])));
				w.surface(d, c, 1); if (w.sH > p.bed[k] && p.bed[k] > 0.5) centreDry++;
				const hw = 0.5 * p.w[k], bankAt = hw + 0.18 + 0.6 * hw, ribHalf = hw + 0.8 * (0.18 + 0.6 * hw);
				let cl = 1e9;
				for (const side of [-1, 1]) {
					const at = (r) => { const x = norm([d[0] * R + ac[0] * side * r, d[1] * R + ac[1] * side * r, d[2] * R + ac[2] * side * r]); w.surface(x, c, 1); return w.sH; };
					cl = Math.min(cl, at(bankAt) - p.bed[k]);
					if (p.bed[k] > 0.5) { const lc = at(hw + 0.1) - p.bed[k]; levee.push(lc); const k0 = Math.max(k - 1, 0), k1 = Math.min(k + 1, n - 1); if (Math.abs(p.bed[k0] - p.bed[k1]) < 12) leveeCalm.push(lc); } // the shore the grid water meets (calm = away from falls)
					const he = at(ribHalf); ribV++;           // ribbon edge vertex against the ground under it
					if (p.bed[k] > 0.5) { if (he < p.bed[k] - 1) ribFloat++; }
					const hm = at(hw * 0.5); if (p.bed[k] > 0.5 && hm > p.bed[k] + 1) ribBuried++;
				}
				if (p.bed[k] > 0.5) clearance.push(cl);
			}
		}
		const dn = w.downhill[c];
		if (w.hasRiver[dn]) { const A = w.riverPaths(c)[0], B = w.riverPaths(dn).find((x) => Math.hypot(x.pts[0][0] - A.pts[A.pts.length - 1][0], x.pts[0][1] - A.pts[A.pts.length - 1][1], x.pts[0][2] - A.pts[A.pts.length - 1][2]) < 1e-6); if (B) { joins++; maxJoin = Math.max(maxJoin, Math.abs(B.bed[0] - A.bed[A.bed.length - 1])); } }
	}
	console.log("rivers:", JSON.stringify({ paths: pathsN, segments: segs, levelRises: rises, maxRiseM: fmt(maxRise), bordersJoined: joins, maxLevelJumpAtBorderM: fmt(maxJoin), bankClearanceM_min_p5_p50: [fmt(q(clearance, 0)), fmt(q(clearance, 0.05)), fmt(q(clearance, 0.5))], negativeClearance: clearance.filter((x) => x < 0).length, leveeClearanceM_min_p5_p50: [fmt(q(levee, 0)), fmt(q(levee, 0.05)), fmt(q(levee, 0.5))], leveeBelowWater: levee.filter((x) => x < 0).length, calmReachSamples: leveeCalm.length, calmLeveeBelowWater: leveeCalm.filter((x) => x < 0).length, calmLeveeMinM: fmt(q(leveeCalm, 0)), waterSlopeMPerUnit_p50_p95_max: [fmt(q(slope, 0.5)), fmt(q(slope, 0.95)), fmt(q(slope, 1))], widthChangePerUnit_p95_max: [fmt(q(widthJump, 0.95)), fmt(q(widthJump, 1))], ribbonEdgeVerts: ribV, ribbonEdgeFloatingAboveGround: ribFloat, channelPointsWhereGroundAboveWater: ribBuried, centreLineDry: centreDry }));
	// Water surface against the terrain grid (finest and middle level): vertices of the
	// drawn mesh that are under river water although they lie outside the channel+bank.
	for (const lod of [0, 1]) {
		let nv = 0, wet = 0, wetOutside = 0, n = 0;
		for (let c = 0; c < w.nCells && n < 10; c++) {
			if (!w.hasRiver[c] || w.elev[c] < 30) continue; n++;
			const g = build(c, lod).terrain.geometry, D = g.getAttribute("adata").array, S = g.getAttribute("asurf").array, L = g.getAttribute("ariver").array, C = g.getAttribute("acolor").array;
			for (let i = 0; i < L.length; i++) { if (C[i * 4 + 3] < -0.5 || L[i] < -9e4) continue; nv++; if (D[i * 4] < L[i]) { wet++; if (S[i * 4 + 3] > 1.6) wetOutside++; } }
		}
		console.log(`river grid lod${lod}:`, JSON.stringify({ cells: n, riverVerts: nv, underWater: wet, underWaterOutsideChannel: wetOutside }));
	}
}
