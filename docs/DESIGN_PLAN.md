# Design plan: terrain fixes, performance, and the multi-scale engine

Status: **plan only — nothing in this document is implemented yet.**
Scope: the three briefs (fix terrain artefacts; performance optimisation; scalable
multi-scale engine) applied to this repository.

How to read the evidence labels used below:

- **Confirmed** — seen in the code or in screenshots taken from this code.
- **Suspected** — follows from the code structure but has not been measured or reproduced.
- **Unmeasured** — needs your hardware; this sandbox only has software rendering.

No screenshot was attached to the request, so the artefact list in section 2 comes from
the screenshots captured during the three terrain passes and from reading the code. If
your screenshot shows something not listed there, it is not covered yet.

---

## 0. Decisions needed before implementation

These change what gets built, so they come first. Each has a recommendation.

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| D1 | Where the work happens: keep iterating in `web/` then port, or port to Godot now | Stabilise geometry and rivers in `web/` (section 2), build the data architecture as engine-neutral modules with tests (section 4), **then port, then do most performance work in Godot** | Geometry and generation fixes are algorithmic and transfer 1:1. Most performance findings do not: threads, instancing, shadows and shader cost behave differently in Godot than in WebGL/three r128. The Godot project is three passes behind and has never been run. |
| D2 | Terrain mesh unit: keep "one Voronoi cell = one mesh" or move to chunks independent of cells | Keep cells through stabilisation; move to **cube-sphere quadtree chunks** at the port | Cells as mesh units tie triangle density to province size, force fan triangulation (thin triangles at the site, uneven density) and make level of detail coarse. Provinces should be *data* drawn onto terrain, not the terrain's mesh structure. It is the one large structural change this plan proposes. |
| D3 | Target hardware and resolution for the 60 fps goal | You choose; plan assumes a mid-range laptop integrated GPU at 1080p | Every budget in section 3 is derived from this. |
| D4 | Camera: orthographic or slight perspective | Slight perspective (narrow field of view, 20–30°) | Keeps the globe-to-map zoom continuous and gives parallax on relief; pixel-art sprites still hold a fixed texel size per zoom tier (section 2.7). |
| D5 | Province granularity: 3000 cells per planet (about 170 000 km² each) only, or add Orbis-style sub-cells | Add one sub-cell layer later, as data only | Orbis Terrarum already specifies an 18–34 sub-cell subdivision; it fits the hierarchy in section 4 without touching the renderer. |

---

## 1. Current state

### 1.1 What exists

| Part | Location | State |
| --- | --- | --- |
| Web POC (three.js r128) | `web/` | Runs; three terrain passes plus a 2D sprite layer and map lenses. Verified only in headless Chromium with software rendering. |
| Godot 4 project | repo root (`scripts/`, `shaders/`) | Never run. Has the first-generation renderer (faceted cells, uniform terraces). Three passes behind `web/`. |
| Orbis Terrarum | separate repo, read-only reference | 2D cartographic engine (React, canvas, three for the globe); universe → galaxy → orrery → globe → atlas → sub-cells; lenses, fog of war, baked binary schema. About 35 000 lines. |

### 1.2 Pipeline of the web POC (confirmed by reading the code)

1. `worldgen.js`: 3000 spherical Voronoi cells → plates → elevation → climate → rivers →
   biomes. Then `surface(direction)`: one continuous height function (kernel blend of
   cells, hills, ridges, tablelands, gullies, carved river channels) used by everything.
2. `planetview.js`: far view is one sphere with a baked 2048×1024 map. Near view streams
   **one mesh group per Voronoi cell** as a triangle fan, at three levels of detail
   (40 / 16 / 8 subdivisions) chosen by distance, with skirts to hide gaps between levels.
   Cells are built on the main thread, sliced to 7 ms per frame.
