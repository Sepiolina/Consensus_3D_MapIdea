// Sea surface of a cell. Reuses the terrain vertex data, so raising `sea_level`
// floods exactly the ground that lies below it.
shader_type spatial;
render_mode cull_disabled, blend_mix, depth_draw_never;

#include "res://shaders/common.gdshaderinc"

varying vec3 v_dir;
varying float v_h;
varying float v_tmean;
varying float v_tamp;

void vertex() {
	v_dir = normalize(VERTEX);
	v_h = UV.x * 10000.0;
	v_tmean = UV.y * 50.0;
	v_tamp = UV2.x * 50.0;
	VERTEX = v_dir * (PLANET_R + disp(sea_level) * detail);
	NORMAL = v_dir;
}

void fragment() {
	float depth = sea_level - v_h;
	if (depth < -4.0) {
		discard;
	}
	depth = max(depth, 0.0);
	vec3 d = normalize(v_dir);
	float tnow = temp_now(v_tmean, v_tamp, d);
	float ripple = vnoise(d * 900.0 + vec3(wall_time * 0.6, 0.0, wall_time * 0.4));
	ALBEDO = water_color(depth, tnow) * (0.93 + 0.14 * ripple);
	ALPHA = mix(0.72, 0.97, 1.0 - exp(-depth / 350.0));
	ROUGHNESS = 0.25;
	SPECULAR = 0.6;
}
