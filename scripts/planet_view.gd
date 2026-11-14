extends Node3D
## Renders a WorldGen planet at the origin of this node.
##
## Far away: one sphere textured with the baked 2D map (cheap).
## Close up: per-cell 3D meshes streamed in around the focus point, with relief,
## water, rivers, borders and trees. `detail` (0..1) blends between the two; the
## relief is applied in the vertex shader so the transition is continuous both ways.

const WorldGen = preload("res://scripts/world_gen.gd")

const R := 100.0
const HEIGHT_SCALE := 0.0004 # keep in sync with common.gdshaderinc
const SEA_FLOOR := 1.0
const SUB := 4               # subdivisions of each fan triangle
const BORDER_W := 0.035
const MAX_TREES := 70

var world: WorldGen
var detail := 0.0
var sea_level := 0.0

var mats: Array = []
var globe_mat: ShaderMaterial
var terrain_mat: ShaderMaterial
var water_mat: ShaderMaterial
var river_mat: ShaderMaterial
var border_mat: ShaderMaterial
var select_mat: ShaderMaterial
var tree_mat: ShaderMaterial
var cloud_mat: ShaderMaterial

var globe: MeshInstance3D
var clouds: MeshInstance3D
var cells_root: Node3D
var selection: MeshInstance3D
var tree_mesh: CylinderMesh

var loaded := {}       # cell index -> MeshInstance3D
var queue: Array = []  # cell indices waiting to be built, nearest first
var _focus_cell := 0
var _last_focus := -1
var _last_rad := -1.0


func _new_mat(path: String) -> ShaderMaterial:
	var m := ShaderMaterial.new()
	m.shader = load(path)
	mats.append(m)
	return m


func setup(p_world: WorldGen) -> void:
	world = p_world
	globe_mat = _new_mat("res://shaders/globe.gdshader")
	terrain_mat = _new_mat("res://shaders/terrain.gdshader")
	water_mat = _new_mat("res://shaders/water.gdshader")
	river_mat = _new_mat("res://shaders/river.gdshader")
	border_mat = _new_mat("res://shaders/border.gdshader")
	select_mat = _new_mat("res://shaders/border.gdshader")
	tree_mat = _new_mat("res://shaders/tree.gdshader")
	cloud_mat = _new_mat("res://shaders/clouds.gdshader")
	globe_mat.set_shader_parameter("data_tex", world.data_tex)
	globe_mat.set_shader_parameter("mask_tex", world.mask_tex)
	select_mat.set_shader_parameter("lift", 0.09)

	var sphere := SphereMesh.new()
	sphere.radius = R
	sphere.height = R * 2.0
	sphere.radial_segments = 192
	sphere.rings = 96
	globe = MeshInstance3D.new()
	globe.mesh = sphere
	globe.material_override = globe_mat
	globe.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(globe)

	var csphere := SphereMesh.new()
	csphere.radius = R * 1.014
	csphere.height = R * 2.028
	csphere.radial_segments = 96
	csphere.rings = 48
	clouds = MeshInstance3D.new()
	clouds.mesh = csphere
	clouds.material_override = cloud_mat
	clouds.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(clouds)

	cells_root = Node3D.new()
	add_child(cells_root)
	selection = MeshInstance3D.new()
	selection.extra_cull_margin = 8.0
	selection.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(selection)

	tree_mesh = CylinderMesh.new()
	tree_mesh.top_radius = 0.0
	tree_mesh.bottom_radius = 0.11
	tree_mesh.height = 0.34
	tree_mesh.radial_segments = 5
	tree_mesh.rings = 1
	tree_mesh.cap_top = false


## Sets a uniform on every planet material (those without it ignore the call).
func set_shared(param: String, value: Variant) -> void:
	for mv in mats:
		var m: ShaderMaterial = mv
		m.set_shader_parameter(param, value)


static func disp(h: float) -> float:
	var d := h * HEIGHT_SCALE
	if h >= 0.0:
		return d
	return -SEA_FLOOR * (1.0 - exp(d / SEA_FLOOR))


## Rendered surface radius (land or sea surface) under planet-space direction `dir`.
func ground_radius(dir: Vector3) -> float:
	_focus_cell = world.sample(dir, _focus_cell)
	return R + disp(maxf(world.s_h, sea_level)) * detail


