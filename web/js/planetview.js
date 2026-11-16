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
	const RISER_W = [0.21, 0.5, 1.0]; // minimum cliff-wall width (world units) per level: about 1.9x its vertex spacing
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

	// Moves unit vector d sideways by up to `amp` radians, by a hash of d itself.
	const jitter = (d, amp) => {
		let h = Math.imul(Math.round(d[0] * 4e6) | 0, 73856093) ^ Math.imul(Math.round(d[1] * 4e6) | 0, 19349663) ^ Math.imul(Math.round(d[2] * 4e6) | 0, 83492791);
		h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); h ^= h >>> 15;
		const u = ((h & 1023) / 1023 - 0.5) * 2 * amp, v = (((h >>> 10) & 1023) / 1023 - 0.5) * 2 * amp;
		const [e1, e2] = tangentBasis(d);
		return norm([d[0] + e1[0] * u + e2[0] * v, d[1] + e1[1] * u + e2[1] * v, d[2] + e1[2] * u + e2[2] * v]);
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
			this.riverGridMat = mat(S.riverGridVert, S.riverGridFrag, null, { side: THREE.DoubleSide, transparent: true, depthWrite: false, extensions: { derivatives: true } });
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
		static get LOD_SUB() { return LOD_SUB; }
		static get RISER_W() { return RISER_W; }

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
		_vertex(d, start, eps, out, o, rw) {
			const w = this.world;
			const c = w.surface(d, start, 1, rw);
			const h = w.sH;
			out.data[o * 4] = h; out.data[o * 4 + 1] = w.sT; out.data[o * 4 + 2] = w.sA; out.data[o * 4 + 3] = w.sP;
			out.surf[o * 4] = w.sMesa; out.surf[o * 4 + 1] = w.sGully; out.surf[o * 4 + 3] = Math.min(w.sRivD, 99);
			out.col[o * 4] = w.sRock[0]; out.col[o * 4 + 1] = w.sRock[1]; out.col[o * 4 + 2] = w.sRock[2]; out.col[o * 4 + 3] = w.pop[c];
			out.riv[o] = w.sRivL;
			const [e1, e2] = tangentBasis(d);
			const r0 = R + disp(h);
			const d1 = norm([d[0] + e1[0] * eps, d[1] + e1[1] * eps, d[2] + e1[2] * eps]);
			w.gHold = w.sG; // the riser-width gradient barely changes over eps: reuse it
			w.surface(d1, c, 1, rw); const r1 = R + disp(w.sH);
			const d2 = norm([d[0] + e2[0] * eps, d[1] + e2[1] * eps, d[2] + e2[2] * eps]);
			w.surface(d2, c, 1, rw); const r2 = R + disp(w.sH);
			w.gHold = 0;
			const ax = d1[0] * r1 - d[0] * r0, ay = d1[1] * r1 - d[1] * r0, az = d1[2] * r1 - d[2] * r0;
			const bx = d2[0] * r2 - d[0] * r0, by = d2[1] * r2 - d[1] * r0, bz = d2[2] * r2 - d[2] * r0;
			let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
			let nl = Math.hypot(nx, ny, nz) || 1;
			if (nx * d[0] + ny * d[1] + nz * d[2] < 0) nl = -nl;
			out.nrm[o * 4] = nx / nl; out.nrm[o * 4 + 1] = ny / nl; out.nrm[o * 4 + 2] = nz / nl;
			// Five horizon probes on two rings: how much of the sky the ground around hides.
			// (Five, not six, to pay for the riser-width clamp in surface().)
			let occ = 0, curv = 0;
			const dh = disp(h);
			for (let k = 0; k < 5; k++) {
				const a = k * 1.2566 + 0.35, rr = AO_R[k < 3 ? 0 : 1], ca = Math.cos(k < 3 ? a * 1.6667 : a) * rr, sa = Math.sin(k < 3 ? a * 1.6667 : a) * rr;
				const dk = norm([d[0] + e1[0] * ca + e2[0] * sa, d[1] + e1[1] * ca + e2[1] * sa, d[2] + e1[2] * ca + e2[2] * sa]);
				w.surface(dk, c, 2);
				const rise = disp(w.sH) - dh, e = rise / (rr * R);
				if (e > 0) occ += e / Math.sqrt(1 + e * e);
				if (k < 3) curv += rise;
			}
			out.nrm[o * 4 + 3] = clamp(1 - occ / 5 * 1.1, 0.2, 1);
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
				// Jitter amplitude for this fan triangle: a fifth of its smaller grid spacing.
				const ac = (u, q) => Math.acos(clamp(dot(u, q), -1, 1));
				const jit = (0.2 * Math.min(ac(pa, pb), ac(pc, pa), ac(pc, pb))) / SUB;
				// Triangle (site, corner a, corner b) as a grid: row r runs parallel to the cell edge.
				for (let r = 0; r <= SUB; r++) {
					for (let s = 0; s <= r; s++) {
						const wb = s / SUB, wa = (r - s) / SUB, wc = 1 - r / SUB;
						let d = norm([pc[0] * wc + pa[0] * wa + pb[0] * wb, pc[1] * wc + pa[1] * wa + pb[1] * wb, pc[2] * wc + pa[2] * wa + pb[2] * wb]);
						// Interior vertices are jittered sideways (by a hash of their own
						// direction): flat-shaded rock then breaks into irregular facets
						// instead of a regular diamond pattern. Vertices on the sides of the
						// fan triangle (shared with the next one) and the cell edge stay put.
						if (s > 0 && s < r && r < SUB) d = jitter(d, jit);
						out.pos[v * 3] = d[0] * R; out.pos[v * 3 + 1] = d[1] * R; out.pos[v * 3 + 2] = d[2] * R;
						start = this._vertex(d, start, eps, out, v, RISER_W[lod]);
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
			// River water near the camera is drawn with the terrain's own vertices at the
			// river's water level (like the sea), so the shoreline is the exact
			// intersection with the carved bed. The ribbon (_addRivers) only shows far away.
			let nearRiver = false;
			for (let i = 0; i < nGrid && !nearRiver; i++) nearRiver = out.surf[i * 4 + 3] < 2.5;
			if (nearRiver) add(new THREE.Mesh(geo, this.riverGridMat), 1);

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
			const wantVeg = lod <= VEG_LOD && w.elev[c] > -500;
			if (wantVeg && !this.vegPlans.has(c)) yield* this._vegPlanGen(c);
			const veg = wantVeg ? this._placeVegetation(c, lod, out) : null;
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
			this.vegCells = new Map(); this.vegPlans = new Map(); this.vegDirty = false; this._vegTime = 0;
			// [name, geometry, leaf colour, wood colour, kind id, global instance cap]
			const kinds = [
				["broad0", G.broadleaf(11), [0.17, 0.22, 0.08], [0.24, 0.17, 0.11], 0, 2600],
				["broad1", G.broadleaf(23, true), [0.20, 0.24, 0.09], [0.24, 0.17, 0.11], 0, 2600],
				["conifer", G.conifer(5), [0.08, 0.14, 0.08], [0.20, 0.14, 0.10], 1, 6000],
				["acacia", G.acacia(7), [0.26, 0.27, 0.11], [0.26, 0.19, 0.12], 2, 5000],
				["palm", G.palm(3), [0.20, 0.27, 0.09], [0.36, 0.29, 0.20], 3, 3000],
				["shrub", G.shrub(9), [0.20, 0.22, 0.09], [0.22, 0.16, 0.10], 4, 7000],
				["tuft", G.tuft(4), [0.40, 0.36, 0.15], [0.40, 0.34, 0.16], 5, 20000],
				["boulder", G.boulder(13), [0.46, 0.40, 0.33], [0.40, 0.35, 0.30], 6, 4000],
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

		// Vegetation and boulders are planned once per cell from the surface function
		// (position, height, slope from the surface normal, river and cliff distances),
		// seeded by the cell id, so the plan is the same at every level of detail and
		// cached. Each level then shows a fixed subset (by instance rank) with heights
		// snapped to its own drawn triangles, so nothing floats, sinks or moves.
		//
		// Candidates: per kind, a fully jittered grid in the cell's tangent plane taken
		// in random order (stratified, then thinned: blue-noise-like, no rows), a cheap
		// noise pre-pass (groves and clearings) before any surface() call, then hard
		// exclusions and a minimum spacing that varies with a low-frequency field.
		_vegPlan(c) {
			const hit = this.vegPlans.get(c);
			if (hit) return hit;
			const it = this._vegPlanGen(c);
			let r;
			do { r = it.next(); } while (!r.done);
			return r.value;
		}
		// Generator (yields every few dozen surface samples, so a cell build stays
		// within the per-frame budget).
		*_vegPlanGen(c) {
			let work = 0;
			const tick = () => (++work & 31) === 0;
			const w = this.world, n3 = w.sn, K = this.kindIndex, rng = new POC.RNG((w.seed * 7919 + c * 104729 + 17) | 0);
			const pc = w.sites[c], [t1, t2] = tangentBasis(pc);
			let rad = 0;
			for (const k of w.cellCorner[c]) rad = Math.max(rad, Math.acos(clamp(dot(pc, w.cornerPos[k]), -1, 1)));
			const cosRad = Math.cos(rad), radU = rad * R, cellWet = smoothstep(220, 1500, w.precip[c]), hasRiv = w.riverNear[c].length > 0;
			const plan = this.vegKinds.map(() => []);
			// Grid hash of accepted instances per spacing class, in tangent-plane units.
			const HC = 0.1, hash = [new Map(), new Map(), new Map(), new Map()];
			const near = (cls, u, v, r) => {
				const H = hash[cls], i0 = Math.floor((u - r) / HC), i1 = Math.floor((u + r) / HC), j0 = Math.floor((v - r) / HC), j1 = Math.floor((v + r) / HC);
				for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
					const L = H.get(i * 4096 + j);
					if (L) for (let k = 0; k < L.length; k += 2) if ((L[k] - u) ** 2 + (L[k + 1] - v) ** 2 < r * r) return true;
				}
				return false;
			};
			const mark = (cls, u, v) => { const key = Math.floor(u / HC) * 4096 + Math.floor(v / HC), H = hash[cls]; let L = H.get(key); if (!L) H.set(key, (L = [])); L.push(u, v); };
			// Candidates for one kind: jittered grid of spacing g, shuffled.
			// pmax: an upper bound of the kind's acceptance in this cell; points are
			// thinned by it before any work (the loops then accept with pre / pmax).
			const cands = (g, pmax) => {
				const n = Math.ceil((2 * radU) / g), list = [];
				for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
					const u = (i + rng.randf()) * g - radU, v = (j + rng.randf()) * g - radU;
					if (rng.randf() > pmax) continue;
					if (u * u + v * v > radU * radU) continue;
					const d = norm([pc[0] + (t1[0] * u + t2[0] * v) / R, pc[1] + (t1[1] * u + t2[1] * v) / R, pc[2] + (t1[2] * u + t2[2] * v) / R]);
					if (dot(d, pc) < cosRad || w.locate(d, c) !== c) continue;
					list.push([u, v, d]);
				}
				for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rng.randf() * (i + 1)), t = list[i]; list[i] = list[j]; list[j] = t; }
				return list;
			};
			// Groves and clearings: warped two-octave noise, so patches differ in size and
			// shape instead of repeating one blob; plus a slow field for spacing.
			const groveF = (d) => {
				const wq = 0.35 * n3(d[0] * 21 + 4.4, d[1] * 21 + 1.3, d[2] * 21 + 7.9);
				return n3(d[0] * 48 + wq + 3.1, d[1] * 48 - wq + 7.7, d[2] * 48 + wq + 1.3) + 0.45 * n3(d[0] * 131 + 9.2, d[1] * 131 + 2.4, d[2] * 131 + 6.6);
			};
			const slowF = (d) => 0.5 + 0.5 * n3(d[0] * 17 + 5.5, d[1] * 17 + 0.5, d[2] * 17 + 3.3);
			// Full sample: surface data and the slope (degrees, displaced space) from the
			// surface normal over a fixed 0.06-unit step.
			const S = {};
			const sample = (d) => {
				w.surface(d, c, 1);
				Object.assign(S, { d, G: w.sG, h: w.sH, t: w.sT, amp: w.sA, p: w.sP, mesa: w.sMesa, gully: w.sGully, mtn: w.sMtn, rivX: w.sRivX, rivHW: w.sRivHW, rivL: w.sRivL, risD: w.sRisD, risHW: w.sRisHW, risH: w.sRisH });
				// Only risers that are real walls (mean slope over ~25 deg in the drawn,
				// displaced relief) count as cliffs; wide gentle ones are just slopes.
				S.wall = S.risHW > 0 && (S.risH * 0.0018) / (2 * S.risHW) > 0.45;
				S.cliff = S.wall ? Math.abs(S.risD) - S.risHW : 99; // distance beyond the riser (world units)
				S.dry = S.rivHW > 0 ? S.rivX : 99;                         // distance from the channel edge
				S.wet = smoothstep(220, 1500, S.p);
				return S;
			};
			// Slope (degrees, displaced space) from the surface normal over a 0.06-unit
			// step; evaluated last, only for points that passed everything else.
			const slopeOf = (S) => {
				const d = S.d, [e1, e2] = tangentBasis(d), eps = 0.0006, r0 = R + disp(S.h);
				w.gHold = S.G;
				const d1 = norm([d[0] + e1[0] * eps, d[1] + e1[1] * eps, d[2] + e1[2] * eps]); w.surface(d1, c, 1); const r1 = R + disp(w.sH);
				const d2 = norm([d[0] + e2[0] * eps, d[1] + e2[1] * eps, d[2] + e2[2] * eps]); w.surface(d2, c, 1); const r2 = R + disp(w.sH);
				w.gHold = 0;
				const ax = d1[0] * r1 - d[0] * r0, ay = d1[1] * r1 - d[1] * r0, az = d1[2] * r1 - d[2] * r0;
				const bx = d2[0] * r2 - d[0] * r0, by = d2[1] * r2 - d[1] * r0, bz = d2[2] * r2 - d[2] * r0;
				const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
				return (Math.acos(clamp(Math.abs(nx * d[0] + ny * d[1] + nz * d[2]) / (Math.hypot(nx, ny, nz) || 1), 0, 1)) * 180) / Math.PI;
			};
			const push = (kind, d, s, scale, lean, extra) => {
				const hemi = clamp(d[1] * 6, -1, 1);
				plan[kind].push(d[0], d[1], d[2], s.h, rng.randf() * 6.2832, scale, lean, rng.randf(), s.t, s.amp * hemi, 1, extra);
			};

			// Trees. Exclusions: slope <= 22 deg; 0.15 units clear of any riser (rim and
			// foot); the channel plus a bank margin of 0.14 + 1.1 half widths; dry land
			// 20 m above the sea and 6 m above the river. Riparian band just beyond that.
			const treeMax = Math.min(1, (0.006 + 0.55 * Math.pow(cellWet, 1.5) + (hasRiv ? 0.15 : 0)) * 1.3);
			for (const [u, v, d] of cands(0.06, treeMax)) {
				const g = groveF(d), clearing = smoothstep(-0.2, 0.3, g);
				const pre = Math.min(1, (0.006 + 0.55 * Math.pow(cellWet, 1.5) * clearing + (hasRiv ? 0.15 : 0)) * 1.3);
				if (rng.randf() * treeMax > pre) continue;
				const sp = 0.085 + 0.1 * slowF(d) * (0.6 + 0.4 * (1 - clearing));
				if (near(0, u, v, sp)) continue;
				// Cheap river test first: no tree in the channel or on the bank shelf, and
				// the riparian share of `pre` only applies near a river.
				const rx = hasRiv ? w.riverEdgeDist(d, c) : 99;
				if (rx < 0.14 || (rx > 1.2 && rng.randf() * pre > pre - (hasRiv ? 0.15 * 1.3 : 0))) continue;
				if (tick()) yield;
				const s = sample(d);
				if (s.h < 20 || s.h > 3300 || s.t < -5 || s.cliff < 0.15 || s.h < s.rivL + 6) continue;
				const bank = 0.14 + 1.1 * s.rivHW;
				if (s.dry < bank) continue;
				const riparian = s.dry < bank + 0.55 ? 0.12 + 0.2 * (1 - s.wet) : 0;
				const dens = 0.006 + 0.55 * Math.pow(s.wet, 1.5) * clearing + riparian * smoothstep(-0.5, 0.1, g);
				if (rng.randf() * pre > dens || slopeOf(s) > 22) continue;
				let kind;
				const tm = s.t;
				if (tm < 5 || (tm < 9 && rng.randf() < 0.5) || (s.h > 1600 && rng.randf() < 0.6)) kind = K.conifer;
				else if (tm > 21 && s.p > 1300 && s.h < 300 && rng.randf() < 0.22) kind = K.palm;
				else if (tm > 16 && s.p < 1100 && rng.randf() < 0.75) kind = K.acacia;
				else kind = rng.randf() < 0.5 ? K.broad0 : K.broad1;
				if (s.wet < 0.35 && rng.randf() < 0.1) kind = K.snag;
				// Bigger, older trees inside groves; smaller at their edges and alone.
				push(kind, d, s, (0.62 + 0.45 * clearing) * (0.85 + 0.35 * rng.randf()), (rng.randf() - 0.5) * 0.14, s.wet);
				mark(0, u, v);
			}
			// Shrubs: groves' edges, hollows and banks; looser limits.
			const shrubMax = Math.min(1, 0.025 + 0.15 * cellWet + (hasRiv ? 0.12 : 0));
			for (const [u, v, d] of cands(0.06, shrubMax)) {
				const g = groveF(d), edge = 1 - Math.abs(smoothstep(-0.4, 0.5, g) * 2 - 1);
				const pre = Math.min(1, 0.025 + 0.15 * cellWet * (0.4 + 0.6 * edge) + (hasRiv ? 0.12 : 0));
				if (rng.randf() * shrubMax > pre) continue;
				const sp = 0.045 + 0.04 * slowF(d);
				if (near(1, u, v, sp) || near(0, u, v, 0.05)) continue;
				const rx = hasRiv ? w.riverEdgeDist(d, c) : 99;
				if (rx < 0.07 || (rx > 0.8 && rng.randf() * pre > pre - (hasRiv ? 0.12 : 0))) continue;
				if (tick()) yield;
				const s = sample(d);
				if (s.h < 15 || s.h > 2300 || s.t < -3 || s.cliff < 0.06 || s.h < s.rivL + 3) continue;
				const bank = 0.07 + 0.6 * s.rivHW;
				if (s.dry < bank) continue;
				const dens = (0.02 + 0.14 * s.wet) * (0.4 + 0.6 * edge) + (s.dry < bank + 0.4 ? 0.12 : 0);
				if (rng.randf() * pre > dens || slopeOf(s) > 32) continue;
				push(K.shrub, d, s, 0.6 + 0.9 * rng.randf(), (rng.randf() - 0.5) * 0.2, s.wet);
				mark(1, u, v);
			}
			// Grass tufts: dry grassland and steppe, off banks and walls.
			const tuftMax = Math.min(1, (0.75 - 0.5 * cellWet) * smoothstep(80, 300, w.precip[c])) * 0.2;
			for (const [u, v, d] of cands(0.06, tuftMax)) {
				const tg = n3(d[0] * 200 + 7.3, d[1] * 200 + 3.9, d[2] * 200 + 5.1) + 0.5 * n3(d[0] * 61 + 1.7, d[1] * 61 + 8.3, d[2] * 61 + 2.9);
				if (rng.randf() > smoothstep(-0.35, 0.35, tg)) continue;
				if (near(2, u, v, 0.03)) continue;
				if (tick()) yield;
				const s = sample(d);
				if (s.h < 22 || s.h > 2300 || s.t < -3 || s.cliff < 0.04 || s.dry < 0.12 + 0.8 * s.rivHW || s.h < s.rivL + 3) continue;
				if (rng.randf() * tuftMax > (0.75 - 0.55 * s.wet) * smoothstep(80, 300, s.p) * 0.2 || slopeOf(s) > 30) continue;
				push(K.tuft, d, s, 1.1 + 1.0 * rng.randf(), (rng.randf() - 0.5) * 0.3, s.wet);
				mark(2, u, v);
			}
			// Boulders: talus at cliff feet (largest, cliff-chunk size), along rims,
			// river banks, mountain scree and gullies; a few anywhere in dry country.
			// Coloured like the local rock (extra = redness, as in terrainFrag).
			// Two levels: a coarse jittered grid finds the zones (foot, rim, bank, scree,
			// gully); only there are a few nearby candidates sampled. Elsewhere a rare
			// lone boulder in dry country.
			const rocky = hasRiv || w.mesaP[c] > 0.05 || w.rug[c] > 200;
			const dryc = (s) => 1 - smoothstep(300, 1400, s.p);
			const zoneOf = (s) => {
				const foot = s.wall && s.risH > 70 && s.risD < -s.risHW * 0.55 && s.risD > -s.risHW - 0.45 ? 1 : 0;
				const rimz = s.wall && s.risH > 70 && s.risD > s.risHW * 0.75 && s.risD < s.risHW + 0.12 ? 1 : 0;
				const bankz = s.rivHW > 0 && s.dry < 0.12 + 0.9 * s.rivHW ? 1 : 0;
				const scree = smoothstep(0.25, 0.6, s.mtn); // mountain flanks (slope is checked at placement)
				return { foot, rimz, bankz, scree, any: foot + rimz + bankz + scree > 0.3 || s.gully * dryc(s) > 0.85 };
			};
			const placeBoulder = (u, v, d, s, z, dens) => {
				if (s.h < 3 || s.dry < 0.01 || s.h < s.rivL + 1 || rng.randf() > dens) return;
				const sl = slopeOf(s);
				if (sl > 52 || (z.scree > 0 && !z.foot && !z.bankz && sl < 12)) return;
				const big = rng.randf();
				let scale = z.foot ? 1.2 + 3.8 * big * big * smoothstep(60, 220, s.risH) + 0.6 * big : z.bankz ? 0.7 + 1.3 * big : 0.6 + 1.6 * big * big;
				if (z.rimz) scale *= 0.8;
				if (near(3, u, v, 0.03 + 0.055 * scale)) return;
				const warmDry = smoothstep(6, 16, s.t) * (1 - smoothstep(700, 1900, s.p));
				const red = clamp(warmDry * 0.85 + s.mesa * 0.35, 0, 1) * (1 - smoothstep(1800, 3000, s.h) * 0.7) * (1 - Math.max(smoothstep(1700, 2500, s.h), 1 - smoothstep(-6, 1, s.t)));
				push(K.boulder, d, s, scale, (rng.randf() - 0.5) * 0.6, red);
				mark(3, u, v);
			};
			for (const [u0, v0, d0] of cands(0.3, rocky ? 1 : 0.12)) {
				if (tick()) yield;
				let s = sample(d0), z = zoneOf(s);
				const dc = dryc(s);
				if (!z.any) { placeBoulder(u0, v0, d0, s, z, 0.008 * dc); continue; }
				for (let k = 0; k < 4; k++) {
					const a = rng.randf() * 6.2832, rr = 0.18 * Math.sqrt(rng.randf()), u = u0 + Math.cos(a) * rr, v = v0 + Math.sin(a) * rr;
					const d = norm([pc[0] + (t1[0] * u + t2[0] * v) / R, pc[1] + (t1[1] * u + t2[1] * v) / R, pc[2] + (t1[2] * u + t2[2] * v) / R]);
					if (w.locate(d, c) !== c) continue;
					s = sample(d); z = zoneOf(s);
					placeBoulder(u, v, d, s, z, 0.005 * dc + 0.75 * z.foot + 0.15 * z.rimz + 0.25 * z.bankz + 0.3 * z.scree + 0.04 * s.gully * dc);
				}
			}
			const out = plan.map((l) => Float32Array.from(l));
			this.vegPlans.set(c, out);
			if (this.vegPlans.size > 900) this.vegPlans.delete(this.vegPlans.keys().next().value); // bounded cache
			return out;
		}

		// The cell's plan at one level of detail: a fixed subset by instance rank, heights
		// snapped to the drawn grid of that level (barycentric in the fan triangle), AO
		// from the nearest vertex, contact-shadow discs at the finest level only.
		_placeVegetation(c, lod, out) {
			const w = this.world, K = this.kindIndex, plan = this._vegPlan(c), SUB = LOD_SUB[lod];
			const corners = w.cellCorner[c], m = corners.length, pc = w.sites[c], rowLen = ((SUB + 1) * (SUB + 2)) / 2;
			// Inverse of [site, corner a, corner b] per fan triangle.
			const inv = [];
			for (let i = 0; i < m; i++) {
				const a = pc, b = w.cornerPos[corners[i]], d = w.cornerPos[corners[(i + 1) % m]];
				const c0 = cross(b, d), c1 = cross(d, a), c2 = cross(a, b), det = dot(a, c0);
				inv.push([c0, c1, c2, det]);
			}
			const vh = (i, r, s) => disp(out.data[(i * rowLen + (r * (r + 1)) / 2 + s) * 4]);
			const drawn = (d) => {
				let bi = 0, bw = null, bmin = -1e9;
				for (let i = 0; i < m; i++) {
					const [c0, c1, c2, det] = inv[i], x = dot(d, c0) / det, y = dot(d, c1) / det, z = dot(d, c2) / det, sum = x + y + z, mn = Math.min(x, y, z) / sum;
					if (mn > bmin) { bmin = mn; bi = i; bw = [x / sum, y / sum, z / sum]; }
				}
				const Rf = clamp((1 - bw[0]) * SUB, 0, SUB), Sf = clamp(bw[2] * SUB, 0, Rf);
				const r0 = Math.min(Math.floor(Rf), SUB - 1), s0 = Math.min(Math.floor(Sf), r0), fx = Rf - r0, fy = clamp(Sf - s0, 0, 1);
				const rr = fy <= fx ? (1 - fx) * vh(bi, r0, s0) + (fx - fy) * vh(bi, r0 + 1, s0) + fy * vh(bi, r0 + 1, s0 + 1)
					: (1 - fy) * vh(bi, r0, s0) + fx * vh(bi, r0 + 1, s0 + 1) + (fy - fx) * vh(bi, r0, Math.min(s0 + 1, r0));
				const ao = out.nrm[(bi * rowLen + (Math.round(Rf) * (Math.round(Rf) + 1)) / 2 + Math.min(Math.round(Sf), Math.round(Rf))) * 4 + 3];
				return [rr >= 0 ? -RELIEF_H0 * Math.log(Math.max(1 - rr / RELIEF_MAX, 1e-6)) : -99999, ao];
			};
			// Share of each kind kept at this level (by rank = iparam.w).
			const keep = (ki, scale, rank) => {
				if (lod === 0) return true;
				if (ki === K.tuft) return false;
				if (ki === K.shrub) return rank < 0.12;
				if (ki === K.boulder) return scale > 1.6 || rank < 0.25;
				return rank < 0.35;
			};
			const BLOB_R = { [K.broad0]: 0.09, [K.broad1]: 0.08, [K.conifer]: 0.07, [K.acacia]: 0.11, [K.palm]: 0.06, [K.shrub]: 0.045, [K.boulder]: 0.055, [K.snag]: 0.04 };
			const lists = plan.map(() => []);
			plan.forEach((a, ki) => {
				for (let i = 0; i < a.length; i += 12) {
					if (!keep(ki, a[i + 5], a[i + 7])) continue;
					const d = [a[i], a[i + 1], a[i + 2]], [h, ao] = drawn(d);
					const L = lists[ki], o = L.length;
					for (let k = 0; k < 12; k++) L.push(a[i + k]);
					L[o + 3] = a[i + 3] < 15 && ki !== K.boulder ? -99999 : h; L[o + 10] = ao;
					const br = BLOB_R[ki];
					if (br && lod === 0) lists[K.blob].push(d[0], d[1], d[2], L[o + 3], 0, a[i + 5] * br, 0, 0.5, a[i + 8], 0, ao, 0);
				}
			});
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
