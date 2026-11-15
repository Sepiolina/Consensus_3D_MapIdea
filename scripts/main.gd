extends Node3D
## Demo scene: builds everything in code (no scene, texture or model assets).
##
## The home planet always sits at the world origin; the star, the other planets and
## their orbit lines move around it on a compressed scale. One zoom axis takes the
## camera from the 3D Voronoi map, through the textured globe, out to the system.

const WorldGen = preload("res://scripts/world_gen.gd")
const SolarSystem = preload("res://scripts/solar_system.gd")
const PlanetView = preload("res://scripts/planet_view.gd")

const R := 100.0
const AU := 5000.0          # world units per astronomical unit (compressed)
const STAR_R := 350.0
const ALT_MIN := 4.0
const ALT_MAX := 400000.0

@export var world_seed := 20261
@export var cell_count := 3000

var world: WorldGen
var system: SolarSystem
var view: PlanetView

var cam: Camera3D
var sun_light: DirectionalLight3D
var atmosphere_mat: ShaderMaterial
var star_mat: ShaderMaterial
var star_mi: MeshInstance3D
var corona_mi: MeshInstance3D
var system_root: Node3D
var orbit_root: Node3D
var body_nodes: Array = []   # MeshInstance3D per planet (null for home)
var body_mats: Array = []
var moon_mi: MeshInstance3D

# Simulation state
var t_days := 0.0
var time_speed := 0.05       # days per real second
var paused := false
var spin := 0.0
var frame_angle := 0.0
var sea_level := 0.0
var flood := 0.0
var borders_on := true
var shadows_on := true
var season := 0.0
var _prev_season := 0.0
var _season_rising := true
var wall_time := 0.0

# Camera state
var alt := 320.0
var alt_target := 320.0
var focus_f := Vector3(0.75, 0.45, 0.48).normalized()
var heading := 0.0
var pitch_user := 0.0
var drag_l := false
var drag_r := false
var drag_dist := 0.0
var selected := -1
var ready_ok := false
var generating := false

# HUD
var hud: CanvasLayer
var stats_label: Label
var info_label: Label
var status_label: Label
var right_panel: PanelContainer
var info_panel: PanelContainer
var sea_value: Label
var speed_value: Label
var body_labels: Array = []
var _hud_timer := 0.0
var _system_text := ""


func _ready() -> void:
	_build_environment()
	_build_hud()
	_generate()


# ---------------------------------------------------------------- Setup

func _build_environment() -> void:
	var env := Environment.new()
	env.background_mode = Environment.BG_SKY
	var sky := Sky.new()
	var sky_mat := ShaderMaterial.new()
	sky_mat.shader = load("res://shaders/sky.gdshader")
	sky.sky_material = sky_mat
	env.sky = sky
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.35, 0.42, 0.6)
	env.ambient_light_energy = 0.3
	env.tonemap_mode = Environment.TONE_MAPPER_ACES
	env.tonemap_white = 6.0
	env.glow_enabled = true
	env.glow_intensity = 0.6
	env.glow_bloom = 0.05
	env.ssao_enabled = true # Forward+ only; ignored by the other renderers
	env.ssao_radius = 0.6
	env.ssao_intensity = 1.5
	env.adjustment_enabled = true
	env.adjustment_saturation = 1.12
	env.adjustment_contrast = 1.05
	var we := WorldEnvironment.new()
	we.environment = env
	add_child(we)

	cam = Camera3D.new()
	cam.fov = 60.0
	cam.far = 2000000.0
	add_child(cam)
	cam.make_current()

	sun_light = DirectionalLight3D.new()
	sun_light.light_energy = 1.6
	sun_light.shadow_enabled = false # switched on in the close-up map view
	sun_light.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_4_SPLITS
	sun_light.directional_shadow_blend_splits = true
	sun_light.shadow_bias = 0.04
	sun_light.shadow_normal_bias = 1.2
	add_child(sun_light)

	var atm := MeshInstance3D.new()
	var atm_mesh := SphereMesh.new()
	atm_mesh.radius = 104.5
	atm_mesh.height = 209.0
	atm_mesh.radial_segments = 96
	atm_mesh.rings = 48
	atm.mesh = atm_mesh
	atmosphere_mat = ShaderMaterial.new()
	atmosphere_mat.shader = load("res://shaders/atmosphere.gdshader")
	atm.material_override = atmosphere_mat
	atm.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(atm)


