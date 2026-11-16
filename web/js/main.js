// Demo glue: camera, time, solar system objects, input and HUD.
// Web twin of scripts/main.gd. The home planet always sits at the world origin; the
// star, other planets and orbit lines move around it on a compressed scale. One zoom
// axis takes the camera from the 3D Voronoi map, through the globe, out to the system.
(function () {
	const POC = window.POC, THREE = window.THREE, S = POC.shaders;
	const { clamp, smoothstep } = POC.vec;
	const R = 100, AU = 5000, STAR_R = 350, ALT_MIN = 4, ALT_MAX = 400000;
	const $ = (id) => document.getElementById(id);
	const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
	const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);

	const st = {
		seed: 20261, tDays: 0, timeSpeed: 0.05, paused: false, spin: 0, frameAngle: 0,
		seaLevel: 0, flood: 0, borders: false, strategic: true, lens: 0, season: 0, seasonRising: true, wall: 0,
		alt: 330, altTarget: 330, focus: new THREE.Vector3(0.75, 0.45, 0.48).normalize(), heading: 0, pitchUser: 0,
		selected: -1, ready: false, generating: false, fps: 60, buildBudget: 7,
	};
	let world, system, view, strat, stratView, systemRoot, orbitRoot, starMesh, corona, moon, bodies = [], labels = [];

	// ---------------------------------------------------------------- renderer and fixed scene
	const canvas = $("stage");
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.setClearColor(0x03050b, 1);
	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 3e6);

	const starGeo = new THREE.BufferGeometry();
	{
		const rng = new POC.RNG(99), n = 3500, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) {
			const z = rng.range(-1, 1), a = rng.range(0, 6.2832), r = Math.sqrt(1 - z * z), b = Math.pow(rng.randf(), 2.5) * 0.9 + 0.1, warm = rng.randf();
			pos.set([r * Math.cos(a) * 1e6, z * 1e6, r * Math.sin(a) * 1e6], i * 3);
			col.set([b * (0.75 + 0.25 * warm), b * 0.85, b * (1 - 0.25 * warm)], i * 3);
		}
		starGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
		starGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
	}
	const starField = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
	starField.frustumCulled = false;
	scene.add(starField);

	const atmoMat = new THREE.ShaderMaterial({
		vertexShader: S.atmoVert, fragmentShader: S.atmoFrag, side: THREE.BackSide, transparent: true, depthWrite: false,
		uniforms: { sun_dir_world: { value: new THREE.Vector3(1, 0, 0) }, atm_radius: { value: 104.5 }, planet_radius: { value: 99 } },
	});
	const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(104.5, 96, 48), atmoMat);
	atmosphere.renderOrder = 3;
	scene.add(atmosphere);

	function resize() {
		const w = canvas.clientWidth, h = canvas.clientHeight;
		renderer.setSize(w, h, false);
		camera.aspect = w / h; camera.updateProjectionMatrix();
	}
	window.addEventListener("resize", resize);

	// ---------------------------------------------------------------- generation
	const nextFrame = () => new Promise((r) => setTimeout(r, 0));
	async function generate() {
		if (st.generating) return;
		st.generating = true; st.ready = false;
		$("loading").hidden = false; $("cell").hidden = true;
		if (stratView) { stratView.dispose(); stratView = null; }
		if (view) { scene.remove(view.group); view.dispose(); view = null; }
		if (systemRoot) { scene.remove(systemRoot); systemRoot = null; }
		for (const l of labels) l.el.remove();
		labels = []; bodies = []; st.selected = -1;

		const status = (t, p) => { $("loading-text").textContent = t; $("loading-bar").style.width = Math.round(p * 100) + "%"; };
		status("Forming the star system", 0.02); await nextFrame();
		system = new POC.SolarSystem(); system.generate(st.seed);
		const home = system.home;
		world = new POC.WorldGen();
		world.seed = st.seed; world.radiusKm = home.radius * 6371; world.axialTiltDeg = home.tilt; world.meanTempC = home.meanC;
		const names = POC.WorldGen.STEP_NAMES;
		for (let i = 0; i < names.length; i++) { status(names[i], 0.05 + 0.08 * i); await nextFrame(); world.genStep(i); }
		world.bakeBegin();
		let p = 0;
		while (p < 1) { p = world.bakeStep(30); status("Baking the globe's 2D map", 0.45 + 0.5 * p); await nextFrame(); }
		world.bakeFinish();

		view = new POC.PlanetView(world);
		strat = new POC.Strategic(world);
		stratView = new POC.StrategicView(strat, view);
		scene.add(view.group);
		buildSystem();
		fillStats();
		// Start at a time of day with the sun about 30 degrees above the default focus
		// (long, soft shadows); time then runs normally from there.
		st.tDays = startTime(); st.spin = (6.283185307 * st.tDays) / (system.home.dayH / 24); st.frameAngle = 0;
		$("loading").hidden = true;
		st.generating = false; st.ready = true;
	}

	// Earliest time within the first day when the sun stands about 30 degrees above the
	// default focus, with the sun rising (morning light).
	function startTime() {
		const h = system.home, dayLen = h.dayH / 24, tilt = (h.tilt * Math.PI) / 180, qq = new THREE.Quaternion(), pq = new THREE.Quaternion();
		let best = 0, bestErr = 1e9, prev = -2;
		for (let k = 0; k <= 480; k++) {
			const t = (k / 480) * dayLen, spin = (6.283185307 * t) / dayLen;
			pq.setFromAxisAngle(X, tilt).multiply(qq.setFromAxisAngle(Y, spin % 6.283185307));
			const sun = V(system.planetPos(system.homeIndex, t)).multiplyScalar(-1).normalize().applyQuaternion(pq.invert());
			const f = st.focus.clone().applyAxisAngle(Y, -spin);
			const e = sun.dot(f), err = Math.abs(e - 0.5);
			if (e > prev && err < bestErr) { bestErr = err; best = t; }
			prev = e;
		}
		return best;
	}

	function addLabel(text, obj, cls) {
		const el = document.createElement("div");
		el.className = "body-label" + (cls ? " " + cls : "");
		el.textContent = text; el.hidden = true;
		$("labels").appendChild(el);
		labels.push({ el, obj });
	}

	function buildSystem() {
		systemRoot = new THREE.Group(); scene.add(systemRoot);
		const sc = V(system.star.color);
		view.shared.sun_color.value.copy(sc).lerp(new THREE.Vector3(1, 1, 1), 0.6);
		const common = () => ({ wall_time: view.shared.wall_time });
		starMesh = new THREE.Mesh(new THREE.SphereGeometry(STAR_R, 48, 24), new THREE.ShaderMaterial({ vertexShader: S.starVert, fragmentShader: S.starFrag, uniforms: Object.assign(common(), { star_color: { value: sc } }) }));
		corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ vertexShader: S.coronaVert, fragmentShader: S.coronaFrag, uniforms: { star_color: { value: sc } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
		corona.renderOrder = 4; corona.frustumCulled = false;
		orbitRoot = new THREE.Group();
		systemRoot.add(starMesh, corona, orbitRoot);
		addLabel(system.star.name, starMesh, "star");

		const starPosU = { value: new THREE.Vector3() };
		systemRoot.userData.starPos = starPosU;
		const makeBody = (radius, a, b, banded) => {
			const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 20), new THREE.ShaderMaterial({ vertexShader: S.starVert, fragmentShader: S.bodyFrag, uniforms: Object.assign(common(), { color_a: { value: V(a) }, color_b: { value: V(b) }, banded: { value: banded }, star_pos_world: starPosU }) }));
			systemRoot.add(m);
			return m;
		};
		system.planets.forEach((p, i) => {
			const pts = [];
			for (let k = 0; k <= 256; k++) pts.push(V(system.orbitPoint(i, (6.2832 * k) / 256)).multiplyScalar(AU));
			orbitRoot.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: p.home ? 0xf2c14e : 0x5f7396, transparent: true, opacity: p.home ? 0.9 : 0.55 })));
			const mesh = p.home ? null : makeBody(R * Math.pow(p.radius, 0.6), p.colorA, p.colorB, p.banded);
			bodies.push(mesh);
			addLabel(p.name, mesh || view.group, p.home ? "home" : "");
		});
		moon = makeBody(R * system.moon.radius, [0.62, 0.61, 0.6], [0.36, 0.36, 0.38], 0);
		addLabel(system.moon.name, moon, "moon");
	}

	// ---------------------------------------------------------------- HUD
	function fillStats() {
		const s = system.star, h = system.home, n = (x, d) => x.toFixed(d);
		$("seed").textContent = "seed " + st.seed;
		$("star-name").textContent = `${s.name} · class ${s.cls}`;
		$("star-rows").innerHTML = rows([["Mass", n(s.mass, 2) + " M☉"], ["Radius", n(s.radius, 2) + " R☉"], ["Luminosity", n(s.lum, 2) + " L☉"], ["Surface", Math.round(s.temp).toLocaleString() + " K"]]);
		$("system-rows").innerHTML = system.planets.map((p) => `<div class="row${p.home ? " is-home" : ""}"><span>${p.name}</span><span>${n(p.a, 2)} AU · ${p.type.replace(" (habitable)", "")}</span></div>`).join("");
		$("home-name").textContent = h.name;
		$("home-rows").innerHTML = rows([
			["Radius", Math.round(h.radius * 6371).toLocaleString() + " km"], ["Gravity", n(h.gravity, 2) + " m/s²"],
			["Day", n(h.dayH, 1) + " h"], ["Year", n(h.period, 1) + " days"], ["Axial tilt", n(h.tilt, 1) + "°"],
			["Mean surface", n(h.meanC, 1) + " °C"], ["Land", Math.round(world.landFraction * 100) + " %"],
			["Highest / deepest", `${Math.round(world.maxElev).toLocaleString()} / ${Math.round(world.minElev).toLocaleString()} m`],
			["Cells", `${world.nCells.toLocaleString()} · ${world.riverCells} with rivers`],
		]);
	}
	const rows = (list) => list.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join("");

	function updateHud(detail) {
		const h = system.home, dayLen = h.dayH / 24;
		const year = Math.floor(st.tDays / h.period) + 1, day = ((st.tDays % h.period) / dayLen).toFixed(1);
		const north = st.season > 0.5 ? "summer" : st.season < -0.5 ? "winter" : st.seasonRising ? "spring" : "autumn";
		const south = { summer: "winter", winter: "summer", spring: "autumn", autumn: "spring" }[north];
		$("time-rows").innerHTML = rows([["Date", `year ${year}, day ${day}${st.paused ? " · paused" : ""}`], ["North / south", `${north} / ${south}`]]);
		const mode = detail > 0 ? "3D map" : st.alt < 1500 ? "Globe" : "System";
		$("mode").textContent = mode;
		$("alt").textContent = fmtDist((st.alt / R) * world.radiusKm);
		$("fps").textContent = Math.round(st.fps) + " fps" + (detail > 0 ? ` · ${view.loaded.size} cells` : "");
		$("speed-val").textContent = st.timeSpeed < 1 ? `${(st.timeSpeed * system.home.dayH).toFixed(1)} h/s` : `${st.timeSpeed.toFixed(1)} days/s`;
		$("sea-val").textContent = (st.seaLevel >= 0 ? "+" : "−") + Math.abs(Math.round(st.seaLevel)) + " m";
		$("flood-val").textContent = Math.round(st.flood * 100) + " %";
		const z = $("zoom");
		if (document.activeElement !== z) z.value = Math.log10(st.altTarget);
		for (const b of document.querySelectorAll("[data-alt]")) b.classList.toggle("on", b.dataset.mode === mode);
	}
	const fmtDist = (km) => (km >= 1e6 ? (km / 1e6).toFixed(1) + " M km" : km >= 1000 ? Math.round(km / 100) / 10 + "k km" : Math.round(km) + " km");

	function showCell(c) {
		const info = world.cellInfo(c);
		$("cell-title").textContent = info.title;
		$("cell-id").textContent = "cell " + info.cell;
		$("cell-rows").innerHTML = rows(info.rows);
		$("cell").hidden = false;
	}

	$("speed").addEventListener("input", (e) => (st.timeSpeed = Math.pow(10, +e.target.value)));
	$("sea").addEventListener("input", (e) => (st.seaLevel = +e.target.value));
	$("flood").addEventListener("input", (e) => (st.flood = +e.target.value));
	$("borders").addEventListener("change", (e) => (st.borders = e.target.checked));
	$("strategic").addEventListener("change", (e) => (st.strategic = e.target.checked));
	$("lens").addEventListener("change", (e) => (st.lens = +e.target.value));
	$("zoom").addEventListener("input", (e) => (st.altTarget = Math.pow(10, +e.target.value)));
	$("pause").addEventListener("click", () => togglePause());
	$("regen").addEventListener("click", () => { st.seed++; generate(); });
	$("cell-close").addEventListener("click", () => { $("cell").hidden = true; st.selected = -1; if (view) view.selectCell(-1); });
	for (const b of document.querySelectorAll("[data-alt]")) b.addEventListener("click", () => (st.altTarget = +b.dataset.alt));
	function togglePause() { st.paused = !st.paused; $("pause").textContent = st.paused ? "Resume" : "Pause"; }

	// ---------------------------------------------------------------- input
	const pointers = new Map();
	let dragDist = 0, pinch = 0;
	function tangent() {
		const u = st.focus;
		let e = new THREE.Vector3().crossVectors(Y, u);
		if (e.lengthSq() < 1e-4) e.crossVectors(X, u);
		e.normalize();
		const n = new THREE.Vector3().crossVectors(u, e);
		const fwd = n.multiplyScalar(Math.cos(st.heading)).addScaledVector(e, Math.sin(st.heading));
		return { u, fwd, right: new THREE.Vector3().crossVectors(fwd, u) };
	}
	function pan(dx, dy) {
		const k = Math.min((st.alt * 0.0013) / R, 0.01), t = tangent();
		st.focus.addScaledVector(t.right, -dx * k).addScaledVector(t.fwd, dy * k).normalize();
	}
	canvas.addEventListener("pointerdown", (e) => {
		canvas.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button });
		if (pointers.size === 1) dragDist = 0;
		if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
	});
	canvas.addEventListener("pointermove", (e) => {
		const p = pointers.get(e.pointerId);
		if (!p) return;
		const dx = e.clientX - p.x, dy = e.clientY - p.y;
		p.x = e.clientX; p.y = e.clientY;
		if (pointers.size === 2) {
			const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
			if (pinch > 0) st.altTarget = clamp(st.altTarget * (pinch / d), ALT_MIN, ALT_MAX);
			pinch = d; dragDist = 99;
			st.heading -= dx * 0.002;
			return;
		}
		dragDist += Math.hypot(dx, dy);
		if (p.button === 2 || e.shiftKey) { st.heading -= dx * 0.005; st.pitchUser = clamp(st.pitchUser + dy * 0.004, -1, 0.9); }
		else pan(dx, dy);
	});
	const release = (e) => {
		const p = pointers.get(e.pointerId);
		pointers.delete(e.pointerId); pinch = 0;
		if (p && p.button === 0 && dragDist < 6 && e.type === "pointerup") pick(e.clientX, e.clientY);
	};
	canvas.addEventListener("pointerup", release);
	canvas.addEventListener("pointercancel", release);
	canvas.addEventListener("contextmenu", (e) => e.preventDefault());
	canvas.addEventListener("wheel", (e) => { e.preventDefault(); st.altTarget = clamp(st.altTarget * Math.exp(e.deltaY * 0.0012), ALT_MIN, ALT_MAX); }, { passive: false });
	const keys = new Set();
	window.addEventListener("keydown", (e) => {
		if (e.target.tagName === "INPUT") return;
		keys.add(e.code);
		if (e.code === "Space") { e.preventDefault(); togglePause(); }
		if (e.code === "KeyB") { st.borders = !st.borders; $("borders").checked = st.borders; }
		if (e.code === "KeyR") { st.seed++; generate(); }
	});
	window.addEventListener("keyup", (e) => keys.delete(e.code));

	const ray = new THREE.Raycaster();
	function pick(x, y) {
		if (!st.ready) return;
		const r = canvas.getBoundingClientRect();
		ray.setFromCamera({ x: ((x - r.left) / r.width) * 2 - 1, y: -((y - r.top) / r.height) * 2 + 1 }, camera);
		const ro = ray.ray.origin, rd = ray.ray.direction, b = ro.dot(rd), disc = b * b - (ro.dot(ro) - R * R);
		if (disc < 0 || -b - Math.sqrt(disc) < 0) { st.selected = -1; view.selectCell(-1); $("cell").hidden = true; return; }
		const hit = ro.clone().addScaledVector(rd, -b - Math.sqrt(disc)).applyQuaternion(view.group.quaternion.clone().invert()).normalize();
		st.selected = world.locate([hit.x, hit.y, hit.z], Math.max(st.selected, 0));
		view.selectCell(st.selected, clamp(st.alt * 0.004, 0.06, 1.5));
		showCell(st.selected);
	}

	// ---------------------------------------------------------------- frame
	const tiltQ = new THREE.Quaternion(), planetQ = new THREE.Quaternion(), frameQ = new THREE.Quaternion(), q = new THREE.Quaternion();
	let last = performance.now(), hudTimer = 0;
	function frame(now) {
		requestAnimationFrame(frame);
		const delta = Math.min((now - last) / 1000, 0.1); last = now;
		st.fps += (1 / Math.max(delta, 1e-3) - st.fps) * 0.05;
		if (!st.ready) { renderer.render(scene, camera); return; }
		st.wall += delta;
		if (!st.paused) st.tDays += delta * st.timeSpeed;

		// Keyboard camera controls.
		const mx = (keys.has("KeyA") ? 1 : 0) - (keys.has("KeyD") ? 1 : 0), my = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
		if (mx || my) pan(mx * delta * 500, my * delta * 500);
		if (keys.has("KeyQ")) st.heading += delta;
		if (keys.has("KeyE")) st.heading -= delta;
		if (keys.has("KeyZ")) st.altTarget = Math.max(ALT_MIN, st.altTarget * Math.pow(0.3, delta));
		if (keys.has("KeyX")) st.altTarget = Math.min(ALT_MAX, st.altTarget / Math.pow(0.3, delta));
		st.alt = Math.exp(Math.log(st.alt) + (Math.log(st.altTarget) - Math.log(st.alt)) * (1 - Math.exp(-delta * 8)));

		// Planet rotation. The camera frame co-rotates with the planet only when close,
		// so the ground stays put in map view while the planet visibly spins from afar.
		const home = system.home, dayLen = home.dayH / 24, tilt = (home.tilt * Math.PI) / 180;
		const newSpin = (6.283185307 * st.tDays) / dayLen, follow = 1 - smoothstep(150, 600, st.alt);
		st.frameAngle += (newSpin - st.spin) * follow; st.spin = newSpin;
		tiltQ.setFromAxisAngle(X, tilt);
		planetQ.copy(tiltQ).multiply(q.setFromAxisAngle(Y, st.spin % 6.283185307));
		frameQ.copy(tiltQ).multiply(q.setFromAxisAngle(Y, st.frameAngle % 6.283185307));
		view.group.quaternion.copy(planetQ);

		// Orbits: everything is placed relative to the home planet.
		const homePos = V(system.planetPos(system.homeIndex, st.tDays));
		const starPos = homePos.clone().multiplyScalar(-AU), sunDir = starPos.clone().normalize();
		const sunLocal = sunDir.clone().applyQuaternion(q.copy(planetQ).invert());
		const prev = st.season;
		st.season = clamp(sunLocal.y / Math.max(Math.sin(tilt), 0.01), -1, 1);
		if (Math.abs(st.season - prev) > 1e-7) st.seasonRising = st.season > prev;
		starMesh.position.copy(starPos); orbitRoot.position.copy(starPos);
		systemRoot.userData.starPos.value.copy(starPos);
		bodies.forEach((b, i) => { if (b) b.position.copy(V(system.planetPos(i, st.tDays)).sub(homePos).multiplyScalar(AU)); });
		const ma = (6.283185307 * st.tDays) / system.moon.period;
		moon.position.set(Math.cos(ma), 0.09 * Math.sin(ma), Math.sin(ma)).multiplyScalar(system.moon.dist);

		// Level of detail from altitude, and the uniforms every planet shader shares.
		const detail = 1 - smoothstep(18, 45, st.alt);
		const sh = view.shared;
		view.seaLevel = st.seaLevel; view.detail = detail;
		sh.sea_level.value = st.seaLevel; sh.season.value = st.season; sh.flood.value = st.flood; sh.wall_time.value = st.wall;
		sh.sun_dir_local.value.copy(sunLocal); sh.sun_dir_world.value.copy(sunDir);
		sh.border_strength.value = st.borders ? 1 : 0;
		view.setBorders(st.borders);
		sh.lens.value = st.lens;
		view.globeMat.uniforms.border_strength.value = st.borders ? 0.22 : 0;
		atmoMat.uniforms.sun_dir_world.value.copy(sunDir);

		// Camera rig.
		const t = tangent(), u = t.u, fwd = t.fwd;
		const autoPitch = (42 + (89 - 42) * smoothstep(12, 70, st.alt)) * (Math.PI / 180);
		const pitch = clamp(autoPitch + st.pitchUser, 0.21, 1.562);
		const focusLocal = u.clone().applyAxisAngle(Y, st.frameAngle - st.spin);
		const fl = [focusLocal.x, focusLocal.y, focusLocal.z];
		const target = u.clone().multiplyScalar(view.groundRadius(fl)).applyQuaternion(frameQ);
		const nearDir = u.clone().multiplyScalar(Math.sin(pitch)).addScaledVector(fwd, -Math.cos(pitch)).applyQuaternion(frameQ);
		const nearUp = u.clone().add(fwd).normalize().applyQuaternion(frameQ);
		// Far away the camera lifts above the ecliptic so the orbits are readable.
		const farW = smoothstep(1500, 12000, st.alt), el = clamp(0.96 - st.pitchUser, 0.14, 1.53);
		const farDir = new THREE.Vector3(Math.cos(el) * Math.sin(st.heading), Math.sin(el), Math.cos(el) * Math.cos(st.heading));
		const camDir = slerp(nearDir, farDir, farW), camUp = nearUp.lerp(Y, farW).normalize();
		camera.position.copy(target).addScaledVector(camDir, st.alt);
		camera.up.copy(camUp); camera.lookAt(target);
		camera.near = clamp(st.alt * 0.02, 0.05, 2000); camera.far = 3e6; camera.updateProjectionMatrix();
		starField.position.copy(camera.position);

		const camHeight = camera.position.length() - R;
		view.update(fl, camHeight, detail, st.buildBudget); // ms of cell building per frame
		const camLocal = camera.position.clone().applyQuaternion(q.copy(planetQ).invert()).normalize();
		view.cull([camLocal.x, camLocal.y, camLocal.z], camHeight);
		view.renderShadows(renderer, sunDir, target, fl, st.alt);

		// The glow quad faces the camera and never shrinks below a few pixels.
		const glow = Math.max(STAR_R * 3.5, starPos.distanceTo(camera.position) * 0.05);
		corona.position.copy(starPos); corona.quaternion.copy(camera.quaternion); corona.scale.setScalar(glow);

		renderer.render(scene, camera);
		stratView.update(camera, st.alt, st.strategic, canvas, view.group.quaternion);
		updateLabels();
		hudTimer -= delta;
		if (hudTimer <= 0) { hudTimer = 0.15; updateHud(detail); }
	}
	function slerp(a, b, t) {
		const d = clamp(a.dot(b), -1, 1), th = Math.acos(d);
		if (th < 1e-4 || t <= 0) return a.clone();
		const s = Math.sin(th);
		return a.clone().multiplyScalar(Math.sin((1 - t) * th) / s).addScaledVector(b, Math.sin(t * th) / s).normalize();
	}
	const proj = new THREE.Vector3();
	function updateLabels() {
		const on = st.alt > 1200, w = canvas.clientWidth, h = canvas.clientHeight;
		for (const l of labels) {
			proj.setFromMatrixPosition(l.obj.matrixWorld).project(camera);
			const vis = on && proj.z < 1 && Math.abs(proj.x) < 1 && Math.abs(proj.y) < 1;
			l.el.hidden = !vis;
			if (vis) l.el.style.transform = `translate(${((proj.x + 1) / 2) * w + 10}px, ${((1 - proj.y) / 2) * h - 8}px)`;
		}
	}

	// Small test/automation hook.
	POC.app = { st, generate, renderer, camera, get strat() { return stratView; }, get view() { return view; }, get world() { return world; }, get system() { return system; } };

	if (window.matchMedia("(max-width: 720px)").matches) for (const d of document.querySelectorAll("details.panel")) d.open = false;
	resize();
	requestAnimationFrame(frame);
	generate();
})();
