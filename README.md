# Consensus 3D Map Idea

Proof of concept: a fully procedural **3D Voronoi world map** for Godot 4, from a
solar system down to individual map cells. No texture, model or scene assets — the
repository is only GDScript and shader source; everything else is generated at run time
from one seed.

> **Web POC first.** `web/` holds a browser version of the same design, used to tune the
> look and the algorithms where they can be run and seen quickly. It is currently ahead of
> the Godot project; `web/README.md` maps each file to its Godot twin.

## Run

Open the folder with **Godot 4.3 or newer** and press Play (`main.tscn`), or:

```bash
godot --path .
```

Generation takes a few seconds (a progress line is shown).

| Input | Action |
| --- | --- |
| Mouse wheel, `Z` / `X` | Zoom: 3D map ⇄ globe ⇄ solar system |
| Left drag, `WASD` | Move over the surface |
| Right drag, `Q` / `E` | Rotate / tilt the camera |
| Click | Inspect a cell (biome, elevation, climate, bedrock, river discharge) |
| `Space` | Pause time |
| `B` | Toggle cell borders |
| `R` | New world (next seed) |

Sliders: time speed (0.01 – 50 days per second), sea level (±300 m), river flow / flooding.

## What it does

1. **Everything procedural** — spherical Voronoi cells, terrain meshes, the globe's 2D
   map texture, trees, clouds, atmosphere, star field, star and planets are all generated.
2. **Physically motivated world generation** (`scripts/world_gen.gd`)
   - *Tectonics*: random plates with Euler-pole motion; convergent boundaries build fold
     mountains, cordilleras and island arcs with trenches; divergent ones make ridges and rifts;
     hotspots make shield volcanoes.
   - *Elevation* in metres with an Earth-like hypsometry (about 30 % land, shelves, abyssal plains).
   - *Geology*: bedrock per cell (basalt, granite, sandstone, limestone, gneiss, andesite).
   - *Climate*: temperature from latitude, lapse rate (6.5 °C/km) and continentality; seasonal
     amplitude from axial tilt; rainfall from zonal circulation bands, prevailing winds carrying
     ocean moisture inland, orographic rain and rain shadows.
   - *Rivers*: depression filling, downhill routing, discharge in m³/s from rainfall × area × runoff.
   - *Biomes*: Whittaker-style classification from temperature and precipitation.
3. **Stylised look** — faceted low-poly relief, flat colour ramps, plate-coloured cell borders
   with corner dots, cone trees, soft water.
4. **Continuous zoom, both ways** — far away the planet is a single sphere textured with a baked
   equirectangular 2D map (cheap). Below a threshold altitude, per-cell 3D meshes stream in
   around the camera; their relief is applied in the vertex shader and scaled by a `detail`
   uniform, so the map flattens back onto the globe when zooming out.
5. **Solar system** (`scripts/solar_system.gd`) — a main-sequence star derived from its mass
   (luminosity, radius, temperature, colour), planets on Kepler orbits spaced around a home
   planet in the habitable zone, with types, equilibrium temperatures, gravity, day and year
   lengths. Day/night comes from the planet's real spin; seasons come from its axial tilt and
   orbital position. The star's and planet's parameters feed the climate model.
6. **Dynamic map** — sea level, river flooding, time of day and season are shader uniforms, so
   they change live without regenerating anything: coasts flood or emerge, rivers widen and
   turn muddy, snow lines and sea ice advance and retreat, temperate vegetation goes dormant,
   settlement lights appear on the night side.

## Integrating into another Godot project

Copy `scripts/` and `shaders/` (the shaders are referenced as `res://shaders/...`).

```gdscript
const WorldGen = preload("res://scripts/world_gen.gd")
const PlanetView = preload("res://scripts/planet_view.gd")

var world := WorldGen.new()
world.seed_value = 42
world.n_cells = 3000
world.generate_all()              # data only: cells, climate, rivers, biomes
world.bake_begin()
while world.bake_step(1000) < 1.0:
    pass
world.bake_finish()               # 2D map textures for the globe

var view := PlanetView.new()
add_child(view)
view.setup(world)
# every frame:
view.set_shared("sea_level", 0.0)                    # metres
view.set_shared("season", 0.3)                       # -1 .. 1
view.set_shared("sun_dir_local", Vector3(1, 0, 0))   # sun direction in planet space
view.update_view(focus_dir, camera_height, detail, 6)
```

- `WorldGen` is a plain `RefCounted` with packed arrays per cell (`elev`, `temp_mean`,
  `precip`, `biome`, `rock`, `plate`, `flux`, `cell_nb`, `cell_corner`, ...), so game logic
  (provinces, pathfinding, ownership) can read it directly. `locate(dir)` maps a point on the
  sphere to its cell and `sample(dir)` returns the continuous surface there.
- `PlanetView` only renders; `scripts/main.gd` is the demo glue (camera, time, HUD, solar system).
- The planet radius is 100 world units. `PLANET_R` / `HEIGHT_SCALE` are duplicated in
  `shaders/common.gdshaderinc` and `scripts/planet_view.gd` and must stay equal.

## Layout

```
scripts/world_gen.gd     planet data generation and 2D map baking
scripts/solar_system.gd  star, planets, Kepler orbits
scripts/planet_view.gd   globe, streamed 3D cell meshes, materials
scripts/main.gd          demo scene: camera, time, HUD
shaders/                 terrain, water, rivers, borders, trees, globe, clouds, atmosphere, star, sky
```

## Known limits of the POC

- Distances and sizes in the solar system are compressed, and relief is exaggerated about 25×.
- Rivers are ribbons laid on the terrain rather than carved valleys; lakes are not rendered.
- Cells are large (about 170 000 km² at 3000 cells); raise `cell_count` for finer maps at
  the cost of generation time.