## Call every frame. `focus` is the planet-space unit vector the camera looks at,
## `cam_height` the camera height above the surface in world units.
func update_view(focus: Vector3, cam_height: float, p_detail: float, budget_ms: int) -> void:
	detail = p_detail
	set_shared("detail", detail)
	globe_mat.set_shader_parameter("sink", 1.6 * smoothstep(0.0, 0.05, detail))
	cloud_mat.set_shader_parameter("cloud_alpha", 1.0 - smoothstep(0.0, 0.7, detail))
	clouds.visible = detail < 0.7
	if detail <= 0.0:
		cells_root.visible = false
		return
	cells_root.visible = true

	var horizon := acos(clampf(R / (R + maxf(cam_height, 0.1)), -1.0, 1.0))
	var rad := clampf(horizon + cam_height / R * 0.8 + 0.1, 0.25, 0.8)
	_focus_cell = world.locate(focus, _focus_cell)
	if _focus_cell != _last_focus or absf(rad - _last_rad) > 0.03:
		_last_focus = _focus_cell
		_last_rad = rad
		_refresh_wanted(focus, rad)

	var t0 := Time.get_ticks_msec()
	while not queue.is_empty():
		var c: int = queue.pop_front()
		if not loaded.has(c):
			var mi := _build_cell(c)
			cells_root.add_child(mi)
			loaded[c] = mi
		if Time.get_ticks_msec() - t0 >= budget_ms:
			break


func _refresh_wanted(focus: Vector3, rad: float) -> void:
	var cos_r := cos(rad)
	var cos_drop := cos(rad + 0.15)
	for cv in loaded.keys():
		var c: int = cv
		if world.sites[c].dot(focus) < cos_drop:
			var old: Node = loaded[c]
			old.queue_free()
			loaded.erase(c)
	# Breadth-first from the focus cell gives a nearest-first build order.
	queue.clear()
	var seen := {_focus_cell: true}
	var frontier: Array = [_focus_cell]
	var qi := 0
	while qi < frontier.size():
		var c: int = frontier[qi]
		qi += 1
		if not loaded.has(c):
			queue.append(c)
		var nb: PackedInt32Array = world.cell_nb[c]
		for j in nb:
			if not seen.has(j) and world.sites[j].dot(focus) > cos_r:
				seen[j] = true
				frontier.append(j)


func clear_cells() -> void:
	for cv in loaded.keys():
		var node: Node = loaded[cv]
		node.queue_free()
	loaded.clear()
	queue.clear()
	_last_focus = -1


func _surface(arrays_v: PackedVector3Array, uv: PackedVector2Array, col: PackedColorArray, idx: PackedInt32Array) -> Array:
	var arr := []
	arr.resize(Mesh.ARRAY_MAX)
	arr[Mesh.ARRAY_VERTEX] = arrays_v
	arr[Mesh.ARRAY_TEX_UV] = uv
	arr[Mesh.ARRAY_COLOR] = col
	arr[Mesh.ARRAY_INDEX] = idx
	return arr


func _add_ribbon_point(bv: PackedVector3Array, buv: PackedVector2Array, bcol: PackedColorArray, d: Vector3, across: Vector3, h: float, col: Color) -> void:
	bv.append(d * R + across)
	bv.append(d * R - across)
	buv.append(Vector2(h / 10000.0, 0.0))
	buv.append(Vector2(h / 10000.0, 0.0))
	bcol.append(col)
	bcol.append(col)


