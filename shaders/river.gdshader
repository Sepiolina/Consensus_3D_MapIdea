// River ribbons. `flood` widens and raises them (overflow), and each hemisphere
// gets a seasonal high-water bump in its warm season.
shader_type spatial;
render_mode cull_disabled;

#include "res://shaders/common.gdshaderinc"

uniform float flood = 0.0;

varying float v_h;
varying float v_tnow;
varying float v_flood;

void vertex() {
	vec3 d = normalize(VERTEX);
	float side = UV.x;
	v_h = UV.y * 10000.0;
	float width = UV2.x;
	float tmean = UV2.y * 50.0;
	vec3 across = normalize(COLOR.rgb * 2.0 - 1.0);
	float tamp = COLOR.a * 50.0;
	float hemi = clamp(d.y * 6.0, -1.0, 1.0);
	v_tnow = tmean + tamp * season * hemi;
	v_flood = clamp(flood + 0.2 * max(season * hemi, 0.0), 0.0, 1.5);
	float half_w = width * (1.0 + v_flood * 4.0) * 0.5;
	d = normalize(d * PLANET_R + across * side * half_w);
	VERTEX = d * (PLANET_R + disp(v_h) * detail + 0.004 + (0.035 + v_flood * 0.03) * detail);
	NORMAL = d;
}

void fragment() {
	if (v_h < sea_level - 1.0) {
		discard;
	}
	vec3 col = mix(vec3(0.16, 0.50, 0.76), vec3(0.46, 0.40, 0.28), clamp(v_flood, 0.0, 1.0) * 0.6);
	col = mix(col, vec3(0.85, 0.92, 0.97), 1.0 - smoothstep(-6.0, -3.0, v_tnow));
	ALBEDO = haze(col, VERTEX);
	ROUGHNESS = 0.3;
	SPECULAR = 0.5;
}
