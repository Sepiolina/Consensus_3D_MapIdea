// Shared by every planet shader. Keep the constants in sync with planet_view.gd.
const float PLANET_R = 100.0;
const float RELIEF_MAX = 3.6;     // world units the highest peaks approach
const float RELIEF_H0 = 2500.0;   // metres; lowlands are exaggerated more than peaks
const float SEA_FLOOR = 1.0;      // deepest rendered sea bed, in world units

uniform float sea_level = 0.0;     // metres relative to the generated datum
uniform float detail = 0.0;        // 0 = flat globe, 1 = full 3D relief
uniform float season = 0.0;        // -1 = northern winter solstice, +1 = northern summer
uniform vec3 sun_dir_local = vec3(1.0, 0.0, 0.0); // sun direction in planet space
uniform vec3 sun_dir_world = vec3(1.0, 0.0, 0.0);
uniform float wall_time = 0.0;     // real seconds, for cosmetic animation

float disp(float h) {
	if (h >= 0.0) {
		return RELIEF_MAX * (1.0 - exp(-h / RELIEF_H0));
	}
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

	vec3 desert = vec3(0.86, 0.72, 0.46);
	vec3 tundra = vec3(0.56, 0.56, 0.42);
	vec3 savanna = vec3(0.74, 0.68, 0.30);
	vec3 grass = vec3(0.50, 0.70, 0.24);
	vec3 taiga = vec3(0.17, 0.40, 0.26);
	vec3 forest = vec3(0.20, 0.52, 0.17);
	vec3 jungle = vec3(0.07, 0.43, 0.13);

	vec3 dry = mix(tundra, desert, smoothstep(-2.0, 16.0, tmean));
	vec3 mid = mix(tundra, mix(grass, savanna, smoothstep(15.0, 23.0, tmean)), smoothstep(-4.0, 5.0, tmean));
	vec3 lush = mix(taiga, mix(forest, jungle, smoothstep(17.0, 24.0, tmean)), smoothstep(1.0, 9.0, tmean));
	vec3 col = wet < 0.5 ? mix(dry, mid, wet * 2.0) : mix(mid, lush, wet * 2.0 - 1.0);

	// Seasonal dormancy of temperate vegetation.
	float temperate = smoothstep(0.0, 6.0, tmean) * (1.0 - smoothstep(16.0, 22.0, tmean));
	float dormant = (1.0 - smoothstep(1.0, 9.0, tnow)) * temperate;
	col = mix(col, vec3(0.56, 0.43, 0.24), dormant * 0.55);

	// Freshly exposed sea bed, then the beach strip around the current shoreline.
	col = mix(col, vec3(0.62, 0.56, 0.44), (1.0 - smoothstep(-200.0, 0.0, h)) * 0.8);
	col = mix(vec3(0.90, 0.82, 0.60), col, smoothstep(5.0, 70.0, h - sea_level));

	// Bare rock at altitude, snow wherever it is currently freezing.
	col = mix(col, rock, smoothstep(1800.0, 3600.0, h) * 0.85);
	float snow = 1.0 - smoothstep(-5.0, 0.5, tnow + (n - 0.5) * 4.0);
	col = mix(col, vec3(0.95, 0.97, 1.0), snow);
	// Higher terraces read slightly lighter, so the levels separate visually.
	col *= 0.92 + 0.14 * smoothstep(0.0, 1800.0, h);
	return col * (0.9 + 0.2 * n);
}

// Flat-shaded normal from the screen-space derivatives (dFdx, dFdy) of the
// view-space position, flipped to face the viewer whatever the winding.
vec3 facet_normal(vec3 dpdx, vec3 dpdy, vec3 view_dir) {
	vec3 fn = normalize(cross(dpdx, dpdy));
	return dot(fn, view_dir) < 0.0 ? -fn : fn;
}

// Aerial perspective for the close-up map: distant ground fades to sky blue.
vec3 haze(vec3 col, vec3 view_pos) {
	float f = (1.0 - exp(-length(view_pos) / 260.0)) * detail * 0.55;
	return mix(col, vec3(0.62, 0.75, 0.92), f);
}

vec3 water_color(float depth, float tnow) {
	vec3 shallow = vec3(0.16, 0.62, 0.66);
	vec3 deep = vec3(0.03, 0.13, 0.36);
	vec3 col = mix(shallow, deep, 1.0 - exp(-depth / 900.0));
	col = mix(col, vec3(0.85, 0.95, 0.97), (1.0 - smoothstep(0.0, 25.0, depth)) * 0.45);
	float ice = 1.0 - smoothstep(-7.0, -2.5, tnow);
	return mix(col, vec3(0.86, 0.93, 0.98), ice);
}

// Settlement lights on the night side, driven by a habitability value.
vec3 night_lights(vec3 dir, float pop) {
	float night = 1.0 - smoothstep(-0.12, 0.08, dot(dir, sun_dir_local));
	float blobs = smoothstep(0.55, 0.85, vnoise(dir * 150.0)) * smoothstep(0.4, 0.8, vnoise(dir * 420.0));
	return vec3(1.0, 0.72, 0.36) * blobs * pop * night * 2.0;
}