func _add_slider(box: VBoxContainer, title: String, min_v: float, max_v: float, value: float, on_change: Callable) -> Label:
	var lab := Label.new()
	lab.text = title
	box.add_child(lab)
	var sl := HSlider.new()
	sl.min_value = min_v
	sl.max_value = max_v
	sl.step = (max_v - min_v) / 400.0
	sl.value = value
	sl.custom_minimum_size = Vector2(230.0, 18.0)
	sl.focus_mode = Control.FOCUS_NONE
	sl.value_changed.connect(on_change)
	box.add_child(sl)
	return lab


func _build_hud() -> void:
	hud = CanvasLayer.new()
	add_child(hud)

	var left := PanelContainer.new()
	left.position = Vector2(10.0, 10.0)
	left.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hud.add_child(left)
	stats_label = Label.new()
	stats_label.add_theme_font_size_override("font_size", 13)
	left.add_child(stats_label)

	info_panel = PanelContainer.new()
	info_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	info_panel.visible = false
	hud.add_child(info_panel)
	info_label = Label.new()
	info_label.add_theme_font_size_override("font_size", 13)
	info_panel.add_child(info_label)

	status_label = Label.new()
	status_label.add_theme_font_size_override("font_size", 22)
	hud.add_child(status_label)

	right_panel = PanelContainer.new()
	hud.add_child(right_panel)
	var box := VBoxContainer.new()
	right_panel.add_child(box)
	speed_value = _add_slider(box, "Time speed", -2.0, 1.7, log(time_speed) / log(10.0), _on_speed)
	sea_value = _add_slider(box, "Sea level", -300.0, 300.0, 0.0, _on_sea)
	_add_slider(box, "River flow / flooding", 0.0, 1.0, 0.0, _on_flood)
	var cb := CheckBox.new()
	cb.text = "Cell borders (B)"
	cb.button_pressed = true
	cb.focus_mode = Control.FOCUS_NONE
	cb.toggled.connect(_on_borders)
	box.add_child(cb)
	var sb := CheckBox.new()
	sb.text = "Sun shadows (map view)"
	sb.button_pressed = true
	sb.focus_mode = Control.FOCUS_NONE
	sb.toggled.connect(_on_shadows)
	box.add_child(sb)
	var pause_btn := Button.new()
	pause_btn.text = "Pause / resume (Space)"
	pause_btn.focus_mode = Control.FOCUS_NONE
	pause_btn.pressed.connect(_on_pause)
	box.add_child(pause_btn)
	var gen_btn := Button.new()
	gen_btn.text = "New world (R)"
	gen_btn.focus_mode = Control.FOCUS_NONE
	gen_btn.pressed.connect(_on_new_world)
	box.add_child(gen_btn)
	var help := Label.new()
	help.add_theme_font_size_override("font_size", 12)
	help.text = "Wheel / Z X: zoom (map - globe - system)\nLeft drag / WASD: move\nRight drag / Q E: rotate and tilt\nClick: inspect a cell"
	box.add_child(help)


func _on_speed(v: float) -> void:
	time_speed = pow(10.0, v)


func _on_sea(v: float) -> void:
	sea_level = v


func _on_flood(v: float) -> void:
	flood = v


func _on_borders(on: bool) -> void:
	borders_on = on


func _on_shadows(on: bool) -> void:
	shadows_on = on


func _on_pause() -> void:
	paused = not paused


func _on_new_world() -> void:
	if generating:
		return
	world_seed += 1
	_generate()


