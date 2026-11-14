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
	col *= mix(1.0, 0.55, smoothstep(0.0, 800.0, sea_level - v_h)); // darker sea bed
	ALBEDO = col;
	ROUGHNESS = 0.95;
	SPECULAR = 0.15;
	EMISSION = v_h > sea_level ? night_lights(d, COLOR.a) : vec3(0.0);

	// Faceted low-poly normals, facing the viewer whatever the winding.
	vec3 fn = normalize(cross(dFdx(VERTEX), dFdy(VERTEX)));
	if (dot(fn, VIEW) < 0.0) {
		fn = -fn;
	}
	NORMAL = normalize(mix(NORMAL, fn, clamp(detail * 1.5, 0.0, 1.0)));
}
