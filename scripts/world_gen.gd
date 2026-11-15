extends RefCounted
## Procedural Voronoi planet.
##
## Pure data, no nodes: spherical Voronoi cells, plate tectonics, elevation (m),
## climate (deg C, mm/yr), rivers (m3/s), geology and biomes. Everything is derived
## from one seed. `sample()` evaluates the continuous surface anywhere on the sphere
## and is what both the baked 2D map and the 3D cell meshes are built from.

const PLANET_R := 100.0
const TEX_W := 1024
const TEX_H := 512
const NOISE_FREQ := 38.0
const RIVER_MIN_FLOW := 2000.0 # m3/s
const LEVEL_STEP := 300.0  # metres between terrace levels
const LEVEL_RAMP := 0.16   # half-width of the cliff between two levels, as a fraction of a step
const STEP_NAMES := ["Voronoi cells", "Tectonic plates and elevation", "Climate", "Rivers", "Biomes and geology"]

enum Rock { BASALT, GRANITE, SANDSTONE, LIMESTONE, METAMORPHIC, ANDESITE, VOLCANIC }
const ROCK_NAMES := [
	"Basalt (oceanic crust)", "Granite (continental shield)", "Sandstone (sedimentary basin)",
	"Limestone (carbonate platform)", "Gneiss and schist (orogenic belt)",
	"Andesite (volcanic arc)", "Basalt shield volcano (hotspot)",
]
const ROCK_COLORS := [
	Color(0.27, 0.27, 0.31), Color(0.56, 0.47, 0.44), Color(0.62, 0.50, 0.36),
	Color(0.68, 0.66, 0.58), Color(0.40, 0.41, 0.45), Color(0.44, 0.40, 0.38),
	Color(0.24, 0.21, 0.22),
]

enum Biome {
	OCEAN, ICE, TUNDRA, TAIGA, COLD_DESERT, STEPPE, MEDITERRANEAN, TEMPERATE_FOREST,
	TEMPERATE_RAINFOREST, DESERT, SAVANNA, TROPICAL_SEASONAL, TROPICAL_RAINFOREST, ALPINE,
}
const BIOME_NAMES := [
	"Ocean", "Ice cap", "Tundra", "Taiga (boreal forest)", "Cold desert", "Steppe / grassland",
	"Mediterranean shrubland", "Temperate forest", "Temperate rainforest", "Hot desert",
	"Savanna", "Tropical seasonal forest", "Tropical rainforest", "Alpine",
]

# Planet parameters, set by the caller (normally from the solar system) before generating.
var seed_value := 1
var n_cells := 3000
var radius_km := 6371.0
var axial_tilt_deg := 23.4
var mean_temp_c := 14.5

var rng := RandomNumberGenerator.new()
var noise := FastNoiseLite.new()
var detail_noise := FastNoiseLite.new()

# Cells
var sites := PackedVector3Array()
var cell_nb: Array = []      # PackedInt32Array per cell; nb[i] is across edge corner[i] -> corner[i+1]
var cell_corner: Array = []  # PackedInt32Array per cell, counter-clockwise seen from outside
var cell_wn: Array = []      # PackedVector3Array: site x corner[i]
var cell_en: Array = []      # PackedVector3Array: corner[i] x corner[i+1]
var elev := PackedFloat32Array()
var rug := PackedFloat32Array()
var temp_mean := PackedFloat32Array()
var temp_amp := PackedFloat32Array()
var precip := PackedFloat32Array()
var flux := PackedFloat32Array()
var pop := PackedFloat32Array()
var plate := PackedInt32Array()
var rock := PackedInt32Array()
var biome := PackedInt32Array()
var downhill := PackedInt32Array()
var has_river := PackedByteArray()
var river_up: Array = []     # Array[int] per cell: upstream river cells
var plate_color: Array = []
var uplift := PackedFloat32Array()

# Corners (Voronoi vertices), each shared by three cells
var corner_pos := PackedVector3Array()
var corner_tri: Array = []
var corner_h := PackedFloat32Array()
var corner_t := PackedFloat32Array()
var corner_a := PackedFloat32Array()
var corner_p := PackedFloat32Array()
var corner_rug := PackedFloat32Array()

# Stats
var land_fraction := 0.0
var max_elev := 0.0
var min_elev := 0.0
var river_cells := 0
var cell_area_km2 := 0.0

# Result of the last sample() call
var s_h := 0.0
var s_t := 0.0
var s_a := 0.0
var s_p := 0.0
var s_wc := 1.0