func _generate() -> void:
	generating = true
	ready_ok = false
	if view != null:
		view.queue_free()
		view = null
	if system_root != null:
		system_root.queue_free()
		system_root = null
	for lv in body_labels:
		var old_label: Label = lv
		old_label.queue_free()
	body_labels.clear()
	selected = -1
	info_panel.visible = false

	status_label.text = "Generating solar system..."
	await get_tree().process_frame
	system = SolarSystem.new()
	system.generate(world_seed)
	var home: Dictionary = system.home()

	world = WorldGen.new()
	world.seed_value = world_seed
	world.n_cells = cell_count
	world.radius_km = float(home["radius"]) * 6371.0
	world.axial_tilt_deg = home["tilt"]
	world.mean_temp_c = home["mean_c"]
	for i in WorldGen.STEP_NAMES.size():
		var step_name: String = WorldGen.STEP_NAMES[i]
		status_label.text = "Generating planet: %s..." % step_name
		await get_tree().process_frame
		await get_tree().process_frame
		world.gen_step(i)
	world.bake_begin()
	var progress := 0.0
	while progress < 1.0:
		progress = world.bake_step(14)
		status_label.text = "Baking 2D globe map: %d%%" % int(progress * 100.0)
		await get_tree().process_frame
	world.bake_finish()

	view = PlanetView.new()
	add_child(view)
	view.setup(world)
	_build_system_nodes()
	_system_text = system.describe()
	_system_text += "  Land %.0f%%   Highest %.0f m   Deepest %.0f m\n" % [world.land_fraction * 100.0, world.max_elev, world.min_elev]
	_system_text += "  %d Voronoi cells (%.0f km2 each)   %d river cells\n" % [world.n_cells, world.cell_area_km2, world.river_cells]
	status_label.text = ""
	t_days = 0.0
	spin = 0.0
	frame_angle = 0.0
	generating = false
	ready_ok = true


func _body_label(text: String) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", 12)
	l.visible = false
	hud.add_child(l)
	body_labels.append(l)
	return l


func _build_system_nodes() -> void:
	system_root = Node3D.new()
	add_child(system_root)
	var star_col: Color = system.star["color"]

	star_mi = MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = STAR_R
	sm.height = STAR_R * 2.0
	star_mi.mesh = sm
	star_mat = ShaderMaterial.new()
	star_mat.shader = load("res://shaders/star.gdshader")
	star_mat.set_shader_parameter("star_color", star_col)
	star_mi.material_override = star_mat
	star_mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	system_root.add_child(star_mi)

	corona_mi = MeshInstance3D.new()
	var quad := QuadMesh.new()
	quad.size = Vector2(2.0, 2.0)
	corona_mi.mesh = quad
	var cmat := ShaderMaterial.new()
	cmat.shader = load("res://shaders/corona.gdshader")
	cmat.set_shader_parameter("star_color", star_col)
	corona_mi.material_override = cmat
	corona_mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	system_root.add_child(corona_mi)
	sun_light.light_color = star_col.lerp(Color.WHITE, 0.6)

	orbit_root = Node3D.new()
	system_root.add_child(orbit_root)
	body_nodes.clear()
	body_mats.clear()
	var star_name: String = system.star["name"]
	_body_label(star_name)
	for i in system.planets.size():
		var p: Dictionary = system.planets[i]
		var is_home: bool = p["home"]
		# Orbit line (Kepler ellipse around the star).
		var pts := PackedVector3Array()
		for k in 257:
			pts.append(system.orbit_point(i, TAU * k / 256.0) * AU)
		var arr := []
		arr.resize(Mesh.ARRAY_MAX)
		arr[Mesh.ARRAY_VERTEX] = pts
		var omesh := ArrayMesh.new()
		omesh.add_surface_from_arrays(Mesh.PRIMITIVE_LINE_STRIP, arr)
		var omat := StandardMaterial3D.new()
		omat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		omat.albedo_color = Color(0.45, 0.9, 0.6) if is_home else Color(0.4, 0.5, 0.7)
		omesh.surface_set_material(0, omat)
		var omi := MeshInstance3D.new()
		omi.mesh = omesh
		omi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		orbit_root.add_child(omi)

		var pname: String = p["name"]
		_body_label(pname)
		if is_home:
			body_nodes.append(null)
			body_mats.append(null)
			continue
		var pr: float = p["radius"]
		body_nodes.append(_make_body(R * pow(pr, 0.6), p["color_a"], p["color_b"], p["banded"]))
	var mr: float = system.moon["radius"]
	moon_mi = _make_body(R * mr, Color(0.62, 0.61, 0.6), Color(0.36, 0.36, 0.38), 0.0)
	var moon_name: String = system.moon["name"]
	_body_label(moon_name)


