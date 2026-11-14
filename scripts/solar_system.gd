extends RefCounted
## Procedural star system with one guaranteed Earth-like "home" planet.
## Distances in AU, time in Earth days, masses/radii in solar or Earth units.

var star := {}
var planets: Array = []   # Array of Dictionary
var home_index := 0
var moon := {}

const SYL_A := ["Ae", "Bel", "Cor", "Dra", "El", "Fen", "Gal", "Hel", "Ith", "Kor", "Lum", "Mer", "Nor", "Or", "Pha", "Quel", "Rho", "Sol", "Tal", "Vel"]
const SYL_B := ["a", "an", "ar", "en", "ia", "is", "on", "or", "os", "ur", "yn", "eth"]


func _make_name(rng: RandomNumberGenerator) -> String:
	var a: String = SYL_A[rng.randi() % SYL_A.size()]
	var b: String = SYL_B[rng.randi() % SYL_B.size()]
	var out := a + b
	if rng.randf() < 0.4:
		var b2: String = SYL_B[rng.randi() % SYL_B.size()]
		out += b2
	return out


func generate(p_seed: int) -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = p_seed * 7919 + 13

	# Main-sequence star from its mass.
	var mass := rng.randf_range(0.78, 1.22)
	var lum := pow(mass, 3.8)
	var radius := pow(mass, 0.8)
	var temp := 5772.0 * pow(lum / (radius * radius), 0.25)
	var cls := "G"
	if temp >= 6000.0:
		cls = "F"
	elif temp < 5200.0:
		cls = "K"
	var warm := clampf((temp - 4600.0) / 2200.0, 0.0, 1.0)
	star = {
		"name": _make_name(rng), "mass": mass, "lum": lum, "radius": radius, "temp": temp, "class": cls,
		"color": Color(1.0, 0.72, 0.45).lerp(Color(0.95, 0.96, 1.0), warm),
	}

	# Orbits: geometric spacing anchored on a home planet inside the habitable zone.
	var hz := sqrt(lum) # distance receiving Earth's insolation
	var home_a := hz * rng.randf_range(0.97, 1.04)
	var ratio := rng.randf_range(1.55, 1.95)
	var inner := rng.randi_range(1, 3)
	var outer := rng.randi_range(2, 4)
	var frost := 2.7 * hz
	planets.clear()
	home_index = inner
	for i in inner + outer + 1:
		var a := home_a * pow(ratio, i - inner)
		var is_home := i == inner
		var p := {}
		p["name"] = _make_name(rng)
		p["a"] = a
		p["e"] = rng.randf_range(0.005, 0.03) if is_home else rng.randf_range(0.0, 0.09)
		p["incl"] = 0.0 if is_home else deg_to_rad(rng.randf_range(-3.0, 3.0))
		p["peri"] = rng.randf_range(0.0, TAU)
		p["node"] = rng.randf_range(0.0, TAU)
		p["phase"] = rng.randf_range(0.0, TAU)
		p["period"] = 365.25 * sqrt(a * a * a / mass)
		p["home"] = is_home
		var albedo := 0.3
		if is_home:
			var r := rng.randf_range(0.92, 1.08)
			p["type"] = "Terrestrial (habitable)"
			p["radius"] = r
			p["mass"] = pow(r, 3.7)
			p["day_h"] = rng.randf_range(19.0, 29.0)
			p["tilt"] = rng.randf_range(14.0, 30.0)
			p["moons"] = 1
			p["color_a"] = Color(0.2, 0.45, 0.8)
			p["color_b"] = Color(0.3, 0.6, 0.3)
			p["banded"] = 0.0
		elif a < frost:
			var r2 := rng.randf_range(0.35, 1.6)
			p["type"] = "Rocky"
			p["radius"] = r2
			p["mass"] = pow(r2, 3.7)
			p["day_h"] = rng.randf_range(10.0, 2000.0)
			p["tilt"] = rng.randf_range(0.0, 40.0)
			p["moons"] = rng.randi_range(0, 2)
			var hue := rng.randf_range(0.02, 0.12)
			p["color_a"] = Color.from_hsv(hue, 0.45, 0.75)
			p["color_b"] = Color.from_hsv(hue + 0.03, 0.5, 0.35)
			p["banded"] = 0.0
			albedo = 0.2
		elif a < frost * 4.5:
			var r3 := rng.randf_range(7.0, 12.0)
			p["type"] = "Gas giant"
			p["radius"] = r3
			p["mass"] = rng.randf_range(60.0, 400.0)
			p["day_h"] = rng.randf_range(9.0, 14.0)
			p["tilt"] = rng.randf_range(0.0, 30.0)
			p["moons"] = rng.randi_range(12, 90)
			var hue2 := rng.randf_range(0.05, 0.13)
			p["color_a"] = Color.from_hsv(hue2, 0.35, 0.9)
			p["color_b"] = Color.from_hsv(hue2 - 0.02, 0.55, 0.55)
			p["banded"] = 1.0
			albedo = 0.45
		else:
			var r4 := rng.randf_range(3.4, 4.6)
			p["type"] = "Ice giant"
			p["radius"] = r4
			p["mass"] = rng.randf_range(12.0, 20.0)
			p["day_h"] = rng.randf_range(15.0, 19.0)
			p["tilt"] = rng.randf_range(0.0, 98.0)
			p["moons"] = rng.randi_range(5, 30)
			var hue3 := rng.randf_range(0.5, 0.62)
			p["color_a"] = Color.from_hsv(hue3, 0.45, 0.85)
			p["color_b"] = Color.from_hsv(hue3 + 0.03, 0.6, 0.6)
			p["banded"] = 0.7
			albedo = 0.5
		var pr: float = p["radius"]
		var pm: float = p["mass"]
		p["gravity"] = 9.81 * pm / (pr * pr)
		p["teq"] = 278.5 * pow(lum, 0.25) / sqrt(a) * pow(1.0 - albedo, 0.25)
		if p["type"] == "Rocky" and float(p["teq"]) > 600.0:
			p["type"] = "Lava world"
		if is_home:
			# Greenhouse warming on top of the black-body equilibrium temperature.
			p["mean_c"] = clampf(float(p["teq"]) - 273.15 + rng.randf_range(31.0, 35.0), 9.0, 20.0)
		planets.append(p)

	moon = {"name": _make_name(rng), "dist": 900.0, "period": rng.randf_range(18.0, 36.0), "radius": rng.randf_range(0.2, 0.32)}


