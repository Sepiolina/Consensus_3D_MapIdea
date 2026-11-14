// Drifting cloud shell, faded out by script as the camera approaches the ground.
shader_type spatial;
render_mode blend_mix, depth_draw_never, specular_disabled;

#include "res://shaders/common.gdshaderinc"

uniform float cloud_alpha = 1.0;
uniform float coverage = 0.52;

varying vec3 v_dir;

void vertex() {
	v_dir = normalize(VERTEX);
}

void fragment() {
	vec3 d = normalize(v_dir);
	float ang = wall_time * 0.004;
	vec3 q = vec3(d.x * cos(ang) - d.z * sin(ang), d.y, d.x * sin(ang) + d.z * cos(ang));
	float n = mix(fbm(q * 4.5 + vec3(0.0, wall_time * 0.003, 0.0)), fbm(q * 13.0), 0.3);
	float a = smoothstep(coverage, coverage + 0.22, n);
	ALBEDO = vec3(1.0);
	ROUGHNESS = 1.0;
	ALPHA = a * cloud_alpha * 0.85;
}
