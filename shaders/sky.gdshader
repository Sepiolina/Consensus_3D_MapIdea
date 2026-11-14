// Procedural star field.
shader_type sky;

float h13(vec3 p) {
	p = fract(p * 0.1031);
	p += dot(p, p.zyx + 31.32);
	return fract((p.x + p.y) * p.z);
}

void sky() {
	vec3 d = normalize(EYEDIR);
	vec3 g = d * 110.0;
	vec3 id = floor(g);
	vec3 f = fract(g) - 0.5;
	float rnd = h13(id);
	vec3 jitter = (vec3(h13(id + 1.3), h13(id + 2.7), h13(id + 4.1)) - 0.5) * 0.5;
	float star = step(0.986, rnd) * (1.0 - smoothstep(0.0, 0.22, length(f + jitter)));
	vec3 tint = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), h13(id + 9.0));
	float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.8, 0.5))) * 4.0, 2.0));
	vec3 col = vec3(0.004, 0.005, 0.012) + vec3(0.02, 0.018, 0.03) * band;
	COLOR = col + tint * star * (0.6 + 2.0 * h13(id + 5.5));
}
