// MultiMesh trees. INSTANCE_CUSTOM = (height/10000, mean temp/50, signed seasonal amp/50, random).
shader_type spatial;

#include "res://shaders/common.gdshaderinc"

varying float v_tnow;
varying float v_tmean;
varying float v_rand;

void vertex() {
	float h = INSTANCE_CUSTOM.r * 10000.0;
	v_tmean = INSTANCE_CUSTOM.g * 50.0;
	v_tnow = v_tmean + INSTANCE_CUSTOM.b * 50.0 * season;
	v_rand = INSTANCE_CUSTOM.a;
	float grow = (0.7 + 0.6 * v_rand) * smoothstep(0.5, 0.95, detail);
	if (h < sea_level + 3.0) {
		grow = 0.0; // drowned
	}
	float broad = smoothstep(8.0, 16.0, v_tmean);
	vec3 p = VERTEX;
	p.y += 0.17;
	p.xz *= mix(1.0, 1.45, broad);
	p.y *= mix(1.0, 0.78, broad);
	p *= grow;
	p.y += disp(h) * detail; // local +Y is the planet's radial direction
	VERTEX = p;
}

void fragment() {
	vec3 conifer = vec3(0.09, 0.29, 0.16);
	vec3 broadleaf = vec3(0.17, 0.46, 0.13);
	vec3 jungle = vec3(0.06, 0.37, 0.11);
	vec3 col = mix(conifer, mix(broadleaf, jungle, smoothstep(18.0, 24.0, v_tmean)), smoothstep(8.0, 16.0, v_tmean));
	float temperate = smoothstep(6.0, 10.0, v_tmean) * (1.0 - smoothstep(16.0, 22.0, v_tmean));
	float dormant = (1.0 - smoothstep(1.0, 9.0, v_tnow)) * temperate;
	col = mix(col, vec3(0.66, 0.36, 0.10), dormant * 0.8);
	col = mix(col, vec3(0.93, 0.96, 1.0), (1.0 - smoothstep(-4.0, 0.0, v_tnow)) * 0.75);
	ALBEDO = col * (0.85 + 0.3 * v_rand);
	ROUGHNESS = 0.9;
	SPECULAR = 0.1;
}