3. `shaders.js`: all lighting is hand-written (three's lights and shadows are not used);
   a 2048² shadow map is re-rendered every frame; ground materials are several layers of
   procedural noise evaluated per pixel.
4. `vegetation.js`: nine kinds, each one instanced mesh for the whole near field.
5. `strategic.js`: one billboard batch from one runtime-drawn atlas.
6. `main.js`: one global state object, camera rig, time, HUD. The star and other planets
   are placed around the home planet on a compressed, non-physical scale.

### 1.3 Measurements so far

All from software rendering, so only the counts are meaningful, not the frame rates.

| Metric | Value |
| --- | --- |
| Triangles per frame, close views | 0.58–1.35 million (includes the shadow pass) |
| Triangles per frame, map altitude | 1.11–1.47 million |
| Draw calls | 310–500 close, 660–770 at map altitude |
| Cell build cost | 10–26 ms average; finest level 120–470 ms per cell (inflated by parallel test runs) |
| Globe bake | about 2 s |
| Real-GPU frame time, memory growth, 1 % lows | **Unmeasured** |

---

## 2. Task 1 — terrain artefacts and map quality

Priority order follows the brief: geometry, then rivers and cliffs, then vegetation, then
materials and lighting.

### 2.1 Mesh artefacts

| Symptom | Root cause | Evidence | Fix | How it is verified |
| --- | --- | --- | --- | --- |
| Dark seams, overlapping slivers and lighting breaks between neighbouring cells | Neighbours at different levels of detail do not share edge vertices; skirts hide the gap instead of closing it | Confirmed (skirts exist for exactly this; "skirt shading seams" was fixed twice) | **Edge stitching**: the vertex count along a shared edge is decided by the edge (from its midpoint distance), so both cells build identical edge vertices. Then delete skirts. | Automated: for every loaded shared edge, the two cells' edge vertices match bit-for-bit. Visual: render over a magenta clear colour and count magenta pixels inside the land silhouette (must be zero). |
| Shading changes across a level-of-detail boundary | Normals come from finite differences whose step depends on the level | Confirmed | Compute normals from `surface()` at one fixed world-space step, independent of mesh level | Automated: normals at shared vertices agree within 1°. |
| Faceted, sharp triangles on steep faces and mountains | (a) cliff risers are narrower than the vertex spacing, so one row of triangles spans the whole wall; (b) the shader switches to the raw triangle normal on steep faces | Confirmed in the mountain and mesa screenshots | (a) Clamp riser width to at least 1.5× the local vertex spacing at each level, so a wall always has interior vertices. (b) Remove the triangle-normal switch once (a) holds. (c) Slide grid rows toward the rim line so a vertex row sits on the break of slope. | Automated: maximum triangle aspect ratio and maximum height step between adjacent vertices, per level, under set limits. |
| Thin triangles converging on each cell's centre | Fan triangulation from the site | Confirmed by construction | Short term: none needed (they are small). Long term: removed by quadtree chunks (D2). | — |
| Small grey pit near a river mouth | Channel carved below sea level where the coast is further out than the cell edge | Confirmed (reduced, one left) | Clamp the bed to sea level along the last segment and fade the channel into a delta fan inside the sea cell | Automated: no land vertex below sea level that is not connected to the sea through below-sea vertices. |
| Ice caps render faceted and plain white | Finest level still too coarse for ridged noise amplitude there; no rock exposure rule on ice | Confirmed | Limit ridged-noise frequency to what the level can represent (band-limit by level); separate ice-sheet material (smooth, blue-tinted, crevasses) from snow on rock | Screenshot preset on an ice cap. |

Intentional cliffs, plateaus and mountains are kept: every fix above changes how they are
sampled and shaded, not whether they exist.

### 2.2 Rivers and water

Root cause of most river problems (confirmed): the river is two separate things that only
roughly agree — a channel carved into the height function, and a flat ribbon mesh laid
along the path "wide enough to reach the banks", lifted slightly at distance where coarse
cells cannot show the channel.

| Symptom | Fix |
| --- | --- |
| Banks cut through water; water floats or leaves gaps | **One representation.** Drop the ribbon. Draw river water with the terrain grid itself: same vertices, height set to the river's water level, shown where the channel mask is non-zero (the sea already works this way). The shoreline is then the exact intersection at every level of detail. |
| Sharp turns, per-cell kinks | Build each river once, globally, as one smooth spline through its cell-crossing points (centripetal Catmull–Rom, resampled by arc length). Channel distance and flow direction come from that spline, not from per-cell Béziers. |
| Sudden width changes | Width is a function of discharge smoothed along arc length; at confluences blend over a fixed length. Keep the pools-and-narrows noise but bound its rate of change. |
| Water running uphill or stepping | Already prevented for the bed (never rises downstream). Add the test: water level is monotone along every river; at tableland rims, mark the drop as a waterfall segment instead of a slope. |
| Flat, uniform water | Depth from bed to surface drives colour and opacity; flow-aligned ripples from the spline tangent; foam at waterfalls and narrows. |
| Visibility from a strategy camera | Minimum on-screen width: below about 2 px, widen the *shading* (not the carve) so rivers stay readable at map altitude. |

Verification: automated checks for monotone water level, minimum bank clearance (bank top
above water everywhere along the spline) and no land vertex below water outside the
channel mask; screenshot presets at a confluence, a canyon, a river mouth and a waterfall.

### 2.3 Cliffs and elevation transitions

- **Stretching**: cliff materials already avoid mesh coordinates (strata follow height,
  streaks follow direction). Keep that; the stretched look comes from geometry
  (section 2.1, riser clamp and rim-aligned rows).
- **Strata repetition**: replace the periodic band function with a per-region stratigraphic
  column (a short seeded list of layer thicknesses, hardness and colours) so bands are
  irregular and consistent across a whole mesa.
- **Consistent heights**: quantise tableland step heights per region to two or three
  values, so neighbouring mesas line up like real caprock.
- **Transitions**: scree apron width proportional to cliff height; grass may overhang the
  lip by a noise-broken margin; sand only below the bank line near water.
- **Spikes**: cap the gradient of the combined height function after all layers are added
  (a final slope limiter), exempting marked cliff risers.

### 2.4 Materials

- One texel density for every ground layer, defined in metres, so detail scale is the same
  on every biome and slope.
- Blend by slope, height above water, climate, curvature and ambient occlusion (already in
  place); add a transition band rule so no two materials meet in a straight line.
- Replace the most expensive per-pixel noise (cellular cracks, pebbles) with small tiling
  noise textures generated at startup. This is a performance change (section 3.4) but also
  removes the grazing-angle breakup, because textures get mip-mapping for free.
- Palette discipline for sprite readability: see 2.7.

### 2.5 Vegetation

Root cause of floating, buried and shifting plants (confirmed by design): instances are
placed on the *drawn triangles* of the two finest levels, so positions depend on which
level a cell happens to be at.

| Problem | Fix |
| --- | --- |
| Floating, buried, moving when level changes | Place from `surface()` directly, at a fixed sampling density per cell, seeded by cell id. Position and normal never depend on the mesh. Cache per cell. |
| On cliffs, in rivers, on steep slopes | Reject by slope from the surface normal (per-kind limit), by channel mask with a bank margin, and by cliff-riser mask. |
| Uniform spacing or visible repetition | Blue-noise (Poisson-disc) candidates per cell, thinned by a density field = biome density × low-frequency clearing noise × moisture × distance-to-river bonus. Per-instance variation in scale, lean, hue. |
| Alignment | Trees stay vertical (radial), shrubs and rocks tilt partly to the slope. |

Verification: automated — every instance's base is within a small tolerance of `surface()`
at its position; none inside a channel mask; slope under the kind's limit. The low-poly
vegetation style is kept.

### 2.6 Lighting and shadows

- Web: the custom shadow map stays for now. Stabilise it (fit to the visible near field,
  two cascades instead of one 2048² map) and soften contact; raise the fill so vegetation
  is not near-black in shadow; one ambient-occlusion convention shared by terrain and
  objects.
- Godot: delete all of the above and use the engine's directional shadows, ambient light
  and SSAO; only `ALBEDO`, `ROUGHNESS`, `AO`, `NORMAL` are written.
- No bloom or heavy grading; tone mapping only.

### 2.7 Rules that keep 2D sprites readable on the 3D stage

- Terrain stays in a restrained value and saturation range; the brightest and most
  saturated colours are reserved for sprites, borders and markers.
- Sprites: nearest-neighbour sampling, alpha test (no soft edges), a dark outline in the
  art, and on-screen size snapped to whole multiples of the source texel at each zoom tier.
- Depth: sprites test against terrain depth but are pulled slightly toward the camera so a
  hill never slices a unit in half; within the batch they are sorted back to front.
- Shadows: sprites do not receive terrain shadows; each gets a flat contact blob.
- Terrain shaders never write emissive or fog that could wash out a sprite.

### 2.8 Regression harness (built before the fixes)

- Fixed seeds and named camera presets (canyon, confluence, river mouth, mesa rim,
  mountain, ice cap, forest, coast, level-of-detail boundary, map altitude, globe).
- Numeric checks listed in the tables above, runnable in Node without a browser where they
  only need `worldgen.js`.
- A determinism hash of the per-cell world data per seed; it must not change through
  Task 1 (map generation behaviour is preserved; only the sub-cell surface and rendering
  change).

---

## 3. Task 2 — performance

Rule for this task: measure first, on real hardware, and report only what was measured.

### 3.1 Phase 1 — instrumentation and baseline (must run on your machine)

- **In-page profiler overlay**: frame time (average, 99th percentile, 1 % low), CPU time
  split (cell building, vegetation rebuild, culling, HUD), GPU time where the browser
  exposes timer queries, draw calls, triangles, loaded cells by level, JS heap.
- **Benchmark mode** (`?bench=name`): scripted, repeatable camera paths at a fixed
  resolution that write a JSON result. Scenes: close / medium / far zoom; sparse desert and
  dense forest; fast pan; rapid zoom in and out; 5-minute soak for memory growth; sprite
  stress (10 000 tokens).
- Baseline run on the target hardware (D3) before any change. Every later change is
  compared against it.

### 3.2 Bottlenecks, ranked by expected impact

| Rank | Bottleneck | Evidence | Kind |
| --- | --- | --- | --- |
| 1 | Cell meshes built on the main thread (up to hundreds of ms per fine cell) → stutter while panning | Confirmed cost; stutter suspected | CPU spikes |
| 2 | Ground shader: many noise layers per pixel (cellular, ridged, fbm at three scales) | Suspected, likely the main GPU cost on integrated GPUs | GPU fill |
| 3 | Shadow pass re-renders all casters every frame, roughly doubling triangles | Confirmed | GPU vertex |
| 4 | One mesh group per cell × terrain, water, border, river → 300–770 draw calls | Confirmed | CPU/driver |
| 5 | No frustum culling; only a horizon test, so everything loaded behind the camera is drawn | Confirmed (`frustumCulled = false` everywhere) | GPU vertex |
| 6 | Vegetation buffers rebuilt and re-uploaded for the whole near field when cells change | Confirmed (throttled to 250 ms) | CPU spikes |
| 7 | `surface()` re-evaluated from scratch for every vertex, probe and plant | Confirmed | CPU |
| 8 | Per-frame vector allocations in the frame loop and camera rig | Confirmed (small) | GC |
| 9 | 2 s globe bake and world generation on the main thread at load | Confirmed | load time |

### 3.3 Terrain (phases 2 and 7 of the brief)

- **Background generation**: move `surface()` evaluation and mesh assembly to workers
  (web) / `WorkerThreadPool` (Godot); the main thread only uploads finished buffers.
- **Chunks and level of detail** (D2): cube-sphere quadtree, fixed vertex grid per chunk,
  split by screen-space error with hysteresis; neighbours differ by at most one level and
  shared edges are stitched, so no cracks and no skirts.
- **Caching**: per-chunk height tiles in an LRU cache with a memory budget; meshes,
  normals, ambient occlusion and vegetation derive from the tile, so `surface()` runs once
  per sample.
- **Culling**: per-chunk bounding spheres that include the vertical displacement, tested
  against the frustum and the horizon.
- **Dirty regions**: sea level, season and flooding stay shader uniforms (already true).
  Real terrain edits invalidate only the chunks whose tiles they touch.
- **Shared materials**: one terrain material, one water material; no per-chunk variants.

### 3.4 Shading

- Replace per-pixel procedural noise with a few small tiling noise textures generated at
  startup; keep procedural only for the two lowest-frequency layers.
- Drop detail layers by distance in the shader (they are already faded out there, but
  still computed).
- Shadow map: update only when the sun or the focus has moved past a threshold; two
  cascades; exclude grass tufts and distant chunks. In Godot, engine cascades.

### 3.5 Vegetation (phase 3)

- Per-chunk instance buffers, built with the chunk and never rebuilt globally.
- Three distance bands: full instances near; thinned (stable, hash-ordered so plants do not
  flicker) at mid range; beyond that no instances at all, forests shown by a **canopy
  layer in the terrain shader** (darker, bumpier ground where tree density is high).
- Cross-fade bands by dithered scale to avoid popping.

### 3.6 Sprites, borders and overlays (phases 4 and 5)

- Units: one atlas, one instanced batch (already so). Add aggregation by zoom tier: far =
  one strategic marker per army; medium = formation icon; close = individual figures.
  Aggregation is a view decision only; the simulation holds one army record either way.
- Animation: frame index computed in the shader from time and a per-instance offset; no
  per-sprite updates on the CPU.
- **Province overlays from an ID map**: a province-ID texture (already implied by the
  baked globe map) plus a small palette lookup texture. Political colours, selection and
  highlights become a lookup; changing an owner updates one texel. Border lines come from
  ID discontinuities in the shader at far zoom and from cached per-chunk ribbons up close.
  Nothing is rebuilt per frame.
- Labels: pooled, decluttered on a timer (not every frame), cached until the camera moves.

### 3.7 Zoom tiers (phase 6)

| Tier | Terrain | Vegetation | Units | Overlays |
| --- | --- | --- | --- | --- |
| Close | finest chunks, full materials, shadows | full instances | individual 2D figures | settlements, roads, paths |
| Medium | mid chunks, reduced detail layers | thinned instances + canopy | formation icons | province borders, labels |
| Far | coarse chunks → baked globe | canopy only | strategic markers | political fill, realm borders |

Tier changes use hysteresis (enter and leave thresholds differ by about 15 %) and
cross-fades; panning and zooming never regenerate world data.

### 3.8 Memory and simulation (phases 8 and 9)

- Pool typed arrays for chunk buffers; budgets for the chunk cache and for GPU buffers;
  soak test asserts the heap is flat after warm-up.
- Remove per-frame allocations in the frame loop.
- No simulation exists yet. Its design (fixed tick, decoupled from frame rate) is in
  section 4.6; this task only reserves a per-frame time budget for it.

### 3.9 Targets and validation (phase 10)

Configurable goals, on the hardware chosen in D3: 16.7 ms average frame, 1 % low above
45 fps, no frame over 33 ms while panning, under 200 draw calls and under 600 000
triangles at any zoom, flat memory over a 5-minute soak. Every optimisation lands with a
before/after benchmark result and the section 2.8 regression checks.

---

## 4. Task 3 — multi-scale engine

Design for Galaxy → Star system → Planet → Continent → Province → Local terrain. This is
the design; the only code proposed for the first step is the vertical slice in 4.10.

### 4.1 What blocks scaling today (confirmed)

- One global mutable state object in `main.js`; one planet and one system assumed.
- Seeds derived ad hoc (`seed * 7919 + 13`), and some random draws depend on iteration
  order, so nothing can be generated in isolation by identity.
- World data, derived caches and renderer objects live in the same objects.
- The star and planets are positioned in a made-up compressed space around the planet;
  there is no physical coordinate anywhere above the planet surface.
- Whole-planet generation is eager (fine at 3000 cells, not as a pattern for a galaxy).

Reusable as they are: the planet generator's steps, the Kepler orbit code, the surface
function, the planet renderer, the sprite batch.

### 4.2 Four layers, strictly separated

| Layer | Contents | Saved? | Depends on camera? |
| --- | --- | --- | --- |
| **Base** | Pure functions of (master seed, generator version, object ID) → star, orbit, planet, cell data | No — regenerated | No |
| **Delta** | Player and simulation changes to base objects (ownership, renames, terraforming, depleted resources) | Yes | No |
| **Simulation** | Armies, fleets, economies, event queue, clocks | Yes | No |
| **View** | Meshes, sprites, textures, labels | No | Yes |

An object's existence in the game never depends on a view object existing for it.

### 4.3 Identity and seeds

- **Hierarchical 64-bit ID**: galaxy sector (24 bits: two signed 12-bit grid coordinates) ·
  system index in sector (12) · body index (8) · province (16) · reserved (4). Entities
  created during play (armies, fleets) get IDs from a saved counter, in a separate space.
- **Seed of a child** = hash(parent seed, child kind, child index). Never taken from a
  shared random stream, so any object can be generated alone, in any order.
- **Generator version** is stored in the save; a world keeps the generator it was created
  with.

### 4.4 Coordinates

| Scale | Representation | Precision |
| --- | --- | --- |
| Galaxy | integer sector coordinates + 64-bit float offset within the sector, in light-years | sub-millimetre irrelevant; exact sector identity |
| Star system | 64-bit float position relative to the star, in metres; orbits are analytic (Kepler elements + time) | millimetres at 100 AU |
| Planet surface | cube face + two fixed-point coordinates (or unit vector in 64-bit) + height in metres | centimetres |
| Rendering | 32-bit floats **relative to the camera's anchor** (floating origin): the anchor is the focused chunk, planet, star or sector depending on the view | no jitter, because rendered values stay small |

Conversions between levels are pure, deterministic functions with unit tests (round-trip
error bounds, identity at anchors). The compressed "display scale" used today for the
solar system becomes an explicit view mapping, separate from physical coordinates.

### 4.5 Views and level of detail

Separate view modules with their own scene, camera rig and unit scale; one heavy view is
live at a time and transitions cross-fade.

| View | Draws | Never loads |
| --- | --- | --- |
| Galaxy | stars as instanced points per sector, sector density sprites when far, borders, routes, fleet markers | any planet data |
| System | star, planets and moons as simple shaded spheres, orbit lines, stations, fleet sprites | planet surface meshes |
| Planet | baked globe map, province ID overlay, political fill | terrain chunks beyond the horizon |
| Terrain | existing terrain renderer, vegetation, 2D units | anything off-planet |

Level of detail is applied on six independent axes — geometry, representation (mesh →
sprite → marker → nothing), render frequency, simulation frequency, data residency,
animation — not one mesh mechanism.

### 4.6 Streaming and lifecycle

Every object's data moves through explicit states:

`Unknown → Described → Generated → Resident → Meshed`

- **Described**: a few bytes from the parent's generator (a star's class and planet count
  without generating the planets).
