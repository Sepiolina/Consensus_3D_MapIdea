// Renders a WorldGen planet at the origin of `this.group`.
// Web twin of scripts/planet_view.gd.
//
// Far away: one sphere textured with the baked 2D map (cheap).
// Close up: per-cell 3D meshes streamed in around the focus point at three levels of
// detail (finer near the focus; skirts hide the seams between levels), with smooth
// normals and ambient occlusion baked from the height function, river water filling
// carved channels, optional cell borders, and instanced vegetation and rocks.
// `detail` (0..1) blends between the two; relief is applied in the vertex shader so
// the transition is continuous. A sun shadow map is rendered for the near region.
(function () {
	const POC = (window.POC = window.POC || {});
	const { dot, cross, norm, lerp3, clamp, smoothstep } = POC.vec;
	const S = POC.shaders;

	const R = 100.0;
	const RELIEF_MAX = 5.0, RELIEF_H0 = 2500.0, SEA_FLOOR = 1.0; // keep in sync with COMMON
	const LOD_SUB = [40, 16, 8];     // subdivisions of each fan triangle, per level of detail
	const LOD_RAD = [0.11, 0.22];    // angular distance from the focus where LOD 0 and LOD 1 end
	const LOD_HYST = 0.02;           // extra distance before a cell is coarsened again
	const VEG_LOD = 1;               // cells at this LOD or finer carry trees and rocks
	const AO_R = [0.0018, 0.0055];   // AO probe radii (rad); 0.01 rad = 1 world unit
	const BORDER_W = 0.02;
	const SHADOW_SIZE = 2048;

	const disp = (h) => (h >= 0 ? RELIEF_MAX * (1 - Math.exp(-h / RELIEF_H0)) : -SEA_FLOOR * (1 - Math.exp((h * RELIEF_MAX) / RELIEF_H0 / SEA_FLOOR)));
	const tangentBasis = (d) => {
		const e1 = norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
		return [e1, cross(d, e1)];
	};

	class PlanetView {
		constructor(world) {
			const THREE = window.THREE;
			this.world = world;
			this.group = new THREE.Group();
			this.detail = 0; this.seaLevel = 0; this.bordersOn = false;
			this.loaded = new Map(); // cell index -> { group, lod, terrain }
			this.queue = [];
			this.job = null;
			this._focusCell = 0; this._lastFocus = -1; this._lastRad = -1; this._lastFocusDir = [0, 0, 0];
			this.stats = { built: 0, buildMs: 0, lastBuildMs: 0, maxBuildMs: 0 };

			// One uniform object shared by every planet material.
			const u = (this.shared = {
				sea_level: { value: 0 }, detail: { value: 0 }, season: { value: 0 },
				sun_dir_local: { value: new THREE.Vector3(1, 0, 0) }, sun_dir_world: { value: new THREE.Vector3(1, 0, 0) },
				sun_color: { value: new THREE.Vector3(1, 0.96, 0.9) }, wall_time: { value: 0 },
				flood: { value: 0 }, border_strength: { value: 0 }, lens: { value: 0 },
				shadow_map: { value: null }, shadow_matrix: { value: new THREE.Matrix4() }, shadow_on: { value: 0 }, shadow_texel: { value: 0.01 },
			});
			const mat = (vs, fs, extra, opts) => new THREE.ShaderMaterial(Object.assign({ vertexShader: vs, fragmentShader: fs, uniforms: Object.assign({}, u, extra || {}) }, opts || {}));
			this._mat = mat;

			// Baked 2D map -> textures.
			const W = world.texW, H = world.texH;
			const half = new Uint16Array(W * H * 4);
			for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(world.data[i]);
			const dataTex = new THREE.DataTexture(half, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
			const maskTex = new THREE.DataTexture(world.mask, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
			for (const t of [dataTex, maskTex]) { t.magFilter = t.minFilter = THREE.LinearFilter; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.generateMipmaps = false; t.needsUpdate = true; }

			this.globeMat = mat(S.globeVert, S.globeFrag, { data_tex: { value: dataTex }, mask_tex: { value: maskTex }, sink: { value: 0 }, border_strength: { value: 0 } });
			this.terrainMat = mat(S.terrainVert, S.terrainFrag, { skirt_drop: { value: 400 } }, { side: THREE.DoubleSide, extensions: { derivatives: true } });
			this.terrainDepthMat = mat(S.terrainVert, S.depthFrag, { skirt_drop: { value: 0 } }, { side: THREE.DoubleSide });
			this.waterMat = mat(S.waterVert, S.waterFrag, null, { side: THREE.DoubleSide, transparent: true, depthWrite: false });
			this.riverMat = mat(S.riverVert, S.riverFrag, null, { side: THREE.DoubleSide, transparent: true, depthWrite: false });
			this.borderMat = mat(S.borderVert, S.borderFrag, { lift: { value: 0.04 } }, { side: THREE.DoubleSide });
			this.selectMat = mat(S.borderVert, S.borderFrag, { lift: { value: 0.09 }, border_strength: { value: 1 } }, { side: THREE.DoubleSide });
			this.cloudMat = mat(S.cloudVert, S.cloudFrag, { cloud_alpha: { value: 1 } }, { transparent: true, depthWrite: false });

			this.globe = new THREE.Mesh(new THREE.SphereGeometry(R, 192, 96), this.globeMat);
			this.clouds = new THREE.Mesh(new THREE.SphereGeometry(R * 1.014, 96, 48), this.cloudMat);
			this.clouds.renderOrder = 2;
			this.cellsRoot = new THREE.Group();
			this.selection = new THREE.Mesh(new THREE.BufferGeometry(), this.selectMat);
			this.selection.visible = false; this.selection.frustumCulled = false;
			this.group.add(this.globe, this.cellsRoot, this.clouds, this.selection);

			this._initVegetation();
			this._initShadows();
		}

		static disp(h) { return disp(h); }

		// Rendered surface radius (land or sea surface) under planet-space direction dir.
		groundRadius(dir) {
			this._focusCell = this.world.sample(dir, this._focusCell);
			return R + disp(Math.max(this.world.sH, this.seaLevel)) * this.detail;
		}

		setBorders(on) {
			if (on === this.bordersOn) return;
			this.bordersOn = on;
			for (const e of this.loaded.values()) if (e.border) e.border.visible = on;
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
			const moved = Math.acos(clamp(dot(focus, this._lastFocusDir), -1, 1));
			if (this._focusCell !== this._lastFocus || Math.abs(rad - this._lastRad) > 0.03 || moved > 0.01) {
				this._lastFocus = this._focusCell; this._lastRad = rad; this._lastFocusDir = focus.slice();
				this._refreshWanted(focus, rad);
			}
			const t0 = performance.now();
			while (performance.now() - t0 < budgetMs) {
				if (!this.job) {
					const next = this.queue.shift();
					if (!next) break;
					const cur = this.loaded.get(next.c);
					if (cur && cur.lod === next.lod) continue;
					this.job = { c: next.c, lod: next.lod, it: this._buildCell(next.c, next.lod), ms: 0 };
				}
				const j = this.job, s0 = performance.now();
				let r;
				do { r = j.it.next(); } while (!r.done && performance.now() - t0 < budgetMs);
				j.ms += performance.now() - s0;
				if (r.done) {
					this.job = null;
					const old = this.loaded.get(j.c);
					if (old) this._dispose(j.c, old);
					this.cellsRoot.add(r.value.group);
					this.loaded.set(j.c, r.value);
					if (r.value.veg) { this.vegCells.set(j.c, r.value.veg); this.vegDirty = true; }
					const st = this.stats; st.built++; st.buildMs += j.ms; st.lastBuildMs = j.ms; st.maxBuildMs = Math.max(st.maxBuildMs, j.ms);
				}
			}
			const now = performance.now();
			if (this.vegDirty && (now - this._vegTime > 250 || (!this.job && !this.queue.length))) this._rebuildVegetation(now);
		}

		_lodFor(ang, cur) {
			let want = ang < LOD_RAD[0] ? 0 : ang < LOD_RAD[1] ? 1 : 2;
			if (cur !== undefined && want > cur && ang < LOD_RAD[cur] + LOD_HYST) want = cur; // hysteresis
			return want;
		}

		_refreshWanted(focus, rad) {
			const w = this.world, cosR = Math.cos(rad), cosDrop = Math.cos(rad + 0.15);
			for (const [c, e] of this.loaded) if (dot(w.sites[c], focus) < cosDrop) { this._dispose(c, e); this.loaded.delete(c); }
			// Breadth-first from the focus cell gives a nearest-first build order: missing
			// cells first, then level-of-detail changes.
			const missing = [], change = [];
			const seen = new Set([this._focusCell]), frontier = [this._focusCell];
			for (let qi = 0; qi < frontier.length; qi++) {
				const c = frontier[qi], e = this.loaded.get(c);
				const ang = Math.acos(clamp(dot(w.sites[c], focus), -1, 1));
				const lod = this._lodFor(ang, e ? e.lod : undefined);
				if (!e) missing.push({ c, lod }); else if (e.lod !== lod) change.push({ c, lod });
				for (const j of w.cellNb[c]) if (!seen.has(j) && dot(w.sites[j], focus) > cosR) { seen.add(j); frontier.push(j); }
			}
			this.queue = missing.concat(change);
			// Keep the cell being built if it is still wanted at that level of detail.
			if (this.job) {
				const k = this.queue.findIndex((q) => q.c === this.job.c && q.lod === this.job.lod);
				if (k >= 0) this.queue.splice(k, 1); else this.job = null;
			}
		}

		_dispose(c, e) {
			this.cellsRoot.remove(e.group);
			e.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
			if (this.vegCells.delete(c)) this.vegDirty = true;
		}

		dispose() {
			for (const [c, e] of this.loaded) this._dispose(c, e);
			this.loaded.clear();
			this.globe.geometry.dispose();
			this.globeMat.uniforms.data_tex.value.dispose(); this.globeMat.uniforms.mask_tex.value.dispose();
			for (const k of this.vegKinds) k.geo.dispose();
			this.shadowRT.dispose();
		}

		// Hides cells behind the horizon (they are never frustum-culled individually,
		// because their vertices are displaced in the shader).
		cull(camLocalDir, camHeight) {
			if (!this.cellsRoot.visible) return;
			const lim = Math.cos(Math.acos(clamp(R / (R + Math.max(camHeight, 0.1)), -1, 1)) + 0.2);
			for (const [c, e] of this.loaded) e.group.visible = dot(this.world.sites[c], camLocalDir) > lim;
		}

		// ------------------------------------------------------------ cell meshes
		// One surface sample with its normal (finite differences of the displaced
		// surface), ambient occlusion and concavity (horizon probes around it).
		_vertex(d, start, eps, out, o) {
			const w = this.world;
			const c = w.surface(d, start, 1);
			const h = w.sH;
			out.data[o * 4] = h; out.data[o * 4 + 1] = w.sT; out.data[o * 4 + 2] = w.sA; out.data[o * 4 + 3] = w.sP;
			out.surf[o * 4] = w.sMesa; out.surf[o * 4 + 1] = w.sGully; out.surf[o * 4 + 3] = Math.min(w.sRivD, 99);
			out.col[o * 4] = w.sRock[0]; out.col[o * 4 + 1] = w.sRock[1]; out.col[o * 4 + 2] = w.sRock[2]; out.col[o * 4 + 3] = w.pop[c];
			out.riv[o] = w.sRivL;
			const [e1, e2] = tangentBasis(d);
			const r0 = R + disp(h);
			const d1 = norm([d[0] + e1[0] * eps, d[1] + e1[1] * eps, d[2] + e1[2] * eps]);
			w.surface(d1, c, 1); const r1 = R + disp(w.sH);
			const d2 = norm([d[0] + e2[0] * eps, d[1] + e2[1] * eps, d[2] + e2[2] * eps]);
			w.surface(d2, c, 1); const r2 = R + disp(w.sH);
			const ax = d1[0] * r1 - d[0] * r0, ay = d1[1] * r1 - d[1] * r0, az = d1[2] * r1 - d[2] * r0;
			const bx = d2[0] * r2 - d[0] * r0, by = d2[1] * r2 - d[1] * r0, bz = d2[2] * r2 - d[2] * r0;
			let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
			let nl = Math.hypot(nx, ny, nz) || 1;
			if (nx * d[0] + ny * d[1] + nz * d[2] < 0) nl = -nl;
			out.nrm[o * 4] = nx / nl; out.nrm[o * 4 + 1] = ny / nl; out.nrm[o * 4 + 2] = nz / nl;
			// Six horizon probes on two rings: how much of the sky the ground around hides.
			let occ = 0, curv = 0;
			const dh = disp(h);
			for (let k = 0; k < 6; k++) {
				const a = k * 1.0472 + 0.35, rr = AO_R[k & 1], ca = Math.cos(a) * rr, sa = Math.sin(a) * rr;
				const dk = norm([d[0] + e1[0] * ca + e2[0] * sa, d[1] + e1[1] * ca + e2[1] * sa, d[2] + e1[2] * ca + e2[2] * sa]);
				w.surface(dk, c, 2);
				const rise = disp(w.sH) - dh, e = rise / (rr * R);
				if (e > 0) occ += e / Math.sqrt(1 + e * e);
				if (!(k & 1)) curv += rise;
			}
			out.nrm[o * 4 + 3] = clamp(1 - occ / 6 * 1.1, 0.2, 1);
			out.surf[o * 4 + 2] = clamp(curv / 3 / (AO_R[0] * R), -1, 1); // + concave, - convex
			return c;
		}

		// Generator: builds cell c at level of detail `lod`, yielding after each row so
		// the caller can spread the work over frames. Returns the cell record.
		*_buildCell(c, lod) {
			const THREE = window.THREE, w = this.world, SUB = LOD_SUB[lod];
			const corners = w.cellCorner[c], nb = w.cellNb[c], m = corners.length, pc = w.sites[c];
			const rowLen = ((SUB + 1) * (SUB + 2)) / 2, nGrid = m * rowLen, nv = nGrid + m * (SUB + 1);
			const out = { pos: new Float32Array(nv * 3), data: new Float32Array(nv * 4), nrm: new Float32Array(nv * 4), surf: new Float32Array(nv * 4), col: new Float32Array(nv * 4), riv: new Float32Array(nv) };
			const idx = [];
			// Finite-difference step: fixed per level of detail, so neighbouring cells at
			// the same level compute identical normals along their shared edge.
			const eps = 0.02 / SUB;
			let minH = 1e9, v = 0, start = c;
			const edgeRows = [];
			for (let i = 0; i < m; i++) {
				const ia = corners[i], ib = corners[(i + 1) % m], pa = w.cornerPos[ia], pb = w.cornerPos[ib];
				const base = v;
				// Triangle (site, corner a, corner b) as a grid: row r runs parallel to the cell edge.
				for (let r = 0; r <= SUB; r++) {
					for (let s = 0; s <= r; s++) {
						const wb = s / SUB, wa = (r - s) / SUB, wc = 1 - r / SUB;
						const d = norm([pc[0] * wc + pa[0] * wa + pb[0] * wb, pc[1] * wc + pa[1] * wa + pb[1] * wb, pc[2] * wc + pa[2] * wa + pb[2] * wb]);
						out.pos[v * 3] = d[0] * R; out.pos[v * 3 + 1] = d[1] * R; out.pos[v * 3 + 2] = d[2] * R;
						start = this._vertex(d, start, eps, out, v);
						if (out.data[v * 4] < minH) minH = out.data[v * 4];
						v++;
					}
					yield;
				}
				for (let r = 0; r < SUB; r++) {
					const r0 = base + (r * (r + 1)) / 2, r1 = base + ((r + 1) * (r + 2)) / 2;
					for (let s = 0; s <= r; s++) {
						idx.push(r0 + s, r1 + s, r1 + s + 1);
						if (s < r) idx.push(r0 + s, r1 + s + 1, r0 + s + 1);
					}
				}
				edgeRows.push(base + (SUB * (SUB + 1)) / 2);
			}
			const nGridTri = idx.length / 3;
			// Skirts: a copy of each edge row hanging below it hides cracks against
			// neighbours built at another level of detail.
			for (let i = 0; i < m; i++) {
				const e0 = edgeRows[i], k0 = v;
				for (let s = 0; s <= SUB; s++, v++) {
					const src = e0 + s;
					for (let k = 0; k < 3; k++) out.pos[v * 3 + k] = out.pos[src * 3 + k];
					for (let k = 0; k < 4; k++) { out.data[v * 4 + k] = out.data[src * 4 + k]; out.nrm[v * 4 + k] = out.nrm[src * 4 + k]; out.surf[v * 4 + k] = out.surf[src * 4 + k]; out.col[v * 4 + k] = out.col[src * 4 + k]; }
					out.riv[v] = out.riv[src];
					out.col[v * 4 + 3] = -1; // skirt: the terrain shader drops it, the sea skips it
					if (s < SUB) idx.push(src, src + 1, k0 + s, src + 1, k0 + s + 1, k0 + s);
				}
			}

			const group = new THREE.Group();
			group.matrixAutoUpdate = false;
			const add = (mesh, order) => { mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; if (order) mesh.renderOrder = order; group.add(mesh); return mesh; };

			const geo = new THREE.BufferGeometry();
			geo.setAttribute("position", new THREE.BufferAttribute(out.pos, 3));
			geo.setAttribute("adata", new THREE.BufferAttribute(out.data, 4));
			geo.setAttribute("anormal", new THREE.BufferAttribute(out.nrm, 4));
			geo.setAttribute("asurf", new THREE.BufferAttribute(out.surf, 4));
			geo.setAttribute("acolor", new THREE.BufferAttribute(out.col, 4));
			geo.setAttribute("ariver", new THREE.BufferAttribute(out.riv, 1));
			geo.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
			const terrain = add(new THREE.Mesh(geo, this.terrainMat));
			terrain.layers.enable(1); // shadow caster
			// The sea surface reuses the terrain vertices; the shader puts it at sea level.
			if (minH < 400) add(new THREE.Mesh(geo, this.waterMat), 1);

			// Border ribbons along each edge, coloured by tectonic plate, plus corner dots.
			const bPos = [], bH = [], bCol = [], bIdx = [];
			const ribbonPoint = (d, across, h, colr) => {
				bPos.push(d[0] * R + across[0], d[1] * R + across[1], d[2] * R + across[2], d[0] * R - across[0], d[1] * R - across[1], d[2] * R - across[2]);
				bH.push(h, h); bCol.push(colr[0], colr[1], colr[2], colr[0], colr[1], colr[2]);
			};
			for (let i = 0; i < m; i++) {
				const pa = w.cornerPos[corners[i]], pb = w.cornerPos[corners[(i + 1) % m]];
				const pcol = w.plateColor[w.plate[Math.min(c, nb[i])]];
				const edge = norm([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]);
				const bb = bPos.length / 3;
				let d0 = null, h0 = 0;
				for (let s = 0; s <= SUB; s++) {
					const vi = edgeRows[i] + s, d = [out.pos[vi * 3] / R, out.pos[vi * 3 + 1] / R, out.pos[vi * 3 + 2] / R];
					if (s === 0) { d0 = d; h0 = out.data[vi * 4]; }
					const ac = norm(cross(d, edge));
					ribbonPoint(d, [ac[0] * BORDER_W, ac[1] * BORDER_W, ac[2] * BORDER_W], out.data[vi * 4], pcol);
					if (s < SUB) { const k = bb + s * 2; bIdx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
				}
				const db = bPos.length / 3, dw = BORDER_W * 2.6, t2 = norm(cross(d0, edge));
				ribbonPoint(d0, [edge[0] * dw, edge[1] * dw, edge[2] * dw], h0, [1, 1, 1]);
				ribbonPoint(d0, [t2[0] * dw, t2[1] * dw, t2[2] * dw], h0, [1, 1, 1]);
				bIdx.push(db, db + 2, db + 1, db, db + 1, db + 3);
			}
			const bgeo = new THREE.BufferGeometry();
			bgeo.setAttribute("position", new THREE.Float32BufferAttribute(bPos, 3));
			bgeo.setAttribute("aheight", new THREE.Float32BufferAttribute(bH, 1));
			bgeo.setAttribute("acolor3", new THREE.Float32BufferAttribute(bCol, 3));
			bgeo.setIndex(bIdx);
			const border = add(new THREE.Mesh(bgeo, this.borderMat));
			border.visible = this.bordersOn;

			if (w.hasRiver[c]) this._addRivers(c, add);
			yield;
			const veg = lod <= VEG_LOD && w.elev[c] > -500 ? this._placeVegetation(c, lod, out, idx, nGridTri) : null;
			return { group, lod, terrain, border, veg };
		}

		// River water: a level ribbon along each channel at the water level, wide enough
		// to cover the banks; the carved terrain hides it wherever the ground is higher,
		// so the visible shoreline is where the water meets the banks.
		_addRivers(c, add) {
			const THREE = window.THREE, w = this.world;
			const pos = [], river = [], across = [], flow = [], idx = [];
			for (const path of w.riverPaths(c)) {
				const pts = path.pts, n = pts.length, base = pos.length / 3;
				let along = 0;
				for (let k = 0; k < n; k++) {
					const d = pts[k], a = pts[Math.min(k + 1, n - 1)], b = pts[Math.max(k - 1, 0)];
					const ac = norm(cross(d, norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]])));
					if (k > 0) along += Math.acos(clamp(dot(d, pts[k - 1]), -1, 1)) * R;
					const hw = 0.5 * path.w[k];
					w.sample(d, c);
					for (const side of [-1, 1]) {
						pos.push(d[0] * R, d[1] * R, d[2] * R);
						river.push(side, path.bed[k], hw, w.sT);
						across.push(ac[0], ac[1], ac[2], w.sA);
						flow.push(along, hw + 0.8 * (0.18 + 0.6 * hw)); // ends inside the levelled banks (see _carveRivers)
					}
					if (k < n - 1) { const q = base + k * 2; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
				}
			}
			if (!pos.length) return;
			const geo = new THREE.BufferGeometry();
			geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
			geo.setAttribute("ariver", new THREE.Float32BufferAttribute(river, 4));
			geo.setAttribute("aacross", new THREE.Float32BufferAttribute(across, 4));
			geo.setAttribute("aflow", new THREE.Float32BufferAttribute(flow, 2));
			geo.setIndex(idx);
			add(new THREE.Mesh(geo, this.riverMat), 1);
		}

		// ------------------------------------------------------------ vegetation and rocks
		// Every kind is ONE instanced mesh for the whole near field (a handful of draw
		// calls); cells hand in their instances and the buffers are rebuilt when cells
		// come and go. Instance data: ipos (dir xyz, height m), iparam (yaw, scale,
		// lean, random), iclim (mean temp, signed seasonal amp, ao, moisture/warmth).
		_initVegetation() {
			const THREE = window.THREE;
			const G = POC.vegGeometry;
			this.vegCells = new Map(); this.vegDirty = false; this._vegTime = 0;
			// [name, geometry, leaf colour, wood colour, kind id, global instance cap]
			const kinds = [
				["broad0", G.broadleaf(11), [0.17, 0.22, 0.08], [0.24, 0.17, 0.11], 0, 2600],
				["broad1", G.broadleaf(23, true), [0.20, 0.24, 0.09], [0.24, 0.17, 0.11], 0, 2600],
				["conifer", G.conifer(5), [0.08, 0.14, 0.08], [0.20, 0.14, 0.10], 1, 6000],
				["acacia", G.acacia(7), [0.26, 0.27, 0.11], [0.26, 0.19, 0.12], 2, 5000],
				["palm", G.palm(3), [0.20, 0.27, 0.09], [0.36, 0.29, 0.20], 3, 3000],
				["shrub", G.shrub(9), [0.20, 0.22, 0.09], [0.22, 0.16, 0.10], 4, 7000],
				["tuft", G.tuft(4), [0.40, 0.36, 0.15], [0.40, 0.34, 0.16], 5, 20000],
				["rock0", G.rock(13), [0.46, 0.40, 0.33], [0.40, 0.35, 0.30], 6, 2500],
				["rock1", G.rock(29, 0), [0.46, 0.40, 0.33], [0.40, 0.35, 0.30], 6, 4000],
				["snag", G.snag(17), [0.2, 0.2, 0.1], [0.36, 0.30, 0.24], 7, 1500],
				["blob", G.blob(), [0, 0, 0], [0, 0, 0], 8, 14000],
			];
			this.vegKinds = kinds.map(([name, base, leaf, wood, kind, limit]) => {
				const geo = new THREE.InstancedBufferGeometry();
				for (const a of ["position", "normal", "aveg"]) geo.setAttribute(a, base.getAttribute(a));
				geo.setIndex(base.getIndex());
				geo.instanceCount = 0;
				const extra = { leaf_col: { value: new THREE.Vector3(...leaf) }, wood_col: { value: new THREE.Vector3(...wood) }, kind: { value: kind } };
				const material = kind === 8
					? this._mat(S.vegVert, S.vegFrag, extra, { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
					: this._mat(S.vegVert, S.vegFrag, extra, { side: kind === 5 || kind === 3 ? THREE.DoubleSide : THREE.FrontSide });
				const depth = this._mat(S.vegVert, S.depthFrag, extra, { side: THREE.DoubleSide });
				const mesh = new THREE.Mesh(geo, material);
				mesh.frustumCulled = false; mesh.visible = false;
				if (kind !== 5 && kind !== 4 && kind !== 8) mesh.layers.enable(1); // grass tufts, shrubs and contact blobs cast no shadow
				if (kind === 8) mesh.renderOrder = 1;
				this.cellsRoot.add(mesh);
				return { name, geo, mesh, material, depth, cap: 0, buf: null, limit };
			});
			this.kindIndex = Object.fromEntries(this.vegKinds.map((k, i) => [k.name, i]));
		}

		_rebuildVegetation(now) {
			const THREE = window.THREE;
			this.vegDirty = false; this._vegTime = now;
			this.vegKinds.forEach((k, ki) => {
				// Over the kind's limit (dense forest), every cell is thinned evenly; the
				// woodland colour of the ground keeps forests reading as forests.
				let total = 0;
				for (const v of this.vegCells.values()) total += v[ki].length / 12;
				const keep = Math.min(1, k.limit / Math.max(total, 1));
				if (keep < 1) { total = 0; for (const v of this.vegCells.values()) total += Math.floor((v[ki].length / 12) * keep); }
				if (total > k.cap) {
					k.cap = Math.max(1024, 1 << Math.ceil(Math.log2(total * 1.25)));
					k.buf = new THREE.InstancedInterleavedBuffer(new Float32Array(k.cap * 12), 12, 1);
					k.buf.setUsage(THREE.DynamicDrawUsage);
					k.geo.setAttribute("ipos", new THREE.InterleavedBufferAttribute(k.buf, 4, 0));
					k.geo.setAttribute("iparam", new THREE.InterleavedBufferAttribute(k.buf, 4, 4));
					k.geo.setAttribute("iclim", new THREE.InterleavedBufferAttribute(k.buf, 4, 8));
				}
				if (k.buf) {
					let o = 0;
					for (const v of this.vegCells.values()) {
						const a = v[ki], n = Math.floor((a.length / 12) * keep);
						for (let j = 0; j < n; j++) { const src = Math.floor(j / keep) * 12; for (let i = 0; i < 12; i++) k.buf.array[o++] = a[src + i]; }
					}
					k.buf.needsUpdate = true;
				}
				k.geo.instanceCount = total;
				k.mesh.visible = total > 0;
			});
		}

		// Scatters trees, shrubs, grass tufts and rocks over the cell's triangles.
		// Suitability comes from the vertex data already computed for the mesh (slope,
		// AO, moisture, temperature, mesa, gullies, river distance) and clustered noise;
		// positions are interpolated on the rendered triangles, so nothing floats.
		_placeVegetation(c, lod, out, idx, nTri) {
			const w = this.world, n3 = w.sn, rng = new POC.RNG(w.seed * 31 + c * 7 + 1);
			const lists = this.vegKinds.map(() => []);
			const K = this.kindIndex;
			const fine = lod === 0;
			const pt = { d: [0, 0, 0] };
			const interp = () => {
				const t = Math.floor(rng.randf() * nTri) * 3, i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
				let a = rng.randf(), b = rng.randf();
				if (a + b > 1) { a = 1 - a; b = 1 - b; }
				const g = 1 - a - b;
				const L = (arr, s, k) => arr[i0 * s + k] * g + arr[i1 * s + k] * a + arr[i2 * s + k] * b;
				const d = norm([L(out.pos, 3, 0), L(out.pos, 3, 1), L(out.pos, 3, 2)]);
				pt.d = d;
				// Height on the flat triangle between the displaced vertices.
				const rr = g * disp(out.data[i0 * 4]) + a * disp(out.data[i1 * 4]) + b * disp(out.data[i2 * 4]);
				const hi = L(out.data, 4, 0);
				pt.h = hi;
				pt.rr = rr;
				pt.t = L(out.data, 4, 1); pt.amp = L(out.data, 4, 2); pt.p = L(out.data, 4, 3);
				const nx = L(out.nrm, 4, 0), ny = L(out.nrm, 4, 1), nz = L(out.nrm, 4, 2);
				pt.up = (nx * d[0] + ny * d[1] + nz * d[2]) / (Math.hypot(nx, ny, nz) || 1);
				pt.ao = L(out.nrm, 4, 3);
				pt.mesa = L(out.surf, 4, 0); pt.gully = L(out.surf, 4, 1); pt.curv = L(out.surf, 4, 2);
				pt.rivD = Math.min(out.surf[i0 * 4 + 3], out.surf[i1 * 4 + 3], out.surf[i2 * 4 + 3]);
				pt.warm = clamp((L(out.col, 4, 0) - L(out.col, 4, 2)) * 4 + 0.2, 0, 1);
				return pt;
			};
			// Exact height for an instance that sits on the drawn triangle: invert disp().
			const heightOn = (rr) => (rr >= 0 ? -RELIEF_H0 * Math.log(Math.max(1 - rr / RELIEF_MAX, 1e-6)) : -99999);
			const BLOB_R = { [K.broad0]: 0.09, [K.broad1]: 0.08, [K.conifer]: 0.07, [K.acacia]: 0.11, [K.palm]: 0.06, [K.shrub]: 0.045, [K.rock0]: 0.06, [K.rock1]: 0.06, [K.snag]: 0.04 };
			const push = (kind, p, scale, lean, extra) => {
				const hemi = clamp(p.d[1] * 6, -1, 1);
				const h = p.h < 15 ? -99999 : heightOn(p.rr);
				lists[kind].push(p.d[0], p.d[1], p.d[2], h, rng.randf() * 6.2832, scale, lean, rng.randf(), p.t, p.amp * hemi, p.ao, extra);
				// Soft contact shadow under everything that stands on the ground.
				const r = BLOB_R[kind];
				if (r && fine) lists[K.blob].push(p.d[0], p.d[1], p.d[2], h, 0, scale * r, 0, 0.5, p.t, 0, p.ao, 0);
			};
			const area = (fine ? 1 : 1) * 1.0;
			// Trees.
			const nTreeCand = Math.round(1300 * area);
			for (let k = 0; k < nTreeCand; k++) {
				const p = interp(), d = p.d;
				if (p.h < 25 || p.up < 0.86 || p.rivD < 1.35 || p.t < -5 || p.h > 3300) continue;
				const wet = smoothstep(220, 1500, p.p);
				const clump = n3(d[0] * 55 + 3.1, d[1] * 55 + 7.7, d[2] * 55 + 1.3) + 0.5 * n3(d[0] * 150 + 9.2, d[1] * 150 + 2.4, d[2] * 150 + 6.6);
				const riparian = p.rivD < 4.5 ? (1 - wet) * 0.3 : 0;
				let dens = 1.5 * Math.pow(wet, 1.6) * smoothstep(-0.25, 0.25, clump) + riparian * smoothstep(-0.3, 0.2, clump) + 0.008;
				dens *= 1 - 0.7 * p.mesa * smoothstep(0.95, 0.85, p.up);
				if (!fine) dens *= 0.14;
				if (rng.randf() > dens) continue;
				let kind;
				const tm = p.t;
				if (tm < 5 || (tm < 9 && rng.randf() < 0.5) || (p.h > 1600 && rng.randf() < 0.6)) kind = K.conifer;
				else if (tm > 21 && p.p > 1300 && p.h < 300 && rng.randf() < 0.22) kind = K.palm;
				else if (tm > 16 && p.p < 1100 && rng.randf() < 0.75) kind = K.acacia;
				else kind = rng.randf() < 0.5 ? K.broad0 : K.broad1;
				if (wet < 0.35 && rng.randf() < 0.12) kind = K.snag; // a few dead trees in dry country
				push(kind, p, 0.7 + 0.65 * rng.randf(), (rng.randf() - 0.5) * 0.16, wet);
			}
			// Rocks and boulders: cliff feet, steep slopes, gullies, dry country.
			const nRockCand = Math.round((fine ? 420 : 120) * area);
			for (let k = 0; k < nRockCand; k++) {
				const p = interp(), d = p.d;
				if (p.h < 5 || p.up < 0.55 || p.rivD < 1.1) continue;
				const dry = 1 - smoothstep(300, 1400, p.p);
				const foot = (1 - smoothstep(0.55, 0.9, p.ao)) * smoothstep(0.99, 0.8, p.up);
				const clump = n3(d[0] * 120 + 5.5, d[1] * 120 + 1.5, d[2] * 120 + 8.5);
				let dens = 0.004 + 0.8 * foot * (0.3 + 0.7 * p.mesa) + 0.12 * p.gully * dry + 0.08 * dry * smoothstep(0.2, 0.6, clump) + 0.12 * smoothstep(0.97, 0.85, p.up);
				if (!fine) dens = foot > 0.4 ? dens : 0;
				if (rng.randf() > dens) continue;
				const big = rng.randf();
				push(rng.randf() < 0.5 ? K.rock0 : K.rock1, p, (fine ? 0.5 : 0.9) + 1.6 * big * big * (0.4 + foot), (rng.randf() - 0.5) * 0.5, p.warm);
			}
			if (fine) {
				// Shrubs: everywhere vegetated, clustered, denser by water.
				for (let k = 0; k < 900; k++) {
					const p = interp(), d = p.d;
					if (p.h < 18 || p.h > 2300 || p.up < 0.8 || p.rivD < 1.3 || p.t < -3) continue;
					const wet = smoothstep(150, 1300, p.p);
					const clump = n3(d[0] * 90 + 1.9, d[1] * 90 + 6.1, d[2] * 90 + 3.3) + 0.6 * n3(d[0] * 260 + 4.4, d[1] * 260 + 8.8, d[2] * 260 + 2.2);
					const dens = (0.1 + 0.55 * wet) * smoothstep(-0.3, 0.4, clump) + (p.rivD < 5 ? 0.55 : 0) + 0.35 * smoothstep(0.05, 0.4, p.curv);
					if (rng.randf() > dens) continue;
					push(K.shrub, p, 0.6 + 0.9 * rng.randf(), (rng.randf() - 0.5) * 0.2, wet);
				}
				// Grass tufts: dry grassland and steppe.
				for (let k = 0; k < 2600; k++) {
					const p = interp(), d = p.d;
					if (p.h < 22 || p.h > 2300 || p.up < 0.85 || p.rivD < 2.2 || p.t < -3) continue;
					const wet = smoothstep(150, 1300, p.p);
					const clump = n3(d[0] * 200 + 7.3, d[1] * 200 + 3.9, d[2] * 200 + 5.1);
					const dens = (0.75 - 0.55 * wet) * smoothstep(-0.2, 0.3, clump) * smoothstep(80, 300, p.p);
					if (rng.randf() > dens) continue;
					push(K.tuft, p, 1.1 + 1.0 * rng.randf(), (rng.randf() - 0.5) * 0.3, wet);
				}
			}
			return lists.map((l) => Float32Array.from(l));
		}

		// ------------------------------------------------------------ sun shadows
		// The relief is displaced in the vertex shaders, so three's built-in shadow maps
		// cannot see it; this renders the casters (terrain, trees, rocks) with depth
		// variants of their own vertex shaders into an RGBA-packed depth map from an
		// orthographic sun camera centred on the focus, and lit() samples it with PCF.
		_initShadows() {
			const THREE = window.THREE;
			this.shadowRT = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false, generateMipmaps: false });
			this.shadowCam = new THREE.OrthographicCamera(-10, 10, 10, -10, 1, 200);
			this.shadowCam.layers.set(1);
			this.shared.shadow_map.value = this.shadowRT.texture;
			this._v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
		}

		// focusWorld: world-space point the camera looks at; focusLocal: same, planet-space unit vector.
		renderShadows(renderer, sunDirWorld, focusWorld, focusLocal, alt) {
			const THREE = window.THREE, u = this.shared;
			const sunUp = sunDirWorld.dot(this._v[0].copy(focusWorld).normalize());
			const on = smoothstep(0.35, 0.75, this.detail) * smoothstep(-0.02, 0.06, sunUp);
			u.shadow_on.value = on;
			if (on <= 0) return;
			const size = clamp(alt * 1.15, 7, 34), cam = this.shadowCam;
			const texel = (2 * size) / SHADOW_SIZE;
			// Light-space basis; snap the centre to whole texels so shadows do not crawl.
			const up = this._v[1].set(0, 1, 0);
			if (Math.abs(sunDirWorld.y) > 0.95) up.set(1, 0, 0);
			const right = this._v[2].crossVectors(up, sunDirWorld).normalize();
			const lup = this._v[3].crossVectors(sunDirWorld, right).normalize();
			const fx = focusWorld.dot(right), fy = focusWorld.dot(lup);
			const centre = this._v[0].copy(focusWorld).addScaledVector(right, Math.round(fx / texel) * texel - fx).addScaledVector(lup, Math.round(fy / texel) * texel - fy);
			cam.left = -size; cam.right = size; cam.top = size; cam.bottom = -size; cam.near = 1; cam.far = 220;
			cam.position.copy(centre).addScaledVector(sunDirWorld, 110);
			cam.up.copy(lup);
			cam.lookAt(centre);
			cam.updateProjectionMatrix(); cam.updateMatrixWorld();
			u.shadow_matrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
			u.shadow_texel.value = texel;

			// Casters only: depth materials, and cells outside the shadow region hidden.
			const cosLim = Math.cos((size * 1.6) / R + 0.04), hidden = [];
			this.group.updateMatrixWorld();
			for (const [c, e] of this.loaded) {
				if (e.group.visible && dot(this.world.sites[c], focusLocal) < cosLim) { e.group.visible = false; hidden.push(e.group); }
				e.terrain.material = this.terrainDepthMat;
			}
			for (const k of this.vegKinds) k.mesh.material = k.depth;
			const prevTarget = renderer.getRenderTarget(), prevColor = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
			renderer.setRenderTarget(this.shadowRT);
			renderer.setClearColor(0xffffff, 1);
			renderer.clear(true, true, false);
			renderer.render(this.group, cam);
			renderer.setRenderTarget(prevTarget);
			renderer.setClearColor(prevColor, prevAlpha);
			for (const g of hidden) g.visible = true;
			for (const e of this.loaded.values()) e.terrain.material = this.terrainMat;
			for (const k of this.vegKinds) k.mesh.material = k.material;
		}

		// Outlines cell c (pass -1 to clear). `width` is in world units.
		selectCell(c, width) {
			const THREE = window.THREE, w = this.world;
			if (c < 0) { this.selection.visible = false; return; }
			const corners = w.cellCorner[c], m = corners.length, steps = 32;
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
