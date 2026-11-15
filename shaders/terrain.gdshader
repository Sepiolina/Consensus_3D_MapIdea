// Near view: one mesh per Voronoi cell, relief applied in the vertex shader so it
// can be flattened smoothly back onto the globe while zooming out.
shader_type spatial;
render_mode cull_disabled;

#include "res://shaders/common.gdshaderinc"

varying vec3 v_dir;
varying float v_h;
varying float v_tmean;
varying float v_tamp;
varying float v_precip;

void vertex() {
	v_dir = normalize(VERTEX);
	v_h = UV.x * 10000.0;
	v_tmean = UV.y * 50.0;
	v_tamp = UV2.x * 50.0;
	v_precip = UV2.y * 4000.0;
	VERTEX = v_dir * (PLANET_R + disp(v_h) * detail);
}

void fragment() {
	vec3 d = normalize(v_dir);
	float tnow = temp_now(v_tmean, v_tamp, d);
	vec3 col = land_color(v_h, tnow, v_tmean, v_precip, d, COLOR.rgb);

	// Faceted low-poly normals; steep facets (terrace cliffs, mountain sides) show
	// banded bedrock instead of vegetation.
	float relief = clamp(detail * 1.5, 0.0, 1.0);
	vec3 smooth_n = normalize(NORMAL);
	vec3 fn = facet_normal(dFdx(VERTEX), dFdy(VERTEX), VIEW);
	float slope = 1.0 - clamp(dot(fn, smooth_n), 0.0, 1.0);
	float cliff = smoothstep(0.05, 0.16, slope) * relief;
	float strata = 0.82 + 0.18 * step(0.5, fract(v_h / 45.0 + vnoise(d * 90.0) * 0.6));
	vec3 rock = COLOR.rgb * strata * 1.15;
	float frozen = 1.0 - smoothstep(-5.0, 0.5, tnow);
	col = mix(col, mix(rock, vec3(0.9, 0.93, 0.97), frozen * 0.5), cliff * 0.9);

	col *= mix(1.0, 0.55, smoothstep(0.0, 800.0, sea_level - v_h)); // darker sea bed
	ALBEDO = haze(col, VERTEX);
	ROUGHNESS = 0.95;
	SPECULAR = 0.15;
	EMISSION = v_h > sea_level ? night_lights(d, COLOR.a) * (1.0 - relief * 0.7) : vec3(0.0);
	NORMAL = normalize(mix(smooth_n, fn, relief));
}