func home() -> Dictionary:
	return planets[home_index]


## Position on orbit `i` for eccentric anomaly `ecc_anom`, in AU. The ecliptic is the XZ plane.
func orbit_point(i: int, ecc_anom: float) -> Vector3:
	var p: Dictionary = planets[i]
	var a: float = p["a"]
	var e: float = p["e"]
	var peri: float = p["peri"]
	var incl: float = p["incl"]
	var node: float = p["node"]
	var v := Vector3(a * (cos(ecc_anom) - e), 0.0, a * sqrt(1.0 - e * e) * sin(ecc_anom))
	v = v.rotated(Vector3.UP, peri)
	v = v.rotated(Vector3.RIGHT, incl)
	return v.rotated(Vector3.UP, node)


## Kepler orbit position of planet `i` at time `t_days`, in AU.
func planet_pos(i: int, t_days: float) -> Vector3:
	var p: Dictionary = planets[i]
	var e: float = p["e"]
	var period: float = p["period"]
	var phase: float = p["phase"]
	var mean_anom := fposmod(TAU * t_days / period + phase, TAU)
	var ea := mean_anom
	for k in 6:
		ea = ea - (ea - e * sin(ea) - mean_anom) / (1.0 - e * cos(ea))
	return orbit_point(i, ea)


func describe() -> String:
	var h := home()
	var txt := "STAR  %s  (class %s)\n" % [star["name"], star["class"]]
	txt += "  %.2f Msun   %.2f Rsun   %.2f Lsun   %.0f K\n" % [star["mass"], star["radius"], star["lum"], star["temp"]]
	txt += "SYSTEM  %d planets\n" % planets.size()
	for i in planets.size():
		var p: Dictionary = planets[i]
		txt += "  %s %-9s %5.2f AU  %s\n" % [">" if i == home_index else " ", p["name"], p["a"], p["type"]]
	txt += "HOME  %s\n" % h["name"]
	txt += "  Radius %.0f km   Gravity %.2f m/s2\n" % [float(h["radius"]) * 6371.0, h["gravity"]]
	txt += "  Day %.1f h   Year %.1f d   Tilt %.1f deg\n" % [h["day_h"], h["period"], h["tilt"]]
	txt += "  Equilibrium %.0f K   Mean surface %.1f C\n" % [h["teq"], h["mean_c"]]
	return txt
