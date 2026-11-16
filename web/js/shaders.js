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
	const float SHADOW_UV = 1.0 / 2048.0; // one shadow-map texel (keep in sync with SHADOW_SIZE)

	uniform float sea_level;      // metres relative to the generated datum
	uniform float detail;         // 0 = flat globe, 1 = full 3D relief
	uniform float season;         // -1 = northern winter solstice, +1 = northern summer
	uniform vec3 sun_dir_local;   // sun direction in planet space
	uniform vec3 sun_dir_world;
	uniform vec3 sun_color;
	uniform float wall_time;      // real seconds, cosmetic animation
	uniform float flood;          // river flooding 0..1
	uniform sampler2D shadow_map; // web-only: packed sun depth (see lit())
	uniform mat4 shadow_matrix;
	uniform float shadow_on;
	uniform float shadow_texel;   // world units per shadow texel

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
	// Cellular (Worley) noise: distances to the nearest and second-nearest feature
	// point. F2 - F1 gives crack networks, F1 gives pebbles and cells.
	vec2 worley3(vec3 p) {
		vec3 i = floor(p);
		vec3 f = fract(p);
		float d1 = 8.0;
		float d2 = 8.0;
		for (int z = -1; z <= 1; z++) {
			for (int y = -1; y <= 1; y++) {
				for (int x = -1; x <= 1; x++) {
					vec3 g = vec3(float(x), float(y), float(z));
					vec3 o = vec3(hash13(i + g), hash13(i + g + 17.3), hash13(i + g + 31.7));
					vec3 r = g + o - f;
					float dd = dot(r, r);
					if (dd < d1) { d2 = d1; d1 = dd; } else if (dd < d2) { d2 = dd; }
				}
			}
		}
		return vec2(sqrt(d1), sqrt(d2));
	}
	// Ridged value noise, 0..1, peaks along thin lines (strokes, paths, ripples).
	float ridge(vec3 p) {
		return 1.0 - abs(2.0 * vnoise(p) - 1.0);
	}
	// Current temperature (deg C) from annual mean + seasonal half-range.
	float temp_now(float tmean, float tamp, vec3 dir) {
		float hemi = clamp(dir.y * 6.0, -1.0, 1.0);
		return tmean + tamp * season * hemi;
	}
	float snow_cover(float tnow, vec3 d) {
		return 1.0 - smoothstep(-5.0, 0.5, tnow + (fbm(d * 55.0) - 0.5) * 4.0);
	}

	// Palette (albedo). Warm, earthy and muted: golden grass and ochre earth in dry
	// country, olive to deep green where it rains, red sandstone and grey rock.
	const vec3 C_OCHRE = vec3(0.48, 0.28, 0.11);
	const vec3 C_GOLDEN = vec3(0.54, 0.37, 0.08);
	const vec3 C_TUNDRA = vec3(0.37, 0.35, 0.27);
	const vec3 C_GRASS = vec3(0.29, 0.31, 0.12);
	const vec3 C_MEADOW = vec3(0.20, 0.25, 0.10);
	const vec3 C_FOREST = vec3(0.13, 0.21, 0.08);
	const vec3 C_TAIGA = vec3(0.13, 0.19, 0.12);
	const vec3 C_SAND = vec3(0.62, 0.49, 0.28);
	const vec3 C_RED_DARK = vec3(0.40, 0.19, 0.11);
	const vec3 C_RED = vec3(0.62, 0.33, 0.18);
	const vec3 C_RED_LIGHT = vec3(0.76, 0.52, 0.33);
	const vec3 C_GREY = vec3(0.44, 0.43, 0.41);
	const vec3 C_SNOW = vec3(0.92, 0.95, 1.0);

	// Flat-ground colour from climate: shared by the globe and the 3D terrain so the
	// two match. px is the pixel footprint in world units (pass a large value on the
	// globe) and drops the mottling that would otherwise shimmer.
	vec3 land_albedo(float h, float tnow, float tmean, float precip, vec3 d, vec3 rock, float px) {
		float big = fbm(d * 23.0);
		float mid = fbm_aa(d * 140.0 + 3.1, px * 140.0 / PLANET_R);
		float wet = clamp(smoothstep(170.0, 1600.0, precip) + (big - 0.5) * 0.6 + (mid - 0.5) * 0.45, 0.0, 1.0);
		float warm = smoothstep(2.0, 20.0, tmean);
		// Dry: golden grass with patches of bare ochre earth; cold and dry: tundra.
		vec3 dry = mix(C_GOLDEN, C_OCHRE, smoothstep(0.42, 0.62, mid) * 0.75 + smoothstep(20.0, 28.0, tmean) * 0.25);
		dry = mix(C_TUNDRA, dry, warm);
		// Moist: muted grass to meadow, then woodland.
		vec3 green = mix(C_GRASS, C_MEADOW, smoothstep(0.45, 0.7, wet));
		green = mix(mix(C_TUNDRA, green, 0.6), green, smoothstep(-2.0, 6.0, tmean));
		vec3 lush = mix(C_TAIGA, C_FOREST, smoothstep(4.0, 12.0, tmean));
		vec3 col = mix(dry, green, smoothstep(0.18, 0.5, wet));
		col = mix(col, lush, smoothstep(0.62, 0.95, wet) * 0.85);
		// Seasonal dormancy of temperate vegetation.
		float temperate = smoothstep(0.0, 6.0, tmean) * (1.0 - smoothstep(16.0, 22.0, tmean));
		float dormant = (1.0 - smoothstep(1.0, 9.0, tnow)) * temperate;
		col = mix(col, vec3(0.50, 0.37, 0.19), dormant * 0.5);
		// Freshly exposed sea bed, then the beach strip around the current shoreline.
		col = mix(col, vec3(0.56, 0.49, 0.36), (1.0 - smoothstep(-200.0, 0.0, h)) * 0.8);
		col = mix(C_SAND, col, smoothstep(2.0, 10.0 + mid * 14.0, h - sea_level));
		// Bare rock at altitude, snow wherever it is currently freezing.
		col = mix(col, mix(rock, C_GREY, 0.4), smoothstep(1900.0, 3600.0, h) * 0.85);
		col = mix(col, C_SNOW, snow_cover(tnow, d));
		return col * (0.84 + 0.32 * big);
	}
	vec3 water_color(float depth, float tnow) {
		// Turquoise over sand, sea-green over the shelf, through dark teal, to slate-navy.
		vec3 shallow = vec3(0.12, 0.40, 0.34);
		vec3 shelf = vec3(0.05, 0.22, 0.17);
		vec3 deep = vec3(0.025, 0.065, 0.14);
		vec3 col = mix(shallow, shelf, smoothstep(0.0, 900.0, depth));
		col = mix(col, deep, smoothstep(600.0, 2600.0, depth));
		float ice = 1.0 - smoothstep(-7.0, -2.5, tnow);
		return mix(col, vec3(0.82, 0.90, 0.96), ice);
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
	vec3 facet_normal(vec3 dpdx, vec3 dpdy, vec3 up) {
		vec3 fn = normalize(cross(dpdx, dpdy));
		return dot(fn, up) < 0.0 ? -fn : fn;
	}
	// Aerial perspective for the close-up map: distance hazes toward a pale sky
	// colour, warmer when looking toward the sun.
	vec3 haze(vec3 col, float dist, vec3 wpos) {
		float day = smoothstep(-0.1, 0.25, dot(normalize(wpos), sun_dir_world));
		vec3 vd = normalize(wpos - cameraPosition);
		float sunward = max(dot(vd, sun_dir_world), 0.0);
		vec3 hc = mix(vec3(0.50, 0.57, 0.66), vec3(0.80, 0.66, 0.50), sunward * sunward * 0.75) * (0.04 + 0.96 * day);
		float f = (1.0 - exp(-max(dist - 10.0, 0.0) / 55.0)) * detail * 0.45;
		return mix(col, hc, f);
	}

	// ---- web-only: shadows, lighting and tone mapping (Godot does all three itself:
	// write ALBEDO / ROUGHNESS / AO / EMISSION there instead).
	vec4 pack_depth(float v) {
		vec4 r = vec4(fract(v * vec3(16777216.0, 65536.0, 256.0)), v);
		r.yzw -= r.xyz * (1.0 / 256.0);
		return r * (256.0 / 255.0);
	}
	float unpack_depth(vec4 v) {
		return dot(v, (255.0 / 256.0) / vec4(16777216.0, 65536.0, 256.0, 1.0));
	}
	// Sun visibility 0..1 from the shadow map: 12-tap Vogel-disk PCF, normal offset.
	float shadow_factor(vec3 wpos, vec3 n) {
		if (shadow_on <= 0.0) return 1.0;
		// Normal offset plus a slope-scaled depth bias (depth range of the sun camera
		// is 219 world units) keep steep faces free of acne.
		float cosl = clamp(dot(n, sun_dir_world), 0.05, 1.0);
		float tanl = min(sqrt(1.0 - cosl * cosl) / cosl, 8.0);
		vec3 p = wpos + n * shadow_texel * 3.5;
		float bias = shadow_texel * (1.0 + 1.5 * tanl) / 219.0;
		vec4 sc = shadow_matrix * vec4(p, 1.0);
		vec3 s = sc.xyz / sc.w * 0.5 + 0.5;
		vec2 e = min(s.xy, vec2(1.0) - s.xy);
		float edge = smoothstep(0.0, 0.06, min(e.x, e.y));
		if (edge <= 0.0 || s.z >= 1.0) return 1.0;
		float sum = 0.0;
		for (int i = 0; i < 12; i++) {
			float a = float(i) * 2.39996;
			float r = sqrt((float(i) + 0.5) / 12.0) * 2.2;
			vec2 o = vec2(cos(a), sin(a)) * r * SHADOW_UV;
			sum += step(s.z - bias, unpack_depth(texture2D(shadow_map, s.xy + o)));
		}
		return mix(1.0, sum / 12.0, shadow_on * edge);
	}
	// Warm key light (golden when the sun is low), cool sky fill, warm ground bounce.
	// ao darkens the fill fully and the key a little.
	vec3 lit_s(vec3 albedo, vec3 n, vec3 wpos, float rough, float spec, vec3 emission, float ao, float sh);
	vec3 lit(vec3 albedo, vec3 n, vec3 wpos, float rough, float spec, vec3 emission, float ao) {
		return lit_s(albedo, n, wpos, rough, spec, emission, ao, dot(n, sun_dir_world) > 0.0 ? shadow_factor(wpos, n) : 1.0);
	}
	// Same, with the sun visibility given (sh = 1: unshadowed).
	vec3 lit_s(vec3 albedo, vec3 n, vec3 wpos, float rough, float spec, vec3 emission, float ao, float sh) {
		vec3 up = normalize(wpos);
		float sun_up = dot(up, sun_dir_world);
		float day = smoothstep(-0.12, 0.2, sun_up);
		float low = 1.0 - smoothstep(0.05, 0.6, sun_up);
		vec3 key = sun_color * mix(vec3(1.0, 0.92, 0.78), vec3(1.0, 0.70, 0.43), low) * 1.36;
		float ndl = max(dot(n, sun_dir_world), 0.0);
		float hemi = dot(n, up) * 0.5 + 0.5;
		vec3 amb = mix(vec3(0.26, 0.20, 0.13), vec3(0.30, 0.39, 0.55), hemi) * (0.06 + 0.94 * day) * 0.46;
		vec3 v = normalize(cameraPosition - wpos);
		vec3 hv = normalize(v + sun_dir_world);
		float sp = pow(max(dot(n, hv), 0.0), mix(180.0, 6.0, rough)) * spec * step(0.0, dot(n, sun_dir_world)) * day * sh;
		return albedo * (amb * ao + key * ndl * day * sh * mix(0.55, 1.0, ao)) + key * sp * 0.7 + emission;
	}
	vec3 tonemap(vec3 x) { // ACES filmic fit + sRGB-ish gamma
		x *= 0.95;
		vec3 c = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
		// Grade: pull saturation down a touch and warm the result.
		float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
		c = mix(vec3(l), c, 0.97) * vec3(1.04, 1.0, 0.9);
		return pow(c, vec3(1.0 / 2.2));
	}
	`;

	// Shadow-map pass: any displacing vertex shader + this fragment shader.
	S.depthFrag = `
	vec4 pack_depth(float v) {
		vec4 r = vec4(fract(v * vec3(16777216.0, 65536.0, 256.0)), v);
		r.yzw -= r.xyz * (1.0 / 256.0);
		return r * (256.0 / 255.0);
	}
	void main() {
		gl_FragColor = pack_depth(gl_FragCoord.z);
	}`;

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
			col = land_albedo(h, tnow, tmean, precip, d, vec3(0.46, 0.42, 0.38), 2.0);
			vec3 river = tnow < -4.0 ? vec3(0.82, 0.90, 0.96) : vec3(0.12, 0.40, 0.40);
			col = mix(col, river, smoothstep(0.15, 0.6, msk.g) * 0.9);
			emi = night_lights(d, msk.b);
		} else {
			float depth = sea_level - h;
			col = water_color(depth, tnow);
			col = mix(col, vec3(0.70, 0.60, 0.36), (1.0 - smoothstep(0.0, 60.0, depth)) * 0.35);
			rough = 0.35;
			spec = 0.5;
		}
		col = mix(col, vec3(1.0), smoothstep(0.3, 0.9, msk.r) * border_strength);
		gl_FragColor = vec4(tonemap(lit(col, n, v_wpos, rough, spec, emi, 1.0)), 1.0);
	}`;

	// ---------------------------------------------------------------- terrain (per-cell mesh)
	// adata = (height m, mean temp, seasonal amp, precip); anormal = (normal xyz, AO);
	// asurf = (mesa, gully, concavity, river distance / half width); acolor = (bedrock
	// rgb, population); ariver = river water level m (-1e5 = none).
	S.terrainVert = S.COMMON + `
	uniform float skirt_drop;     // metres; 0 in the shadow pass so skirts cast nothing
	attribute vec4 adata;
	attribute vec4 anormal;
	attribute vec4 asurf;
	attribute vec4 acolor;
	attribute float ariver;
	varying vec3 v_dir;
	varying vec3 v_wpos;
	varying vec4 v_data;
	varying vec4 v_nrm;
	varying vec4 v_surf;
	varying vec4 v_color;
	varying float v_rivl;
	varying float v_skirt;
	void main() {
		v_dir = normalize(position);
		v_data = adata;
		v_skirt = acolor.a < -0.5 ? 1.0 : 0.0;
		v_surf = asurf;
		v_color = acolor;
		v_rivl = ariver;
		// Skirt vertices (acolor.a = -1) hang below the cell edge but keep its shading.
		float h = adata.x - (acolor.a < -0.5 ? skirt_drop : 0.0);
		// The baked normal belongs to the full relief; flatten it with the relief.
		v_nrm = vec4(normalize(mat3(modelMatrix) * normalize(mix(v_dir, anormal.xyz, detail))), anormal.w);
		vec4 wp = modelMatrix * vec4(v_dir * (PLANET_R + disp(h) * detail), 1.0);
		v_wpos = wp.xyz;
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.terrainFrag = S.COMMON + `
	varying vec3 v_dir;
	varying vec3 v_wpos;
	varying vec4 v_data;
	varying vec4 v_nrm;
	varying vec4 v_surf;
	varying vec4 v_color;
	varying float v_rivl;
	varying float v_skirt;
	void main() {
		vec3 d = normalize(v_dir);
		// Skirt fragments (any part of a skirt triangle) copy the edge's shading.
		bool skirt = v_skirt > 0.0001;
		float h = v_data.x;
		float tmean = v_data.y;
		float precip = v_data.w;
		float tnow = temp_now(tmean, v_data.z, d);
		float relief = clamp(detail * 1.5, 0.0, 1.0);
		float px_dir = length(fwidth(v_dir)) * PLANET_R;
		float px_pos = length(fwidth(v_wpos));
		float px = skirt ? px_dir : px_pos;
		vec3 up = normalize(v_wpos);
		vec3 dpx = dFdx(v_wpos);
		vec3 dpy = dFdy(v_wpos);
		// Smooth normal from the height function; the triangle's own normal only where
		// it is much steeper (cliff walls spanning one or two rows of triangles).
		vec3 sn = normalize(v_nrm.xyz);
		vec3 fn = skirt ? sn : facet_normal(dpx, dpy, up);
		float sslope = 1.0 - clamp(dot(sn, up), 0.0, 1.0);
		float fslope = 1.0 - clamp(dot(fn, up), 0.0, 1.0);
		float steep = max(sslope, fslope) * relief;        // 1 - cos(slope angle)
		float ao = mix(1.0, v_nrm.w, relief);
		float mesa = v_surf.x;
		float gully = v_surf.y;
		float curv = v_surf.z;
		float rivd = v_surf.w;
		float above = h - sea_level;

		// Painterly noise: soft large patches, brush-sized mottling, fine grain; every
		// octave fades out before it gets finer than a pixel.
		float n_mid = fbm_aa(d * 420.0 + 5.0, px * 420.0 / PLANET_R);
		float n_brush = fbm_aa(d * 1100.0 + 9.0, px * 1100.0 / PLANET_R);
		float n_fine = (vnoise(d * 3200.0) - 0.5) * aa_keep(3200.0, px);

		vec3 col = land_albedo(h, tnow, tmean, precip, d, v_color.rgb, px);
		float snow = snow_cover(tnow, d);
		float wet = smoothstep(170.0, 1600.0, precip);
		float warm_dry = smoothstep(6.0, 16.0, tmean) * (1.0 - smoothstep(700.0, 1900.0, precip));
		// Painted ground. Grass and bare earth interlock through a height-like mask
		// (clumps + directional tuft strokes) cut by a narrow threshold, so the grass
		// breaks up into earth with ragged edges instead of a smooth blend. Earth gets
		// cracks and pebbles (cellular noise) and lighter trampled tracks. Every layer
		// fades by pixel footprint (k1..k3), so the map view stays calm.
		float k1 = aa_keep(700.0, px);
		float k2 = aa_keep(1800.0, px);
		float k3 = aa_keep(4200.0, px);
		vec3 sq = d + (vec3(vnoise(d * 160.0), vnoise(d * 160.0 + 4.1), vnoise(d * 160.0 + 8.3)) - 0.5) * 0.004;
		float clumpH = fbm_aa(sq * 600.0 + 2.0, px * 600.0 / PLANET_R);
		// Tufts: ridged noise stretched along a slowly turning direction.
		float ang = vnoise(d * 40.0) * 6.2832;
		vec3 ax = normalize(cross(up, vec3(cos(ang), 0.37, sin(ang))));
		vec3 ay = cross(up, ax);
		vec3 sp = vec3(dot(d, ax) * 2000.0, dot(d, ay) * 650.0, dot(d, up) * 650.0);
		float tuft = pow(ridge(sp), 3.0) * aa_keep(2000.0 * 1.6, px);
		float grassH = clumpH * 0.8 + (n_brush - 0.5) * 0.35 + tuft * 0.1;
		float cover = clamp(0.2 + 0.85 * wet + (n_mid - 0.5) * 0.5, 0.0, 1.0);
		float path = smoothstep(0.955, 0.99, ridge(sq * 75.0 + 3.3)) * smoothstep(0.55, 0.75, vnoise(d * 30.0 + 2.0)) * k1 * (1.0 - wet * 0.8) * (1.0 - smoothstep(0.03, 0.1, steep));
		float edgew = 0.045 + 0.25 * (1.0 - k2);   // ragged but crisp up close, soft far away
		float grass = smoothstep(1.0 - cover - edgew, 1.0 - cover + edgew, grassH) * (1.0 - path);
		grass = mix(1.0, grass, relief * (1.0 - snow));
		// Earth: ochre, with cracks and scattered pebbles.
		vec3 earth = mix(mix(mix(C_OCHRE, C_GOLDEN, 0.35), C_SAND, 0.25) * 1.04, mix(C_OCHRE, C_SAND, 0.6), path * 0.7) * (0.88 + 0.24 * n_brush);
		float crack = 0.0;
		float pebble = 0.0;
		if (k1 > 0.0) {
			vec2 wc = worley3(sq * 1100.0);
			crack = (1.0 - smoothstep(0.0, 0.06, wc.y - wc.x)) * aa_keep(1100.0 * 2.5, px) * smoothstep(0.5, 0.7, vnoise(d * 110.0 + 6.0)) * (1.0 - wet);
			vec2 wp = worley3(sq * 1500.0 + 5.0);
			pebble = (1.0 - smoothstep(0.1, 0.22, wp.x)) * aa_keep(1500.0 * 3.0, px) * step(0.6, hash13(floor(sq * 1500.0 + 5.0) + 3.0));
		}
		earth *= 1.0 - 0.25 * crack;
		earth = mix(earth, vec3(0.58, 0.52, 0.42), pebble * 0.5);
		// Grass: the climate colour, darker in dense clumps, lit tips along the strokes.
		vec3 grassc = mix(col, C_GRASS * 1.1, 0.4 * (1.0 - wet)) * mix(0.7, 1.12, smoothstep(0.35, 0.8, grassH)) * (1.0 + tuft * 0.3);
		grassc = mix(grassc, C_FOREST * 1.15, smoothstep(0.62, 0.85, clumpH) * wet * 0.55);
		col = mix(col, mix(earth, grassc, grass), relief * (1.0 - snow));
		float groundBump = grass * (grassH * 0.8 + tuft * 0.5) + (1.0 - grass) * (pebble * 0.6 - crack * 0.5 + n_brush * 0.2);
		float clump = clumpH;

		// Dry washes: sand and gravel in gully floors.
		float wash = smoothstep(0.5, 0.85, gully + (n_mid - 0.5) * 0.3) * smoothstep(-0.05, 0.25, curv) * (1.0 - 0.6 * wet);
		col = mix(col, mix(C_SAND, C_OCHRE, 0.35) * (0.9 + 0.25 * n_brush), wash * 0.75 * relief);

		// River banks: a sandy strip and damp sand at the waterline.
		float rivl = v_rivl + flood * 45.0;
		float bank = (1.0 - smoothstep(1.3, 2.6, rivd + (n_mid - 0.5) * 1.0)) * relief;
		// Wind and current ripples on sand.
		float rip = (sin(dot(d, normalize(vec3(0.7, 0.2, 0.68))) * 9000.0 + vnoise(d * 500.0) * 9.0) * 0.5 + 0.5) * k2;
		float sandy = max(max(bank, wash), (1.0 - smoothstep(6.0, 22.0, above)) * step(0.0, above) * relief);
		col = mix(col, C_SAND * (0.9 + 0.2 * n_brush) * (0.94 + 0.12 * rip), bank * 0.9);
		col *= 1.0 + (rip - 0.5) * 0.08 * sandy;
		float damp = (1.0 - smoothstep(rivl + 2.0, rivl + 14.0, h)) * step(rivd, 6.0) * relief;
		col *= 1.0 - 0.3 * damp;
		col = mix(col, vec3(0.20, 0.33, 0.30), (1.0 - smoothstep(rivl - 6.0, rivl, h)) * step(rivd, 6.0) * relief * 0.6);
		// Wet sand right at the sea shore.
		col *= 1.0 - 0.28 * (1.0 - smoothstep(0.0, 6.0, above)) * step(-1.0, above);

		// Rock: steep faces everywhere, moderate risers too in mesa country.
		float rocky = smoothstep(0.24, 0.46, steep + (n_mid - 0.5) * 0.14);
		rocky = max(rocky, smoothstep(0.16, 0.3, steep) * mesa * 0.9);
		rocky = max(rocky, smoothstep(1500.0, 2800.0, h) * smoothstep(0.06, 0.16, steep + (n_mid - 0.5) * 0.08));
		// Layered strata follow height with a slight warp; fade once they get thinner
		// than a pixel. Vertical streaks come for free: d barely changes up a wall.
		float band = h / 55.0 + (vnoise(d * 70.0) - 0.5) * 1.2 + (fbm(d * 260.0) - 0.5) * 0.35;
		float bk = 1.0 - smoothstep(0.08, 0.3, fwidth(band));
		float s1 = fract(band);
		float layer = smoothstep(0.0, 0.12, s1) * (1.0 - smoothstep(0.55, 0.7, s1));
		float s2 = fract(band * 2.3 + 0.37);
		float thin = smoothstep(0.2, 0.3, s2) * (1.0 - smoothstep(0.75, 0.85, s2));
		float strata = mix(0.5, layer * 0.75 + thin * 0.25, bk);
		float tone = hash13(vec3(floor(band), 1.7, 3.1));
		vec3 red = mix(mix(C_RED_DARK, C_RED, 0.55), mix(C_RED, C_RED_LIGHT, tone * 0.8), strata);
		vec3 grey = mix(mix(v_color.rgb, C_GREY, 0.45), C_GREY * 1.12, strata * 0.6) * (0.85 + 0.25 * tone);
		vec3 rockc = mix(grey, red, clamp(warm_dry * 0.85 + mesa * 0.35, 0.0, 1.0) * (1.0 - smoothstep(1800.0, 3000.0, h) * 0.7));
		float streak = fbm_aa(vec3(d * 700.0), px * 700.0 / PLANET_R);
		// Vertical fluting and cracks: ridged noise of the direction alone, so it runs
		// straight down a wall; hard/soft layers as ledges (smooth bands for the bump).
		float flute = pow(ridge(d * 1500.0 + 7.0), 4.0) * aa_keep(1500.0 * 1.5, px);
		float ledge = (0.5 + 0.5 * sin(band * 6.2832 * 2.0)) * bk;
		rockc *= (0.84 + 0.28 * streak) * (1.0 - 0.35 * flute) * (0.9 + 0.2 * ledge);
		rockc *= 1.0 + clamp(-curv * 1.5, 0.0, 1.0) * 0.35;          // sunlit caprock lips
		rockc *= 1.0 - clamp(curv * 1.5, 0.0, 1.0) * 0.3;            // dark contact at the foot
		col = mix(col, rockc, rocky);
		// Scree and talus at cliff feet (concave, occluded, moderately steep).
		float scree = (1.0 - smoothstep(0.55, 0.85, v_nrm.w)) * smoothstep(0.03, 0.14, steep) * (1.0 - rocky) * relief;
		col = mix(col, mix(rockc, vec3(0.56, 0.46, 0.34), 0.5) * (0.85 + 0.3 * n_brush), scree * (0.35 + 0.4 * mesa));

		// Snow on top of everything but sheer walls.
		col = mix(col, C_SNOW * (0.94 + 0.08 * n_brush), snow * (1.0 - rocky * smoothstep(0.12, 0.3, steep) * 0.9) * relief);
		col = mix(col, land_albedo(h, tnow, tmean, precip, d, v_color.rgb, 2.0), 1.0 - relief);
		// Drowned ground turns to wet sea bed, darkening with depth; occluded hollows a
		// touch darker; cloud shadows.
		col = mix(col, vec3(0.42, 0.40, 0.30), smoothstep(0.0, 30.0, sea_level - h) * 0.7);
		col *= mix(1.0, 0.5, smoothstep(0.0, 800.0, sea_level - h));
		col *= mix(0.88, 1.0, ao);
		col *= 1.0 - 0.2 * cloud_cover(d) * relief;

		// Bump the normal with the ground detail (screen-space gradient of a height).
		float bump = (skirt ? 0.0 : 1.0) * relief * (rocky * streak * 0.35 + (1.0 - rocky) * (groundBump * (1.0 - sandy) + rip * 0.4 * sandy));
		float useF = smoothstep(0.18, 0.42, fslope - sslope) * relief;
		vec3 n = normalize(mix(sn, fn, useF));
		vec3 r1 = cross(dpy, n);
		vec3 r2 = cross(n, dpx);
		float det = dot(dpx, r1);
		vec3 grad = sign(det) * (dFdx(bump) * r1 + dFdy(bump) * r2);
		n = normalize(abs(det) * n - grad * 0.02);
		vec3 emi = h > sea_level ? night_lights(d, v_color.a) * (1.0 - relief * 0.7) : vec3(0.0);
		// Skirts sit under the ground, so the shadow map would black them out.
		float sh = skirt || dot(n, sun_dir_world) <= 0.0 ? 1.0 : shadow_factor(v_wpos, n);
		vec3 c = lit_s(col, n, v_wpos, 0.95, 0.03, emi, ao, sh);
		gl_FragColor = vec4(tonemap(haze(c, distance(cameraPosition, v_wpos), v_wpos)), 1.0);
	}`;

	// ---------------------------------------------------------------- sea (same vertices as terrain)
	S.waterVert = S.COMMON + `
	attribute vec4 adata;
	attribute vec4 acolor;
	varying vec3 v_dir;
	varying vec3 v_wpos;
	varying vec4 v_data;
	varying float v_skirt;
	void main() {
		v_dir = normalize(position);
		v_data = adata;
		v_skirt = acolor.a < -0.5 ? 1.0 : 0.0;
		vec4 wp = modelMatrix * vec4(v_dir * (PLANET_R + disp(sea_level) * detail), 1.0);
		v_wpos = wp.xyz;
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.waterFrag = S.COMMON + `
	varying vec3 v_dir;
	varying vec3 v_wpos;
	varying vec4 v_data;
	varying float v_skirt;
	void main() {
		float depth = sea_level - v_data.x;
		if (depth < -4.0 || v_skirt > 0.001) discard;
		depth = max(depth, 0.0);
		vec3 d = normalize(v_dir);
		float tnow = temp_now(v_data.y, v_data.z, d);
		float ice = 1.0 - smoothstep(-7.0, -2.5, tnow);
		vec3 col = water_color(depth, tnow);
		// Turquoise over the sand right by the shore.
		col = mix(col, vec3(0.20, 0.52, 0.46), (1.0 - smoothstep(0.0, 70.0, depth)) * 0.6 * (1.0 - ice));
		// Soft swell plus bands of surf rolling onto the shore.
		float swell = fbm(d * 260.0 + vec3(wall_time * 0.15, 0.0, wall_time * 0.1));
		col *= (0.9 + 0.2 * swell) * (1.0 - 0.2 * cloud_cover(d) * clamp(detail * 1.5, 0.0, 1.0));
		float shore = (1.0 - smoothstep(0.0, 30.0, depth)) * smoothstep(-40.0, 0.0, v_data.x); // surf only on real shores, not flooded plains
		float surf = sin(depth * 0.14 - wall_time * 1.4 + swell * 5.0) * 0.5 + 0.5;
		float foam = shore * smoothstep(0.6, 0.95, surf) * (1.0 - ice);
		col = mix(col, vec3(0.95, 0.93, 0.85), foam * 0.45);
		// Fresnel: grazing views reflect the sky.
		vec3 n = normalize(v_wpos);
		vec3 view = normalize(cameraPosition - v_wpos);
		float fres = pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 4.0);
		col = mix(col, vec3(0.50, 0.60, 0.66), fres * 0.45 * (1.0 - ice));
		// Ripple the normal a little so the sun glints.
		vec3 rn = normalize(n + (vec3(vnoise(d * 700.0 + wall_time * 0.5), vnoise(d * 700.0 + 9.0 - wall_time * 0.4), vnoise(d * 700.0 + 4.0)) - 0.5) * 0.12);
		vec3 c = lit(col, rn, v_wpos, mix(0.15, 0.8, ice), 0.7, vec3(0.0), 1.0);
		float alpha = clamp(mix(0.78, 0.97, 1.0 - exp(-depth / 150.0)) + foam * 0.3 + fres * 0.25, 0.0, 1.0);
		gl_FragColor = vec4(tonemap(haze(c, distance(cameraPosition, v_wpos), v_wpos)), alpha);
	}`;

	// ---------------------------------------------------------------- rivers
	// A level water ribbon along the carved channel. ariver = (side -1/+1, water level m,
	// channel half width, mean temp); aacross = (across xyz, seasonal amp); aflow =
	// (distance along the channel, ribbon half width incl. banks).
	S.riverVert = S.COMMON + `
	attribute vec4 ariver;
	attribute vec4 aacross;
	attribute vec2 aflow;
	varying vec3 v_wpos;
	varying vec3 v_dir;
	varying vec3 v_flowdir;
	varying float v_level;
	varying float v_tnow;
	varying float v_flood;
	varying float v_side;
	void main() {
		vec3 d = normalize(position);
		float hemi = clamp(d.y * 6.0, -1.0, 1.0);
		v_tnow = ariver.w + aacross.w * season * hemi;
		v_flood = clamp(flood + 0.2 * max(season * hemi, 0.0), 0.0, 1.5);
		v_level = ariver.y + v_flood * 45.0;
		vec3 across = normalize(aacross.xyz);
		v_flowdir = cross(across, d);
		// Far away the coarse terrain cannot show the channel: lift a narrower ribbon.
		vec4 w0 = modelMatrix * vec4(d * PLANET_R, 1.0);
		float dist = distance(cameraPosition, w0.xyz);
		float far = smoothstep(16.0, 30.0, dist);
		float half_w = mix(aflow.y + v_flood * 0.15, ariver.z * (1.0 + v_flood), smoothstep(9.0, 15.0, dist));
		v_side = ariver.x * half_w / ariver.z;
		d = normalize(d * PLANET_R + across * ariver.x * half_w);
		v_dir = d;
		vec4 wp = modelMatrix * vec4(d * (PLANET_R + (disp(v_level) + 0.004 + far * 0.05) * detail), 1.0);
		v_wpos = wp.xyz;
		gl_Position = projectionMatrix * viewMatrix * wp;
	}`;
	S.riverFrag = S.COMMON + `
	varying vec3 v_wpos;
	varying vec3 v_dir;
	varying vec3 v_flowdir;
	varying float v_level;
	varying float v_tnow;
	varying float v_flood;
	varying float v_side;
	void main() {
		if (v_level < sea_level - 2.0) discard;
		float s = abs(v_side);                  // 0 centre, 1 channel edge, >1 over the banks
		float depthk = 1.0 - smoothstep(0.0, 1.15, s);
		vec3 col = mix(vec3(0.24, 0.43, 0.40), vec3(0.09, 0.27, 0.29), depthk);
		col = mix(col, vec3(0.40, 0.34, 0.22), clamp(v_flood, 0.0, 1.0) * 0.55);
		// Flow: noise advected downstream.
		vec3 q = v_dir * PLANET_R * 7.0 - v_flowdir * wall_time * 1.6;
		float ripple = vnoise(q * vec3(1.0, 1.0, 1.0)) * 0.6 + vnoise(q * 2.7 + 3.0) * 0.4;
		col *= 0.9 + 0.22 * ripple;
		float ice = 1.0 - smoothstep(-6.0, -3.0, v_tnow);
		col = mix(col, vec3(0.82, 0.90, 0.96), ice);
		vec3 n = normalize(v_wpos);
		vec3 view = normalize(cameraPosition - v_wpos);
		float fres = pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 4.0);
		col = mix(col, vec3(0.55, 0.65, 0.70), fres * 0.5 * (1.0 - ice));
		vec3 rn = normalize(n + (vec3(vnoise(q * 1.3), vnoise(q * 1.3 + 7.0), vnoise(q * 1.3 + 13.0)) - 0.5) * 0.16);
		vec3 c = lit(col, rn, v_wpos, mix(0.12, 0.8, ice), 0.8, vec3(0.0), 1.0);
		float alpha = mix(0.62, 0.94, depthk) * (1.0 - smoothstep(1.4, 2.0, s) * 0.3);
		gl_FragColor = vec4(tonemap(haze(c, distance(cameraPosition, v_wpos), v_wpos)), max(alpha, ice));
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

	// ---------------------------------------------------------------- vegetation and rocks (instanced)
	// Per vertex: aveg = (part 0 wood / 1 foliage / 2 rock / 3 grass, baked shade).
	// Per instance: ipos = (dir xyz, height m), iparam = (yaw, scale, lean, random),
	// iclim = (mean temp, signed seasonal amp, ground AO, moisture or rock warmth).
	S.vegVert = S.COMMON + `
	uniform float kind;
	attribute vec4 aveg;
	attribute vec4 ipos;
	attribute vec4 iparam;
	attribute vec4 iclim;
	varying vec3 v_wpos;
	varying vec3 v_wn;
	varying vec3 v_lpos;
	varying vec4 v_veg;
	varying vec4 v_inst;
	void main() {
		vec3 up = normalize(ipos.xyz);
		vec3 ref = abs(up.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
		vec3 ex = normalize(cross(ref, up));
		vec3 ez = cross(ex, up);
		vec3 ax = ex * cos(iparam.x) + ez * sin(iparam.x);
		vec3 ay = normalize(up + ax * iparam.z);
		ax = normalize(ax - ay * dot(ax, ay));
		vec3 az = cross(ax, ay);
		float grow = smoothstep(0.5, 0.95, detail);
		if (ipos.w < sea_level + 3.0) grow = 0.0; // drowned
		float r = iparam.w;
		vec3 p = position * vec3(1.0 + (r - 0.5) * 0.35, 1.0 - (r - 0.5) * 0.3, 1.0 + (fract(r * 7.13) - 0.5) * 0.3) * iparam.y * grow;
		// A little wind in the foliage and grass.
		float sway = (aveg.x > 0.5 && aveg.x < 1.5) || aveg.x > 2.5 ? sin(wall_time * 1.4 + r * 40.0) * 0.06 * max(position.y, 0.0) : 0.0;
		p.x += sway * iparam.y;
		vec3 lp = up * (PLANET_R + disp(ipos.w) * detail) + ax * p.x + ay * p.y + az * p.z;
		vec4 wp = modelMatrix * vec4(lp, 1.0);
		v_wpos = wp.xyz;
		v_lpos = position;
		v_wn = normalize(mat3(modelMatrix) * (ax * normal.x + ay * normal.y + az * normal.z));
		v_veg = aveg;
		v_inst = vec4(iclim.x + iclim.y * season, iclim.x, iclim.z, iclim.w);
		v_inst.x = v_inst.x; // current temperature
		gl_Position = projectionMatrix * viewMatrix * wp;
		v_veg.z = r;
	}`;
	S.vegFrag = S.COMMON + `
	uniform float kind;     // 0 broadleaf, 1 conifer, 2 acacia, 3 palm, 4 shrub, 5 grass tuft, 6 rock
	uniform vec3 leaf_col;
	uniform vec3 wood_col;
	varying vec3 v_wpos;
	varying vec3 v_wn;
	varying vec3 v_lpos;
	varying vec4 v_veg;
	varying vec4 v_inst;
	void main() {
		float part = v_veg.x;
		float shade = v_veg.y;
		if (kind > 7.5) { // contact shadow disc: dark centre fading out
			float day = smoothstep(-0.1, 0.25, dot(normalize(v_wpos), sun_dir_world));
			gl_FragColor = vec4(0.0, 0.0, 0.0, shade * shade * 0.45 * day);
			return;
		}
		float r = v_veg.z;
		float tnow = v_inst.x;
		float tmean = v_inst.y;
		float moist = v_inst.w;
		vec3 col;
		float rough = 0.9;
		if (part < 0.5) {
			col = wood_col * (0.8 + 0.4 * r);
		} else if (part < 1.5 || part > 2.5) {
			// Foliage and grass: per-instance hue and value, drier and olive where it is dry.
			col = leaf_col * vec3(1.0 + (r - 0.5) * 0.3, 1.0 + (fract(r * 5.7) - 0.5) * 0.2, 1.0 + (fract(r * 3.3) - 0.5) * 0.2);
			vec3 dry = part > 2.5 ? vec3(0.46, 0.36, 0.14) : vec3(0.30, 0.29, 0.14);
			col = mix(dry, col, smoothstep(0.05, 0.6, moist) * (part > 2.5 ? 0.8 : 1.0));
			if (part > 2.5) col = mix(col, vec3(0.30, 0.34, 0.13), smoothstep(0.5, 0.9, moist));
			// Deciduous trees and grass turn and drop in the cold season.
			float temperate = smoothstep(4.0, 9.0, tmean) * (1.0 - smoothstep(17.0, 22.0, tmean));
			float dormant = (1.0 - smoothstep(1.0, 9.0, tnow)) * temperate * (kind < 0.5 || kind > 3.5 ? 1.0 : 0.0);
			col = mix(col, vec3(0.46, 0.30, 0.13), dormant * 0.75);
			col = mix(col, vec3(0.90, 0.94, 1.0), (1.0 - smoothstep(-4.0, 0.0, tnow)) * smoothstep(0.3, 0.9, shade) * 0.8);
		} else {
			// Rock: grey to warm sandstone, mottled.
			col = mix(vec3(0.34, 0.33, 0.31), vec3(0.50, 0.30, 0.19), moist) * (0.75 + 0.35 * r);
			col *= 0.8 + 0.35 * vnoise(v_lpos * 90.0 + r * 10.0);
			col = mix(col, vec3(0.90, 0.94, 1.0), (1.0 - smoothstep(-4.0, 0.0, tnow)) * smoothstep(0.6, 1.0, normalize(v_wn).y * 0.5 + 0.5) * 0.0);
			rough = 0.8;
		}
		float ao = mix(0.35, 1.0, shade) * mix(0.7, 1.0, v_inst.z);
		vec3 n = normalize(v_wn);
		vec3 c = lit(col, n, v_wpos, rough, part > 1.5 && part < 2.5 ? 0.05 : 0.02, vec3(0.0), ao);
		// Sun through the leaves.
		if (part > 0.5 && part < 1.5) c += col * sun_color * max(dot(-n, sun_dir_world), 0.0) * 0.35 * shade;
		// Warm rim where the crown's edge catches the sun.
		vec3 vv = normalize(cameraPosition - v_wpos);
		float rim = pow(1.0 - max(dot(n, vv), 0.0), 3.0) * max(dot(n, sun_dir_world) + 0.3, 0.0);
		if (part > 0.5 && part < 1.5 || part > 2.5) c += vec3(1.0, 0.75, 0.45) * sun_color * rim * 0.18 * shade;
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
		vec3 c = lit(vec3(1.0), normalize(v_wpos), v_wpos, 1.0, 0.0, vec3(0.0), 1.0);
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