func _make_body(radius: float, col_a: Color, col_b: Color, banded: float) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = radius
	sm.height = radius * 2.0
	mi.mesh = sm
	var mat := ShaderMaterial.new()
	mat.shader = load("res://shaders/body.gdshader")
	mat.set_shader_parameter("color_a", col_a)
	mat.set_shader_parameter("color_b", col_b)
	mat.set_shader_parameter("banded", banded)
	mi.material_override = mat
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	system_root.add_child(mi)
	body_mats.append(mat)
	return mi


# ---------------------------------------------------------------- Input

func _unhandled_input(ev: InputEvent) -> void:
	if ev is InputEventMouseButton:
		var mb: InputEventMouseButton = ev
		if mb.button_index == MOUSE_BUTTON_WHEEL_UP and mb.pressed:
			alt_target = maxf(ALT_MIN, alt_target * 0.88)
		elif mb.button_index == MOUSE_BUTTON_WHEEL_DOWN and mb.pressed:
			alt_target = minf(ALT_MAX, alt_target / 0.88)
		elif mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				drag_l = true
				drag_dist = 0.0
			else:
				drag_l = false
				if drag_dist < 5.0:
					_pick(mb.position)
		elif mb.button_index == MOUSE_BUTTON_RIGHT:
			drag_r = mb.pressed
	elif ev is InputEventMouseMotion:
		var mm: InputEventMouseMotion = ev
		if drag_l:
			drag_dist += mm.relative.length()
			_pan(mm.relative)
		elif drag_r:
			heading -= mm.relative.x * 0.005
			pitch_user = clampf(pitch_user + mm.relative.y * 0.004, -1.0, 0.9)
	elif ev is InputEventKey:
		var key: InputEventKey = ev
		if key.pressed and not key.echo:
			if key.keycode == KEY_SPACE:
				paused = not paused
			elif key.keycode == KEY_B:
				borders_on = not borders_on
			elif key.keycode == KEY_R:
				_on_new_world()


func _pan(rel: Vector2) -> void:
	var k := minf(alt * 0.0013 / R, 0.01)
	var u := focus_f
	var e := Vector3.UP.cross(u)
	if e.length() < 0.01:
		e = Vector3.RIGHT.cross(u)
	e = e.normalized()
	var n := u.cross(e)
	var fwd := n * cos(heading) + e * sin(heading)
	var right := fwd.cross(u)
	focus_f = (u - right * rel.x * k + fwd * rel.y * k).normalized()


func _pick(mouse: Vector2) -> void:
	if not ready_ok:
		return
	var ro := cam.project_ray_origin(mouse)
	var rd := cam.project_ray_normal(mouse)
	var b := ro.dot(rd)
	var disc := b * b - (ro.dot(ro) - R * R)
	if disc < 0.0 or -b - sqrt(disc) < 0.0:
		selected = -1
		view.select_cell(-1, 0.1)
		info_panel.visible = false
		return
	var hit := ro + rd * (-b - sqrt(disc))
	var local := (view.global_transform.basis.inverse() * hit).normalized()
	selected = world.locate(local, maxi(selected, 0))
	view.select_cell(selected, clampf(alt * 0.004, 0.07, 1.5))
	info_label.text = world.cell_info(selected)
	info_panel.visible = true


# ---------------------------------------------------------------- Frame update