# Baked 2D map
var data_tex: ImageTexture
var mask_tex: ImageTexture
var _bake_y := 0
var _bake_cell := 0
var _data := PackedFloat32Array()
var _mask := PackedByteArray()
var _cos_lon := PackedFloat32Array()
var _sin_lon := PackedFloat32Array()


func gen_step(i: int) -> void:
	match i:
		0:
			_init_noise()
			_make_sites()
			_make_voronoi()
		1:
			_make_elevation()
		2:
			_make_climate()
		3:
			_make_rivers()
		4:
			_make_biomes()
			_make_corners()


func generate_all() -> void:
	for i in STEP_NAMES.size():
		gen_step(i)


func _init_noise() -> void:
	rng.seed = seed_value
	noise.seed = seed_value
	noise.noise_type = FastNoiseLite.TYPE_SIMPLEX
	noise.fractal_type = FastNoiseLite.FRACTAL_FBM
	noise.fractal_octaves = 5
	noise.frequency = 1.0
	detail_noise.seed = seed_value + 77
	detail_noise.noise_type = FastNoiseLite.TYPE_SIMPLEX
	detail_noise.fractal_type = FastNoiseLite.FRACTAL_FBM
	detail_noise.fractal_octaves = 3
	detail_noise.frequency = 1.0
	cell_area_km2 = 4.0 * PI * radius_km * radius_km / n_cells


# ---------------------------------------------------------------- Voronoi

func _make_sites() -> void:
	var n := n_cells
	sites.resize(n)
	var golden := PI * (3.0 - sqrt(5.0))
	var spacing := sqrt(4.0 * PI / n)
	for i in n:
		var y := 1.0 - 2.0 * (i + 0.5) / n
		var r := sqrt(maxf(0.0, 1.0 - y * y))
		var th := golden * i
		var p := Vector3(cos(th) * r, y, sin(th) * r)
		p += Vector3(rng.randf_range(-1.0, 1.0), rng.randf_range(-1.0, 1.0), rng.randf_range(-1.0, 1.0)) * spacing * 0.32
		sites[i] = p.normalized()


func _grid_coord(v: float, g: int) -> int:
	return clampi(int((v + 1.0) * 0.5 * g), 0, g - 1)


func _tri_key(a: int, b: int, c: int) -> int:
	var lo := mini(a, mini(b, c))
	var hi := maxi(a, maxi(b, c))
	var mid := a + b + c - lo - hi
	return (lo * n_cells + mid) * n_cells + hi


## Each cell is the tangent-plane (gnomonic) polygon left after clipping by the
## bisector of every nearby site. Edges remember which neighbour made them, so
## corners can be identified exactly by their three generating sites.
func _make_voronoi() -> void:
	var n := n_cells
	var spacing := sqrt(4.0 * PI / n)
	var g := maxi(2, int(floor(2.0 / (spacing * 2.6))))
	var grid := {}
	for i in n:
		var p0 := sites[i]
		var k := _grid_coord(p0.x, g) + g * (_grid_coord(p0.y, g) + g * _grid_coord(p0.z, g))
		if not grid.has(k):
			grid[k] = []
		var bucket: Array = grid[k]
		bucket.append(i)

	cell_nb.clear()
	cell_corner.clear()
	corner_pos = PackedVector3Array()
	corner_tri.clear()
	var corner_index := {}
	var big := 1.0
	for s in n:
		var p := sites[s]
		var e1 := p.cross(Vector3.UP if absf(p.y) < 0.9 else Vector3.RIGHT).normalized()
		var e2 := p.cross(e1)
		var pts := PackedVector2Array([Vector2(-big, -big), Vector2(big, -big), Vector2(big, big), Vector2(-big, big)])
		var lab := PackedInt32Array([-1, -2, -3, -4])
		var gx := _grid_coord(p.x, g)
		var gy := _grid_coord(p.y, g)
		var gz := _grid_coord(p.z, g)
		for dz in range(-1, 2):
			for dy in range(-1, 2):
				for dx in range(-1, 2):
					var cx := gx + dx
					var cy := gy + dy
					var cz := gz + dz
					if cx < 0 or cy < 0 or cz < 0 or cx >= g or cy >= g or cz >= g:
						continue
					var key := cx + g * (cy + g * cz)
					if not grid.has(key):
						continue
					var cand: Array = grid[key]
					for jv in cand:
						var j: int = jv
						if j == s:
							continue
						var q := sites[j]
						var qp := q.dot(p)
						if qp < 0.2:
							continue
						var ka := q.dot(e1)
						var kb := q.dot(e2)
						var kc := 1.0 - qp
						var m := pts.size()
						var outside := false
						for i in m:
							if ka * pts[i].x + kb * pts[i].y > kc:
								outside = true
								break
						if not outside:
							continue
						var np := PackedVector2Array()
						var nl := PackedInt32Array()
						for i in m:
							var a := pts[i]
							var b := pts[(i + 1) % m]
							var fa := ka * a.x + kb * a.y - kc
							var fb := ka * b.x + kb * b.y - kc
							if fa <= 0.0:
								np.append(a)
								nl.append(lab[i])
								if fb > 0.0:
									np.append(a.lerp(b, fa / (fa - fb)))
									nl.append(j)
							elif fb <= 0.0:
								np.append(a.lerp(b, fa / (fa - fb)))
								nl.append(lab[i])
						pts = np
						lab = nl
		var m2 := pts.size()
		var cc := PackedInt32Array()
		var nb := PackedInt32Array()
		for i in m2:
			var la := lab[(i + m2 - 1) % m2]
			var lb := lab[i]
			var key2 := _tri_key(s, la, lb)
			var ci := 0
			if corner_index.has(key2):
				ci = corner_index[key2]
			else:
				ci = corner_pos.size()
				corner_index[key2] = ci
				corner_pos.append((p + e1 * pts[i].x + e2 * pts[i].y).normalized())
				corner_tri.append(Vector3i(s, la, lb))
			cc.append(ci)
			nb.append(lb if lb >= 0 else s)
		cell_corner.append(cc)
		cell_nb.append(nb)

	cell_wn.clear()
	cell_en.clear()
	for s in n:
		var p := sites[s]
		var cc: PackedInt32Array = cell_corner[s]
		var m := cc.size()
		var wn := PackedVector3Array()
		var en := PackedVector3Array()
		for i in m:
			var a := corner_pos[cc[i]]
			var b := corner_pos[cc[(i + 1) % m]]
			wn.append(p.cross(a))
			en.append(a.cross(b))
		cell_wn.append(wn)
		cell_en.append(en)


