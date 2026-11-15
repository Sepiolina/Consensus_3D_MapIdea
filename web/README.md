# Web POC

A browser version of the same proof of concept, used to iterate on the look and the
algorithms before porting them to the Godot project in the repository root.

Serve this folder with any static file server and open `index.html`:

```bash
python3 -m http.server 8000 --directory web
```

three.js (r128) is loaded from a CDN; there are no texture or model files.

## Mapping to Godot

Each file is the twin of a Godot script, with the same steps, names and units:

| Web | Godot | Notes |
| --- | --- | --- |
| `js/worldgen.js` | `scripts/world_gen.gd` | Pure data. Port line for line; `makeNoise` stands in for `FastNoiseLite`. |
| `js/solarsystem.js` | `scripts/solar_system.gd` | Pure data. |
| `js/planetview.js` | `scripts/planet_view.gd` | `BufferGeometry` → `ArrayMesh`, `InstancedMesh` → `MultiMesh`. Vertex data here is `adata` (height m, mean temp, seasonal amp, precip) and `acolor` (bedrock rgb, population); in Godot pack them into `UV`, `UV2` and `COLOR`. |
| `js/shaders.js` | `shaders/*.gdshader` | `COMMON` is `common.gdshaderinc`. Drop `lit()` and `tonemap()` in Godot and write `ALBEDO`, `ROUGHNESS`, `EMISSION` instead; the engine lights and tone-maps. |
| `js/main.js` | `scripts/main.gd` | Camera rig, time, orbits, input, HUD. |

Tuning made here that the Godot side does not have yet: sharper terrace steps
(`LEVEL_RAMP` 0.05, `SUB` 8, `RELIEF_MAX` 5.0), per-level tones, grassy banks with rock
only on multi-level drops, cloud shadows, the deeper colour palette, the sea-green
shelf in `water_color`, and the close-up ground texture (`ground_detail`: scrub clumps,
dry patches, rock outcrops, field patchwork, grain and a bumped normal). `ground_detail`
takes the pixel footprint (`length(fwidth(v_wpos))`) to fade out detail finer than a
pixel; in Godot that is `fwidth(VERTEX)` in the fragment shader.