func _process(delta: float) -> void:
	var vp := get_viewport().get_visible_rect().size
	right_panel.position = Vector2(vp.x - right_panel.size.x - 10.0, 10.0)
	info_panel.position = Vector2(10.0, vp.y - info_panel.size.y - 10.0)
	status_label.position = Vector2(vp.x * 0.5 - status_label.size.x * 0.5, vp.y * 0.5)
	if not ready_ok:
		return
	wall_time += delta
	if not paused:
		t_days += delta * time_speed

	# Keyboard camera controls.
	var move := Vector2.ZERO
	if Input.is_key_pressed(KEY_A):
		move.x += 1.0
	if Input.is_key_pressed(KEY_D):
		move.x -= 1.0
	if Input.is_key_pressed(KEY_W):
		move.y += 1.0
	if Input.is_key_pressed(KEY_S):
		move.y -= 1.0
	if move != Vector2.ZERO:
		_pan(move * delta * 500.0)
	if Input.is_key_pressed(KEY_Q):
		heading += delta
	if Input.is_key_pressed(KEY_E):
		heading -= delta
	if Input.is_key_pressed(KEY_Z):
		alt_target = maxf(ALT_MIN, alt_target * pow(0.3, delta))
	if Input.is_key_pressed(KEY_X):
		alt_target = minf(ALT_MAX, alt_target / pow(0.3, delta))
	alt = exp(lerpf(log(alt), log(alt_target), 1.0 - exp(-delta * 8.0)))

	# Planet rotation. The camera frame co-rotates with the planet only when close,
	# so the ground stays put in map view while the planet visibly spins from afar.
	var home: Dictionary = system.home()
	var day_len: float = float(home["day_h"]) / 24.0
	var tilt: float = deg_to_rad(float(home["tilt"]))
	var new_spin := TAU * t_days / day_len
	var follow := 1.0 - smoothstep(150.0, 600.0, alt)
	frame_angle += (new_spin - spin) * follow
	spin = new_spin
	var tilt_b := Basis(Vector3.RIGHT, tilt)
	var planet_b := tilt_b * Basis(Vector3.UP, spin)
	var frame_b := tilt_b * Basis(Vector3.UP, frame_angle)
	view.transform = Transform3D(planet_b, Vector3.ZERO)

	# Orbits: everything is placed relative to the home planet.
	var home_pos := system.planet_pos(system.home_index, t_days)
	var star_pos := -home_pos * AU
	var sun_dir := star_pos.normalized()
	var sun_local := planet_b.inverse() * sun_dir
	_prev_season = season
	season = clampf(sun_local.y / maxf(sin(tilt), 0.01), -1.0, 1.0)
	if absf(season - _prev_season) > 1.0e-7:
		_season_rising = season > _prev_season
	sun_light.look_at_from_position(sun_dir * 1000.0, Vector3.ZERO, Vector3.UP)
	star_mi.position = star_pos
	orbit_root.position = star_pos
	for i in body_nodes.size():
		if body_nodes[i] == null:
			continue
		var body: MeshInstance3D = body_nodes[i]
		body.position = (system.planet_pos(i, t_days) - home_pos) * AU
	var moon_ang: float = TAU * t_days / float(system.moon["period"])
	var moon_dist: float = system.moon["dist"]
	moon_mi.position = Vector3(cos(moon_ang), 0.09 * sin(moon_ang), sin(moon_ang)) * moon_dist
	for mv in body_mats:
		if mv == null:
			continue
		var bm: ShaderMaterial = mv
		bm.set_shader_parameter("star_pos_world", star_pos)

	# Level of detail from altitude.
	var detail := 1.0 - smoothstep(18.0, 45.0, alt)
	view.sea_level = sea_level
	view.set_shared("sea_level", sea_level)
	view.set_shared("season", season)
	view.set_shared("sun_dir_local", sun_local)
	view.set_shared("sun_dir_world", sun_dir)
	view.set_shared("wall_time", wall_time)
	view.set_shared("flood", flood)
	view.set_shared("border_strength", (1.0 if borders_on else 0.0))
	view.globe_mat.set_shader_parameter("border_strength", (0.3 if borders_on else 0.0))
	view.select_mat.set_shader_parameter("border_strength", 1.0)
	star_mat.set_shader_parameter("wall_time", wall_time)
	atmosphere_mat.set_shader_parameter("sun_dir_world", sun_dir)

	# Camera rig.
	var u := focus_f
	var e := Vector3.UP.cross(u)
	if e.length() < 0.01:
		e = Vector3.RIGHT.cross(u)
	e = e.normalized()
	var n := u.cross(e)
	var fwd := n * cos(heading) + e * sin(heading)
	var auto_pitch := lerpf(deg_to_rad(42.0), deg_to_rad(89.0), smoothstep(12.0, 70.0, alt))
	var pitch := clampf(auto_pitch + pitch_user, deg_to_rad(12.0), deg_to_rad(89.5))
	var focus_local := Basis(Vector3.UP, frame_angle - spin) * u
	view.detail = detail
	var target := frame_b * (u * view.ground_radius(focus_local))
	var near_dir := frame_b * (u * sin(pitch) - fwd * cos(pitch))
	var near_up := frame_b * (u + fwd).normalized()
	# Far away the camera lifts above the ecliptic so the orbits are readable.
	var far_w := smoothstep(1500.0, 12000.0, alt)
	var elev_ang := clampf(deg_to_rad(55.0) - pitch_user, deg_to_rad(8.0), deg_to_rad(88.0))
	var far_dir := Vector3(cos(elev_ang) * sin(heading), sin(elev_ang), cos(elev_ang) * cos(heading))
	var cam_dir := near_dir.slerp(far_dir, far_w).normalized()
	var cam_up := near_up.lerp(Vector3.UP, far_w).normalized()
	var cam_pos := target + cam_dir * alt
	cam.near = clampf(alt * 0.02, 0.05, 2000.0)
	cam.look_at_from_position(cam_pos, target, cam_up)

	view.update_view(focus_local, cam_pos.length() - R, detail, 6)
	# Terraces, trees and houses cast sun shadows once the 3D relief is up.
	sun_light.shadow_enabled = shadows_on and detail > 0.5
	sun_light.directional_shadow_max_distance = clampf(alt * 4.0, 40.0, 300.0)

	# The glow quad faces the camera and never shrinks below a few pixels.
	var star_dist := (star_pos - cam_pos).length()
	var glow := maxf(STAR_R * 3.5, star_dist * 0.05)
	corona_mi.global_transform = Transform3D(cam.global_transform.basis.scaled(Vector3.ONE * glow), star_pos)

	_update_labels(vp)
	_hud_timer -= delta
	if _hud_timer <= 0.0:
		_hud_timer = 0.15
		_update_hud(home, detail)