# ---------------------------------------------------------------- Tectonics and elevation

func _make_elevation() -> void:
	var n := n_cells
	# Plates: random flood fill from seed cells.
	var n_plates := 14 + rng.randi() % 6
	plate.resize(n)
	plate.fill(-1)
	var poles: Array = []
	var omega: Array = []
	var bias: Array = []
	plate_color.clear()
	var frontier: Array = []
	for k in n_plates:
		var c0 := rng.randi() % n
		while plate[c0] != -1:
			c0 = rng.randi() % n
		plate[c0] = k
		frontier.append(c0)
		poles.append(Vector3(rng.randf_range(-1.0, 1.0), rng.randf_range(-1.0, 1.0), rng.randf_range(-1.0, 1.0)).normalized())
		omega.append(rng.randf_range(0.3, 1.0) * (1.0 if rng.randf() < 0.5 else -1.0))
		bias.append(rng.randf_range(-0.22, 0.22))
		plate_color.append(Color.from_hsv(fmod(0.11 + k * 0.381966, 1.0), 0.55, 1.0))
	while not frontier.is_empty():
		var fi := rng.randi() % frontier.size()
		var c: int = frontier[fi]
		var nb: PackedInt32Array = cell_nb[c]
		var start := rng.randi() % nb.size()
		var grew := false
		for t in nb.size():
			var j := nb[(start + t) % nb.size()]
			if plate[j] == -1:
				plate[j] = plate[c]
				frontier.append(j)
				grew = true
				break
		if not grew:
			frontier[fi] = frontier[frontier.size() - 1]
			frontier.pop_back()
	for c in n:
		if plate[c] < 0:
			plate[c] = 0

	# Continents: low-frequency noise plus a per-plate bias, sea level set by quantile.
	var cont := PackedFloat32Array()
	cont.resize(n)
	for c in n:
		var p := sites[c]
		var pb: float = bias[plate[c]]
		cont[c] = noise.get_noise_3dv(p * 1.1) + 0.45 * noise.get_noise_3dv(p * 2.7 + Vector3(11.3, 4.1, 7.7)) + pb
	var sorted := cont.duplicate()
	sorted.sort()
	var thr := sorted[int(n * 0.71)]
	var base := PackedFloat32Array()
	base.resize(n)
	for c in n:
		var x := cont[c] - thr
		if x > 0.0:
			base[c] = 30.0 + 1500.0 * pow(x, 1.3)
		else:
			base[c] = -120.0 - 4300.0 * smoothstep(0.02, 0.30, -x) - 600.0 * clampf(-x, 0.0, 1.0)

	# Plate boundaries: relative plate velocity across each shared edge.
	uplift.resize(n)
	uplift.fill(0.0)
	var trench := PackedFloat32Array()
	trench.resize(n)
	trench.fill(0.0)
	rock.resize(n)
	for c in n:
		rock[c] = Rock.BASALT if base[c] < -200.0 else Rock.GRANITE
	for c in n:
		var pc := plate[c]
		var nb: PackedInt32Array = cell_nb[c]
		for j in nb:
			var pj := plate[j]
			if pj == pc:
				continue
			var mid := (sites[c] + sites[j]).normalized()
			var pole_c: Vector3 = poles[pc]
			var pole_j: Vector3 = poles[pj]
			var om_c: float = omega[pc]
			var om_j: float = omega[pj]
			var rel := pole_c.cross(mid) * om_c - pole_j.cross(mid) * om_j
			var conv := rel.dot((sites[j] - sites[c]).normalized())
			var land_c := base[c] > -200.0
			var land_j := base[j] > -200.0
			if conv > 0.25:
				var s := clampf((conv - 0.25) / 1.0, 0.0, 1.0)
				if land_c and land_j:
					# Continental collision: fold mountains.
					if 1200.0 + 4800.0 * s > uplift[c]:
						uplift[c] = 1200.0 + 4800.0 * s
						rock[c] = Rock.METAMORPHIC
				elif land_c:
					# Ocean subducting under continent: volcanic cordillera.
					if 900.0 + 3600.0 * s > uplift[c]:
						uplift[c] = 900.0 + 3600.0 * s
						rock[c] = Rock.ANDESITE
				elif land_j or base[c] < base[j]:
					trench[c] = maxf(trench[c], 3000.0 * s)
				else:
					# Ocean-ocean: island arc on the overriding plate.
					if 2800.0 + 2600.0 * s > uplift[c]:
						uplift[c] = 2800.0 + 2600.0 * s
						rock[c] = Rock.ANDESITE
			elif conv < -0.15:
				var s2 := clampf(-conv / 1.2, 0.0, 1.0)
				if land_c:
					trench[c] = maxf(trench[c], 350.0 * s2) # continental rift
				else:
					uplift[c] = maxf(uplift[c], 1500.0 * s2) # mid-ocean ridge
	# Mountain ranges have foothills.
	for pass_i in 1:
		var spread := uplift.duplicate()
		for c in n:
			var nb: PackedInt32Array = cell_nb[c]
			var best := 0.0
			for j in nb:
				best = maxf(best, uplift[j])
			spread[c] = maxf(uplift[c], best * 0.35)
		uplift = spread

	elev.resize(n)
	rug.resize(n)
	for c in n:
		var p := sites[c]
		var n1 := noise.get_noise_3dv(p * 6.0 + Vector3(3.1, 8.2, 1.7))
		var n2 := noise.get_noise_3dv(p * 9.0 + Vector3(5.5, 2.4, 9.9))
		var h := base[c] + uplift[c] * (0.75 + 0.5 * n1) - trench[c]
		h += 220.0 * n2 * (1.0 if base[c] > 0.0 else 0.5)
		elev[c] = h
	# Hotspot shield volcanoes.
	for k in 6:
		var c := rng.randi() % n
		if base[c] < -1000.0:
			elev[c] = maxf(elev[c], rng.randf_range(200.0, 2800.0))
			rock[c] = Rock.VOLCANIC
			uplift[c] = maxf(uplift[c], 3000.0)
	max_elev = -1.0e9
	min_elev = 1.0e9
	var land := 0
	for c in n:
		var h := elev[c]
		if h > 6000.0:
			h = 6000.0 + (h - 6000.0) * 0.4
		if absf(h) < 8.0:
			h = 8.0 if h >= 0.0 else -8.0
		elev[c] = h
		max_elev = maxf(max_elev, h)
		min_elev = minf(min_elev, h)
		if h > 0.0:
			land += 1
			rug[c] = clampf(40.0 + 0.2 * uplift[c] + 0.08 * h, 30.0, 900.0)
		else:
			rug[c] = 70.0 + 0.05 * uplift[c]
	land_fraction = float(land) / n


