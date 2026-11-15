// Procedural Voronoi planet (data only, no rendering).
// Web twin of scripts/world_gen.gd: same steps, same names, same units, so changes
// tuned here can be copied across. Heights in metres, temperature in deg C,
// precipitation in mm/yr, discharge in m3/s.
(function () {
	const root = typeof window !== "undefined" ? window : globalThis;
	const POC = (root.POC = root.POC || {});

	// ------------------------------------------------------------ helpers
	function mulberry32(a) {
		return function () {
			a |= 0; a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	class RNG {
		constructor(seed) { this.f = mulberry32(seed); }
		randf() { return this.f(); }
		range(a, b) { return a + (b - a) * this.f(); }
		randi(n) { return Math.floor(this.f() * n); }
		irange(a, b) { return a + Math.floor(this.f() * (b - a + 1)); }
	}
	// Seeded 3D gradient noise with an fBm wrapper (stands in for FastNoiseLite).
	function makeNoise(seed, octaves) {
		const r = mulberry32(seed);
		const p = new Uint8Array(512);
		const perm = Array.from({ length: 256 }, (_, i) => i);
		for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = perm[i]; perm[i] = perm[j]; perm[j] = t; }
		for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
		const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
		const grad = (h, x, y, z) => {
			h &= 15;
			const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z;
			return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
		};
		const lerp = (a, b, t) => a + (b - a) * t;
		function n3(x, y, z) {
			const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
			x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
			const u = fade(x), v = fade(y), w = fade(z);
			const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z, B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
			return lerp(
				lerp(lerp(grad(p[AA], x, y, z), grad(p[BA], x - 1, y, z), u), lerp(grad(p[AB], x, y - 1, z), grad(p[BB], x - 1, y - 1, z), u), v),
				lerp(lerp(grad(p[AA + 1], x, y, z - 1), grad(p[BA + 1], x - 1, y, z - 1), u), lerp(grad(p[AB + 1], x, y - 1, z - 1), grad(p[BB + 1], x - 1, y - 1, z - 1), u), v), w);
		}
		const fbm = function (x, y, z) {
			let a = 1, f = 1, s = 0, norm = 0;
			for (let i = 0; i < octaves; i++) { s += a * n3(x * f + i * 19.1, y * f + i * 7.3, z * f + i * 3.7); norm += a; a *= 0.5; f *= 2; }
			return (s / norm) * 1.5;
		};
		fbm.n3 = n3; // single octave, roughly -1..1
		return fbm;
	}
	const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
	const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
	const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
	const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
	const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
	const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
	const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
	const deg = (r) => (r * 180) / Math.PI;
	POC.vec = { dot, cross, norm, add, sub, mul, lerp3, clamp, smoothstep };
	POC.RNG = RNG;

	const ROCK = { BASALT: 0, GRANITE: 1, SANDSTONE: 2, LIMESTONE: 3, METAMORPHIC: 4, ANDESITE: 5, VOLCANIC: 6 };
	const ROCK_NAMES = ["Basalt (oceanic crust)", "Granite (continental shield)", "Sandstone (sedimentary basin)", "Limestone (carbonate platform)", "Gneiss and schist (orogenic belt)", "Andesite (volcanic arc)", "Basalt shield volcano (hotspot)"];
	const ROCK_COLORS = [[0.27, 0.27, 0.31], [0.56, 0.47, 0.44], [0.62, 0.5, 0.36], [0.68, 0.66, 0.58], [0.4, 0.41, 0.45], [0.44, 0.4, 0.38], [0.24, 0.21, 0.22]];
	const BIOME_NAMES = ["Ocean", "Ice cap", "Tundra", "Taiga (boreal forest)", "Cold desert", "Steppe / grassland", "Mediterranean shrubland", "Temperate forest", "Temperate rainforest", "Hot desert", "Savanna", "Tropical seasonal forest", "Tropical rainforest", "Alpine"];
	const B = { OCEAN: 0, ICE: 1, TUNDRA: 2, TAIGA: 3, COLD_DESERT: 4, STEPPE: 5, MEDITERRANEAN: 6, TEMPERATE_FOREST: 7, TEMPERATE_RAINFOREST: 8, DESERT: 9, SAVANNA: 10, TROPICAL_SEASONAL: 11, TROPICAL_RAINFOREST: 12, ALPINE: 13 };

	const NOISE_FREQ = 38.0;
	const RIVER_MIN_FLOW = 2000.0;

	// ---- continuous surface (see surface()): tuning shared with planetview.js
	const KERNEL_R = 0.09;            // radius (rad) of the smooth kernel that blends cell values
	const KERNEL_INV = 1 / (1 - Math.cos(KERNEL_R));
	const SEA_K = 0.15;               // ocean depths are compressed by this before blending, so coasts stay put
	const WARP = 0.011;               // domain warp of the kernel lookup (rad): breaks up the Voronoi pattern
	const RIVER_REACH = 1.6;          // world units (1 = PLANET_R / 100) beyond which a river does not carve

	// Soft terrace ("levelled" mesa country): flat benches at multiples of `step`
	// joined by short steep risers. `ramp` is the riser half-width as a fraction of a
	// step; `tilt` keeps a little of the original slope on the flats so they are not
	// glass-flat. Used by surface() under a noise mask, so only some regions are mesas.
	function levelHeight(h, step, ramp, tilt) {
		step = step || 300; ramp = ramp === undefined ? 0.08 : ramp; tilt = tilt === undefined ? 0.12 : tilt;
		const y = h / step, k = Math.floor(y), f = y - k;
		return (k + tilt * f + (1 - tilt) * smoothstep(0.5 - ramp, 0.5 + ramp, f)) * step;
	}
	// River channel width in world units from discharge (m3/s).
	const riverWidth = (q) => clamp(0.1 * Math.pow(Math.max(q, 1) / 1000, 0.35), 0.14, 0.7);

	class WorldGen {
		constructor() {
			this.seed = 1; this.nCells = 3000; this.radiusKm = 6371; this.axialTiltDeg = 23.4; this.meanTempC = 14.5;
			this.texW = 2048; this.texH = 1024;
			// result of the last sample()
			this.sH = 0; this.sT = 0; this.sA = 0; this.sP = 0; this.sWc = 1;
			this._p = [0, 0, 1]; // scratch direction for surface()
			this.sRock = [0.5, 0.5, 0.5]; this.sMesa = 0; this.sGully = 0; this.sMtn = 0; this.sRivD = 99; this.sRivL = -1e5; this.sCell = 0;
		}

		static get STEP_NAMES() { return ["Voronoi cells", "Tectonic plates and elevation", "Climate", "Rivers", "Biomes and geology"]; }

		genStep(i) {
			if (i === 0) { this._init(); this._makeSites(); this._makeVoronoi(); }
			else if (i === 1) this._makeElevation();
			else if (i === 2) this._makeClimate();
			else if (i === 3) this._makeRivers();
			else if (i === 4) { this._makeBiomes(); this._makeCorners(); this._makeSurface(); }
		}
		generateAll() { for (let i = 0; i < 5; i++) this.genStep(i); }

		_init() {
			this.rng = new RNG(this.seed);
			this.noise = makeNoise(this.seed, 5);
			this.detailNoise = makeNoise(this.seed + 77, 3);
			this.sn = makeNoise(this.seed + 4242, 1).n3; // raw gradient noise for the sub-cell surface
			this.cellAreaKm2 = (4 * Math.PI * this.radiusKm * this.radiusKm) / this.nCells;
		}

		// ---------------------------------------------------------- Voronoi
		_makeSites() {
			const n = this.nCells, rng = this.rng;
			const golden = Math.PI * (3 - Math.sqrt(5)), spacing = Math.sqrt((4 * Math.PI) / n);
			this.sites = new Array(n);
			for (let i = 0; i < n; i++) {
				const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(Math.max(0, 1 - y * y)), th = golden * i;
				const j = spacing * 0.32;
				this.sites[i] = norm([Math.cos(th) * r + rng.range(-1, 1) * j, y + rng.range(-1, 1) * j, Math.sin(th) * r + rng.range(-1, 1) * j]);
			}
		}

		// Each cell is the tangent-plane (gnomonic) polygon left after clipping by the
		// bisector of every nearby site. Edges remember which neighbour made them, so
		// corners are identified exactly by their three generating sites.
		_makeVoronoi() {
			const n = this.nCells, sites = this.sites;
			const spacing = Math.sqrt((4 * Math.PI) / n);
			const g = Math.max(2, Math.floor(2 / (spacing * 2.6)));
			const gc = (v) => clamp(Math.floor((v + 1) * 0.5 * g), 0, g - 1);
			const grid = new Map();
			for (let i = 0; i < n; i++) {
				const p = sites[i], k = gc(p[0]) + g * (gc(p[1]) + g * gc(p[2]));
				if (!grid.has(k)) grid.set(k, []);
				grid.get(k).push(i);
			}
			this.cellNb = []; this.cellCorner = []; this.cornerPos = []; this.cornerTri = [];
			const cornerIndex = new Map();
			for (let s = 0; s < n; s++) {
				const p = sites[s];
				const e1 = norm(cross(p, Math.abs(p[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
				const e2 = cross(p, e1);
				let px = [-1, 1, 1, -1], py = [-1, -1, 1, 1], lab = [-1, -2, -3, -4];
				const gx = gc(p[0]), gy = gc(p[1]), gz = gc(p[2]);
				for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const cx = gx + dx, cy = gy + dy, cz = gz + dz;
					if (cx < 0 || cy < 0 || cz < 0 || cx >= g || cy >= g || cz >= g) continue;
					const cand = grid.get(cx + g * (cy + g * cz));
					if (!cand) continue;
					for (const j of cand) {
						if (j === s) continue;
						const q = sites[j], qp = dot(q, p);
						if (qp < 0.2) continue;
						const ka = dot(q, e1), kb = dot(q, e2), kc = 1 - qp, m = px.length;
						let outside = false;
						for (let i = 0; i < m; i++) if (ka * px[i] + kb * py[i] > kc) { outside = true; break; }
						if (!outside) continue;
						const nx = [], ny = [], nl = [];
						for (let i = 0; i < m; i++) {
							const i2 = (i + 1) % m;
							const fa = ka * px[i] + kb * py[i] - kc, fb = ka * px[i2] + kb * py[i2] - kc;
							if (fa <= 0) {
								nx.push(px[i]); ny.push(py[i]); nl.push(lab[i]);
								if (fb > 0) { const t = fa / (fa - fb); nx.push(px[i] + (px[i2] - px[i]) * t); ny.push(py[i] + (py[i2] - py[i]) * t); nl.push(j); }
							} else if (fb <= 0) {
								const t = fa / (fa - fb); nx.push(px[i] + (px[i2] - px[i]) * t); ny.push(py[i] + (py[i2] - py[i]) * t); nl.push(lab[i]);
							}
						}
						px = nx; py = ny; lab = nl;
					}
				}
				const m = px.length, cc = new Array(m), nb = new Array(m);
				for (let i = 0; i < m; i++) {
					const la = lab[(i + m - 1) % m], lb = lab[i];
					const tri = [s, la, lb].sort((a, b) => a - b);
					const key = tri.join(",");
					let ci = cornerIndex.get(key);
					if (ci === undefined) {
						ci = this.cornerPos.length; cornerIndex.set(key, ci);
						this.cornerPos.push(norm([p[0] + e1[0] * px[i] + e2[0] * py[i], p[1] + e1[1] * px[i] + e2[1] * py[i], p[2] + e1[2] * px[i] + e2[2] * py[i]]));
						this.cornerTri.push(tri);
					}
					cc[i] = ci; nb[i] = lb >= 0 ? lb : s;
				}
				this.cellCorner.push(cc); this.cellNb.push(nb);
			}
			this.cellWn = []; this.cellEn = [];
			for (let s = 0; s < n; s++) {
				const cc = this.cellCorner[s], m = cc.length, wn = [], en = [];
				for (let i = 0; i < m; i++) {
					const a = this.cornerPos[cc[i]], b = this.cornerPos[cc[(i + 1) % m]];
					wn.push(cross(sites[s], a)); en.push(cross(a, b));
				}
				this.cellWn.push(wn); this.cellEn.push(en);
			}
		}

		// ---------------------------------------------------------- Tectonics and elevation
		_makeElevation() {
			const n = this.nCells, rng = this.rng, sites = this.sites, noise = this.noise;
			const nPlates = 14 + rng.randi(6);
			const plate = (this.plate = new Int32Array(n).fill(-1));
			const poles = [], omega = [], bias = [];
			this.plateColor = [];
			const frontier = [];
			for (let k = 0; k < nPlates; k++) {
				let c0 = rng.randi(n);
				while (plate[c0] !== -1) c0 = rng.randi(n);
				plate[c0] = k; frontier.push(c0);
				poles.push(norm([rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)]));
				omega.push(rng.range(0.3, 1) * (rng.randf() < 0.5 ? 1 : -1));
				bias.push(rng.range(-0.22, 0.22));
				this.plateColor.push(hsv((0.11 + k * 0.381966) % 1, 0.5, 1.0));
			}
			while (frontier.length) {
				const fi = rng.randi(frontier.length), c = frontier[fi], nb = this.cellNb[c], start = rng.randi(nb.length);
				let grew = false;
				for (let t = 0; t < nb.length; t++) {
					const j = nb[(start + t) % nb.length];
					if (plate[j] === -1) { plate[j] = plate[c]; frontier.push(j); grew = true; break; }
				}
				if (!grew) { frontier[fi] = frontier[frontier.length - 1]; frontier.pop(); }
			}
			for (let c = 0; c < n; c++) if (plate[c] < 0) plate[c] = 0;

			// Continents: low-frequency noise plus a per-plate bias; sea level by quantile.
			const cont = new Float32Array(n);
			for (let c = 0; c < n; c++) {
				const p = sites[c];
				cont[c] = noise(p[0] * 1.1, p[1] * 1.1, p[2] * 1.1) + 0.45 * noise(p[0] * 2.7 + 11.3, p[1] * 2.7 + 4.1, p[2] * 2.7 + 7.7) + bias[plate[c]];
			}
			const thr = Float32Array.from(cont).sort()[Math.floor(n * 0.71)];
			const base = new Float32Array(n);
			for (let c = 0; c < n; c++) {
				const x = cont[c] - thr;
				base[c] = x > 0 ? 30 + 1500 * Math.pow(x, 1.3) : -120 - 4300 * smoothstep(0.02, 0.3, -x) - 600 * clamp(-x, 0, 1);
			}

			// Plate boundaries: relative plate velocity across each shared edge.
			let uplift = new Float32Array(n);
			const trench = new Float32Array(n);
			const rock = (this.rock = new Int32Array(n));
			for (let c = 0; c < n; c++) rock[c] = base[c] < -200 ? ROCK.BASALT : ROCK.GRANITE;
			for (let c = 0; c < n; c++) {
				const pc = plate[c];
				for (const j of this.cellNb[c]) {
					const pj = plate[j];
					if (pj === pc) continue;
					const mid = norm(add(sites[c], sites[j]));
					const rel = sub(mul(cross(poles[pc], mid), omega[pc]), mul(cross(poles[pj], mid), omega[pj]));
					const conv = dot(rel, norm(sub(sites[j], sites[c])));
					const landC = base[c] > -200, landJ = base[j] > -200;
					if (conv > 0.25) {
						const s = clamp(conv - 0.25, 0, 1);
						if (landC && landJ) { if (1200 + 4800 * s > uplift[c]) { uplift[c] = 1200 + 4800 * s; rock[c] = ROCK.METAMORPHIC; } } // collision
						else if (landC) { if (900 + 3600 * s > uplift[c]) { uplift[c] = 900 + 3600 * s; rock[c] = ROCK.ANDESITE; } }          // cordillera
						else if (landJ || base[c] < base[j]) trench[c] = Math.max(trench[c], 3000 * s);                                        // trench
						else if (2800 + 2600 * s > uplift[c]) { uplift[c] = 2800 + 2600 * s; rock[c] = ROCK.ANDESITE; }                         // island arc
					} else if (conv < -0.15) {
						const s2 = clamp(-conv / 1.2, 0, 1);
						if (landC) trench[c] = Math.max(trench[c], 350 * s2); // continental rift
						else uplift[c] = Math.max(uplift[c], 1500 * s2);      // mid-ocean ridge
					}
				}
			}
			const spread = Float32Array.from(uplift); // foothills
			for (let c = 0; c < n; c++) { let best = 0; for (const j of this.cellNb[c]) best = Math.max(best, uplift[j]); spread[c] = Math.max(uplift[c], best * 0.35); }
			uplift = spread;

			const elev = (this.elev = new Float32Array(n)), rug = (this.rug = new Float32Array(n));
			for (let c = 0; c < n; c++) {
				const p = sites[c];
				const n1 = noise(p[0] * 6 + 3.1, p[1] * 6 + 8.2, p[2] * 6 + 1.7), n2 = noise(p[0] * 9 + 5.5, p[1] * 9 + 2.4, p[2] * 9 + 9.9);
				elev[c] = base[c] + uplift[c] * (0.75 + 0.5 * n1) - trench[c] + 220 * n2 * (base[c] > 0 ? 1 : 0.5);
			}
			for (let k = 0; k < 6; k++) { // hotspot shield volcanoes
				const c = rng.randi(n);
				if (base[c] < -1000) { elev[c] = Math.max(elev[c], rng.range(200, 2800)); rock[c] = ROCK.VOLCANIC; uplift[c] = Math.max(uplift[c], 3000); }
			}
			this.maxElev = -1e9; this.minElev = 1e9;
			let land = 0;
			for (let c = 0; c < n; c++) {
				let h = elev[c];
				if (h > 6000) h = 6000 + (h - 6000) * 0.4;
				if (Math.abs(h) < 8) h = h >= 0 ? 8 : -8;
				elev[c] = h;
				this.maxElev = Math.max(this.maxElev, h); this.minElev = Math.min(this.minElev, h);
				if (h > 0) { land++; rug[c] = clamp(40 + 0.2 * uplift[c] + 0.08 * h, 30, 900); }
				else rug[c] = 70 + 0.05 * uplift[c];
			}
			this.landFraction = land / n;
		}

		// ---------------------------------------------------------- Climate
		_windAt(p) {
			let east = cross([0, 1, 0], p);
			if (Math.hypot(east[0], east[1], east[2]) < 1e-4) return [1, 0, 0];
			east = norm(east);
			const north = cross(p, east), hemi = p[1] >= 0 ? 1 : -1, alat = deg(Math.asin(clamp(Math.abs(p[1]), 0, 1)));
			if (alat < 30) return norm(add(mul(east, -0.9), mul(north, -hemi * 0.4)));  // trade winds
			if (alat < 60) return norm(add(mul(east, 0.9), mul(north, hemi * 0.3)));    // westerlies
			return norm(add(mul(east, -0.8), mul(north, -hemi * 0.4)));                 // polar easterlies
		}

		_makeClimate() {
			const n = this.nCells, sites = this.sites, elev = this.elev, noise = this.noise;
			// Continentality: graph distance to the nearest ocean cell.
			const dist = new Int32Array(n).fill(-1), queue = [];
			for (let c = 0; c < n; c++) if (elev[c] <= 0) { dist[c] = 0; queue.push(c); }
			for (let qi = 0; qi < queue.length; qi++) { const c = queue[qi]; for (const j of this.cellNb[c]) if (dist[j] < 0) { dist[j] = dist[c] + 1; queue.push(j); } }

			const tm = (this.tempMean = new Float32Array(n)), ta = (this.tempAmp = new Float32Array(n));
			const tiltK = this.axialTiltDeg / 23.44;
			for (let c = 0; c < n; c++) {
				const p = sites[c], sl = Math.abs(p[1]);
				// Oceans carry heat poleward, so the sea cools less with latitude than land.
				const gradient = elev[c] > 0 ? 40 : 34;
				tm[c] = this.meanTempC + 11.5 - gradient * sl * sl - (6.5 * Math.max(elev[c], 0)) / 1000 + 1.5 * noise(p[0] * 4 + 9, p[1] * 4 + 1, p[2] * 4 + 4);
				if (elev[c] > 0) { const contl = clamp((Math.max(dist[c], 1) - 1) / 3, 0, 1); ta[c] = tiltK * Math.pow(sl, 0.8) * (7 + 24 * contl); }
				else ta[c] = tiltK * sl * 5;
			}

			// Moisture is carried downwind from the ocean and wrung out by rising terrain.
			const upwind = new Int32Array(n);
			for (let c = 0; c < n; c++) {
				const p = sites[c], w = this._windAt(p);
				let best = -2, bj = c;
				for (const j of this.cellNb[c]) { const d = -dot(norm(sub(sites[j], p)), w); if (d > best) { best = d; bj = j; } }
				upwind[c] = bj;
			}
			const moist = new Float32Array(n).fill(1);
			for (let it = 0; it < 30; it++) for (let c = 0; c < n; c++) {
				if (elev[c] <= 0) { moist[c] = 1; continue; }
				const u = upwind[c], rise = Math.max(0, elev[c] - Math.max(elev[u], 0));
				let m = Math.max(0.06, moist[u] * 0.9 * Math.exp(-rise / 1800));
				if (dist[c] === 1) m = Math.max(m, 0.55); // sea breeze
				moist[c] = m;
			}
			const pr = (this.precip = new Float32Array(n));
			for (let c = 0; c < n; c++) {
				const p = sites[c], lat = deg(Math.asin(clamp(p[1], -1, 1))), al = Math.abs(lat);
				// Zonal bands: ITCZ, subtropical highs, mid-latitude storm tracks, polar deserts.
				let band = 380 + 2000 * Math.exp(-Math.pow(lat / 14, 2)) + 950 * Math.exp(-Math.pow((al - 48) / 14, 2)) - 220 * Math.exp(-Math.pow((al - 27) / 7, 2));
				band = Math.max(band, 80);
				const u = upwind[c], rise = elev[c] > 0 ? Math.max(0, elev[c] - Math.max(elev[u], 0)) : 0;
				const oro = 1 + clamp(rise / 900, 0, 1.2), tf = clamp(0.55 + tm[c] / 45, 0.3, 1.15);
				let v = band * (0.3 + 0.7 * moist[c]) * oro * tf;
				v *= 1 + 0.2 * noise(p[0] * 5 + 1, p[1] * 5 + 7, p[2] * 5 + 3);
				pr[c] = clamp(v, 20, 3900);
			}
		}

		// ---------------------------------------------------------- Rivers
		_makeRivers() {
			const n = this.nCells, elev = this.elev;
			// Depression filling (Planchon-Darboux) so every land cell drains to the sea.
			const wl = new Float32Array(n);
			for (let c = 0; c < n; c++) wl[c] = elev[c] <= 0 ? elev[c] : 1e9;
			let changed = true, guard = 0;
			while (changed && guard++ < 500) {
				changed = false;
				for (let c = 0; c < n; c++) {
					if (wl[c] <= elev[c]) continue;
					for (const j of this.cellNb[c]) {
						const wj = wl[j] + 0.5;
						if (elev[c] >= wj) { wl[c] = elev[c]; changed = true; break; }
						if (wl[c] > wj) { wl[c] = wj; changed = true; }
					}
				}
			}
			this.fillLevel = wl; // derived: strictly decreases downstream
			const downhill = (this.downhill = new Int32Array(n).fill(-1)), order = [];
			for (let c = 0; c < n; c++) {
				if (elev[c] <= 0) continue;
				order.push(c);
				let best = wl[c];
				for (const j of this.cellNb[c]) if (wl[j] < best) { best = wl[j]; downhill[c] = j; }
			}
			order.sort((a, b) => wl[b] - wl[a]);
			// Discharge: precipitation x area x runoff coefficient, accumulated downstream.
			const flux = (this.flux = new Float32Array(n)), areaM2 = this.cellAreaKm2 * 1e6;
			for (let c = 0; c < n; c++) flux[c] = (this.precip[c] * 0.001 * areaM2 * (0.15 + 0.35 * smoothstep(200, 1500, this.precip[c]))) / 31557600;
			for (const c of order) { const d = downhill[c]; if (d >= 0 && elev[d] > 0) flux[d] += flux[c]; }
			this.hasRiver = new Uint8Array(n); this.riverUp = []; this.riverCells = 0;
			for (let c = 0; c < n; c++) {
				this.riverUp.push([]);
				if (elev[c] > 0 && downhill[c] >= 0 && flux[c] > RIVER_MIN_FLOW) { this.hasRiver[c] = 1; this.riverCells++; this.rug[c] *= 0.55; }
			}
			for (let c = 0; c < n; c++) if (this.hasRiver[c] && this.hasRiver[downhill[c]]) this.riverUp[downhill[c]].push(c);
		}

		// Quadratic Bezier on the sphere, then meandered: every point is pushed sideways by
		// a smooth noise field of position alone, so pieces still meet at cell borders.
		_bezier(a, b, c, steps) {
			const out = [], n3 = this.sn, A = 0.0055;
			for (let k = 0; k <= steps; k++) {
				const t = k / steps, p = norm(lerp3(lerp3(a, b, t), lerp3(b, c, t), t));
				const e1 = norm(cross(p, Math.abs(p[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = cross(p, e1);
				const u = n3(p[0] * 40 + 3.3, p[1] * 40 + 7.1, p[2] * 40 + 1.9) + 0.4 * n3(p[0] * 110 + 5.2, p[1] * 110 + 2.8, p[2] * 110 + 9.4);
				const v = n3(p[0] * 40 + 8.6, p[1] * 40 + 4.2, p[2] * 40 + 6.5) + 0.4 * n3(p[0] * 110 + 1.4, p[1] * 110 + 6.9, p[2] * 110 + 3.3);
				out.push(norm([p[0] + (e1[0] * u + e2[0] * v) * A, p[1] + (e1[1] * u + e2[1] * v) * A, p[2] + (e1[2] * u + e2[2] * v) * A]));
			}
			return out;
		}
		// River polylines inside cell c: [{pts, w0, w1}]. Curves cross cell borders on the
		// line joining the two sites, so consecutive pieces join smoothly.
		// `bed` (when the surface data exists) is the water level in metres at each point:
		// it never rises downstream and meets the neighbouring piece exactly at the border.
		riverPaths(c) {
			const out = [];
			if (!this.hasRiver[c]) return out;
			const pc = this.sites[c], dn = this.downhill[c], mOut = norm(add(pc, this.sites[dn])), w1 = riverWidth(this.flux[c]), ups = this.riverUp[c];
			const bed = this.riverBed, bc = bed ? bed[c] : 0;
			const bOut = bed ? (this.hasRiver[dn] ? (bc + bed[dn]) * 0.5 : Math.min(bc, -4)) : 0;
			const beds = (n, b0, bm, b1, headwater) => {
				const a = [];
				for (let k = 0; k <= n; k++) { const t = k / n; a.push(headwater ? b0 + (b1 - b0) * t : t < 0.5 ? b0 + (bm - b0) * t * 2 : bm + (b1 - bm) * (t * 2 - 1)); }
				return a;
			};
			if (!ups.length) { const a = norm(lerp3(pc, mOut, 0.25)); out.push({ pts: this._bezier(a, norm(lerp3(a, mOut, 0.5)), mOut, 12), w0: w1 * 0.5, w1, bed: beds(12, bc, bc, bOut, true) }); }
			else for (const j of ups) out.push({ pts: this._bezier(norm(add(this.sites[j], pc)), pc, mOut, 24), w0: riverWidth(this.flux[j]), w1, bed: beds(24, bed ? (bed[j] + bc) * 0.5 : 0, bc, bOut, false) });
			return out;
		}

		// ---------------------------------------------------------- Biomes, geology, corners
		_makeBiomes() {
			const n = this.nCells;
			this.biome = new Int32Array(n); this.pop = new Float32Array(n);
			for (let c = 0; c < n; c++) {
				const h = this.elev[c], t = this.tempMean[c], p = this.precip[c];
				if (h <= 0) { this.biome[c] = B.OCEAN; continue; }
				let b;
				if (t < -10) b = B.ICE;
				else if (h > 3200 && t < 4) b = B.ALPINE;
				else if (t < 0) b = B.TUNDRA;
				else if (t < 6) b = p > 300 ? B.TAIGA : B.COLD_DESERT;
				else if (t < 20) b = p < 250 ? (t < 12 ? B.COLD_DESERT : B.DESERT) : p < 550 ? B.STEPPE : p < 900 ? (t > 13 ? B.MEDITERRANEAN : B.TEMPERATE_FOREST) : p < 1800 ? B.TEMPERATE_FOREST : B.TEMPERATE_RAINFOREST;
				else b = p < 300 ? B.DESERT : p < 1000 ? B.SAVANNA : p < 1800 ? B.TROPICAL_SEASONAL : B.TROPICAL_RAINFOREST;
				this.biome[c] = b;
				if (this.rock[c] === ROCK.GRANITE && h < 600) { // sedimentary cover on quiet crust
					const s = this.sites[c], g = this.noise(s[0] * 3.3 + 2, s[1] * 3.3 + 6, s[2] * 3.3 + 8);
					if (g > 0.12) this.rock[c] = t > 12 ? ROCK.LIMESTONE : ROCK.SANDSTONE;
					else if (g < -0.15) this.rock[c] = ROCK.SANDSTONE;
				}
				// Habitability: drives towns and night-side lights.
				let fit = smoothstep(-2, 10, t) * (1 - smoothstep(26, 32, t));
				fit *= smoothstep(200, 700, p) * (1 - smoothstep(2000, 3200, p) * 0.6) * (1 - smoothstep(800, 2500, h));
				if (this.hasRiver[c]) fit *= 1.6;
				this.pop[c] = clamp(fit, 0, 1);
			}
		}

		_makeCorners() {
			const nc = this.cornerPos.length;
			this.cornerH = new Float32Array(nc); this.cornerT = new Float32Array(nc); this.cornerA = new Float32Array(nc); this.cornerP = new Float32Array(nc); this.cornerRug = new Float32Array(nc);
			for (let k = 0; k < nc; k++) {
				let cnt = 0, sh = 0, st = 0, sa = 0, sp = 0, sr = 0;
				for (const id of this.cornerTri[k]) { if (id < 0) continue; cnt++; sh += this.elev[id]; st += this.tempMean[id]; sa += this.tempAmp[id]; sp += this.precip[id]; sr += this.rug[id]; }
				this.cornerH[k] = sh / cnt; this.cornerT[k] = st / cnt; this.cornerA[k] = sa / cnt; this.cornerP[k] = sp / cnt; this.cornerRug[k] = sr / cnt;
			}
		}

		// ---------------------------------------------------------- Queries
		// Nearest site to unit vector d, walking the neighbour graph from `start`.
		locate(d, start) {
			let cur = clamp(start | 0, 0, this.nCells - 1), best = dot(this.sites[cur], d);
			for (;;) {
				let nxt = cur;
				for (const j of this.cellNb[cur]) { const dd = dot(this.sites[j], d); if (dd > best) { best = dd; nxt = j; } }
				if (nxt === cur) return cur;
				cur = nxt;
			}
		}

		// ---------------------------------------------------------- Continuous surface
		// Derived data for surface(): nothing here changes the per-cell values above.
		_makeSurface() {
			const n = this.nCells, sites = this.sites;
			// Two-ring neighbourhoods: every site the smooth kernel can reach from a cell.
			this.ring2 = new Array(n);
			for (let c = 0; c < n; c++) {
				const set = new Set([c]);
				for (const j of this.cellNb[c]) { set.add(j); for (const k of this.cellNb[j]) set.add(k); }
				this.ring2[c] = Int32Array.from(set);
			}
			// Per-cell values the kernel blends: compressed elevation, mesa (tableland)
			// propensity and bedrock colour.
			this.elevK = new Float32Array(n); this.mesaP = new Float32Array(n);
			for (let c = 0; c < n; c++) {
				const h = this.elev[c], r = this.rock[c];
				this.elevK[c] = h > 0 ? h : h * SEA_K;
				let m = r === ROCK.SANDSTONE ? 1 : r === ROCK.LIMESTONE ? 0.8 : r === ROCK.GRANITE ? 0.35 : r === ROCK.VOLCANIC ? 0.3 : 0.12;
				m *= 1 - 0.55 * smoothstep(600, 1700, this.precip[c]);   // dry country weathers into mesas
				m *= 1 - smoothstep(1400, 2800, h);                         // not in the high ranges
				this.mesaP[c] = h > 0 ? m : 0;
			}
			// River beds: water level at each river site, never rising downstream.
			this.riverBed = null;
			const bed = new Float32Array(n), order = [];
			for (let c = 0; c < n; c++) if (this.hasRiver[c]) order.push(c);
			order.sort((a, b) => this.fillLevel[b] - this.fillLevel[a]);
			this._noRiver = true;
			for (const c of order) {
				this.surface(sites[c], c, 1);
				let b = this.sH - 14;
				for (const j of this.riverUp[c]) b = Math.min(b, bed[j]);
				bed[c] = b;
			}
			this._noRiver = false;
			this.riverBed = bed;
			// Channel segments per river cell: a, b, water level at a and b, width at a and b.
			this.riverSeg = new Array(n).fill(null);
			for (const c of order) {
				const seg = [];
				for (const path of this.riverPaths(c)) {
					const pts = path.pts, m = pts.length;
					for (let k = 0; k < m - 1; k++) {
						const wa = path.w0 + (path.w1 - path.w0) * (k / (m - 1)), wb = path.w0 + (path.w1 - path.w0) * ((k + 1) / (m - 1));
						seg.push(pts[k][0], pts[k][1], pts[k][2], pts[k + 1][0], pts[k + 1][1], pts[k + 1][2], path.bed[k], path.bed[k + 1], wa, wb);
					}
				}
				this.riverSeg[c] = Float64Array.from(seg);
			}
			this.riverNear = new Array(n);
			for (let c = 0; c < n; c++) this.riverNear[c] = Int32Array.from(Array.from(this.ring2[c]).filter((j) => this.hasRiver[j]));
		}

		// Weight of the site in the (site, corner, corner) triangle under d: 0 on the cell
		// edge, 1 at the site. Used for the border lines baked into the globe map.
		_edgeWeight(c, d) {
			const wn = this.cellWn[c], m = wn.length;
			let prev = dot(wn[0], d);
			for (let i = 0; i < m; i++) {
				const nxt = dot(wn[(i + 1) % m], d);
				if (prev >= 0 && nxt < 0) {
					const sb = prev, sa = -nxt, cw = Math.max(0, dot(this.cellEn[c][i], d)), tot = sa + sb + cw;
					return tot > 0 ? cw / tot : 1;
				}
				prev = nxt;
			}
			return 1;
		}

		// The continuous sub-cell surface: ONE function of direction, used by the cell
		// meshes, the baked globe map, rivers, vegetation and the camera, so nothing
		// floats or cracks. Fills sH (m), sT, sA (deg C), sP (mm/yr), plus
		//   sMesa  0..1 tableland mask (cliffs and layered rock),
		//   sGully 0..1 erosion-channel strength (dry washes),
		//   sRivD  distance to the nearest channel centre over its half width (99 = none),
		//   sRivL  that river's water level in metres (-1e5 = none),
		//   sRock  blended bedrock colour, sWc (bake only) cell-edge weight.
		// q: 0 = coarse (globe bake), 1 = full, 2 = no finest octaves (AO probes).
		// Returns the cell index.
		//
		// Layers, in order: domain-warped smooth kernel blend of the cell elevations ->
		// broad swells and rolling hills (amplitude from `rug`) -> ridged noise in
		// mountain belts -> soft terraces (mesas, buttes, benches) under a noise mask ->
		// ridged gullies -> river channels with sandy banks and valley walls.
		surface(d, start, q) {
			const n3 = this.sn, sites = this.sites, x = d[0], y = d[1], z = d[2];
			const c = this.locate(d, start);
			this.sWc = q === 0 ? this._edgeWeight(c, d) : 1;
			// 1. Domain warp, then the kernel blend of cell values.
			const wx = n3(x * 6.1 + 1.7, y * 6.1 + 9.2, z * 6.1 + 3.1) + 0.45 * n3(x * 15.3 + 7.7, y * 15.3 + 2.2, z * 15.3 + 5.5);
			const wy = n3(x * 6.1 + 11.3, y * 6.1 + 4.4, z * 6.1 + 8.8) + 0.45 * n3(x * 15.3 + 1.1, y * 15.3 + 9.9, z * 15.3 + 3.3);
			const wz = n3(x * 6.1 + 5.9, y * 6.1 + 13.7, z * 6.1 + 0.6) + 0.45 * n3(x * 15.3 + 6.6, y * 15.3 + 4.8, z * 15.3 + 12.1);
			const P = this._p;
			P[0] = x + wx * WARP; P[1] = y + wy * WARP; P[2] = z + wz * WARP;
			const pl = Math.hypot(P[0], P[1], P[2]); P[0] /= pl; P[1] /= pl; P[2] /= pl;
			const cp = this.locate(P, c), ring = this.ring2[cp];
			let ws = 0, hk = 0, t = 0, a = 0, pr = 0, rg = 0, ms = 0, r0 = 0, r1 = 0, r2 = 0;
			for (let i = 0; i < ring.length; i++) {
				const j = ring[i], s = sites[j];
				const u = (1 - (s[0] * P[0] + s[1] * P[1] + s[2] * P[2])) * KERNEL_INV;
				if (u >= 1) continue;
				let w = 1 - u; w = w * w * w;
				ws += w; hk += w * this.elevK[j]; t += w * this.tempMean[j]; a += w * this.tempAmp[j]; pr += w * this.precip[j];
				rg += w * this.rug[j]; ms += w * this.mesaP[j];
				const rc = ROCK_COLORS[this.rock[j]]; r0 += w * rc[0]; r1 += w * rc[1]; r2 += w * rc[2];
			}
			if (ws <= 0) { ws = 1; hk = this.elevK[c]; t = this.tempMean[c]; a = this.tempAmp[c]; pr = this.precip[c]; rg = this.rug[c]; ms = this.mesaP[c]; const rc = ROCK_COLORS[this.rock[c]]; r0 = rc[0]; r1 = rc[1]; r2 = rc[2]; }
			const iw = 1 / ws;
			hk *= iw; t *= iw; a *= iw; pr *= iw; rg *= iw; ms *= iw;
			const H0 = hk >= 0 ? hk : hk / SEA_K;
			const land = smoothstep(-160, 40, H0);
			let h = H0;
			// 2. Broad swells and rolling hills.
			// Tableland provinces: the blended rock/climate propensity, broken up by noise.
			const prov = 0.6 * n3(x * 4.1 + 2.9, y * 4.1 + 7.1, z * 4.1 + 4.6) + 0.4 * n3(x * 9.7 + 6.3, y * 9.7 + 0.8, z * 9.7 + 3.4);
			const mesa = smoothstep(0.38, 0.68, ms + prov * 0.5) * land;
			const hillA = Math.max(rg, 80) * (1 - 0.5 * mesa) * (0.25 + 0.75 * land);
			let hill = 0.55 * n3(x * 13 + 0.3, y * 13 + 5.1, z * 13 + 2.2);
			hill += 0.3 * n3(x * 33 + 3.3, y * 33 + 1.9, z * 33 + 8.4) + 0.12 * n3(x * 87 + 6.1, y * 87 + 2.6, z * 87 + 0.9);
			if (q !== 0) hill += 0.05 * n3(x * 181 + 9.4, y * 181 + 3.9, z * 181 + 7.2);
			h += hillA * hill;
			// 3. Ridged noise in mountain belts.
			const mtn = smoothstep(240, 650, rg) * land;
			if (mtn > 0) {
				let rsum = 0, amp = 1, f = 42, norm_ = 0;
				const oct = q === 0 ? 3 : 5;
				for (let o = 0; o < oct; o++) {
					const v = 1 - Math.abs(n3(x * f + o * 7.7, y * f + o * 3.1, z * f + o * 5.3));
					rsum += amp * v * v; norm_ += amp; amp *= 0.5; f *= 2.1;
				}
				h += mtn * rg * 2.3 * (rsum / norm_ - 0.42);
			}
			// 4. Tablelands: a warped swell field cut into flat-topped levels (mesas,
			// buttes, benches) with steep risers; step height, riser width and outline
			// all vary with noise. Gullies bite into the risers (ravines, notched rims).
			let rim = 0;
			if (mesa > 0.003) {
				let sw = 0.6 * n3(x * 10 + wx * 1.5 + 4.4, y * 10 + wy * 1.5 + 0.7, z * 10 + wz * 1.5 + 2.9) + 0.3 * n3(x * 26 + 8.6, y * 26 + 5.2, z * 26 + 1.8);
				sw += 0.13 * n3(x * 64 + 2.1, y * 64 + 9.3, z * 64 + 6.2);
				if (q !== 0) sw += 0.05 * n3(x * 150 + 2.5, y * 150 + 6.3, z * 150 + 9.1);
				const field = (sw + 0.12) * 520;
				if (field > 0) {
					const step = 170 + 90 * (n3(x * 4.3 + 8.1, y * 4.3 + 1.4, z * 4.3 + 6.6) + 1);
					const ramp = 0.1 + 0.035 * (n3(x * 7 + 1, y * 7 + 2, z * 7 + 3) + 1);
					h += levelHeight(field, step, ramp, 0.07) * mesa;
					const f = field / step - Math.floor(field / step);
					rim = smoothstep(0.15, 0.45, f) * (1 - smoothstep(0.5, 0.85, f)) * mesa;
				}
			}
			// 5. Gullies and dry washes: valleys along the zero set of noise, strongest at
			// tableland rims.
			const gA = (12 + 0.1 * rg) * land + 150 * rim;
			const g1 = 1 - Math.abs(n3(x * 70 + wx * 0.8 + 5.5, y * 70 + wy * 0.8 + 1.2, z * 70 + wz * 0.8 + 7.7));
			let gully = g1 * g1 * g1 * g1;
			if (q !== 0) { const g2 = 1 - Math.abs(n3(x * 150 + 2.2, y * 150 + 8.3, z * 150 + 4.4)); gully += 0.5 * g2 * g2 * g2 * g2; }
			gully = Math.min(gully, 1);
			h -= gA * gully;
			// Land cells keep their lowlands above the sea: a soft floor just above 0 m, so
			// coastlines follow the cells instead of breaking into lagoons.
			if (H0 > 0 && h < 8) { const k = smoothstep(0, 60, H0); h += (8 + (h - 8) * 0.12 - h) * k; }
			if (q === 1) h += 5 * n3(x * 330 + 1.5, y * 330 + 7.5, z * 330 + 3.5) * land;
			// 6. River channels.
			this.sRivD = 99; this.sRivL = -1e5;
			if (!this._noRiver && this.riverNear) {
				const near = this.riverNear[c];
				if (near.length) h = this._carveRivers(d, near, h, mesa);
			}
			this.sH = h;
			this.sT = t - 0.0065 * (h - H0);
			this.sA = a; this.sP = pr;
			this.sMesa = mesa; this.sGully = gully * land; this.sMtn = mtn;
			const sr = this.sRock; sr[0] = r0 * iw; sr[1] = r1 * iw; sr[2] = r2 * iw;
			this.sCell = c;
			return c;
		}

		// Lowers (and right beside the water, levels) the ground into river channels:
		// a parabolic bed under the water, low sandy banks, then valley walls whose
		// steepness grows in mesa country (canyons). Confluences take the lowest profile.
		_carveRivers(d, near, h, mesa) {
			const x = d[0], y = d[1], z = d[2];
			const COS_REJECT = Math.cos(0.05 + RIVER_REACH / 100);
			let best = 1e9, bestD = 99, bestL = -1e5, bestX = 1e9;
			for (let i = 0; i < near.length; i++) {
				const r = near[i], s = this.sites[r];
				if (s[0] * x + s[1] * y + s[2] * z < COS_REJECT) continue;
				const seg = this.riverSeg[r];
				for (let k = 0; k < seg.length; k += 10) {
					const ax = seg[k], ay = seg[k + 1], az = seg[k + 2];
					const ex = seg[k + 3] - ax, ey = seg[k + 4] - ay, ez = seg[k + 5] - az;
					const ll = ex * ex + ey * ey + ez * ez;
					let tt = ll > 0 ? ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / ll : 0;
					tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
					const dx = x - ax - ex * tt, dy = y - ay - ey * tt, dz = z - az - ez * tt;
					const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) * 100; // world units
					if (dist > RIVER_REACH) continue;
					const wl = seg[k + 6] + (seg[k + 7] - seg[k + 6]) * tt;
					const hw = 0.5 * (seg[k + 8] + (seg[k + 9] - seg[k + 8]) * tt);
					const bankW = 0.18 + 0.6 * hw;
					let prof;
					if (dist < hw) { const u = dist / hw; prof = wl - (14 + 50 * hw) * (1 - u * u); }
					else {
						const xb = dist - hw;
						prof = wl + 4 + 22 * smoothstep(0, bankW, xb);
						if (xb > bankW) { const xw = xb - bankW; prof += (420 + 1600 * mesa) * xw + 900 * xw * xw; }
						if (dist > RIVER_REACH - 0.5) { const e = dist - (RIVER_REACH - 0.5); prof += 30000 * e * e; }
					}
					if (prof < best) { best = prof; bestL = wl; bestX = dist - hw; bestD = dist / hw; }
				}
			}
			if (best >= 1e9) return h;
			this.sRivD = bestD; this.sRivL = bestL;
			// Smooth minimum against the ground so the valley rim is rounded, not creased.
			const k = 18, hh = clamp(0.5 + 0.5 * (h - best) / k, 0, 1);
			const out = Math.min(h + (best - h) * hh - k * hh * (1 - hh), h);
			// Right beside the water the banks are levelled to the profile (also raised).
			const lev = 1 - smoothstep(0.1, 0.35, bestX);
			return out + (best - out) * lev;
		}

		// Legacy name: the full-quality surface.
		sample(d, start) { return this.surface(d, start, 1); }

		cellInfo(c) {
			const p = this.sites[c], lat = deg(Math.asin(clamp(p[1], -1, 1)));
			const rows = [
				["Latitude", `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? "N" : "S"}`],
				["Elevation", `${Math.round(this.elev[c]).toLocaleString()} m`],
				["Mean temperature", `${this.tempMean[c].toFixed(1)} °C  (±${this.tempAmp[c].toFixed(1)} seasonal)`],
				["Precipitation", `${Math.round(this.precip[c]).toLocaleString()} mm/yr`],
				["Bedrock", ROCK_NAMES[this.rock[c]]],
				["Tectonic plate", `#${this.plate[c]}`],
			];
			if (this.hasRiver[c]) rows.push(["River discharge", `${Math.round(this.flux[c]).toLocaleString()} m³/s`]);
			return { title: BIOME_NAMES[this.biome[c]], cell: c, rows };
		}

		// ---------------------------------------------------------- Baked 2D map
		bakeBegin() {
			const W = this.texW, H = this.texH;
			this.data = new Float32Array(W * H * 4); // height/10000, temp/50, amp/50, precip/4000
			this.mask = new Uint8Array(W * H * 4);   // cell border, river, population
			this._cosLon = new Float32Array(W); this._sinLon = new Float32Array(W);
			for (let x = 0; x < W; x++) { const lon = ((x + 0.5) / W) * 2 * Math.PI - Math.PI; this._cosLon[x] = Math.cos(lon); this._sinLon[x] = Math.sin(lon); }
			this._bakeY = 0; this._bakeCell = 0;
		}
		// Bakes rows of the equirectangular map until budgetMs is used. Returns progress 0..1.
		bakeStep(budgetMs) {
			const W = this.texW, H = this.texH, t0 = Date.now(), d = [0, 0, 0];
			while (this._bakeY < H) {
				const lat = Math.PI * 0.5 - ((this._bakeY + 0.5) / H) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
				let c = this._bakeCell, o = this._bakeY * W * 4;
				for (let x = 0; x < W; x++, o += 4) {
					d[0] = cl * this._cosLon[x]; d[1] = sl; d[2] = cl * this._sinLon[x];
					c = this.surface(d, c, 0);
					if (x === 0) this._bakeCell = c;
					this.data[o] = this.sH / 10000; this.data[o + 1] = this.sT / 50; this.data[o + 2] = this.sA / 50; this.data[o + 3] = this.sP / 4000;
					this.mask[o] = clamp(1 - this.sWc / 0.1, 0, 1) * 255; this.mask[o + 2] = this.pop[c] * 255; this.mask[o + 3] = 255;
				}
				this._bakeY++;
				if (Date.now() - t0 > budgetMs) break;
			}
			return this._bakeY / H;
		}
		bakeFinish() { // rivers into the mask's green channel
			const W = this.texW, H = this.texH;
			for (let c = 0; c < this.nCells; c++) {
				if (!this.hasRiver[c]) continue;
				for (const path of this.riverPaths(c)) for (let k = 0; k < path.pts.length - 1; k++) for (let s = 0; s < 6; s++) {
					const d = norm(lerp3(path.pts[k], path.pts[k + 1], s / 6));
					const px = clamp(Math.floor((Math.atan2(d[2], d[0]) / (2 * Math.PI) + 0.5) * W), 0, W - 1);
					const py = clamp(Math.floor((0.5 - Math.asin(clamp(d[1], -1, 1)) / Math.PI) * H), 0, H - 1);
					this.mask[(py * W + px) * 4 + 1] = 255;
				}
			}
		}
	}

	function hsv(h, s, v) {
		const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
		return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
	}
	POC.hsv = hsv;
	POC.WorldGen = WorldGen;
	POC.levelHeight = levelHeight;
	POC.NOISE_FREQ = NOISE_FREQ;
	POC.ROCK_COLORS = ROCK_COLORS;
	POC.BIOME_NAMES = BIOME_NAMES;
})();