func _update_labels(vp: Vector2) -> void:
	var labels_on := alt > 1200.0
	var idx := 0
	var positions: Array = [star_mi.global_position]
	for i in system.planets.size():
		if body_nodes[i] == null:
			positions.append(Vector3.ZERO)
		else:
			var body: MeshInstance3D = body_nodes[i]
			positions.append(body.global_position)
	positions.append(moon_mi.global_position)
	for lv in body_labels:
		var l: Label = lv
		var pos: Vector3 = positions[idx]
		idx += 1
		if not labels_on or cam.is_position_behind(pos):
			l.visible = false
			continue
		var sp := cam.unproject_position(pos)
		l.visible = sp.x > 0.0 and sp.y > 0.0 and sp.x < vp.x and sp.y < vp.y
		l.position = sp + Vector2(8.0, -8.0)


func _update_hud(home: Dictionary, detail: float) -> void:
	var year_len: float = home["period"]
	var day_len: float = float(home["day_h"]) / 24.0
	var year := int(t_days / year_len) + 1
	var local_days := fmod(t_days, year_len) / day_len
	var decl := rad_to_deg(asin(clampf(season * sin(deg_to_rad(float(home["tilt"]))), -1.0, 1.0)))
	var north := "summer"
	if season < -0.5:
		north = "winter"
	elif season < 0.5:
		north = "spring" if _season_rising else "autumn"
	var south := "winter"
	if north == "winter":
		south = "summer"
	elif north == "spring":
		south = "autumn"
	elif north == "autumn":
		south = "spring"
	var mode := "System view"
	if detail > 0.0:
		mode = "3D map (%d cells loaded)" % view.loaded.size()
	elif alt < 1500.0:
		mode = "Globe (baked 2D map)"
	var txt := _system_text
	txt += "TIME  Year %d, local day %.1f%s\n" % [year, local_days, "  [paused]" if paused else ""]
	txt += "  North: %s   South: %s   (sun declination %+.1f deg)\n" % [north, south, decl]
	txt += "VIEW  %s   altitude %.0f km\n" % [mode, alt / R * world.radius_km]
	stats_label.text = txt
	speed_value.text = "Time speed: %.2f days / s" % time_speed
	sea_value.text = "Sea level: %+.0f m" % sea_level
