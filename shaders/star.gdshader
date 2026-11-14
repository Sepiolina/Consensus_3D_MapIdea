shader_type spatial;
render_mode unshaded;

#include "res://shaders/common.gdshaderinc"

uniform vec3 star_color : source_color = vec3(1.0, 0.92, 0.75);

varying vec3 v_dir;

void vertex() {
	v_dir = normalize(VERTEX);
}

void fragment() {
	vec3 d = normalize(v_dir);
	float n = fbm(d * 7.0 + vec3(wall_time * 0.05));
	float limb = pow(max(dot(NORMAL, VIEW), 0.0), 0.4);
	ALBEDO = star_color * (1.5 + n) * (0.55 + 0.65 * limb);
}