# ---------------------------------------------------------------- Climate

func _wind_at(p: Vector3) -> Vector3:
	var east := Vector3.UP.cross(p)
	if east.length() < 0.0001:
		return Vector3.RIGHT
	east = east.normalized()
	var north := p.cross(east)
	var hemi := 1.0 if p.y >= 0.0 else -1.0
	var alat := rad_to_deg(asin(clampf(absf(p.y), 0.0, 1.0)))
	if alat < 30.0:
		return (-east * 0.9 - north * hemi * 0.4).normalized() # trade winds
	if alat < 60.0:
		return (east * 0.9 + north * hemi * 0.3).normalized()  # westerlies
	return (-east * 0.8 - north * hemi * 0.4).normalized()      # polar easterlies


func _make_climate() -> void:
	var n := n_cells
	# Continentality: graph distance to the nearest ocean cell.
	var dist := PackedInt32Array()
	dist.resize(n)
	dist.fill(-1)
	var queue: Array = []
	for c in n:
		if elev[c] <= 0.0:
			dist[c] = 0
			queue.append(c)
	var qi := 0
	while qi < queue.size():
		var c: int = queue[qi]
		qi += 1
		var nb: PackedInt32Array = cell_nb[c]
		for j in nb:
			if dist[j] < 0:
				dist[j] = dist[c] + 1
				queue.append(j)

	temp_mean.resize(n)
	temp_amp.resize(n)
	var tilt_k := axial_tilt_deg / 23.44
	for c in n:
		var p := sites[c]
		var sl := absf(p.y)
		# Oceans carry heat poleward, so the sea cools less with latitude than land.
		var gradient := 40.0 if elev[c] > 0.0 else 34.0
		var t := mean_temp_c + 11.5 - gradient * sl * sl - 6.5 * maxf(elev[c], 0.0) / 1000.0
		t += 1.5 * noise.get_noise_3dv(p * 4.0 + Vector3(9.0, 1.0, 4.0))
		temp_mean[c] = t
		if elev[c] > 0.0:
			var contl := clampf((maxi(dist[c], 1) - 1) / 3.0, 0.0, 1.0)
			temp_amp[c] = tilt_k * pow(sl, 0.8) * (7.0 + 24.0 * contl)
		else:
			temp_amp[c] = tilt_k * sl * 5.0

	# Moisture is carried downwind from the ocean and wrung out by rising terrain.
	var upwind := PackedInt32Array()
	upwind.resize(n)
	for c in n:
		var p := sites[c]
		var w := _wind_at(p)
		var nb: PackedInt32Array = cell_nb[c]
		var best := -2.0
		var bj := c
		for j in nb:
			var d := (sites[j] - p).normalized().dot(-w)
			if d > best:
				best = d
				bj = j
		upwind[c] = bj
	var moist := PackedFloat32Array()
	moist.resize(n)
	moist.fill(1.0)
	for it in 30:
		for c in n:
			if elev[c] <= 0.0:
				moist[c] = 1.0
				continue
			var u := upwind[c]
			var rise := maxf(0.0, elev[c] - maxf(elev[u], 0.0))
			var m := maxf(0.06, moist[u] * 0.9 * exp(-rise / 1800.0))
			if dist[c] == 1:
				m = maxf(m, 0.55) # sea breeze
			moist[c] = m

	precip.resize(n)
	for c in n:
		var p := sites[c]
		var lat := rad_to_deg(asin(clampf(p.y, -1.0, 1.0)))
		var al := absf(lat)
		# Zonal bands: ITCZ, subtropical highs, mid-latitude storm tracks, polar deserts.
		var band := 380.0 + 2000.0 * exp(-pow(lat / 14.0, 2.0)) + 950.0 * exp(-pow((al - 48.0) / 14.0, 2.0)) - 220.0 * exp(-pow((al - 27.0) / 7.0, 2.0))
		band = maxf(band, 80.0)
		var u := upwind[c]
		var rise := maxf(0.0, elev[c] - maxf(elev[u], 0.0)) if elev[c] > 0.0 else 0.0
		var oro := 1.0 + clampf(rise / 900.0, 0.0, 1.2)
		var tf := clampf(0.55 + temp_mean[c] / 45.0, 0.3, 1.15)
		var v := band * (0.3 + 0.7 * moist[c]) * oro * tf
		v *= 1.0 + 0.2 * noise.get_noise_3dv(p * 5.0 + Vector3(1.0, 7.0, 3.0))
		precip[c] = clampf(v, 20.0, 3900.0)


