// Procedural star system with one guaranteed Earth-like "home" planet.
// Web twin of scripts/solar_system.gd. Distances in AU, time in Earth days.
(function () {
	const root = typeof window !== "undefined" ? window : globalThis;
	const POC = (root.POC = root.POC || {});
	const SYL_A = ["Ae", "Bel", "Cor", "Dra", "El", "Fen", "Gal", "Hel", "Ith", "Kor", "Lum", "Mer", "Nor", "Or", "Pha", "Quel", "Rho", "Sol", "Tal", "Vel"];
	const SYL_B = ["a", "an", "ar", "en", "ia", "is", "on", "or", "os", "ur", "yn", "eth"];
	const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
	const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

	function rotY(v, a) { const c = Math.cos(a), s = Math.sin(a); return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]; }
	function rotX(v, a) { const c = Math.cos(a), s = Math.sin(a); return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]; }

	class SolarSystem {
		generate(seed) {
			const rng = new POC.RNG(seed * 7919 + 13);
			const name = () => {
				let s = SYL_A[rng.randi(SYL_A.length)] + SYL_B[rng.randi(SYL_B.length)];
				if (rng.randf() < 0.4) s += SYL_B[rng.randi(SYL_B.length)];
				return s;
			};
			// Main-sequence star from its mass.
			const mass = rng.range(0.78, 1.22), lum = Math.pow(mass, 3.8), radius = Math.pow(mass, 0.8);
			const temp = 5772 * Math.pow(lum / (radius * radius), 0.25);
			this.star = {
				name: name(), mass, lum, radius, temp, cls: temp >= 6000 ? "F" : temp < 5200 ? "K" : "G",
				color: mix3([1.0, 0.72, 0.45], [0.95, 0.96, 1.0], clamp((temp - 4600) / 2200, 0, 1)),
			};
			// Orbits: geometric spacing anchored on a home planet inside the habitable zone.
			const hz = Math.sqrt(lum), homeA = hz * rng.range(0.97, 1.04), ratio = rng.range(1.55, 1.95);
			const inner = rng.irange(1, 3), outer = rng.irange(2, 4), frost = 2.7 * hz;
			this.planets = []; this.homeIndex = inner;
			for (let i = 0; i < inner + outer + 1; i++) {
				const a = homeA * Math.pow(ratio, i - inner), home = i === inner;
				const p = {
					name: name(), a, home,
					e: home ? rng.range(0.005, 0.03) : rng.range(0, 0.09),
					incl: home ? 0 : (rng.range(-3, 3) * Math.PI) / 180,
					peri: rng.range(0, 6.2832), node: rng.range(0, 6.2832), phase: rng.range(0, 6.2832),
					period: 365.25 * Math.sqrt((a * a * a) / mass),
				};
				let albedo = 0.3;
				if (home) {
					const r = rng.range(0.92, 1.08);
					Object.assign(p, { type: "Terrestrial (habitable)", radius: r, mass: Math.pow(r, 3.7), dayH: rng.range(19, 29), tilt: rng.range(14, 30), moons: 1, colorA: [0.2, 0.45, 0.8], colorB: [0.3, 0.6, 0.3], banded: 0 });
				} else if (a < frost) {
					const r = rng.range(0.35, 1.6), hue = rng.range(0.02, 0.12);
					Object.assign(p, { type: "Rocky", radius: r, mass: Math.pow(r, 3.7), dayH: rng.range(10, 2000), tilt: rng.range(0, 40), moons: rng.irange(0, 2), colorA: POC.hsv(hue, 0.45, 0.75), colorB: POC.hsv(hue + 0.03, 0.5, 0.35), banded: 0 });
					albedo = 0.2;
				} else if (a < frost * 4.5) {
					const hue = rng.range(0.05, 0.13);
					Object.assign(p, { type: "Gas giant", radius: rng.range(7, 12), mass: rng.range(60, 400), dayH: rng.range(9, 14), tilt: rng.range(0, 30), moons: rng.irange(12, 90), colorA: POC.hsv(hue, 0.35, 0.9), colorB: POC.hsv(hue - 0.02 + 1, 0.55, 0.55), banded: 1 });
					albedo = 0.45;
				} else {
					const hue = rng.range(0.5, 0.62);
					Object.assign(p, { type: "Ice giant", radius: rng.range(3.4, 4.6), mass: rng.range(12, 20), dayH: rng.range(15, 19), tilt: rng.range(0, 98), moons: rng.irange(5, 30), colorA: POC.hsv(hue, 0.45, 0.85), colorB: POC.hsv(hue + 0.03, 0.6, 0.6), banded: 0.7 });
					albedo = 0.5;
				}
				p.gravity = (9.81 * p.mass) / (p.radius * p.radius);
				p.teq = ((278.5 * Math.pow(lum, 0.25)) / Math.sqrt(a)) * Math.pow(1 - albedo, 0.25);
				if (p.type === "Rocky" && p.teq > 600) p.type = "Lava world";
				// Greenhouse warming on top of the black-body equilibrium temperature.
				if (home) p.meanC = clamp(p.teq - 273.15 + rng.range(31, 35), 9, 20);
				this.planets.push(p);
			}
			this.moon = { name: name(), dist: 900, period: rng.range(18, 36), radius: rng.range(0.2, 0.32) };
		}
		get home() { return this.planets[this.homeIndex]; }

		// Position on orbit i for eccentric anomaly E, in AU. The ecliptic is the XZ plane.
		orbitPoint(i, E) {
			const p = this.planets[i];
			let v = [p.a * (Math.cos(E) - p.e), 0, p.a * Math.sqrt(1 - p.e * p.e) * Math.sin(E)];
			v = rotY(v, p.peri); v = rotX(v, p.incl);
			return rotY(v, p.node);
		}
		// Kepler orbit position of planet i at time tDays, in AU.
		planetPos(i, tDays) {
			const p = this.planets[i], M = ((2 * Math.PI * tDays) / p.period + p.phase) % (2 * Math.PI);
			let E = M;
			for (let k = 0; k < 6; k++) E -= (E - p.e * Math.sin(E) - M) / (1 - p.e * Math.cos(E));
			return this.orbitPoint(i, E);
		}
	}
	POC.SolarSystem = SolarSystem;
})();
