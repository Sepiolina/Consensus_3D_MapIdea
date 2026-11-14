// Analytic atmosphere shell: opacity from the length of the view ray inside the
// shell, colour from the sun angle. Works from space and from inside.
shader_type spatial;
render_mode unshaded, cull_front, blend_mix, depth_draw_never;

uniform vec3 sun_dir_world = vec3(1.0, 0.0, 0.0);
uniform float atm_radius = 104.5;
uniform float planet_radius = 99.0;

varying vec3 v_world;

void vertex() {
	v_world = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec3 ro = CAMERA_POSITION_WORLD;
	vec3 rd = normalize(v_world - ro);
	float b = dot(ro, rd);
	float disc = b * b - (dot(ro, ro) - atm_radius * atm_radius);
	if (disc <= 0.0) {
		discard;
	}
	float sq = sqrt(disc);
	float t0 = max(-b - sq, 0.0);
	float t1 = -b + sq;
	float dp = b * b - (dot(ro, ro) - planet_radius * planet_radius);
	if (dp > 0.0) {
		float tp = -b - sqrt(dp);
		if (tp > 0.0) {
			t1 = min(t1, tp);
		}
	}
	float len = max(t1 - t0, 0.0);
	vec3 mid = ro + rd * (t0 + len * 0.5);
	float sun = dot(normalize(mid), sun_dir_world);
	float day = smoothstep(-0.25, 0.35, sun);
	float twilight = smoothstep(-0.25, 0.0, sun) * (1.0 - smoothstep(0.0, 0.3, sun));
	vec3 col = mix(vec3(0.35, 0.60, 1.0), vec3(1.0, 0.5, 0.25), twilight * 0.7);
	ALBEDO = col * (0.15 + 0.85 * day);
	ALPHA = (1.0 - exp(-len / ((atm_radius - planet_radius) * 2.5))) * day * 0.9;
}
