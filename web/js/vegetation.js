// Procedural meshes for the instanced vegetation and rocks (no model files).
// Web twin of what would be a small mesh-building script in Godot (SurfaceTool /
// ArrayMesh): each builder returns a BufferGeometry with
//   position, normal  (normals are "soft": blended toward the crown centre so a
//                      crown made of several blobs shades as one painterly volume)
//   aveg = (part, shade, 0, 0): part 0 wood, 1 foliage, 2 rock, 3 grass;
//          shade 0..1 is baked self-occlusion (dark inside / underneath).
// Sizes are in world units (1 unit = PLANET_R / 100); +Y is up, the base is at y = 0.
(function () {
	const POC = (window.POC = window.POC || {});

	const T = (1 + Math.sqrt(5)) / 2;
	const ICO_V = [[-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0], [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T], [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1]];
	const ICO_F = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
	const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

	// Unit icosphere: detail 0 = 20 faces, 1 = 80 faces.
	function ico(detail) {
		const v = ICO_V.map(nrm);
		let f = ICO_F.slice();
		for (let k = 0; k < detail; k++) {
			const cache = new Map(), nf = [];
			const mid = (a, b) => {
				const key = a < b ? a + "_" + b : b + "_" + a;
				if (!cache.has(key)) { cache.set(key, v.length); v.push(nrm([v[a][0] + v[b][0], v[a][1] + v[b][1], v[a][2] + v[b][2]])); }
				return cache.get(key);
			};
			for (let i = 0; i < f.length; i += 3) {
				const a = f[i], b = f[i + 1], c = f[i + 2], ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
				nf.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
			}
			f = nf;
		}
		return { v, f };
	}

	class Builder {
		constructor(seed) { this.p = []; this.n = []; this.a = []; this.i = []; this.rng = new POC.RNG(seed); }
		r(a, b) { return a + (b - a) * this.rng.randf(); }
		vert(p, n, part, shade) { this.p.push(p[0], p[1], p[2]); const q = nrm(n); this.n.push(q[0], q[1], q[2]); this.a.push(part, shade, 0, 0); return this.p.length / 3 - 1; }
		// Triangle wound so its face normal agrees with the vertex normals (outward).
		tri(a, b, c) {
			const P = this.p, N = this.n;
			const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
			const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
			const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
			const hx = N[a * 3] + N[b * 3] + N[c * 3], hy = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], hz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
			if (fx * hx + fy * hy + fz * hz >= 0) this.i.push(a, b, c); else this.i.push(a, c, b);
		}
		// Jittered ellipsoid blob; normals lean toward `crown` (soft volume shading).
		blob(c, rad, detail, jitter, part, crown, crownMix) {
			const g = ico(detail), base = this.p.length / 3;
			for (const v of g.v) {
				const k = 1 + (this.rng.randf() - 0.5) * jitter;
				const p = [c[0] + v[0] * rad[0] * k, c[1] + v[1] * rad[1] * k, c[2] + v[2] * rad[2] * k];
				const toC = crown ? nrm([p[0] - crown[0], p[1] - crown[1], p[2] - crown[2]]) : v;
				const nb = nrm([v[0] / rad[0], v[1] / rad[1], v[2] / rad[2]]);
				this.vert(p, [nb[0] * (1 - crownMix) + toC[0] * crownMix, nb[1] * (1 - crownMix) + toC[1] * crownMix, nb[2] * (1 - crownMix) + toC[2] * crownMix], part, 1);
			}
			for (let i = 0; i < g.f.length; i += 3) this.tri(base + g.f[i], base + g.f[i + 1], base + g.f[i + 2]);
		}
		// Open tapered tube (trunk) from y0 to y1, optionally bent toward +x.
		tube(y0, y1, r0, r1, seg, bend, part) {
			const base = this.p.length / 3, rings = 3;
			for (let k = 0; k <= rings; k++) {
				const t = k / rings, y = y0 + (y1 - y0) * t, r = r0 + (r1 - r0) * t, ox = bend * t * t;
				for (let s = 0; s < seg; s++) {
					const a = (s / seg) * Math.PI * 2;
					this.vert([ox + Math.cos(a) * r, y, Math.sin(a) * r], [Math.cos(a), 0.2, Math.sin(a)], part, 0.35 + 0.4 * t);
				}
			}
			for (let k = 0; k < rings; k++) for (let s = 0; s < seg; s++) {
				const a = base + k * seg + s, b = base + k * seg + ((s + 1) % seg), c = a + seg, d = b + seg;
				this.tri(a, b, d); this.tri(a, d, c);
			}
		}
		// One conifer tier: jittered, slightly drooping skirt ring, apex and underside.
		tier(y0, y1, r, seg, crown) {
			const base = this.p.length / 3;
			const apex = this.vert([this.r(-0.004, 0.004), y1, this.r(-0.004, 0.004)], [0, 1, 0], 1, 1);
			const under = this.vert([0, y0 + (y1 - y0) * 0.25, 0], [0, -1, 0], 1, 0.15);
			for (let s = 0; s < seg; s++) {
				const a = (s / seg) * Math.PI * 2 + this.r(-0.2, 0.2), rr = r * this.r(0.8, 1.15);
				const p = [Math.cos(a) * rr, y0 - this.r(0, 0.012), Math.sin(a) * rr];
				const toC = nrm([p[0] - crown[0], p[1] - crown[1], p[2] - crown[2]]);
				this.vert(p, [Math.cos(a) * 0.6 + toC[0] * 0.4, 0.55 + toC[1] * 0.4, Math.sin(a) * 0.6 + toC[2] * 0.4], 1, 0.55);
			}
			for (let s = 0; s < seg; s++) {
				const a = base + 2 + s, b = base + 2 + ((s + 1) % seg);
				this.tri(a, b, apex); this.tri(b, a, under);
			}
		}
		// Baked self-occlusion for foliage: darker low in the crown and toward its core.
		shadeFoliage(cy, cr) {
			let y0 = 1e9, y1 = -1e9;
			for (let v = 0; v < this.p.length / 3; v++) if (this.a[v * 4] === 1) { y0 = Math.min(y0, this.p[v * 3 + 1]); y1 = Math.max(y1, this.p[v * 3 + 1]); }
			for (let v = 0; v < this.p.length / 3; v++) {
				if (this.a[v * 4] !== 1) continue;
				const t = (this.p[v * 3 + 1] - y0) / Math.max(y1 - y0, 1e-4);
				const rr = Math.hypot(this.p[v * 3], (this.p[v * 3 + 1] - cy) * 0.8, this.p[v * 3 + 2]) / cr;
				this.a[v * 4 + 1] *= Math.min(1, 0.35 + 0.5 * t + 0.35 * rr);
			}
		}
		build(flatNormals) {
			const THREE = window.THREE, g = new THREE.BufferGeometry();
			g.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3));
			g.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3));
			g.setAttribute("aveg", new THREE.Float32BufferAttribute(this.a, 4));
			g.setIndex(this.i);
			if (flatNormals) g.computeVertexNormals();
			return g;
		}
	}

	const G = (POC.vegGeometry = {});

	// Rounded broadleaf: a trunk and a crown of 4-5 merged, jittered blobs.
	G.broadleaf = (seed) => {
		const b = new Builder(seed), h = 0.12;
		b.tube(-0.05, h + 0.03, 0.012, 0.007, 5, b.r(-0.01, 0.01), 0);
		const crown = [0, h + 0.07, 0], n = 5;
		b.blob([0, h + 0.08, 0], [0.085, 0.07, 0.085], 0, 0.22, 1, crown, 0.55);
		for (let k = 0; k < n - 1; k++) {
			const a = (k / (n - 1)) * Math.PI * 2 + b.r(-0.4, 0.4), d = b.r(0.045, 0.07);
			b.blob([Math.cos(a) * d, h + b.r(0.03, 0.11), Math.sin(a) * d], [b.r(0.045, 0.06), b.r(0.04, 0.055), b.r(0.045, 0.06)], 0, 0.3, 1, crown, 0.6);
		}
		b.shadeFoliage(crown[1], 0.12);
		return b.build();
	};
	// Layered conifer: stacked drooping tiers on a short trunk.
	G.conifer = (seed) => {
		const b = new Builder(seed), top = 0.34;
		b.tube(-0.05, 0.08, 0.011, 0.007, 5, 0, 0);
		const crown = [0, 0.16, 0], tiers = 4;
		for (let k = 0; k < tiers; k++) {
			const t = k / tiers, y0 = 0.05 + t * 0.22, y1 = y0 + 0.13 - t * 0.02;
			b.tier(y0, Math.min(y1, top), 0.085 * (1 - t * 0.68), 7, crown);
		}
		b.shadeFoliage(crown[1], 0.1);
		return b.build();
	};
	// Flat-topped savanna tree (acacia): forked trunk, wide umbrella crown.
	G.acacia = (seed) => {
		const b = new Builder(seed), h = 0.15;
		b.tube(-0.05, h, 0.011, 0.006, 5, 0.03, 0);
		b.tube(h * 0.55, h + 0.01, 0.006, 0.004, 4, -0.05, 0);
		const crown = [0, h + 0.01, 0];
		b.blob([0.02, h + 0.02, 0], [0.12, 0.03, 0.1], 0, 0.25, 1, crown, 0.35);
		b.blob([-0.06, h + 0.005, 0.03], [0.07, 0.025, 0.06], 0, 0.3, 1, crown, 0.4);
		b.blob([0.08, h + 0.01, -0.04], [0.06, 0.022, 0.06], 0, 0.3, 1, crown, 0.4);
		b.shadeFoliage(crown[1], 0.12);
		return b.build();
	};
	// Palm: curved trunk and drooping fronds.
	G.palm = (seed) => {
		const b = new Builder(seed), h = 0.3, bend = 0.05;
		b.tube(-0.05, h, 0.01, 0.007, 5, bend, 0);
		const top = [bend, h, 0], n = 7;
		for (let k = 0; k < n; k++) {
			const a = (k / n) * Math.PI * 2 + b.r(-0.2, 0.2), dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
			const L = b.r(0.12, 0.16), w = 0.022;
			const m = [top[0] + dx * L * 0.45, top[1] + 0.03, top[2] + dz * L * 0.45], e = [top[0] + dx * L, top[1] - b.r(0.03, 0.06), top[2] + dz * L];
			const up = [dx * 0.3, 1, dz * 0.3];
			const t0 = b.vert(top, up, 1, 0.6), ml = b.vert([m[0] + px * w, m[1], m[2] + pz * w], up, 1, 0.9), mr = b.vert([m[0] - px * w, m[1], m[2] - pz * w], up, 1, 0.9), tip = b.vert(e, up, 1, 1);
			b.tri(t0, ml, mr); b.tri(ml, tip, mr);
		}
		return b.build();
	};
	// Low shrub: two or three squat blobs.
	G.shrub = (seed) => {
		const b = new Builder(seed), crown = [0, 0.025, 0];
		b.blob([0, 0.028, 0], [0.042, 0.032, 0.04], 0, 0.3, 1, crown, 0.5);
		b.blob([0.03, 0.018, 0.012], [0.03, 0.024, 0.028], 0, 0.3, 1, crown, 0.5);
		b.blob([-0.022, 0.016, -0.02], [0.028, 0.022, 0.03], 0, 0.3, 1, crown, 0.5);
		b.shadeFoliage(crown[1], 0.05);
		return b.build();
	};
	// Grass tuft: a fan of thin blades.
	G.tuft = (seed) => {
		const b = new Builder(seed), n = 7;
		for (let k = 0; k < n; k++) {
			const a = (k / n) * Math.PI * 2 + b.r(-0.3, 0.3), dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
			const r0 = 0.006, w = 0.004, L = b.r(0.03, 0.05), out = b.r(0.012, 0.025);
			const nn = [dx * 0.5, 1, dz * 0.5];
			const b0 = b.vert([dx * r0 + px * w, -0.005, dz * r0 + pz * w], nn, 3, 0.35), b1 = b.vert([dx * r0 - px * w, -0.005, dz * r0 - pz * w], nn, 3, 0.35);
			const tip = b.vert([dx * (r0 + out), L, dz * (r0 + out)], nn, 3, 1);
			b.tri(b0, b1, tip);
		}
		return b.build();
	};
	// Boulder: lumpy icosphere, flattened underneath.
	G.rock = (seed) => {
		const b = new Builder(seed), g = ico(1), base = 0;
		const waves = [0, 1, 2].map(() => [nrm([b.r(-1, 1), b.r(-1, 1), b.r(-1, 1)]), b.r(2, 4), b.r(0, 6.28)]);
		const flat = b.r(0.55, 0.8);
		for (const v of g.v) {
			let k = 1;
			for (const [dir, f, ph] of waves) k += 0.13 * Math.cos((v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]) * f + ph);
			k += (b.rng.randf() - 0.5) * 0.08;
			const p = [v[0] * 0.05 * k, Math.max(v[1] * k, -0.3) * 0.05 * flat + 0.012, v[2] * 0.05 * k * b.r(0.97, 1.03)];
			b.vert(p, v, 2, 0.5 + 0.5 * Math.max(v[1], 0));
		}
		for (let i = 0; i < g.f.length; i += 3) b.tri(base + g.f[i], base + g.f[i + 1], base + g.f[i + 2]);
		return b.build(true);
	};
})();
