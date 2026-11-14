// Additive glow quad; the script keeps it facing the camera.
shader_type spatial;
render_mode unshaded, blend_add, depth_draw_never, cull_disabled;

uniform vec3 star_color : source_color = vec3(1.0, 0.92, 0.75);

void fragment() {
	float r = length(UV - vec2(0.5)) * 2.0;
	float g = pow(max(1.0 - r, 0.0), 3.0);
	ALBEDO = star_color * g * 2.0;
	ALPHA = g;
}
