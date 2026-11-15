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
	float ice = 1.0 - smoothstep(-7.0, -2.5, tnow);
	vec3 col = water_color(depth, tnow);

	// Soft swell plus bands of surf rolling onto the shore.
	float swell = fbm(d * 260.0 + vec3(wall_time * 0.15, 0.0, wall_time * 0.1));
	col *= 0.9 + 0.2 * swell;
	float shore = 1.0 - smoothstep(0.0, 110.0, depth);
	float surf = sin(depth * 0.16 - wall_time * 1.4 + swell * 5.0) * 0.5 + 0.5;
	float foam = shore * smoothstep(0.62, 0.95, surf) * (1.0 - ice);
	col = mix(col, vec3(1.0), foam * 0.75);

	// Fresnel: grazing views reflect the sky.
	float fres = pow(1.0 - clamp(dot(normalize(NORMAL), VIEW), 0.0, 1.0), 4.0);
	col = mix(col, vec3(0.70, 0.84, 0.97), fres * 0.5 * (1.0 - ice));

	ALBEDO = haze(col, VERTEX);
	ALPHA = clamp(mix(0.70, 0.97, 1.0 - exp(-depth / 350.0)) + foam * 0.3 + fres * 0.2, 0.0, 1.0);
	ROUGHNESS = mix(0.12, 0.7, ice);
	SPECULAR = 0.7;
}