func _build_cell(c: int) -> MeshInstance3D:
	var w := world
	var corners: PackedInt32Array = w.cell_corner[c]
	var nb: PackedInt32Array = w.cell_nb[c]
	var m := corners.size()
	var pc: Vector3 = w.sites[c]
	var hc: float = w.elev[c]
	var tc: float = w.temp_mean[c]
	var ac: float = w.temp_amp[c]
	var prc: float = w.precip[c]
	var rgc: float = w.rug[c]
	var rock_col: Color = WorldGen.ROCK_COLORS[w.rock[c]]
	var vcol := Color(rock_col.r, rock_col.g, rock_col.b, w.pop[c])

	var tv := PackedVector3Array()
	var tn := PackedVector3Array()
	var tuv := PackedVector2Array()
	var tuv2 := PackedVector2Array()
	var tcol := PackedColorArray()
	var ti := PackedInt32Array()
	var bv := PackedVector3Array()
	var buv := PackedVector2Array()
	var bcol := PackedColorArray()
	var bi := PackedInt32Array()
	var edge_h := PackedFloat32Array()
	var edge_d := PackedVector3Array()
	edge_h.resize(SUB + 1)
	edge_d.resize(SUB + 1)
	var min_h := 1.0e9

	for i in m:
		var ia := corners[i]
		var ib := corners[(i + 1) % m]
		var pa: Vector3 = w.corner_pos[ia]
		var pb: Vector3 = w.corner_pos[ib]
		var ha: float = w.corner_h[ia]
		var hb: float = w.corner_h[ib]
		var ta: float = w.corner_t[ia]
		var tb: float = w.corner_t[ib]
		var aa: float = w.corner_a[ia]
		var ab: float = w.corner_a[ib]
		var pra: float = w.corner_p[ia]
		var prb: float = w.corner_p[ib]
		var rga: float = w.corner_rug[ia]
		var rgb: float = w.corner_rug[ib]
		var base := tv.size()
		# Triangle (site, corner a, corner b) as a grid: row r runs parallel to the cell edge.
		for r in SUB + 1:
			for s in r + 1:
				var wb := float(s) / SUB
				var wa := float(r - s) / SUB
				var wc := 1.0 - float(r) / SUB
				var d := (pc * wc + pa * wa + pb * wb).normalized()
				var dz: float = w.detail_noise.get_noise_3dv(d * WorldGen.NOISE_FREQ) * (rgc * wc + rga * wa + rgb * wb)
				var h := hc * wc + ha * wa + hb * wb + dz
				var t := tc * wc + ta * wa + tb * wb - 0.0065 * dz
				tv.append(d * R)
				tn.append(d)
				tuv.append(Vector2(h / 10000.0, t / 50.0))
				tuv2.append(Vector2((ac * wc + aa * wa + ab * wb) / 50.0, (prc * wc + pra * wa + prb * wb) / 4000.0))
				tcol.append(vcol)
				min_h = minf(min_h, h)
				if r == SUB:
					edge_h[s] = h
					edge_d[s] = d
		for r in SUB:
			var r0 := base + r * (r + 1) / 2
			var r1 := base + (r + 1) * (r + 2) / 2
			for s in r + 1:
				ti.append(r0 + s)
				ti.append(r1 + s + 1)
				ti.append(r1 + s)
				if s < r:
					ti.append(r0 + s)
					ti.append(r0 + s + 1)
					ti.append(r1 + s + 1)

		# Border ribbon along this edge, coloured by tectonic plate, plus a corner dot.
		var pcol: Color = w.plate_color[w.plate[mini(c, nb[i])]]
		var edge := (pb - pa).normalized()
		var bb := bv.size()
		for s in SUB + 1:
			var across := edge_d[s].cross(edge).normalized() * BORDER_W
			_add_ribbon_point(bv, buv, bcol, edge_d[s], across, edge_h[s], pcol)
			if s < SUB:
				var k := bb + s * 2
				bi.append_array(PackedInt32Array([k, k + 1, k + 2, k + 1, k + 3, k + 2]))
		var dot_base := bv.size()
		var t1 := edge * BORDER_W * 2.6
		var t2 := edge_d[0].cross(edge).normalized() * BORDER_W * 2.6
		_add_ribbon_point(bv, buv, bcol, edge_d[0], t1, edge_h[0], Color.WHITE)
		_add_ribbon_point(bv, buv, bcol, edge_d[0], t2, edge_h[0], Color.WHITE)
		bi.append_array(PackedInt32Array([dot_base, dot_base + 2, dot_base + 1, dot_base, dot_base + 1, dot_base + 3]))

	var mesh := ArrayMesh.new()
	var arr := []
	arr.resize(Mesh.ARRAY_MAX)
	arr[Mesh.ARRAY_VERTEX] = tv
	arr[Mesh.ARRAY_NORMAL] = tn
	arr[Mesh.ARRAY_TEX_UV] = tuv
	arr[Mesh.ARRAY_TEX_UV2] = tuv2
	arr[Mesh.ARRAY_COLOR] = tcol
	arr[Mesh.ARRAY_INDEX] = ti
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arr)
	mesh.surface_set_material(0, terrain_mat)
	if min_h < 400.0:
		# The sea surface reuses the terrain vertices; the shader puts it at sea level.
		mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arr)
		mesh.surface_set_material(mesh.get_surface_count() - 1, water_mat)
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, _surface(bv, buv, bcol, bi))
	mesh.surface_set_material(mesh.get_surface_count() - 1, border_mat)
	if w.has_river[c] == 1:
		_add_rivers(mesh, c)

	var mi := MeshInstance3D.new()
	mi.mesh = mesh
	mi.extra_cull_margin = 6.0
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	_add_trees(mi, c)
	return mi


