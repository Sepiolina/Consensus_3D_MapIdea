// Far view: a plain sphere textured with the baked equirectangular 2D map.
shader_type spatial;

#include "res://shaders/common.gdshaderinc"

uniform sampler2D data_tex : filter_linear, repeat_enable; // height, mean temp, seasonal amp, precip
uniform sampler2D mask_tex : filter_linear, repeat_enable; // cell border, river, population
uniform float border_strength = 0.3;
uniform float sink = 0.0; // pushes the globe under the 3D cells when zoomed in

varying vec3 v_dir;

void vertex() {
	v_dir = normalize(VERTEX);
	VERTEX = v_dir * (PLANET_R - sink);
}

void fragment() {
	vec3 d = normalize(v_dir);
	vec2 uv = vec2(atan(d.z, d.x) / TAU + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI);
	vec4 dat = textureLod(data_tex, uv, 0.0);
	vec4 msk = textureLod(mask_tex, uv, 0.0);
	float h = dat.r * 10000.0;
	float tmean = dat.g * 50.0;
	float tamp = dat.b * 50.0;
	float precip = dat.a * 4000.0;
	float tnow = temp_now(tmean, tamp, d);

	vec3 col;
	float rough = 0.95;
	float spec = 0.15;
	vec3 emi = vec3(0.0);
	if (h > sea_level) {
		col = land_color(h, tnow, tmean, precip, d, vec3(0.46, 0.42, 0.38));
		vec3 river = tnow < -4.0 ? vec3(0.85, 0.92, 0.97) : vec3(0.16, 0.50, 0.76);
		col = mix(col, river, smoothstep(0.15, 0.6, msk.g) * 0.9);
		emi = night_lights(d, msk.b);
	} else {
		col = water_color(sea_level - h, tnow);
		rough = 0.3;
		spec = 0.6;
	}
	col = mix(col, vec3(1.0), smoothstep(0.35, 0.9, msk.r) * border_strength);
	ALBEDO = col;
	ROUGHNESS = rough;
	SPECULAR = spec;
	EMISSION = emi;
}