# ---------------------------------------------------------------- Rivers

static func river_width(q: float) -> float:
	return clampf(0.05 * pow(maxf(q, 1.0) / 1000.0, 0.4), 0.08, 0.6)


func _make_rivers() -> void:
	var n := n_cells
	# Depression filling (Planchon-Darboux) so every land cell drains to the sea.
	var wl := PackedFloat32Array()
	wl.resize(n)
	for c in n:
		wl[c] = elev[c] if elev[c] <= 0.0 else 1.0e9
	var changed := true
	var guard := 0
	while changed and guard < 500:
		changed = false
		guard += 1
		for c in n:
			if wl[c] <= elev[c]:
				continue
			var nb: PackedInt32Array = cell_nb[c]
			for j in nb:
				var wj := wl[j] + 0.5
				if elev[c] >= wj:
					wl[c] = elev[c]
					changed = true
					break
				if wl[c] > wj:
					wl[c] = wj
					changed = true

	downhill.resize(n)
	var order: Array = []
	for c in n:
		downhill[c] = -1
		if elev[c] <= 0.0:
			continue
		order.append(c)
		var nb: PackedInt32Array = cell_nb[c]
		var best := wl[c]
		for j in nb:
			if wl[j] < best:
				best = wl[j]
				downhill[c] = j
	order.sort_custom(func(a: int, b: int) -> bool: return wl[a] > wl[b])

	# Discharge: precipitation x area x runoff coefficient, accumulated downstream.
	flux.resize(n)
	var area_m2 := cell_area_km2 * 1.0e6
	for c in n:
		var runoff := 0.15 + 0.35 * smoothstep(200.0, 1500.0, precip[c])
		flux[c] = precip[c] * 0.001 * area_m2 * runoff / 31557600.0
	for cv in order:
		var c: int = cv
		var d := downhill[c]
		if d >= 0 and elev[d] > 0.0:
			flux[d] += flux[c]

	has_river.resize(n)
	has_river.fill(0)
	river_up.clear()
	river_cells = 0
	for c in n:
		river_up.append([])
		if elev[c] > 0.0 and downhill[c] >= 0 and flux[c] > RIVER_MIN_FLOW:
			has_river[c] = 1
			river_cells += 1
			rug[c] *= 0.55 # valleys are smoother
	for c in n:
		if has_river[c] == 1:
			var d := downhill[c]
			if has_river[d] == 1:
				var ups: Array = river_up[d]
				ups.append(c)


