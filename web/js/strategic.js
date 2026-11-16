// HD-2D strategic layer: the 3D terrain is the stage, everything placed on it is a 2D
// sprite or icon. Web twin of what would be scripts/strategic.gd (data) plus a
// strategic view (render). Only derived, deterministic data: nothing in the generated
// world changes.
//
// Data (Strategic): settlements from the existing `pop` data (village / town / port),
// resource icons and landmark "special trees" by biome, a few demo army tokens near
// populated cells and one dotted movement path.
//
// Rendering (StrategicView): ONE instanced billboard batch for every sprite and ONE
// batch of flat contact-shadow discs, both textured from one atlas painted at startup
// with the Canvas 2D API. Army strength plates are HTML overlays (crisp text),
// decluttered and faded by distance. Map lenses live in shaders.js (apply_lens).
(function () {
	const POC = (window.POC = window.POC || {});
	const { cross, norm, lerp3, clamp, smoothstep } = POC.vec;
	const S = POC.shaders;
	const R = 100;

	// Atlas cells (8 x 8 grid of 128 px).
	const SPR = { village: 0, town: 1, port: 2, army: 3, wheat: 4, mine: 5, forest: 6, fish: 7, oak: 8, palms: 9, deadtree: 10, stones: 11, dot: 12, blob: 13 };
	const B = { ICE: 1, TUNDRA: 2, TAIGA: 3, COLD_DESERT: 4, STEPPE: 5, MEDITERRANEAN: 6, TEMPERATE_FOREST: 7, TEMPERATE_RAINFOREST: 8, DESERT: 9, SAVANNA: 10, TROPICAL_SEASONAL: 11, TROPICAL_RAINFOREST: 12, ALPINE: 13 };
	// Semantic zoom bands (camera altitude, world units): sprites appear below z1.
	const Z_SETTLE = 40, Z_DETAIL = 12;

	class Strategic {
		constructor(world) {
			const w = world, rng = new POC.RNG(w.seed * 13 + 5);
			this.world = w;
			const coastal = (c) => w.cellNb[c].some((j) => w.elev[j] <= 0);
			this.settlements = []; this.features = []; this.armies = []; this.path = null;
			for (let c = 0; c < w.nCells; c++) {
				if (w.elev[c] <= 0) continue;
				const p = w.pop[c], b = w.biome[c];
				if (p > 0.3) this.settlements.push({ cell: c, kind: coastal(c) && rng.randf() < 0.5 ? SPR.port : p > 0.6 ? SPR.town : SPR.village });
				const u = rng.randf(), v = rng.randf();
				let kind = -1;
				if (u < 0.05) kind = b === B.TEMPERATE_FOREST || b === B.TEMPERATE_RAINFOREST || b === B.MEDITERRANEAN ? SPR.oak : b === B.TROPICAL_RAINFOREST || b === B.TROPICAL_SEASONAL || b === B.SAVANNA ? SPR.palms : b === B.DESERT || b === B.COLD_DESERT ? SPR.deadtree : SPR.stones;
				else if (v < 0.25 && b !== B.ICE) {
					if (w.elev[c] > 1300) kind = SPR.mine;
					else if (coastal(c) && v < 0.1) kind = SPR.fish;
					else if (w.precip[c] > 1100) kind = SPR.forest;
					else if (p > 0.25) kind = SPR.wheat;
				}
				if (kind >= 0) this.features.push({ cell: c, kind });
			}
			// Demo armies: next to the most populated cells, spread out.
			const byPop = this.settlements.map((s) => s.cell).sort((a, b) => w.pop[b] - w.pop[a]);
			const used = new Set();
			for (const c of byPop) {
				if (this.armies.length >= 14) break;
				if (w.cellNb[c].some((j) => used.has(j)) || used.has(c)) continue;
				const nb = w.cellNb[c].filter((j) => w.elev[j] > 0);
				if (!nb.length) continue;
				const a = nb[rng.randi(nb.length)];
				used.add(c); used.add(a);
				this.armies.push({ cell: a, strength: (20 + rng.randi(100)) * 100 });
			}
			// One movement order: the first army marches to a neighbouring land cell.
			for (const a of this.armies) {
				const tgt = w.cellNb[a.cell].find((j) => w.elev[j] > 0 && !used.has(j));
				if (tgt !== undefined) { this.path = { from: a.cell, to: tgt }; break; }
			}
		}
	}

	// ------------------------------------------------------------------ sprite atlas
	// Illustrated icons with a dark outline so they read at small sizes.
	function drawAtlas() {
		const cv = document.createElement("canvas");
		cv.width = cv.height = 1024;
		const g = cv.getContext("2d"), CELL = 128, INK = "#1e1710";
		g.lineJoin = "round"; g.lineCap = "round";
		const at = (i, fn) => { g.save(); g.translate((i % 8) * CELL, Math.floor(i / 8) * CELL); fn(); g.restore(); };
		const shape = (pts, fill, lw) => { g.beginPath(); g.moveTo(pts[0], pts[1]); for (let k = 2; k < pts.length; k += 2) g.lineTo(pts[k], pts[k + 1]); g.closePath(); g.lineWidth = lw || 6; g.strokeStyle = INK; g.stroke(); g.fillStyle = fill; g.fill(); };
		const circle = (x, y, r, fill, lw) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.lineWidth = lw || 5; g.strokeStyle = INK; g.stroke(); g.fillStyle = fill; g.fill(); };
		const house = (x, y, w, h, roof, wall) => { shape([x, y, x + w, y, x + w, y - h, x, y - h], wall || "#e8d6b0", 5); shape([x - 4, y - h, x + w + 4, y - h, x + w / 2, y - h - w * 0.6], roof || "#b8432e", 5); g.fillStyle = "#4a3320"; g.fillRect(x + w * 0.4, y - h * 0.5, w * 0.2, h * 0.5); };
		const tower = (x, y, w, h, roof) => { shape([x, y, x + w, y, x + w, y - h, x, y - h], "#d8cbb0", 5); shape([x - 5, y - h, x + w + 5, y - h, x + w / 2, y - h - w * 1.1], roof || "#3c4a78", 5); };
		at(SPR.village, () => { house(28, 112, 30, 24, "#b8432e"); house(64, 116, 34, 28, "#9c5a2e"); house(46, 92, 26, 20, "#c0603a"); });
		at(SPR.town, () => { house(14, 116, 30, 30); house(80, 116, 32, 30, "#9c5a2e"); tower(50, 118, 28, 64, "#b8432e"); house(38, 122, 24, 20, "#c0603a"); });
		at(SPR.port, () => { house(10, 100, 30, 26, "#b8432e"); house(46, 104, 28, 24, "#9c5a2e"); shape([10, 108, 118, 108, 118, 122, 10, 122], "#7a5a3a", 4); shape([70, 104, 112, 104, 104, 116, 78, 116], "#8a5a30", 4); g.lineWidth = 4; g.strokeStyle = INK; g.beginPath(); g.moveTo(92, 104); g.lineTo(92, 60); g.stroke(); shape([92, 62, 92, 98, 116, 98], "#f0ead8", 4); });
		// army token: a row of soldiers with spears and a plain neutral pennant
		at(SPR.army, () => {
			for (let k = 0; k < 5; k++) {
				const x = 16 + k * 22, y = 120 - (k % 2) * 4;
				g.lineWidth = 3; g.strokeStyle = INK; g.beginPath(); g.moveTo(x + 9, y - 6); g.lineTo(x + 9, y - 52); g.stroke();
				shape([x - 4, y, x + 8, y, x + 7, y - 26, x - 3, y - 26], "#9a3a2e", 4);
				circle(x + 2, y - 32, 6, "#e0b890", 3);
				shape([x - 4, y - 36, x + 8, y - 36, x + 2, y - 44], "#8a8a92", 3);
			}
			g.lineWidth = 4; g.strokeStyle = INK; g.beginPath(); g.moveTo(64, 116); g.lineTo(64, 14); g.stroke();
			shape([64, 14, 100, 22, 64, 32], "#e8dcc0", 4);
		});
		at(SPR.wheat, () => { shape([8, 118, 120, 118, 104, 86, 24, 86], "#d8b048", 5); g.strokeStyle = "#9a7020"; g.lineWidth = 3; for (let k = 0; k < 9; k++) { g.beginPath(); g.moveTo(22 + k * 10, 116); g.lineTo(28 + k * 9, 90); g.stroke(); } });
		at(SPR.mine, () => { shape([10, 122, 64, 48, 118, 122], "#8a7a6a", 6); shape([46, 122, 46, 96, 82, 96, 82, 122], "#2a2018", 4); g.lineWidth = 6; g.strokeStyle = "#7a5530"; g.beginPath(); g.moveTo(42, 96); g.lineTo(86, 96); g.stroke(); circle(96, 108, 8, "#e0c040", 3); });
		at(SPR.forest, () => { for (const [x, y, s] of [[34, 118, 1], [70, 120, 1.15], [98, 116, 0.9]]) { shape([x - 4 * s, y, x + 4 * s, y, x + 4 * s, y - 14 * s, x - 4 * s, y - 14 * s], "#6a4428", 3); shape([x - 22 * s, y - 12 * s, x + 22 * s, y - 12 * s, x, y - 70 * s], "#3f6a2c", 5); } });
		at(SPR.fish, () => { shape([20, 80, 70, 56, 98, 80, 70, 102], "#7aa8c8", 6); shape([96, 80, 120, 62, 120, 98], "#7aa8c8", 5); circle(44, 76, 4, INK, 1); g.strokeStyle = "#3a6a9a"; g.lineWidth = 4; g.beginPath(); for (let x = 8; x < 120; x += 4) g.lineTo(x, 116 + Math.sin(x * 0.2) * 4); g.stroke(); });
		at(SPR.oak, () => { shape([56, 124, 72, 124, 70, 70, 58, 70], "#6a4428", 5); for (const [x, y, r] of [[64, 50, 34], [36, 66, 24], [92, 66, 24], [50, 30, 22], [80, 32, 22]]) circle(x, y, r, "#4f7a32", 6); for (const [x, y, r] of [[56, 40, 12], [84, 44, 10]]) { g.fillStyle = "#6e9a44"; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); } });
		at(SPR.palms, () => { for (const [x, h, b] of [[40, 90, -10], [74, 110, 8], [100, 80, 14]]) { g.lineWidth = 9; g.strokeStyle = INK; g.beginPath(); g.moveTo(x, 124); g.quadraticCurveTo(x + b, 124 - h * 0.5, x + b, 124 - h); g.stroke(); g.lineWidth = 5; g.strokeStyle = "#8a6a40"; g.stroke(); for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; shape([x + b, 124 - h, x + b + Math.cos(a) * 26, 124 - h + Math.sin(a) * 10 + 8, x + b + Math.cos(a + 0.3) * 14, 124 - h + 4], "#4f8a34", 3); } } });
		at(SPR.deadtree, () => { const tr = () => { g.beginPath(); g.moveTo(64, 124); g.lineTo(62, 70); g.lineTo(40, 40); g.moveTo(62, 70); g.lineTo(86, 34); g.moveTo(72, 54); g.lineTo(98, 58); g.moveTo(46, 48); g.lineTo(30, 52); g.stroke(); }; g.lineWidth = 11; g.strokeStyle = INK; tr(); g.lineWidth = 6; g.strokeStyle = "#9a8068"; tr(); });
		at(SPR.stones, () => { for (const [x, w, h] of [[16, 18, 48], [42, 20, 64], [70, 22, 70], [98, 18, 50]]) shape([x, 122, x + w, 122, x + w - 2, 122 - h, x + 2, 122 - h - 4], "#9a9688", 5); shape([36, 54, 96, 54, 96, 46, 36, 46], "#9a9688", 4); });
		at(SPR.dot, () => { const gr = g.createRadialGradient(64, 64, 4, 64, 64, 40); gr.addColorStop(0, "rgba(255,240,200,1)"); gr.addColorStop(1, "rgba(255,240,200,0)"); g.fillStyle = gr; g.fillRect(0, 0, CELL, CELL); circle(64, 64, 16, "#fff2c8", 5); });
		at(SPR.blob, () => { const gr = g.createRadialGradient(64, 64, 2, 64, 64, 62); gr.addColorStop(0, "rgba(0,0,0,1)"); gr.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = gr; g.fillRect(0, 0, CELL, CELL); });
		const THREE = window.THREE, tex = new THREE.CanvasTexture(cv);
		tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = true; tex.anisotropy = 4;
		return tex;
	}

	// ------------------------------------------------------------------ view
	class StrategicView {
		constructor(strat, view) {
			const THREE = window.THREE;
			this.s = strat; this.view = view; this.world = strat.world;
			this.u = { atlas: { value: drawAtlas() }, cam_alt: { value: 30 }, layer_on: { value: 1 }, flat_mode: { value: 0 } };
			this.group = new THREE.Group();
			this.group.matrixAutoUpdate = false;
			view.group.add(this.group);
			this._buildSprites();
			this._buildLabels();
		}
		// Height of the drawn surface under d (the same function as the cell meshes).
		_h(d, cell) { this.world.surface(d, cell, 1); return this.world.sH; }

		_buildSprites() {
			const THREE = window.THREE, s = this.s, w = this.world, rng = new POC.RNG(w.seed * 3 + 1);
			const inst = [];
			// instance: dir xyz, height | atlas cell, size, zoom max, unused | rgb tint, glow
			const add = (d, cell, sprite, size, z1, glow) => { inst.push(d[0], d[1], d[2], this._h(d, cell), sprite, size, z1, 0, 1, 1, 1, glow || 0); };
			const off = (c, a, r) => { const p = w.sites[c], e1 = norm(cross(p, Math.abs(p[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = cross(p, e1); return norm([p[0] + (e1[0] * Math.cos(a) + e2[0] * Math.sin(a)) * r, p[1] + (e1[1] * Math.cos(a) + e2[1] * Math.sin(a)) * r, p[2] + (e1[2] * Math.cos(a) + e2[2] * Math.sin(a)) * r]); };
			this.anchors = [];
			for (const t of s.settlements) add(w.sites[t.cell], t.cell, t.kind, t.kind === SPR.village ? 0.36 : 0.46, Z_SETTLE, 0);
			for (const a of s.armies) {
				const d = off(a.cell, rng.randf() * 6.28, 0.012);
				add(d, a.cell, SPR.army, 0.42, Z_DETAIL, 0);
				this.anchors.push({ d, h: this._h(d, a.cell), text: a.strength.toLocaleString("en-US") });
			}
			for (const f of s.features) add(off(f.cell, rng.randf() * 6.28, 0.014 + rng.randf() * 0.01), f.cell, f.kind, f.kind >= SPR.oak ? 0.4 : 0.32, Z_DETAIL, 0);
			if (s.path) { // dotted movement order along the surface
				const a = w.sites[s.path.from], b = w.sites[s.path.to];
				for (let k = 1; k < 16; k++) add(norm(lerp3(a, b, k / 16)), s.path.from, SPR.dot, 0.13, 30, 1);
			}
			this.nSprites = inst.length / 12;
			const quad = new THREE.InstancedBufferGeometry();
			quad.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
			quad.setIndex([0, 1, 2, 0, 2, 3]);
			const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(inst), 12, 1);
			quad.setAttribute("ipos", new THREE.InterleavedBufferAttribute(buf, 4, 0));
			quad.setAttribute("iinfo", new THREE.InterleavedBufferAttribute(buf, 4, 4));
			quad.setAttribute("icol", new THREE.InterleavedBufferAttribute(buf, 4, 8));
			quad.instanceCount = this.nSprites;
			const mk = (flat) => this.view._mat(S.spriteVert, S.spriteFrag, Object.assign({}, this.u, { flat_mode: { value: flat } }), flat ? { transparent: true, depthWrite: false } : { side: THREE.DoubleSide });
			this.sprites = new THREE.Mesh(quad, mk(0));
			this.blobs = new THREE.Mesh(quad, mk(1));
			for (const m of [this.sprites, this.blobs]) { m.frustumCulled = false; m.matrixAutoUpdate = false; this.group.add(m); }
			this.blobs.renderOrder = 1;
		}

		_buildLabels() {
			const host = document.getElementById("labels");
			for (const a of this.anchors) {
				const el = document.createElement("div");
				el.className = "plate";
				el.textContent = a.text;
				el.style.opacity = "0";
				host.appendChild(el);
				a.el = el; a.w = 0; a.hgt = 0;
			}
		}
		dispose() { for (const a of this.anchors) a.el.remove(); this.view.group.remove(this.group); }

		// Per frame: uniforms, then project, declutter and fade the strength plates.
		update(camera, alt, on, canvas, planetQuat) {
			const THREE = window.THREE;
			this.u.cam_alt.value = alt; this.u.layer_on.value = on ? 1 : 0;
			this.group.visible = on && this.view.detail > 0;
			const W = canvas.clientWidth, H = canvas.clientHeight, placed = [], v = this._v || (this._v = new THREE.Vector3()), n = this._n || (this._n = new THREE.Vector3());
			const band = 1 - smoothstep(Z_DETAIL * 0.75, Z_DETAIL, alt), det = this.view.detail;
			for (const a of this.anchors) {
				let vis = 0;
				if (on && band > 0.01) {
					const hh = R + POC.PlanetView.disp(Math.max(a.h, this.view.seaLevel)) * det;
					v.set(a.d[0] * hh, a.d[1] * hh, a.d[2] * hh).applyQuaternion(planetQuat);
					n.copy(v).normalize();
					const facing = n.dot(this._t ? this._t.copy(camera.position).sub(v).normalize() : (this._t = camera.position.clone().sub(v).normalize()));
					const dist = v.distanceTo(camera.position);
					v.project(camera);
					if (v.z < 1 && facing > 0.05 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1) {
						const x = ((v.x + 1) / 2) * W, y = ((1 - v.y) / 2) * H;
						if (!a.w) { a.w = a.el.offsetWidth; a.hgt = a.el.offsetHeight; }
						const rect = [x - a.w / 2, y + 3, a.w, a.hgt];
						if (!placed.some((p) => rect[0] < p[0] + p[2] + 4 && p[0] < rect[0] + rect[2] + 4 && rect[1] < p[1] + p[3] + 2 && p[1] < rect[1] + rect[3] + 2)) {
							placed.push(rect);
							vis = band * (1 - smoothstep(alt * 3, alt * 5, dist));
							a.el.style.transform = `translate(${rect[0].toFixed(1)}px, ${rect[1].toFixed(1)}px)`;
						}
					}
				}
				const o = vis.toFixed(2);
				if (a.el.style.opacity !== o) a.el.style.opacity = o;
			}
		}
	}

	POC.Strategic = Strategic;
	POC.StrategicView = StrategicView;
	POC.SPRITE = SPR;
})();
