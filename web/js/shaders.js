// GLSL for the web POC. COMMON mirrors shaders/common.gdshaderinc function for
// function; the only web-only parts are lit() and tonemap(), which Godot's renderer
// provides by itself (write ALBEDO / ROUGHNESS / EMISSION there instead).
(function () {
	const POC = (window.POC = window.POC || {});
	const S = (POC.shaders = {});

	S.COMMON = /* glsl */ `
	const float PLANET_R = 100.0;
	const float RELIEF_MAX = 5.0;     // world units the highest peaks approach
	const float RELIEF_H0 = 2500.0;   // metres; lowlands are exaggerated more than peaks
	const float SEA_FLOOR = 1.0;      // deepest rendered sea bed, in world units
	const float PI = 3.14159265;
	const float TAU = 6.2831853;

	uniform float sea_level;      // metres relative to the generated datum
	uniform float detail;         // 0 = flat globe, 1 = full 3D relief
	uniform float season;         // -1 = northern winter solstice, +1 = northern summer
	uniform vec3 sun_dir_local;   // sun direction in planet space
	uniform vec3 sun_dir_world;
	uniform vec3 sun_color;
	uniform float wall_time;      // real seconds, cosmetic animation

	float disp(float h) {
		if (h >= 0.0) return RELIEF_MAX * (1.0 - exp(-h / RELIEF_H0));
		return -SEA_FLOOR * (1.0 - exp(h * RELIEF_MAX / RELIEF_H0 / SEA_FLOOR));
	}
	float hash13(vec3 p) {
		p = fract(p * 0.1031);
		p += dot(p, p.zyx + 31.32);
		return fract((p.x + p.y) * p.z);
	}
	float vnoise(vec3 p) {
		vec3 i = floor(p);
		vec3 f = fract(p);
		f = f * f * (3.0 - 2.0 * f);
		float a = mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x);
		float b = mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x);
		float c = mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x);
		float d = mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x);
		return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
	}
	float fbm(vec3 p) {
		float amp = 0.5;
		float sum = 0.0;
		for (int i = 0; i < 4; i++) {
			sum += amp * vnoise(p);
			p = p * 2.03 + vec3(17.1, 3.7, 9.2);
			amp *= 0.5;
		}
		return sum / 0.9375;
	}
	// Current temperature (deg C) from annual mean + seasonal half-range.
	float temp_now(float tmean, float tamp, vec3 dir) {
		float hemi = clamp(dir.y * 6.0, -1.0, 1.0);
		return tmean + tamp * season * hemi;
	}
	// Stylised Whittaker-style land colour from climate.
	vec3 land_color(float h, float tnow, float tmean, float precip, vec3 dir, vec3 rock) {
		float n = fbm(dir * 55.0);
		float wet = clamp(smoothstep(0.1, 1.0, sqrt(max(precip, 0.0) / 1800.0)) + (n - 0.5) * 0.25, 0.0, 1.0);
		// Muted, earthy palette: olive and khaki land rather than saturated greens.
		vec3 desert = vec3(0.50, 0.38, 0.19);
		vec3 tundra = vec3(0.30, 0.30, 0.21);
		vec3 savanna = vec3(0.40, 0.33, 0.13);
		vec3 grass = vec3(0.24, 0.29, 0.10);
		vec3 taiga = vec3(0.16, 0.24, 0.15);
		vec3 forest = vec3(0.19, 0.28, 0.11);
		vec3 jungle = vec3(0.12, 0.24, 0.09);
		vec3 dry = mix(tundra, desert, smoothstep(-2.0, 16.0, tmean));
		vec3 mid = mix(tundra, mix(grass, savanna, smoothstep(15.0, 23.0, tmean)), smoothstep(-4.0, 5.0, tmean));
		vec3 lush = mix(taiga, mix(forest, jungle, smoothstep(17.0, 24.0, tmean)), smoothstep(1.0, 9.0, tmean));
		vec3 col = wet < 0.5 ? mix(dry, mid, wet * 2.0) : mix(mid, lush, wet * 2.0 - 1.0);
		// Seasonal dormancy of temperate vegetation.
		float temperate = smoothstep(0.0, 6.0, tmean) * (1.0 - smoothstep(16.0, 22.0, tmean));
		float dormant = (1.0 - smoothstep(1.0, 9.0, tnow)) * temperate;
		col = mix(col, vec3(0.50, 0.36, 0.17), dormant * 0.55);
		// Freshly exposed sea bed, then the beach strip around the current shoreline.
		col = mix(col, vec3(0.55, 0.48, 0.35), (1.0 - smoothstep(-200.0, 0.0, h)) * 0.8);
		col = mix(vec3(0.66, 0.46, 0.16), col, smoothstep(20.0, 150.0, h - sea_level)); // golden shore
		// Bare rock at altitude, snow wherever it is currently freezing.
		col = mix(col, rock, smoothstep(1800.0, 3600.0, h) * 0.85);
		float snow = 1.0 - smoothstep(-5.0, 0.5, tnow + (n - 0.5) * 4.0);
		col = mix(col, vec3(0.92, 0.95, 1.0), snow);
		// Each terrace level gets its own tone, lighter with height, like a relief map.
		float level = clamp(floor(h / 300.0 + 0.5), 0.0, 7.0);
		col *= 0.82 + 0.05 * level;
		return col * (0.88 + 0.24 * n);
	}
	vec3 water_color(float depth, float tnow) {
		// Sea-green over the shelf, through dark teal, to slate-navy in the deeps.
		vec3 shallow = vec3(0.11, 0.34, 0.15);
		vec3 shelf = vec3(0.05, 0.20, 0.13);
		vec3 deep = vec3(0.025, 0.065, 0.14);
		vec3 col = mix(shallow, shelf, smoothstep(0.0, 900.0, depth));
		col = mix(col, deep, smoothstep(600.0, 2600.0, depth));
		float ice = 1.0 - smoothstep(-7.0, -2.5, tnow);
		return mix(col, vec3(0.82, 0.90, 0.96), ice);
	}
	// Value-noise fbm whose octaves fade out once they get finer than a pixel.
	// cpp = cycles per pixel of the first octave (pixel footprint * frequency).
	float fbm_aa(vec3 p, float cpp) {
		float amp = 0.5;
		float sum = 0.0;
		for (int i = 0; i < 4; i++) {
			float keep = 1.0 - smoothstep(0.2, 0.5, cpp);
			sum += amp * mix(0.5, vnoise(p), keep);
			p = p * 2.03 + vec3(17.1, 3.7, 9.2);
			cpp *= 2.03;
			amp *= 0.5;
		}
		return sum / 0.9375;
	}
	// How much of a pattern of the given frequency (cycles per planet radius, as in
	// noise(d * freq)) survives at this pixel footprint (world units per pixel).
	float aa_keep(float freq, float px) {
		return 1.0 - smoothstep(0.15, 0.45, px * freq / PLANET_R);
	}
	// Close-up ground texture: scrub and woodland clumps, dry ochre patches, rock
	// outcrops, a patchwork of fields around settlements and fine grain. amount fades
	// it in with zoom (0 on the globe); px is the pixel footprint in world units, used
	// to drop detail that would otherwise shimmer. Returns the colour; bump receives a
	// height-like value for perturbing the normal.
	vec3 ground_detail(vec3 col, vec3 d, float h, float precip, float pop, vec3 rock, float amount, float px, out float bump) {
		bump = 0.0;
		float land = smoothstep(60.0, 170.0, h - sea_level) * amount;
		if (land <= 0.0) return col;
		float wet = smoothstep(150.0, 1300.0, precip);
		float lum = dot(col, vec3(0.3, 0.55, 0.15));
		vec3 warp = vec3(vnoise(d * 40.0), vnoise(d * 40.0 + 5.2), vnoise(d * 40.0 + 9.7)) - 0.5;
		vec3 q = d + warp * 0.012;
		float broad = fbm_aa(q * 160.0, px * 160.0 / PLANET_R);
		float clump = fbm_aa(q * 520.0 + 7.0, px * 520.0 / PLANET_R);
		// Scrub and woodland clumps: dark olive, denser where it rains.
		float cover = 0.35 + 0.65 * wet;
		float scrub = smoothstep(0.60 - cover * 0.16, 0.66 - cover * 0.14, clump * 0.6 + broad * 0.4);
		vec3 scrub_col = mix(vec3(0.17, 0.18, 0.08), vec3(0.10, 0.15, 0.07), wet) * (0.7 + lum * 0.9);
		col = mix(col, scrub_col, scrub * 0.85 * land);
		bump += scrub * 0.6;
		// Lighter grass / sun-baked ochre ground between them, more of it where it is dry.
		float dry = smoothstep(0.52, 0.68, broad) * (1.0 - 0.75 * wet) * (1.0 - scrub);
		col = mix(col, vec3(0.52, 0.40, 0.21), dry * 0.55 * land);
		float lush = (1.0 - smoothstep(0.30, 0.45, broad)) * wet * (1.0 - scrub);
		col = mix(col, col * vec3(0.86, 0.95, 0.80), lush * 0.5 * land);
		// Fields: a patchwork of crop strips with dark hedgerows around settlements, on
		// lowland that is neither desert nor mountain. The grid lies on the cube face
		// the point projects to, so its lines run straight across the ground.
		const float FIELD_F = 300.0;
		float fk = aa_keep(FIELD_F * 0.5, px);
		float farm = smoothstep(0.15, 0.5, pop) * smoothstep(0.45, 0.55, fbm(d * 60.0 + 3.0));
		farm *= (1.0 - smoothstep(900.0, 1500.0, h)) * smoothstep(200.0, 450.0, precip) * fk;
		vec3 ad = abs(d);
		vec2 uv = ad.x > ad.y && ad.x > ad.z ? q.yz : ad.y > ad.z ? q.zx : q.xy;
		float face = ad.x > ad.y && ad.x > ad.z ? sign(d.x) : ad.y > ad.z ? 2.0 * sign(d.y) : 3.0 * sign(d.z);
		vec2 gp = uv * FIELD_F;
		vec2 gc = floor(gp);
		vec2 gf = fract(gp);
		float r0 = hash13(vec3(gc, face));
		// Split each square into two strips, either way, so the plots vary in shape.
		float split = 0.3 + 0.4 * hash13(vec3(gc, face + 9.0));
		float sx = r0 < 0.5 ? gf.x : gf.y;
		float side = step(split, sx);
		vec2 ge = min(gf, vec2(1.0) - gf);
		float edge = min(min(ge.x, ge.y), abs(sx - split));
		float hedge = (1.0 - smoothstep(0.025, 0.06, edge)) * aa_keep(FIELD_F * 4.0, px);
		float r1 = hash13(vec3(gc, face + side * 3.0 + 1.0));
		vec3 crop = r1 < 0.35 ? vec3(0.50, 0.42, 0.19) : r1 < 0.7 ? vec3(0.26, 0.30, 0.12) : r1 < 0.85 ? vec3(0.37, 0.28, 0.16) : vec3(0.40, 0.38, 0.17);
		crop *= 0.88 + 0.24 * hash13(vec3(gc, face + side * 3.0 + 5.0));
		crop = mix(crop, vec3(0.13, 0.15, 0.07), hedge * 0.6);
		col = mix(col, crop, farm * 0.7 * land);
		bump += farm * hedge * 0.4;
		// Grey rock outcrops breaking through, more of them on high ground.
		float rk = fbm_aa(q * 380.0 + 11.0, px * 380.0 / PLANET_R);
		float rise = 0.12 * smoothstep(500.0, 2000.0, h);
		float outcrop = smoothstep(0.68 - rise, 0.78 - rise, rk) * (1.0 - farm);
		col = mix(col, mix(rock, vec3(0.25, 0.24, 0.22), 0.6) * (0.65 + 0.45 * clump), outcrop * 0.85 * land);
		bump += outcrop;
		// Fine grain.
		float grain = (vnoise(d * 2400.0) - 0.5) * aa_keep(2400.0, px) + (vnoise(d * 900.0 + 3.0) - 0.5) * aa_keep(900.0, px);
		bump = (bump + grain * 0.5) * land;
		return col * (1.0 + grain * 0.22 * land);
	}
	// Cloud cover in planet space; also used as drifting cloud shadows on the map.
	float cloud_cover(vec3 d) {
		float ang = wall_time * 0.004;
		vec3 q = vec3(d.x * cos(ang) - d.z * sin(ang), d.y, d.x * sin(ang) + d.z * cos(ang));
		vec3 w = q * vec3(3.2, 6.5, 3.2); // stretched along latitude: weather bands
		float n = mix(fbm(w + fbm(q * 2.0) * 1.6 + vec3(0.0, wall_time * 0.003, 0.0)), fbm(q * 14.0), 0.32);
		return smoothstep(0.5, 0.74, n);
	}
	// Settlement lights on the night side, driven by a habitability value.
	vec3 night_lights(vec3 dir, float pop) {
		float night = 1.0 - smoothstep(-0.12, 0.08, dot(dir, sun_dir_local));
		float blobs = smoothstep(0.55, 0.85, vnoise(dir * 150.0)) * smoothstep(0.4, 0.8, vnoise(dir * 420.0));
		return vec3(1.0, 0.72, 0.36) * blobs * pop * night * 1.6;
	}
	// Flat-shaded normal from the screen-space derivatives of the position.
	vec3 facet_normal(vec3 dpdx, vec3 dpdy, vec3 view_dir) {
		vec3 fn = normalize(cross(dpdx, dpdy));
		return dot(fn, view_dir) < 0.0 ? -fn : fn;
	}
	// Aerial perspective for the close-up map: distant ground fades to sky blue.
	vec3 haze(vec3 col, float dist, vec3 wpos) {
		float day = smoothstep(-0.1, 0.25, dot(normalize(wpos), sun_dir_world));
		float f = (1.0 - exp(-dist / 420.0)) * detail * 0.4;
		return mix(col, vec3(0.58, 0.64, 0.68) * (0.04 + 0.96 * day), f);
	}

	// ---- web-only: lighting and tone mapping (Godot does both itself)
	vec3 lit(vec3 albedo, vec3 n, vec3 wpos, float rough, float spec, vec3 emission) {
		vec3 up = normalize(wpos);
		float day = smoothstep(-0.12, 0.2, dot(up, sun_dir_world));
		float ndl = max(dot(n, sun_dir_world), 0.0);
		// Cool sky fill from above, warm bounce from below, a little for the night side.
		vec3 amb = mix(vec3(0.10, 0.09, 0.08), vec3(0.20, 0.27, 0.40), dot(n, up) * 0.5 + 0.5) * (0.07 + 0.93 * day);
		vec3 v = normalize(cameraPosition - wpos);
		vec3 hv = normalize(v + sun_dir_world);
		float sp = pow(max(dot(n, hv), 0.0), mix(180.0, 6.0, rough)) * spec * step(0.0, dot(n, sun_dir_world)) * day;
		return albedo * (amb + sun_color * 1.35 * ndl * day) + sun_color * sp * 1.2 + emission;
	}
	vec3 tonemap(vec3 x) { // ACES filmic fit + sRGB-ish gamma
		x *= 0.95;
		vec3 c = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
		// Grade: pull saturation down and warm the result slightly.
		float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
		c = mix(vec3(l), c, 0.84) * vec3(1.03, 1.0, 0.94);
		return pow(c, vec3(1.0 / 2.2));
	}
	`;

	// ---------------------------------------------------------------- globe (baked 2D map)
	S.globeVert = S.COMMON + `
	uniform float sink;
	varying vec3 v_dir;
	varying vec3 v_wpos;
	void main() {
		v_dir = normalize(position);
		vec4 wp = modelMatrix * vec4(v_dir * (PLANET_R - sink), 1.0);
		v_wpos = wp.xyz;
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.globeFrag = S.COMMON + `
	uniform sampler2D data_tex;  // height, mean temp, seasonal amp, precip
	uniform sampler2D mask_tex;  // cell border, river, population
	uniform float border_strength;
	varying vec3 v_dir;
	varying vec3 v_wpos;
	void main() {
		vec3 d = normalize(v_dir);
		vec2 uv = vec2(atan(d.z, d.x) / TAU + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI);
		vec4 dat = textureLod(data_tex, uv, 0.0);
		vec4 msk = textureLod(mask_tex, uv, 0.0);
		float h = dat.r * 10000.0;
		float tmean = dat.g * 50.0;
		float tamp = dat.b * 50.0;
		float precip = dat.a * 4000.0;
		float tnow = temp_now(tmean, tamp, d);
		vec3 n = normalize(v_wpos);
		vec3 col;
		float rough = 0.95;
		float spec = 0.05;
		vec3 emi = vec3(0.0);
		if (h > sea_level) {
			col = land_color(h, tnow, tmean, precip, d, vec3(0.46, 0.42, 0.38));
			vec3 river = tnow < -4.0 ? vec3(0.82, 0.90, 0.96) : vec3(0.14, 0.34, 0.42);
			col = mix(col, river, smoothstep(0.15, 0.6, msk.g) * 0.9);
			emi = night_lights(d, msk.b);
		} else {
			float depth = sea_level - h;
			col = water_color(depth, tnow);
			col = mix(col, vec3(0.72, 0.58, 0.30), (1.0 - smoothstep(0.0, 60.0, depth)) * 0.35);
			rough = 0.35;
			spec = 0.5;
		}
		col = mix(col, vec3(1.0), smoothstep(0.3, 0.9, msk.r) * border_strength);
		gl_FragColor = vec4(tonemap(lit(col, n, v_wpos, rough, spec, emi)), 1.0);
	}`;

	// ---------------------------------------------------------------- terrain (per-cell mesh)
	// adata = (height m, mean temp, seasonal amp, precip); acolor = (bedrock rgb, population)
	S.terrainVert = S.COMMON + `
	attribute vec4 adata;
	attribute vec4 acolor;
	varying vec3 v_dir;
	varying vec3 v_wpos;
	varying vec4 v_data;
	varying vec4 v_color;
	void main() {
		v_dir = normalize(position);
		v_data = adata;
		v_color = acolor;
		vec4 wp = modelMatrix * vec4(v_dir * (PLANET_R + disp(adata.x) * detail), 1.0);
		v_wpos = wp.xyz;
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.terrainFrag = S.COMMON + `
	varying vec3 v_dir;
	varying vec3 v_wpos;
	varying vec4 v_data;
	varying vec4 v_color;
	void main() {
		vec3 d = normalize(v_dir);
		float h = v_data.x;
		float tnow = temp_now(v_data.y, v_data.z, d);
		vec3 col = land_color(h, tnow, v_data.y, v_data.w, d, v_color.rgb);
		// Procedural ground texture, kept off snow and faded by pixel footprint.
		float snowy = 1.0 - smoothstep(-5.0, 0.5, tnow + (fbm(d * 55.0) - 0.5) * 4.0);
		float tex = clamp(detail * 1.5, 0.0, 1.0) * (1.0 - snowy);
		float px = length(fwidth(v_wpos));
		float bump_h;
		col = ground_detail(col, d, h, v_data.w, v_color.a, v_color.rgb, tex, px, bump_h);

		// Faceted low-poly normals; steep facets (terrace cliffs, mountain sides) show
		// banded bedrock instead of vegetation.
		float relief = clamp(detail * 1.5, 0.0, 1.0);
		vec3 smooth_n = normalize(v_wpos);
		vec3 view = normalize(cameraPosition - v_wpos);
		vec3 fn = facet_normal(dFdx(v_wpos), dFdy(v_wpos), view);
		float slope = 1.0 - clamp(dot(fn, smooth_n), 0.0, 1.0);
		// A single terrace step is a grassy bank, a touch darker than the flats;
		// only drops of several levels at once expose the bedrock.
		float bank = smoothstep(0.04, 0.2, slope) * relief;
		float cliff = smoothstep(0.42, 0.62, slope) * relief;
		float strata = 0.90 + 0.10 * step(0.5, fract(h / 75.0 + vnoise(d * 90.0) * 0.6));
		vec3 rock = mix(v_color.rgb, vec3(0.42, 0.32, 0.22), 0.5) * strata * 0.85;
		float frozen = 1.0 - smoothstep(-5.0, 0.5, tnow);
		col *= 1.0 - 0.22 * bank;
		col = mix(col, mix(rock, vec3(0.9, 0.93, 0.97), frozen * 0.5), cliff * 0.9);

		col *= mix(1.0, 0.5, smoothstep(0.0, 800.0, sea_level - h)); // darker sea bed
		col *= 1.0 - 0.38 * cloud_cover(d) * relief;                 // cloud shadows
		// Bump the normal with the ground texture (screen-space gradient of its height)
		// so clumps, hedgerows and outcrops catch the light.
		vec3 n = normalize(mix(smooth_n, fn, relief));
		vec3 dpx = dFdx(v_wpos);
		vec3 dpy = dFdy(v_wpos);
		vec3 r1 = cross(dpy, n);
		vec3 r2 = cross(n, dpx);
		float det = dot(dpx, r1);
		vec3 grad = sign(det) * (dFdx(bump_h) * r1 + dFdy(bump_h) * r2);
		n = normalize(abs(det) * n - grad * 0.015 * relief);
		vec3 emi = h > sea_level ? night_lights(d, v_color.a) * (1.0 - relief * 0.7) : vec3(0.0);
		vec3 c = lit(col, n, v_wpos, 0.95, 0.04, emi);
		gl_FragColor = vec4(tonemap(haze(c, distance(cameraPosition, v_wpos), v_wpos)), 1.0);
	}`;

	// ---------------------------------------------------------------- water (same vertices as terrain)
	S.waterVert = S.COMMON + `
	attribute vec4 adata;
	varying vec3 v_dir;
	varying vec3 v_wpos;
	varying vec4 v_data;
	void main() {
		v_dir = normalize(position);
		v_data = adata;
		vec4 wp = modelMatrix * vec4(v_dir * (PLANET_R + disp(sea_level) * detail), 1.0);
		v_wpos = wp.xyz;
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.waterFrag = S.COMMON + `
	varying vec3 v_dir;
	varying vec3 v_wpos;
	varying vec4 v_data;
	void main() {
		float depth = sea_level - v_data.x;
		if (depth < -4.0) discard;
		depth = max(depth, 0.0);
		vec3 d = normalize(v_dir);
		float tnow = temp_now(v_data.y, v_data.z, d);
		float ice = 1.0 - smoothstep(-7.0, -2.5, tnow);
		vec3 col = water_color(depth, tnow);
		// Soft swell plus bands of surf rolling onto the shore.
		float swell = fbm(d * 260.0 + vec3(wall_time * 0.15, 0.0, wall_time * 0.1));
		col *= (0.9 + 0.2 * swell) * (1.0 - 0.3 * cloud_cover(d) * clamp(detail * 1.5, 0.0, 1.0));
		float shore = 1.0 - smoothstep(0.0, 120.0, depth);
		float surf = sin(depth * 0.14 - wall_time * 1.4 + swell * 5.0) * 0.5 + 0.5;
		float foam = shore * smoothstep(0.6, 0.95, surf) * (1.0 - ice);
		col = mix(col, vec3(0.95, 0.93, 0.85), foam * 0.45);
		// Fresnel: grazing views reflect the sky.
		vec3 n = normalize(v_wpos);
		vec3 view = normalize(cameraPosition - v_wpos);
		float fres = pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 4.0);
		col = mix(col, vec3(0.50, 0.58, 0.58), fres * 0.4 * (1.0 - ice));
		// Ripple the normal a little so the sun glints.
		vec3 rn = normalize(n + (vec3(vnoise(d * 700.0 + wall_time * 0.5), vnoise(d * 700.0 + 9.0 - wall_time * 0.4), vnoise(d * 700.0 + 4.0)) - 0.5) * 0.12);
		vec3 c = lit(col, rn, v_wpos, mix(0.2, 0.8, ice), 0.6, vec3(0.0));
		float alpha = clamp(mix(0.62, 0.97, 1.0 - exp(-depth / 300.0)) + foam * 0.3 + fres * 0.25, 0.0, 1.0);
		gl_FragColor = vec4(tonemap(haze(c, distance(cameraPosition, v_wpos), v_wpos)), alpha);
	}`;

	// ---------------------------------------------------------------- rivers
	// ariver = (side -1/+1, height m, width, mean temp); aacross = (across xyz, seasonal amp)
	S.riverVert = S.COMMON + `
	uniform float flood;
	attribute vec4 ariver;
	attribute vec4 aacross;
	varying vec3 v_wpos;
	varying float v_h;
	varying float v_tnow;
	varying float v_flood;
	varying float v_side;
	void main() {
		vec3 d = normalize(position);
		v_h = ariver.y;
		v_side = ariver.x;
		float hemi = clamp(d.y * 6.0, -1.0, 1.0);
		v_tnow = ariver.w + aacross.w * season * hemi;
		v_flood = clamp(flood + 0.2 * max(season * hemi, 0.0), 0.0, 1.5);
		float half_w = ariver.z * (1.0 + v_flood * 4.0) * 0.5;
		d = normalize(d * PLANET_R + normalize(aacross.xyz) * ariver.x * half_w);
		vec4 wp = modelMatrix * vec4(d * (PLANET_R + disp(v_h) * detail + 0.004 + (0.03 + v_flood * 0.03) * detail), 1.0);
		v_wpos = wp.xyz;
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.riverFrag = S.COMMON + `
	varying vec3 v_wpos;
	varying float v_h;
	varying float v_tnow;
	varying float v_flood;
	varying float v_side;
	void main() {
		if (v_h < sea_level - 1.0) discard;
		vec3 col = mix(vec3(0.14, 0.34, 0.42), vec3(0.40, 0.33, 0.20), clamp(v_flood, 0.0, 1.0) * 0.6);
		col = mix(col, vec3(0.80, 0.92, 0.97), smoothstep(0.55, 0.95, abs(v_side)) * 0.35); // pale banks
		col = mix(col, vec3(0.82, 0.90, 0.96), 1.0 - smoothstep(-6.0, -3.0, v_tnow));
		vec3 c = lit(col, normalize(v_wpos), v_wpos, 0.3, 0.5, vec3(0.0));
		gl_FragColor = vec4(tonemap(haze(c, distance(cameraPosition, v_wpos), v_wpos)), 1.0);
	}`;

	// ---------------------------------------------------------------- cell borders
	S.borderVert = S.COMMON + `
	uniform float lift;
	attribute float aheight;
	attribute vec3 acolor3;
	varying vec3 v_color;
	varying vec3 v_wpos;
	void main() {
		vec3 d = normalize(position);
		v_color = acolor3;
		vec4 wp = modelMatrix * vec4(d * (PLANET_R + disp(max(aheight, sea_level)) * detail + lift), 1.0);
		v_wpos = wp.xyz;
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.borderFrag = S.COMMON + `
	uniform float border_strength;
	varying vec3 v_color;
	varying vec3 v_wpos;
	void main() {
		if (border_strength < 0.01) discard;
		float day = smoothstep(-0.15, 0.2, dot(normalize(v_wpos), sun_dir_world));
		gl_FragColor = vec4(pow(mix(vec3(0.6), v_color, 0.45) * 0.62, vec3(1.0 / 2.2)) * (0.25 + 0.75 * day), 1.0);
	}`;

	// ---------------------------------------------------------------- trees and houses (instanced)
	// icustom = (height m, mean temp, signed seasonal amp, random)
	S.treeVert = S.COMMON + `
	attribute vec4 icustom;
	varying vec3 v_wpos;
	varying vec3 v_wn;
	varying float v_tnow;
	varying float v_tmean;
	varying float v_rand;
	varying float v_up;
	void main() {
		float h = icustom.x;
		v_tmean = icustom.y;
		v_tnow = icustom.y + icustom.z * season;
		v_rand = icustom.w;
		float grow = (0.7 + 0.6 * v_rand) * smoothstep(0.5, 0.95, detail);
		if (h < sea_level + 3.0) grow = 0.0; // drowned
		float broad = smoothstep(8.0, 16.0, v_tmean);
		vec3 p = position;
		p.y += 0.17;
		v_up = p.y / 0.34;
		p.xz *= mix(1.0, 1.45, broad);
		p.y *= mix(1.0, 0.78, broad);
		p *= grow;
		p.y += disp(h) * detail; // local +Y is the planet's radial direction
		vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
		v_wpos = wp.xyz;
		v_wn = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.treeFrag = S.COMMON + `
	varying vec3 v_wpos;
	varying vec3 v_wn;
	varying float v_tnow;
	varying float v_tmean;
	varying float v_rand;
	varying float v_up;
	void main() {
		// Muted olive greens, darker than the ground around them.
		vec3 conifer = vec3(0.07, 0.11, 0.07);
		vec3 broadleaf = vec3(0.13, 0.16, 0.06);
		vec3 jungle = vec3(0.08, 0.13, 0.05);
		vec3 col = mix(conifer, mix(broadleaf, jungle, smoothstep(18.0, 24.0, v_tmean)), smoothstep(8.0, 16.0, v_tmean));
		float temperate = smoothstep(6.0, 10.0, v_tmean) * (1.0 - smoothstep(16.0, 22.0, v_tmean));
		float dormant = (1.0 - smoothstep(1.0, 9.0, v_tnow)) * temperate;
		col = mix(col, vec3(0.46, 0.29, 0.11), dormant * 0.8);
		col = mix(col, vec3(0.90, 0.94, 1.0), (1.0 - smoothstep(-4.0, 0.0, v_tnow)) * 0.75);
		col *= (0.85 + 0.3 * v_rand) * mix(0.55, 1.2, clamp(v_up, 0.0, 1.0)); // darker skirt, sunlit tip
		vec3 c = lit(col, normalize(v_wn), v_wpos, 0.9, 0.02, vec3(0.0));
		gl_FragColor = vec4(tonemap(haze(c, distance(cameraPosition, v_wpos), v_wpos)), 1.0);
	}`;
	S.houseVert = S.COMMON + `
	attribute vec4 icustom;
	varying vec3 v_wpos;
	varying float v_y;
	varying float v_rand;
	varying float v_tnow;
	void main() {
		float h = icustom.x;
		v_tnow = icustom.y + icustom.z * season;
		v_rand = icustom.w;
		vec3 p = position;
		v_y = p.y;
		if (p.y > 0.01) { p.x = 0.0; p.y *= 0.85; } // pinch the top ring into a roof ridge
		p.y += 0.065;
		float grow = (0.8 + 0.5 * v_rand) * smoothstep(0.5, 0.95, detail);
		if (h < sea_level + 3.0) grow = 0.0;
		p *= grow;
		p.y += disp(h) * detail;
		vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
		v_wpos = wp.xyz;
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.houseFrag = S.COMMON + `
	varying vec3 v_wpos;
	varying float v_y;
	varying float v_rand;
	varying float v_tnow;
	void main() {
		float roof = smoothstep(0.0, 0.004, v_y);
		vec3 wall = mix(vec3(0.86, 0.78, 0.60), vec3(0.68, 0.60, 0.50), v_rand);
		vec3 tiles = mix(vec3(0.66, 0.16, 0.07), vec3(0.42, 0.20, 0.11), v_rand);
		tiles = mix(tiles, vec3(0.92, 0.95, 1.0), (1.0 - smoothstep(-4.0, 0.0, v_tnow)) * 0.85);
		vec3 view = normalize(cameraPosition - v_wpos);
		vec3 n = facet_normal(dFdx(v_wpos), dFdy(v_wpos), view);
		float night = 1.0 - smoothstep(-0.12, 0.08, dot(normalize(v_wpos), sun_dir_world));
		vec3 emi = vec3(1.0, 0.65, 0.28) * (1.0 - roof) * night * 0.9;
		vec3 c = lit(mix(wall, tiles, roof), n, v_wpos, 0.9, 0.02, emi);
		gl_FragColor = vec4(tonemap(haze(c, distance(cameraPosition, v_wpos), v_wpos)), 1.0);
	}`;

	// ---------------------------------------------------------------- clouds
	S.cloudVert = S.COMMON + `
	varying vec3 v_dir;
	varying vec3 v_wpos;
	void main() {
		v_dir = normalize(position);
		vec4 wp = modelMatrix * vec4(position, 1.0);
		v_wpos = wp.xyz;
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.cloudFrag = S.COMMON + `
	uniform float cloud_alpha;
	varying vec3 v_dir;
	varying vec3 v_wpos;
	void main() {
		vec3 d = normalize(v_dir);
		float a = cloud_cover(d);
		vec3 c = lit(vec3(1.0), normalize(v_wpos), v_wpos, 1.0, 0.0, vec3(0.0));
		gl_FragColor = vec4(tonemap(c), a * cloud_alpha * 0.9);
	}`;

	// ---------------------------------------------------------------- atmosphere shell
	// Opacity from the length of the view ray inside the shell, colour from the sun angle.
	S.atmoVert = `
	varying vec3 v_wpos;
	void main() {
		vec4 wp = modelMatrix * vec4(position, 1.0);
		v_wpos = wp.xyz;
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.atmoFrag = `
	uniform vec3 sun_dir_world;
	uniform float atm_radius;
	uniform float planet_radius;
	varying vec3 v_wpos;
	void main() {
		vec3 ro = cameraPosition;
		vec3 rd = normalize(v_wpos - ro);
		float b = dot(ro, rd);
		float disc = b * b - (dot(ro, ro) - atm_radius * atm_radius);
		if (disc <= 0.0) discard;
		float sq = sqrt(disc);
		float t0 = max(-b - sq, 0.0);
		float t1 = -b + sq;
		float dp = b * b - (dot(ro, ro) - planet_radius * planet_radius);
		if (dp > 0.0) {
			float tp = -b - sqrt(dp);
			if (tp > 0.0) t1 = min(t1, tp);
		}
		float len = max(t1 - t0, 0.0);
		vec3 mid = ro + rd * (t0 + len * 0.5);
		float sun = dot(normalize(mid), sun_dir_world);
		float day = smoothstep(-0.25, 0.35, sun);
		float twilight = smoothstep(-0.25, 0.0, sun) * (1.0 - smoothstep(0.0, 0.3, sun));
		vec3 col = mix(vec3(0.42, 0.58, 0.80), vec3(0.95, 0.52, 0.28), twilight * 0.7);
		float a = (1.0 - exp(-len / ((atm_radius - planet_radius) * 2.2))) * day;
		gl_FragColor = vec4(pow(col * (0.2 + 0.9 * day), vec3(1.0 / 2.2)), a * 0.85);
	}`;

	// ---------------------------------------------------------------- star, other bodies
	S.starVert = S.COMMON + `
	varying vec3 v_dir;
	varying vec3 v_wn;
	varying vec3 v_wpos;
	void main() {
		v_dir = normalize(position);
		v_wn = normalize(mat3(modelMatrix) * normal);
		vec4 wp = modelMatrix * vec4(position, 1.0);
		v_wpos = wp.xyz;
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.starFrag = S.COMMON + `
	uniform vec3 star_color;
	varying vec3 v_dir;
	varying vec3 v_wn;
	varying vec3 v_wpos;
	void main() {
		vec3 d = normalize(v_dir);
		float n = fbm(d * 7.0 + vec3(wall_time * 0.05));
		float limb = pow(max(dot(normalize(v_wn), normalize(cameraPosition - v_wpos)), 0.0), 0.4);
		gl_FragColor = vec4(tonemap(star_color * (1.6 + 1.4 * n) * (0.5 + 0.8 * limb)), 1.0);
	}`;
	S.bodyFrag = S.COMMON + `
	uniform vec3 color_a;
	uniform vec3 color_b;
	uniform float banded;
	uniform vec3 star_pos_world;
	varying vec3 v_dir;
	varying vec3 v_wn;
	varying vec3 v_wpos;
	void main() {
		vec3 d = normalize(v_dir);
		float blotch = fbm(d * 3.0);
		float bands = fbm(vec3(d.y * 9.0 + fbm(d * 2.0) * 1.5, 0.3, 0.7));
		float n = mix(blotch, bands, banded);
		vec3 col = mix(color_a, color_b, smoothstep(0.3, 0.7, n));
		float l = max(dot(normalize(v_wn), normalize(star_pos_world - v_wpos)), 0.0);
		gl_FragColor = vec4(tonemap(col * (0.03 + 1.6 * l)), 1.0);
	}`;
	S.coronaVert = `
	varying vec2 v_uv;
	void main() {
		v_uv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}`;
	S.coronaFrag = `
	uniform vec3 star_color;
	varying vec2 v_uv;
	void main() {
		float r = length(v_uv - vec2(0.5)) * 2.0;
		float g = pow(max(1.0 - r, 0.0), 3.0);
		gl_FragColor = vec4(star_color * g * 1.6, g);
	}`;
})();