- **Generated / Resident**: base data in memory, in an LRU cache with a memory budget.
- **Meshed**: GPU resources exist.

Interest comes from two sources: the camera, and gameplay (player assets, active wars).
Requests are asynchronous and cancellable; eviction uses hysteresis so panning along a
boundary does not thrash. Evicting a view or base object never touches delta or
simulation state.

### 4.7 Simulation tiers

- Fixed integer tick, independent of frame rate. Random numbers are counter-based:
  hash(entity ID, tick, purpose), so results do not depend on update order or threading.
- **Active**: full per-tick updates (battles, the player's current theatre).
- **Coarse**: aggregated updates every N ticks (economies, distant fronts).
- **Abstract**: closed-form or event-driven. State is stored with a timestamp and advanced
  on demand (`state(t) = f(state(t0), t − t0)`), with future events in a time-ordered
  queue. Orbits are always analytic.
- **Tier assignment is by gameplay relevance, never by camera.** The test for this:
  the same seed and inputs with two different camera paths produce the same state hash.
- Tier changes go through a defined hand-over (aggregate ↔ expand) that conserves totals
  (population, stock, strength).

### 4.8 Movement and pathfinding

One graph per scale, joined at portals: galaxy (routes between systems), system (transfer
times between bodies from orbital geometry), planet (the province adjacency graph that
already exists as cell neighbours, with costs from terrain, rivers and season), local
(optional, inside a province). A long journey is planned top-down and refined only for
the leg being travelled; local search never crosses a province boundary.

### 4.9 Saves

Header (format version, generator version, master seed) · delta store keyed by ID ·
simulation state and event queue · entity ID counter. Untouched procedural objects are
never written. Stored per system so large saves can be written incrementally; migrations
are versioned functions; loading reconstructs base data from seeds and then applies
deltas.

### 4.10 Vertical slice (the first code to write)

Galaxy with 10 000 stars → pick one → its system → its habitable planet → a province on
its surface, and back, with:

- IDs and seed derivation as in 4.3; the existing system and planet generators called by ID;
- coordinate types and conversions from 4.4 with tests;
- lifecycle states from 4.6 for systems and planets;
- one delta (mark a province as owned) that survives leaving to the galaxy and returning,
  and a save/load round trip;
- a determinism test (state hash equal across camera paths).

### 4.11 Scale benchmarks

Galaxy sizes 10², 10³, 10⁴, 10⁵, 10⁶ systems. Measured: initial load, memory, galaxy-view
frame time, simulation tick duration at a fixed share of active systems, streaming
latency when opening a system, save and load time. Expected shapes to confirm or refute:
load and memory roughly constant in galaxy size (sectors generate on demand), galaxy-view
cost proportional to visible sectors, simulation cost proportional to active plus
scheduled entities. No scale is called supported until its row has been run.

### 4.12 What is deliberately not proposed

An entity-component-system rewrite, multithreaded simulation, or networking. Typed arrays
per cell already give a data-oriented layout where it matters; revisit only if the
simulation benchmark shows a need.

---

## 5. Sequence

| Step | Content | Exit criterion |
| --- | --- | --- |
| 1 | Regression harness and numeric checks (2.8) | Checks run; current failures are listed |
| 2 | Geometry: edge stitching, fixed-step normals, riser clamp, river-mouth fix (2.1) | Zero crack pixels; seam tests pass |
| 3 | Rivers as terrain-grid water on global splines (2.2); cliffs (2.3) | River tests pass; presets reviewed |
| 4 | Vegetation from `surface()` (2.5); materials and lighting polish (2.4, 2.6) | Placement tests pass |
| 5 | Profiler overlay and benchmark mode (3.1); **baseline on your hardware** | Baseline JSON recorded |
| 6 | Engine-neutral core: IDs, seeds, coordinates, layers, lifecycle, with tests (4.2–4.6) | Tests pass in Node |
| 7 | Vertical slice (4.10) in the web POC | Round trip and determinism tests pass |
| 8 | Godot port of the stabilised renderer on quadtree chunks (D1, D2) | Runs; regression presets match the web POC |
| 9 | Performance work in Godot against the benchmark (3.3–3.8) | Targets in 3.9 met or gaps reported |
| 10 | Simulation tiers, pathfinding, saves (4.7–4.9); scale benchmarks (4.11) | Benchmark table filled in |

Steps 5 and 6 are independent of 2–4 and can run in parallel with them.

## 6. Risks

- **Quadtree chunks (D2)** touch the mesh builder, vegetation and river water at once.
  Mitigation: do it at the port, behind the regression presets, with the cell-based
  builder kept until the new one matches.
- **Godot has never been run** in this project; the first run may surface basic errors
  unrelated to this plan.
- **Performance numbers are unknown** on real hardware; the ranking in 3.2 may change
  after the baseline.
- **Procedural textures vs. target art**: the reference images are hand-painted. Runtime
  noise textures will narrow the gap but not close it; authored tiling textures (which you
  said are easy to source for 3D) would, at the cost of the "everything procedural" rule.
- **Tier-invariant simulation** is the hardest design constraint in section 4; it needs
  its tests written before the first tiered system.
