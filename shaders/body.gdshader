// Other planets and the moon: noise blotches or gas bands, lit from the star.
shader_type spatial;
render_mode unshaded;

#include "res://shaders/common.gdshaderinc"

uniform vec3 color_a : source_color = vec3(0.6, 0.5, 0.4);
uniform vec3 color_b : source_color = vec3(0.3, 0.25, 0.2);
uniform float banded = 0.0;
uniform vec3 star_pos_world = vec3(0.0);

varying vec3 v_dir;
varying vec3 v_wn;
varying vec3 v_wp;

void vertex() {
	v_dir = normalize(VERTEX);
	v_wn = normalize(mat3(MODEL_MATRIX) * NORMAL);
	v_wp = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec3 d = normalize(v_dir);
	float blotch = fbm(d * 3.0);
	float bands = fbm(vec3(d.y * 9.0 + fbm(d * 2.0) * 1.5, 0.3, 0.7));
	float n = mix(blotch, bands, banded);
	vec3 col = mix(color_a, color_b, smoothstep(0.3, 0.7, n));
	float l = max(dot(normalize(v_wn), normalize(star_pos_world - v_wp)), 0.0);
	ALBEDO = col * (0.04 + l);
}