func _add_rivers(mesh: ArrayMesh, c: int) -> void:
	var w := world
	var rv := PackedVector3Array()
	var rn := PackedVector3Array()
	var ruv := PackedVector2Array()
	var ruv2 := PackedVector2Array()
	var rcol := PackedColorArray()
	var ri := PackedInt32Array()
	for path_v in w.river_paths(c):
		var path: Array = path_v
		var pts: PackedVector3Array = path[0]
		var w0: float = path[1]
		var w1: float = path[2]
		var n := pts.size()
		var base := rv.size()
		for k in n:
			var d := pts[k]
			var tangent := (pts[mini(k + 1, n - 1)] - pts[maxi(k - 1, 0)]).normalized()
			var across := d.cross(tangent).normalized()
			w.sample(d, c)
			var width := lerpf(w0, w1, float(k) / (n - 1))
			var col := Color(across.x * 0.5 + 0.5, across.y * 0.5 + 0.5, across.z * 0.5 + 0.5, clampf(w.s_a / 50.0, 0.0, 1.0))
			for sv in [-1.0, 1.0]:
				var side: float = sv
				rv.append(d * R)
				rn.append(d)
				ruv.append(Vector2(side, w.s_h / 10000.0))
				ruv2.append(Vector2(width, w.s_t / 50.0))
				rcol.append(col)
			if k < n - 1:
				var q := base + k * 2
				ri.append_array(PackedInt32Array([q, q + 1, q + 2, q + 1, q + 3, q + 2]))
	if rv.is_empty():
		return
	var arr := []
	arr.resize(Mesh.ARRAY_MAX)
	arr[Mesh.ARRAY_VERTEX] = rv
	arr[Mesh.ARRAY_NORMAL] = rn
	arr[Mesh.ARRAY_TEX_UV] = ruv
	arr[Mesh.ARRAY_TEX_UV2] = ruv2
	arr[Mesh.ARRAY_COLOR] = rcol
	arr[Mesh.ARRAY_INDEX] = ri
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arr)
	mesh.surface_set_material(mesh.get_surface_count() - 1, river_mat)


func _add_trees(parent: MeshInstance3D, c: int) -> void:
	var w := world
	if w.elev[c] <= 0.0 or w.temp_mean[c] < -6.0:
		return
	var count := int(clampf((w.precip[c] - 350.0) / 1400.0, 0.0, 1.0) * MAX_TREES)
	if count <= 0:
		return
	var rng := RandomNumberGenerator.new()
	rng.seed = w.seed_value * 31 + c
	var corners: PackedInt32Array = w.cell_corner[c]
	var m := corners.size()
	var pc: Vector3 = w.sites[c]
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.use_custom_data = true
	mm.mesh = tree_mesh
	mm.instance_count = count
	for k in count:
		var i := rng.randi() % m
		var u := rng.randf()
		var v := rng.randf()
		if u + v > 1.0:
			u = 1.0 - u
			v = 1.0 - v
		var pa: Vector3 = w.corner_pos[corners[i]]
		var pb: Vector3 = w.corner_pos[corners[(i + 1) % m]]
		var d := (pc * (1.0 - u - v) + pa * u + pb * v).normalized()
		w.sample(d, c)
		var h := w.s_h
		if w.s_t < -7.0 or h > 3000.0:
			h = -99999.0 # hidden by the shader
		var x := d.cross(Vector3.UP if absf(d.y) < 0.9 else Vector3.RIGHT).normalized()
		var z := x.cross(d)
		mm.set_instance_transform(k, Transform3D(Basis(x, d, z), d * R))
		var hemi := clampf(d.y * 6.0, -1.0, 1.0)
		mm.set_instance_custom_data(k, Color(h / 10000.0, w.s_t / 50.0, w.s_a * hemi / 50.0, rng.randf()))
	var mmi := MultiMeshInstance3D.new()
	mmi.multimesh = mm
	mmi.material_override = tree_mat
	mmi.extra_cull_margin = 6.0
	mmi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	parent.add_child(mmi)


## Outlines cell `c` (pass -1 to clear). `width` is in world units.
func select_cell(c: int, width: float) -> void:
	if c < 0:
		selection.mesh = null
		return
	var w := world
	var corners: PackedInt32Array = w.cell_corner[c]
	var m := corners.size()
	var bv := PackedVector3Array()
	var buv := PackedVector2Array()
	var bcol := PackedColorArray()
	var bi := PackedInt32Array()
	var col := Color(1.0, 0.95, 0.3)
	var steps := SUB * 2
	for i in m:
		var pa: Vector3 = w.corner_pos[corners[i]]
		var pb: Vector3 = w.corner_pos[corners[(i + 1) % m]]
		var edge := (pb - pa).normalized()
		var base := bv.size()
		for s in steps + 1:
			var d := pa.lerp(pb, float(s) / steps).normalized()
			w.sample(d, c)
			_add_ribbon_point(bv, buv, bcol, d, d.cross(edge).normalized() * width, w.s_h, col)
			if s < steps:
				var k := base + s * 2
				bi.append_array(PackedInt32Array([k, k + 1, k + 2, k + 1, k + 3, k + 2]))
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, _surface(bv, buv, bcol, bi))
	mesh.surface_set_material(0, select_mat)
	selection.mesh = mesh
