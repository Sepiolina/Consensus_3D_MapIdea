// MultiMesh houses: a subdivided box whose top ring is pinched into a gable roof.
// INSTANCE_CUSTOM = (height/10000, mean temp/50, signed seasonal amp/50, random).
shader_type spatial;
render_mode cull_disabled;

#include "res://shaders/common.gdshaderinc"

varying float v_y;
varying float v_rand;
varying float v_night;
varying float v_tnow;

void vertex() {
	float h = INSTANCE_CUSTOM.r * 10000.0;
	v_tnow = (INSTANCE_CUSTOM.g + INSTANCE_CUSTOM.b * season) * 50.0;
	v_rand = INSTANCE_CUSTOM.a;
	vec3 p = VERTEX;
	v_y = p.y;
	if (p.y > 0.01) {
		p.x = 0.0; // roof ridge
		p.y *= 0.85;
	}
	p.y += 0.065;
	float grow = (0.8 + 0.5 * v_rand) * smoothstep(0.5, 0.95, detail);
	if (h < sea_level + 3.0) {
		grow = 0.0; // drowned
	}
	p *= grow;
	p.y += disp(h) * detail; // local +Y is the planet's radial direction
	vec3 up = normalize((MODEL_MATRIX * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
	v_night = 1.0 - smoothstep(-0.12, 0.08, dot(up, sun_dir_world));
	VERTEX = p;
}

void fragment() {
	float roof = smoothstep(0.0, 0.004, v_y);
	vec3 wall = mix(vec3(0.94, 0.89, 0.77), vec3(0.83, 0.78, 0.70), v_rand);
	vec3 tiles = mix(vec3(0.80, 0.30, 0.17), vec3(0.58, 0.34, 0.22), v_rand);
	tiles = mix(tiles, vec3(0.95, 0.97, 1.0), (1.0 - smoothstep(-4.0, 0.0, v_tnow)) * 0.85);
	ALBEDO = haze(mix(wall, tiles, roof), VERTEX);
	ROUGHNESS = 0.9;
	SPECULAR = 0.1;
	EMISSION = vec3(1.0, 0.70, 0.32) * (1.0 - roof) * v_night * 0.9;
	NORMAL = facet_normal(dFdx(VERTEX), dFdy(VERTEX), VIEW);
}