func _bezier(a: Vector3, b: Vector3, c: Vector3, steps: int) -> PackedVector3Array:
	var out := PackedVector3Array()
	for k in steps + 1:
		var t := float(k) / steps
		out.append(a.lerp(b, t).lerp(b.lerp(c, t), t).normalized())
	return out


## River polylines inside cell `c`: Array of [points (unit vectors), start width, end width].
## Curves cross cell borders on the line joining the two sites, so they stay smooth.
func river_paths(c: int) -> Array:
	var out: Array = []
	if has_river[c] == 0:
		return out
	var pc := sites[c]
	var m_out := (pc + sites[downhill[c]]).normalized()
	var w1 := river_width(flux[c])
	var ups: Array = river_up[c]
	if ups.is_empty():
		var a := pc.lerp(m_out, 0.25).normalized()
		out.append([_bezier(a, a.lerp(m_out, 0.5).normalized(), m_out, 6), w1 * 0.6, w1])
	else:
		for jv in ups:
			var j: int = jv
			var m_in := (sites[j] + pc).normalized()
			out.append([_bezier(m_in, pc, m_out, 10), river_width(flux[j]), w1])
	return out


# ---------------------------------------------------------------- Biomes, geology, corners

func _make_biomes() -> void:
	var n := n_cells
	biome.resize(n)
	pop.resize(n)
	for c in n:
		var h := elev[c]
		var t := temp_mean[c]
		var p := precip[c]
		pop[c] = 0.0
		if h <= 0.0:
			biome[c] = Biome.OCEAN
			continue
		var b := Biome.OCEAN
		if t < -10.0:
			b = Biome.ICE
		elif h > 3200.0 and t < 4.0:
			b = Biome.ALPINE
		elif t < 0.0:
			b = Biome.TUNDRA
		elif t < 6.0:
			b = Biome.TAIGA if p > 300.0 else Biome.COLD_DESERT
		elif t < 20.0:
			if p < 250.0:
				b = Biome.COLD_DESERT if t < 12.0 else Biome.DESERT
			elif p < 550.0:
				b = Biome.STEPPE
			elif p < 900.0:
				b = Biome.MEDITERRANEAN if t > 13.0 else Biome.TEMPERATE_FOREST
			elif p < 1800.0:
				b = Biome.TEMPERATE_FOREST
			else:
				b = Biome.TEMPERATE_RAINFOREST
		else:
			if p < 300.0:
				b = Biome.DESERT
			elif p < 1000.0:
				b = Biome.SAVANNA
			elif p < 1800.0:
				b = Biome.TROPICAL_SEASONAL
			else:
				b = Biome.TROPICAL_RAINFOREST
		biome[c] = b
		# Sedimentary cover on quiet continental crust.
		if rock[c] == Rock.GRANITE and h < 600.0:
			var g := noise.get_noise_3dv(sites[c] * 3.3 + Vector3(2.0, 6.0, 8.0))
			if g > 0.12:
				rock[c] = Rock.LIMESTONE if t > 12.0 else Rock.SANDSTONE
			elif g < -0.15:
				rock[c] = Rock.SANDSTONE
		# Habitability, used for night-side settlement lights.
		var fit := smoothstep(-2.0, 10.0, t) * (1.0 - smoothstep(26.0, 32.0, t))
		fit *= smoothstep(200.0, 700.0, p) * (1.0 - smoothstep(2000.0, 3200.0, p) * 0.6)
		fit *= 1.0 - smoothstep(800.0, 2500.0, h)
		if has_river[c] == 1:
			fit *= 1.6
		pop[c] = clampf(fit, 0.0, 1.0)


