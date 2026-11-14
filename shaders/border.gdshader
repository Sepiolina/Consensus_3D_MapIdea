// Voronoi cell outlines and corner dots, draped over land and sea surface.
shader_type spatial;
render_mode unshaded, cull_disabled;

#include "res://shaders/common.gdshaderinc"

uniform float border_strength = 1.0;
uniform float lift = 0.05;

void vertex() {
	vec3 d = normalize(VERTEX);
	float h = UV.x * 10000.0;
	VERTEX = d * (PLANET_R + disp(max(h, sea_level)) * detail + lift);
}

void fragment() {
	if (border_strength < 0.01) {
		discard;
	}
	ALBEDO = COLOR.rgb;
}
