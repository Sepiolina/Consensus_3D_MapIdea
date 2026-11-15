// Renders a WorldGen planet at the origin of `this.group`.
// Web twin of scripts/planet_view.gd.
//
// Far away: one sphere textured with the baked 2D map (cheap).
// Close up: per-cell 3D meshes streamed in around the focus point, with terraced
// relief, water, rivers, borders, trees and towns. `detail` (0..1) blends between
// the two; relief is applied in the vertex shader so the transition is continuous.
(function () {
	const POC = (window.POC = window.POC || {});
	const { dot, cross, norm, lerp3, clamp, smoothstep } = POC.vec;
	const S = POC.shaders;

	const R = 100.0;
	const RELIEF_MAX = 5.0, RELIEF_H0 = 2500.0, SEA_FLOOR = 1.0; // keep in sync with COMMON
	const SUB = 8;            // subdivisions of each fan triangle
	const BORDER_W = 0.02;
	const MAX_TREES = 150, MAX_HOUSES = 26;

	const disp = (h) => (h >= 0 ? RELIEF_MAX * (1 - Math.exp(-h / RELIEF_H0)) : -SEA_FLOOR * (1 - Math.exp((h * RELIEF_MAX) / RELIEF_H0 / SEA_FLOOR)));

	class PlanetView {
		constructor(world) {
			const THREE = window.THREE;
			this.world = world;
			this.group = new THREE.Group();
			this.detail = 0; this.seaLevel = 0;
			this.loaded = new Map(); // cell index -> THREE.Group
			this.queue = [];
			this._focusCell = 0; this._lastFocus = -1; this._lastRad = -1;

			// One uniform object shared by every planet material.
			const u = (this.shared = {
				sea_level: { value: 0 }, detail: { value: 0 }, season: { value: 0 },
				sun_dir_local: { value: new THREE.Vector3(1, 0, 0) }, sun_dir_world: { value: new THREE.Vector3(1, 0, 0) },
				sun_color: { value: new THREE.Vector3(1, 0.96, 0.9) }, wall_time: { value: 0 },
				flood: { value: 0 }, border_strength: { value: 1 },
			});
			const mat = (vs, fs, extra, opts) => new THREE.ShaderMaterial(Object.assign({ vertexShader: vs, fragmentShader: fs, uniforms: Object.assign({}, u, extra || {}) }, opts || {}));

			// Baked 2D map -> textures.
			const W = world.texW, H = world.texH;
			const half = new Uint16Array(W * H * 4);
			for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(world.data[i]);
			const dataTex = new THREE.DataTexture(half, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
			const maskTex = new THREE.DataTexture(world.mask, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
			for (const t of [dataTex, maskTex]) { t.magFilter = t.minFilter = THREE.LinearFilter; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.generateMipmaps = false; t.needsUpdate = true; }

			this.globeMat = mat(S.globeVert, S.globeFrag, { data_tex: { value: dataTex }, mask_tex: { value: maskTex }, sink: { value: 0 }, border_strength: { value: 0.22 } });
			this.terrainMat = mat(S.terrainVert, S.terrainFrag, null, { side: THREE.DoubleSide, extensions: { derivatives: true } });
			this.waterMat = mat(S.waterVert, S.waterFrag, null, { side: THREE.DoubleSide, transparent: true, depthWrite: false });
			this.riverMat = mat(S.riverVert, S.riverFrag, null, { side: THREE.DoubleSide });
			this.borderMat = mat(S.borderVert, S.borderFrag, { lift: { value: 0.04 } }, { side: THREE.DoubleSide });
			this.selectMat = mat(S.borderVert, S.borderFrag, { lift: { value: 0.09 }, border_strength: { value: 1 } }, { side: THREE.DoubleSide });
			this.treeMat = mat(S.treeVert, S.treeFrag);
			this.houseMat = mat(S.houseVert, S.houseFrag, null, { side: THREE.DoubleSide, extensions: { derivatives: true } });
			this.cloudMat = mat(S.cloudVert, S.cloudFrag, { cloud_alpha: { value: 1 } }, { transparent: true, depthWrite: false });

			this.globe = new THREE.Mesh(new THREE.SphereGeometry(R, 192, 96), this.globeMat);
			this.clouds = new THREE.Mesh(new THREE.SphereGeometry(R * 1.014, 96, 48), this.cloudMat);
			this.clouds.renderOrder = 2;
			this.cellsRoot = new THREE.Group();
			this.selection = new THREE.Mesh(new THREE.BufferGeometry(), this.selectMat);
			this.selection.visible = false; this.selection.frustumCulled = false;
			this.group.add(this.globe, this.cellsRoot, this.clouds, this.selection);

			this.treeGeo = new THREE.ConeGeometry(0.11, 0.34, 5, 1, true);
			this.houseGeo = new THREE.BoxGeometry(0.11, 0.13, 0.15, 1, 2, 1); // middle ring lets the shader raise a gable
		}

		static disp(h) { return disp(h); }

		// Rendered surface radius (land or sea surface) under planet-space direction dir.
		groundRadius(dir) {
			this._focusCell = this.world.sample(dir, this._focusCell);
			return R + disp(Math.max(this.world.sH, this.seaLevel)) * this.detail;
		}

		// Call every frame. `focus` is the planet-space unit vector the camera looks at,
		// `camHeight` the camera height above the surface in world units.
		update(focus, camHeight, detail, budgetMs) {
			this.detail = detail;
			this.shared.detail.value = detail;
			this.globeMat.uniforms.sink.value = 1.6 * smoothstep(0, 0.05, detail);
			this.cloudMat.uniforms.cloud_alpha.value = 1 - smoothstep(0, 0.7, detail);
			this.clouds.visible = detail < 0.7;
			if (detail <= 0) { this.cellsRoot.visible = false; return; }
			this.cellsRoot.visible = true;

			const horizon = Math.acos(clamp(R / (R + Math.max(camHeight, 0.1)), -1, 1));
			const rad = clamp(horizon + (camHeight / R) * 0.8 + 0.1, 0.25, 0.7);
			this._focusCell = this.world.locate(focus, this._focusCell);
			if (this._focusCell !== this._lastFocus || Math.abs(rad - this._lastRad) > 0.03) {
				this._lastFocus = this._focusCell; this._lastRad = rad;
				this._refreshWanted(focus, rad);
			}
			const t0 = performance.now();
			while (this.queue.length) {
				const c = this.queue.shift();
				if (!this.loaded.has(c)) { const g = this._buildCell(c); this.cellsRoot.add(g); this.loaded.set(c, g); }
				if (performance.now() - t0 >= budgetMs) break;
			}
		}

		_refreshWanted(focus, rad) {
			const w = this.world, cosR = Math.cos(rad), cosDrop = Math.cos(rad + 0.15);
			for (const [c, g] of this.loaded) if (dot(w.sites[c], focus) < cosDrop) { this._dispose(g); this.loaded.delete(c); }
			// Breadth-first from the focus cell gives a nearest-first build order.
			this.queue.length = 0;
			const seen = new Set([this._focusCell]), frontier = [this._focusCell];
			for (let qi = 0; qi < frontier.length; qi++) {
				const c = frontier[qi];
				if (!this.loaded.has(c)) this.queue.push(c);
				for (const j of w.cellNb[c]) if (!seen.has(j) && dot(w.sites[j], focus) > cosR) { seen.add(j); frontier.push(j); }
			}
		}

		_dispose(g) {
			this.cellsRoot.remove(g);
			g.traverse((o) => { if (o.geometry && o.geometry !== this.treeGeo && o.geometry !== this.houseGeo) o.geometry.dispose(); });
		}

		dispose() {
			for (const g of this.loaded.values()) this._dispose(g);
			this.loaded.clear();
			this.globe.geometry.dispose();
			this.globeMat.uniforms.data_tex.value.dispose(); this.globeMat.uniforms.mask_tex.value.dispose();
		}

		// Hides cells behind the horizon (they are never frustum-culled individually,
		// because their vertices are displaced in the shader).
		cull(camLocalDir, camHeight) {
			if (!this.cellsRoot.visible) return;
			const lim = Math.cos(Math.acos(clamp(R / (R + Math.max(camHeight, 0.1)), -1, 1)) + 0.2);
			for (const [c, g] of this.loaded) g.visible = dot(this.world.sites[c], camLocalDir) > lim;
		}

		_buildCell(c) {
			const THREE = window.THREE, w = this.world;
			const corners = w.cellCorner[c], nb = w.cellNb[c], m = corners.length, pc = w.sites[c];
			const rock = POC.ROCK_COLORS[w.rock[c]], pop = w.pop[c];
			const rowLen = ((SUB + 1) * (SUB + 2)) / 2, nv = m * rowLen;
			const pos = new Float32Array(nv * 3), data = new Float32Array(nv * 4), col = new Float32Array(nv * 4);
			const idx = [];
			const bPos = [], bH = [], bCol = [], bIdx = [];
			const edgeD = new Array(SUB + 1), edgeH = new Float32Array(SUB + 1);
			let minH = 1e9, v = 0;

			const ribbonPoint = (d, across, h, colr) => {
				bPos.push(d[0] * R + across[0], d[1] * R + across[1], d[2] * R + across[2], d[0] * R - across[0], d[1] * R - across[1], d[2] * R - across[2]);
				bH.push(h, h); bCol.push(colr[0], colr[1], colr[2], colr[0], colr[1], colr[2]);
			};

			for (let i = 0; i < m; i++) {
				const ia = corners[i], ib = corners[(i + 1) % m], pa = w.cornerPos[ia], pb = w.cornerPos[ib];
				const base = v;
				// Triangle (site, corner a, corner b) as a grid: row r runs parallel to the cell edge.
				for (let r = 0; r <= SUB; r++) for (let s = 0; s <= r; s++) {
					const wb = s / SUB, wa = (r - s) / SUB, wc = 1 - r / SUB;
					const d = norm([pc[0] * wc + pa[0] * wa + pb[0] * wb, pc[1] * wc + pa[1] * wa + pb[1] * wb, pc[2] * wc + pa[2] * wa + pb[2] * wb]);
					const rg = w.rug[c] * wc + w.cornerRug[ia] * wa + w.cornerRug[ib] * wb;
					const dz = w.detailNoise(d[0] * POC.NOISE_FREQ, d[1] * POC.NOISE_FREQ, d[2] * POC.NOISE_FREQ) * rg;
					const hs = w.elev[c] * wc + w.cornerH[ia] * wa + w.cornerH[ib] * wb;
					const h = POC.levelHeight(hs + dz);
					pos[v * 3] = d[0] * R; pos[v * 3 + 1] = d[1] * R; pos[v * 3 + 2] = d[2] * R;
					data[v * 4] = h;
					data[v * 4 + 1] = w.tempMean[c] * wc + w.cornerT[ia] * wa + w.cornerT[ib] * wb - 0.0065 * (h - hs);
					data[v * 4 + 2] = w.tempAmp[c] * wc + w.cornerA[ia] * wa + w.cornerA[ib] * wb;
					data[v * 4 + 3] = w.precip[c] * wc + w.cornerP[ia] * wa + w.cornerP[ib] * wb;
					col[v * 4] = rock[0]; col[v * 4 + 1] = rock[1]; col[v * 4 + 2] = rock[2]; col[v * 4 + 3] = pop;
					if (h < minH) minH = h;
					if (r === SUB) { edgeD[s] = d; edgeH[s] = h; }
					v++;
				}
				for (let r = 0; r < SUB; r++) {
					const r0 = base + (r * (r + 1)) / 2, r1 = base + ((r + 1) * (r + 2)) / 2;
					for (let s = 0; s <= r; s++) {
						idx.push(r0 + s, r1 + s, r1 + s + 1);
						if (s < r) idx.push(r0 + s, r1 + s + 1, r0 + s + 1);
					}
				}
				// Border ribbon along this edge, coloured by tectonic plate, plus a corner dot.
				const pcol = w.plateColor[w.plate[Math.min(c, nb[i])]];
				const edge = norm([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]);
				const bb = bPos.length / 3;
				for (let s = 0; s <= SUB; s++) {
					const ac = norm(cross(edgeD[s], edge));
					ribbonPoint(edgeD[s], [ac[0] * BORDER_W, ac[1] * BORDER_W, ac[2] * BORDER_W], edgeH[s], pcol);
					if (s < SUB) { const k = bb + s * 2; bIdx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
				}
				const db = bPos.length / 3, dw = BORDER_W * 2.6, t2 = norm(cross(edgeD[0], edge));
				ribbonPoint(edgeD[0], [edge[0] * dw, edge[1] * dw, edge[2] * dw], edgeH[0], [1, 1, 1]);
				ribbonPoint(edgeD[0], [t2[0] * dw, t2[1] * dw, t2[2] * dw], edgeH[0], [1, 1, 1]);
				bIdx.push(db, db + 2, db + 1, db, db + 1, db + 3);
			}

			const group = new THREE.Group();
			const add = (mesh, order) => { mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; if (order) mesh.renderOrder = order; group.add(mesh); };
			group.matrixAutoUpdate = false;

			const geo = new THREE.BufferGeometry();
			geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
			geo.setAttribute("adata", new THREE.BufferAttribute(data, 4));
			geo.setAttribute("acolor", new THREE.BufferAttribute(col, 4));
			geo.setIndex(idx);
			add(new THREE.Mesh(geo, this.terrainMat));
			// The sea surface reuses the terrain vertices; the shader puts it at sea level.
			if (minH < 400) add(new THREE.Mesh(geo, this.waterMat), 1);

			const bgeo = new THREE.BufferGeometry();
			bgeo.setAttribute("position", new THREE.Float32BufferAttribute(bPos, 3));
			bgeo.setAttribute("aheight", new THREE.Float32BufferAttribute(bH, 1));
			bgeo.setAttribute("acolor3", new THREE.Float32BufferAttribute(bCol, 3));
			bgeo.setIndex(bIdx);
			add(new THREE.Mesh(bgeo, this.borderMat));

			if (w.hasRiver[c]) this._addRivers(group, c, add);
			this._addInstances(group, c, add);
			return group;
		}

		_addRivers(group, c, add) {
			const THREE = window.THREE, w = this.world;
			const pos = [], river = [], across = [], idx = [];
			for (const path of w.riverPaths(c)) {
				const pts = path.pts, n = pts.length, base = pos.length / 3;
				for (let k = 0; k < n; k++) {
					const d = pts[k], a = pts[Math.min(k + 1, n - 1)], b = pts[Math.max(k - 1, 0)];
					const ac = norm(cross(d, norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]])));
					w.sample(d, c);
					const width = path.w0 + (path.w1 - path.w0) * (k / (n - 1));
					for (const side of [-1, 1]) {
						pos.push(d[0] * R, d[1] * R, d[2] * R);
						river.push(side, w.sH, width, w.sT);
						across.push(ac[0], ac[1], ac[2], w.sA);
					}
					if (k < n - 1) { const q = base + k * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
				}
			}
			if (!pos.length) return;
			const geo = new THREE.BufferGeometry();
			geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
			geo.setAttribute("ariver", new THREE.Float32BufferAttribute(river, 4));
			geo.setAttribute("aacross", new THREE.Float32BufferAttribute(across, 4));
			geo.setIndex(idx);
			add(new THREE.Mesh(geo, this.riverMat));
		}

		// Trees scattered by rainfall, and a small town of gabled houses on one spot of
		// every well-populated cell.
		_addInstances(group, c, add) {
			const THREE = window.THREE, w = this.world;
			if (w.elev[c] <= 0) return;
			const rng = new POC.RNG(w.seed * 31 + c);
			const corners = w.cellCorner[c], m = corners.length, pc = w.sites[c];
			const tmp = new THREE.Matrix4();
			const place = (mesh, k, d, x, custom, h) => {
				const z = cross(x, d);
				tmp.set(x[0], d[0], z[0], d[0] * R, x[1], d[1], z[1], d[1] * R, x[2], d[2], z[2], d[2] * R, 0, 0, 0, 1);
				mesh.setMatrixAt(k, tmp);
				const hemi = clamp(d[1] * 6, -1, 1);
				custom.set([h, w.sT, w.sA * hemi, rng.randf()], k * 4);
			};

			// Town first, so trees can keep clear of it.
			let centre = null;
			const nHouses = Math.floor(w.pop[c] * MAX_HOUSES);
			if (nHouses >= 4) {
				centre = norm(lerp3(pc, w.cornerPos[corners[rng.randi(m)]], rng.range(0.15, 0.5)));
				const ax = norm(cross(centre, Math.abs(centre[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), az = cross(ax, centre);
				const mesh = new THREE.InstancedMesh(this.houseGeo, this.houseMat, nHouses), custom = new Float32Array(nHouses * 4);
				for (let k = 0; k < nHouses; k++) {
					const ang = rng.randf() * 6.2832, dist = Math.sqrt(rng.randf()) * 0.55;
					const d = norm([centre[0] * R + (ax[0] * Math.cos(ang) + az[0] * Math.sin(ang)) * dist, centre[1] * R + (ax[1] * Math.cos(ang) + az[1] * Math.sin(ang)) * dist, centre[2] * R + (ax[2] * Math.cos(ang) + az[2] * Math.sin(ang)) * dist]);
					w.sample(d, c);
					const yaw = rng.randf() * 6.2832;
					let x = [ax[0] * Math.cos(yaw) + az[0] * Math.sin(yaw), ax[1] * Math.cos(yaw) + az[1] * Math.sin(yaw), ax[2] * Math.cos(yaw) + az[2] * Math.sin(yaw)];
					const xd = dot(x, d);
					x = norm([x[0] - d[0] * xd, x[1] - d[1] * xd, x[2] - d[2] * xd]);
					place(mesh, k, d, x, custom, w.sH > 2500 ? -99999 : w.sH);
				}
				mesh.geometry = this.houseGeo.clone();
				mesh.geometry.setAttribute("icustom", new THREE.InstancedBufferAttribute(custom, 4));
				add(mesh);
			}

			if (w.tempMean[c] < -6) return;
			const nTrees = Math.floor(clamp((w.precip[c] - 250) / 1100, 0, 1) * MAX_TREES);
			if (nTrees <= 0) return;
			const mesh = new THREE.InstancedMesh(this.treeGeo, this.treeMat, nTrees), custom = new Float32Array(nTrees * 4);
			for (let k = 0; k < nTrees; k++) {
				const i = rng.randi(m);
				let u = rng.randf(), vv = rng.randf();
				if (u + vv > 1) { u = 1 - u; vv = 1 - vv; }
				const pa = w.cornerPos[corners[i]], pb = w.cornerPos[corners[(i + 1) % m]], wc = 1 - u - vv;
				const d = norm([pc[0] * wc + pa[0] * u + pb[0] * vv, pc[1] * wc + pa[1] * u + pb[1] * vv, pc[2] * wc + pa[2] * u + pb[2] * vv]);
				w.sample(d, c);
				let h = w.sH;
				if (w.sT < -7 || h > 3000) h = -99999; // hidden by the shader
				if (centre && Math.acos(clamp(dot(d, centre), -1, 1)) * R < 0.65) h = -99999;
				const x = norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
				place(mesh, k, d, x, custom, h);
			}
			mesh.geometry = this.treeGeo.clone();
			mesh.geometry.setAttribute("icustom", new THREE.InstancedBufferAttribute(custom, 4));
			add(mesh);
		}

		// Outlines cell c (pass -1 to clear). `width` is in world units.
		selectCell(c, width) {
			const THREE = window.THREE, w = this.world;
			if (c < 0) { this.selection.visible = false; return; }
			const corners = w.cellCorner[c], m = corners.length, steps = SUB * 2;
			const pos = [], hh = [], col = [], idx = [];
			for (let i = 0; i < m; i++) {
				const pa = w.cornerPos[corners[i]], pb = w.cornerPos[corners[(i + 1) % m]];
				const edge = norm([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]), base = pos.length / 3;
				for (let s = 0; s <= steps; s++) {
					const d = norm(lerp3(pa, pb, s / steps)), ac = norm(cross(d, edge));
					w.sample(d, c);
					pos.push(d[0] * R + ac[0] * width, d[1] * R + ac[1] * width, d[2] * R + ac[2] * width, d[0] * R - ac[0] * width, d[1] * R - ac[1] * width, d[2] * R - ac[2] * width);
					hh.push(w.sH, w.sH); col.push(1, 0.9, 0.25, 1, 0.9, 0.25);
					if (s < steps) { const k = base + s * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
				}
			}
			const geo = new THREE.BufferGeometry();
			geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
			geo.setAttribute("aheight", new THREE.Float32BufferAttribute(hh, 1));
			geo.setAttribute("acolor3", new THREE.Float32BufferAttribute(col, 3));
			geo.setIndex(idx);
			this.selection.geometry.dispose();
			this.selection.geometry = geo;
			this.selection.visible = true;
		}
	}
	POC.PlanetView = PlanetView;
	POC.PLANET_R = R;
})();