func _make_corners() -> void:
	var nc := corner_pos.size()
	corner_h.resize(nc)
	corner_t.resize(nc)
	corner_a.resize(nc)
	corner_p.resize(nc)
	corner_rug.resize(nc)
	for k in nc:
		var tri: Vector3i = corner_tri[k]
		var ids := [tri.x, tri.y, tri.z]
		var cnt := 0.0
		var sh := 0.0
		var st := 0.0
		var sa := 0.0
		var sp := 0.0
		var sr := 0.0
		for iv in ids:
			var id: int = iv
			if id < 0:
				continue
			cnt += 1.0
			sh += elev[id]
			st += temp_mean[id]
			sa += temp_amp[id]
			sp += precip[id]
			sr += rug[id]
		corner_h[k] = sh / cnt
		corner_t[k] = st / cnt
		corner_a[k] = sa / cnt
		corner_p[k] = sp / cnt
		corner_rug[k] = sr / cnt


# ---------------------------------------------------------------- Queries

## Snaps a raw height to flat terrace levels (plateaus at 150 m, 450 m, 750 m ... and
## -150 m, -450 m ... under water) joined by short cliffs. The coastline (0 m) sits in
## the middle of a cliff, and high mountains keep their natural shape.
static func level_height(h: float) -> float:
	var y := h / LEVEL_STEP + 0.5
	var b := floorf(y)
	var t := (b - 0.5 + smoothstep(0.5 - LEVEL_RAMP, 0.5 + LEVEL_RAMP, y - b)) * LEVEL_STEP
	return lerpf(t, h, smoothstep(2000.0, 3200.0, h))


## Nearest site to unit vector `d`, by walking the neighbour graph from `start`.
func locate(d: Vector3, start: int) -> int:
	var cur := clampi(start, 0, n_cells - 1)
	var best := sites[cur].dot(d)
	while true:
		var nb: PackedInt32Array = cell_nb[cur]
		var nxt := cur
		for j in nb:
			var dd := sites[j].dot(d)
			if dd > best:
				best = dd
				nxt = j
		if nxt == cur:
			break
		cur = nxt
	return cur


## Continuous surface at unit vector `d`: fills s_h (m), s_t (deg C), s_a (deg C),
## s_p (mm/yr), s_wc (0 at the cell edge, 1 at the site). Returns the cell index.
func sample(d: Vector3, start: int) -> int:
	var c := locate(d, start)
	var wn: PackedVector3Array = cell_wn[c]
	var en: PackedVector3Array = cell_en[c]
	var cc: PackedInt32Array = cell_corner[c]
	var m := wn.size()
	var idx := -1
	var sa := 0.0
	var sb := 0.0
	var prev := wn[0].dot(d)
	for i in m:
		var nxt := wn[(i + 1) % m].dot(d)
		if prev >= 0.0 and nxt < 0.0:
			idx = i
			sb = prev
			sa = -nxt
			break
		prev = nxt
	var h := elev[c]
	var t := temp_mean[c]
	var a := temp_amp[c]
	var p := precip[c]
	var r := rug[c]
	s_wc = 1.0
	if idx >= 0:
		var cw := maxf(0.0, en[idx].dot(d))
		var tot := sa + sb + cw
		if tot > 0.0:
			var ia := cc[idx]
			var ib := cc[(idx + 1) % m]
			sa /= tot
			sb /= tot
			cw /= tot
			h = h * cw + corner_h[ia] * sa + corner_h[ib] * sb
			t = t * cw + corner_t[ia] * sa + corner_t[ib] * sb
			a = a * cw + corner_a[ia] * sa + corner_a[ib] * sb
			p = p * cw + corner_p[ia] * sa + corner_p[ib] * sb
			r = r * cw + corner_rug[ia] * sa + corner_rug[ib] * sb
			s_wc = cw
	var dz := detail_noise.get_noise_3dv(d * NOISE_FREQ) * r
	s_h = level_height(h + dz)
	s_t = t - 0.0065 * (s_h - h)
	s_a = a
	s_p = p
	return c


