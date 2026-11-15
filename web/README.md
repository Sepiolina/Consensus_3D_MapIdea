# Web POC

A browser version of the same proof of concept, used to iterate on the look and the
algorithms before porting them to the Godot project in the repository root.

Serve this folder with any static file server and open `index.html`:

```bash
python3 -m http.server 8000 --directory web
```

three.js (r128) is loaded from a CDN; there are no texture or model files. Every
mesh (terrain, trees, rocks) and every texture (the baked globe map, the shadow map)
is generated at runtime.

## Mapping to Godot

Each file is the twin of a Godot script, with the same steps, names and units:

| Web | Godot | Notes |
| --- | --- | --- |
| `js/worldgen.js` | `scripts/world_gen.gd` | Pure data. Port line for line; `makeNoise` stands in for `FastNoiseLite` (`.n3` is one raw octave). |
| `js/solarsystem.js` | `scripts/solar_system.gd` | Pure data. |
| `js/planetview.js` | `scripts/planet_view.gd` | `BufferGeometry` → `ArrayMesh`, instanced meshes → `MultiMesh`. See the vertex layout below. |
| `js/vegetation.js` | (new) a small mesh-building script | Procedural tree, shrub, grass and rock meshes; `SurfaceTool` / `ArrayMesh` in Godot. |
| `js/shaders.js` | `shaders/*.gdshader` | `COMMON` is `common.gdshaderinc`. Drop `lit()`, `lit_s()`, `shadow_factor()`, `tonemap()` and the depth pass in Godot and write `ALBEDO`, `ROUGHNESS`, `AO`, `EMISSION` instead; the engine lights, shadows and tone-maps. |
| `js/main.js` | `scripts/main.gd` | Camera rig, time, orbits, input, HUD. |

## Terrain overhaul (stylised RTS look)

What changed, and what to carry over to Godot:

**Surface function** (`WorldGen.surface(d, start, q)`, with `sample()` kept as the
full-quality alias). One function of direction feeds the cell meshes, the baked
globe map, river carving, vegetation placement and the camera, so nothing floats or
cracks. The per-cell data (cells, plates, elevation, climate, rivers, biomes) is
unchanged for a given seed; only derived data was added (`_makeSurface()`: two-ring
neighbourhoods, mesa propensity, river beds and channel segments, `fillLevel`).
Layers, in order:

1. Domain-warped, compact smooth kernel (`KERNEL_R`) blend of the cell values over
   the two-ring neighbourhood. This replaces the piecewise-linear fan interpolation
   that produced the faceted look. Ocean depths are compressed (`SEA_K`) before
   blending so coastlines stay where the cells say.
2. Broad swells and rolling hills (amplitude from `rug`).
3. Ridged multi-octave noise in mountain belts.
4. Tablelands: in provinces where the blended mesa propensity (sedimentary bedrock,
   dry climate, not high mountains) plus noise is high, a warped swell field is cut
   by `levelHeight()` into flat-topped levels with steep risers; step height and
   riser width vary with noise. This replaces the uniform 300 m terraces and the
   per-level tone banding.
5. Gullies: ridged-noise valleys, strongest on tableland rims (notched cliffs).
6. A soft floor keeps land cells above the sea (no lagoon speckle).
7. River channels carved along `riverPaths()` (which now meander and carry a water
   level `bed` that never rises downstream): parabolic bed, low sandy banks, valley
   walls that steepen into canyons in mesa country.

Outputs besides height and climate: `sMesa`, `sGully`, `sRivD` (distance to channel
over half width), `sRivL` (water level), `sRock` (blended bedrock colour).

**Cell meshes**: three levels of detail by distance from the focus (`LOD_SUB` 32 /
16 / 8 subdivisions per fan triangle, with hysteresis) and skirts along every cell
edge to hide the T-junction cracks between levels. A cell is built by a generator
(`_buildCell`) that yields after every row, so the per-frame budget (`st.buildBudget`,
7 ms) is respected even for the finest cells; in Godot, build cells on a
`WorkerThreadPool` thread instead. Per vertex the build evaluates the surface, two
finite-difference neighbours for the normal (in displaced space, fixed step per
level so shared edges match), and six horizon probes for ambient occlusion and
concavity.

Vertex layout (pack into `CUSTOM0..3` in Godot): `adata` = (height m, mean temp,
seasonal amp, precip); `anormal` = (normal xyz, AO); `asurf` = (mesa, gully,
concavity, river distance); `acolor` = (bedrock rgb, population; -1 marks skirts);
`ariver` = river water level.

**Materials** (`terrainFrag`, `land_albedo`): per-pixel blend of golden grass, ochre
earth, muted greens and woodland by rainfall and temperature, painterly mottling at
three footprint-faded scales, sand in dry washes, river banks and beaches, damp sand at
waterlines, red layered sandstone or grey rock on steep faces (strata follow height;
the vertical streaks come from noise of the direction, which barely changes up a
wall: a free "triplanar"), scree at cliff feet, snow by the existing temperature
rule. Normals are the smooth baked ones, switching to the triangle normal only on
faces much steeper than the vertex normals say, plus a screen-space bump. The crop
field patchwork and the houses were removed (no settlements in the world).

**Lighting** (web-only `lit()`): warm key light that turns golden when the sun is
low, cool sky fill and warm ground bounce scaled by AO, aerial perspective that
hazes toward a warm sky colour toward the sun. Shadows: three's shadow maps cannot
see relief displaced in vertex shaders, so `PlanetView.renderShadows()` renders the
casters (terrain with skirts collapsed, trees, shrubs, rocks) with depth variants of
their own vertex shaders (`S.depthFrag`, RGBA-packed depth) from an orthographic sun
camera centred on the focus and texel-snapped, and `shadow_factor()` samples it
with a 12-tap Vogel-disk PCF, a normal offset and a slope-scaled bias. Godot casts
correct shadows from displaced vertices by itself: drop all of that.

**Water**: rivers are level water ribbons along the channels at the river's water
level, wide enough to reach the banks; the carved terrain hides them wherever the
ground is higher, so the shoreline is where water meets the banks. Turquoise, deeper
in the middle, advected ripples, fresnel sky reflection and sun glint; the flooding
slider raises the water level (and so floods the banks and floodplain). Far away,
where coarse cells cannot show the channel, a narrower ribbon is lifted slightly.
The sea keeps its sea-green shelf with a turquoise shore band and glint.

**Vegetation and rocks** (`vegetation.js`, `_placeVegetation`): broadleaf crowns of
merged jittered blobs, layered conifers, flat-topped acacias, palms, shrubs, grass
tufts and lumpy boulders, each kind ONE instanced mesh for the whole near field
(instance data: direction + height, yaw/scale/lean/random, climate + AO). Placement
reuses the vertex data of the finest two levels (slope, AO, moisture, temperature,
mesa, gullies, river distance) with clustered noise: sparse in dry country, denser in
wet biomes, riparian trees along rivers, boulders at cliff feet and in gullies, none
on cliffs or in channels. Instances sit on the drawn triangles, hide when drowned and
turn or get snow with the season.

**Defaults**: cell borders and corner dots are off (checkbox unchecked; the B key
and the checkbox still toggle them); the clicked-cell outline is unchanged.

Porting notes: all GLSL uses float literals and increasing-edge `smoothstep`; the
only screen-space derivatives are `dFdx` / `dFdy` / `fwidth` (same names in Godot);
`textureLod` is only in the globe shader.