func cell_info(c: int) -> String:
	var p := sites[c]
	var lat := rad_to_deg(asin(clampf(p.y, -1.0, 1.0)))
	var bname: String = BIOME_NAMES[biome[c]]
	var rname: String = ROCK_NAMES[rock[c]]
	var txt := "Cell #%d  -  %s\n" % [c, bname]
	txt += "Latitude %.1f deg   Plate %d\n" % [lat, plate[c]]
	txt += "Elevation %.0f m\n" % elev[c]
	txt += "Mean temp %.1f C  (seasonal +/- %.1f)\n" % [temp_mean[c], temp_amp[c]]
	txt += "Precipitation %.0f mm/yr\n" % precip[c]
	txt += "Bedrock: %s\n" % rname
	if has_river[c] == 1:
		txt += "River discharge %.0f m3/s\n" % flux[c]
	return txt


# ---------------------------------------------------------------- Baked 2D map

func bake_begin() -> void:
	_data.resize(TEX_W * TEX_H * 4)
	_mask.resize(TEX_W * TEX_H * 4)
	_cos_lon.resize(TEX_W)
	_sin_lon.resize(TEX_W)
	for x in TEX_W:
		var lon := (x + 0.5) / TEX_W * TAU - PI
		_cos_lon[x] = cos(lon)
		_sin_lon[x] = sin(lon)
	_bake_y = 0
	_bake_cell = 0


## Bakes rows of the equirectangular map until `budget_ms` is used. Returns progress 0..1.
func bake_step(budget_ms: int) -> float:
	var t0 := Time.get_ticks_msec()
	while _bake_y < TEX_H:
		var lat := PI * 0.5 - (_bake_y + 0.5) / TEX_H * PI
		var cl := cos(lat)
		var sl := sin(lat)
		var c := _bake_cell
		var o := _bake_y * TEX_W * 4
		for x in TEX_W:
			c = sample(Vector3(cl * _cos_lon[x], sl, cl * _sin_lon[x]), c)
			if x == 0:
				_bake_cell = c
			_data[o] = s_h / 10000.0
			_data[o + 1] = s_t / 50.0
			_data[o + 2] = s_a / 50.0
			_data[o + 3] = s_p / 4000.0
			_mask[o] = int(clampf(1.0 - s_wc / 0.14, 0.0, 1.0) * 255.0)
			_mask[o + 1] = 0
			_mask[o + 2] = int(pop[c] * 255.0)
			_mask[o + 3] = 255
			o += 4
		_bake_y += 1
		if Time.get_ticks_msec() - t0 > budget_ms:
			break
	return float(_bake_y) / TEX_H


func bake_finish() -> void:
	# Rivers into the mask's green channel.
	for c in n_cells:
		if has_river[c] == 0:
			continue
		for path_v in river_paths(c):
			var path: Array = path_v
			var pts: PackedVector3Array = path[0]
			for k in pts.size() - 1:
				for sub in 4:
					var d := pts[k].lerp(pts[k + 1], sub / 4.0).normalized()
					var u := atan2(d.z, d.x) / TAU + 0.5
					var v := 0.5 - asin(clampf(d.y, -1.0, 1.0)) / PI
					var px := clampi(int(u * TEX_W), 0, TEX_W - 1)
					var py := clampi(int(v * TEX_H), 0, TEX_H - 1)
					_mask[(py * TEX_W + px) * 4 + 1] = 255
	var img := Image.create_from_data(TEX_W, TEX_H, false, Image.FORMAT_RGBAF, _data.to_byte_array())
	img.convert(Image.FORMAT_RGBAH)
	data_tex = ImageTexture.create_from_image(img)
	var img2 := Image.create_from_data(TEX_W, TEX_H, false, Image.FORMAT_RGBA8, _mask)
	mask_tex = ImageTexture.create_from_image(img2)
	_data = PackedFloat32Array()
	_mask = PackedByteArray()
