---
name: map-export
description: Export a CS2 map's visual geometry from the user's installed game as a simplified triangle mesh coloured with the original materials' average colours (apps/app/public/maps/<map>.mesh.bin.gz), used by the viewer's 3D mode. Use when the user asks to "export a map", "gerar o mapa 3d/2.5d", "extrair a geometria do mapa", "/map-export <map>", or wants 3D data for a new map.
---

# Export a map for the 3D view

Turns a map's **visual** meshes (the `worldnodes/` models in the installed CS2
`.vpk`) into a small binary mesh the viewer draws in its **Visão 3D** mode
(`ViewerMap3D.vue`). Everything runs locally. No game texture is copied: each
surface gets one colour, the average of its ORIGINAL colour texture.

## What the user provides

- The **map name** (`de_dust2`, `de_nuke`, ...). It must have a `MAP_CALIBRATION`
  entry in `apps/app/src/viewer/domain/calibration.ts` (the script reads `posX`,
  `posY`, `scale` and the radar paths from it) and its radar PNG(s) must exist in
  `apps/app/public/maps/` (the radar's alpha marks the playable area). If not, add
  them first (see the Map radars section in CLAUDE.md).
- Optionally the **CS2 install dir** if it is not the default Steam path
  (`--cs2=<dir>` or env `CS2_DIR`).

## Steps

1. Run the exporter from the repo root (it re-launches itself with an 8 GB heap):

   ```bash
   node .claude/skills/map-export/export-map.mjs <map>
   ```

   Options: `--tris=250000` (triangle budget after simplification; 120000 halves the
   file), `--margin=250` (game units kept around the
   playable area; the radar's alpha marks it), `--error=0.05` (simplifier error cap),
   `--keep-edge=100` (triangles with an edge this long are never simplified away),
   `--probe=x,y` (debug: prints, per stage, the triangles covering that game point,
   to find where a hole comes from), `--cs2=<dir>`, `--cli=<Source2Viewer-CLI path>`.

   It downloads Source2Viewer-CLI (ValveResourceFormat) into
   `~/.cache/cs2d/map-export` on first use (linux-x64) and, per map, extracts to that
   cache (reused afterwards; dust2 is ~1.4 GB, first run ~1.5 min):
   - `world_physics` (glb): only used to find the **walkable floors** (see below) and
     a height cap;
   - every `worldnodes/*.vmdl_c` with its materials and textures (glb + png).

   Then it: converts glTF axes to game units (`game = (Z, X, Y) / 0.0254`); keeps
   triangles whose three corners are within `--margin` of the radar's opaque pixels; skips editor
   `tools/` and `effects/` materials; colours each material with the average colour
   of its colour texture (times `g_vColorTint`); classifies it (plaster / wood /
   metal / terrain / other, + see-through for glass and alpha-heavy textures) from
   the material name; welds and simplifies with the colour as an attribute
   (meshoptimizer); writes `apps/app/public/maps/<map>.mesh.bin.gz` (~1.6 MB).

2. **Look at it in the viewer**: run the app, open a replay of that map and turn on
   *Avançado → Visão 3D*. Sanity-check against the radar (no stray coloured or white
   patches, doors/props present, roof cut works). Report triangle count and file size.

3. Do NOT commit unless asked. The VPKs, extracted meshes and textures are Valve
   assets and stay in the cache dir; only the simplified `.mesh.bin.gz` (geometry +
   per-vertex average colours) belongs in the repo.

### Walkable floors and the roof cut

The viewer's roof-cut slider hides everything higher than N units above *the floor a
player could stand on beneath it*, so relief, ramps, bridges and multi-storey
buildings cut correctly. The exporter bakes that into every vertex (`height above
own floor`):

1. Samples the physics mesh per 16-unit column: up-facing surfaces (floor-like) and
   down-facing ones (ceiling-like).
2. Keeps the up-facing levels that have 64 units of headroom.
3. Flood-fills the levels reachable on foot (rise <= 26 units between neighbouring
   columns: stairs, ramps) from **where players really stood** in this map's replays
   (`replays/**/*.cs2dv` and `apps/app/public/replays/*.json`). Roofs are not
   reachable, so they are not floors; upper floors reached by stairs are. With no
   replay for the map it falls back to the lowest standable level of each playable
   column (less accurate: add a replay of that map and re-export).
4. A vertex's height is measured above the highest reachable floor at or below it
   within its 3x3 columns (walls sit on column borders); 0 where there is none (solid
   buildings stay whole).

## File format (`C2M3`, gzip)

`"C2M3" | u32 headerLen | header JSON | Int16 positions (x,y,z game units) | Uint32
indices | Uint8 RGB (sRGB) | Uint8 height above own floor`, each block padded to 4
bytes. The header holds `origin` (`posX`/`posY`/`scale`), `nv`/`ni`, `hStep` (game
units per height byte), `focusZ` and `groups` (`kind`, `translucent`, vertex and
index ranges). Reader:
`viewer/player/map3dGeometry.ts` (it sniffs the gzip magic, since some hosts
transparently gunzip `.gz`).

## Gotcha: the simplifier eats flat floors

A flat triangle on its own costs nothing to collapse, so meshoptimizer deletes big
isolated floor patches first (holes in the ground, seen on mirage). The exporter
locks the corners of every triangle with an edge >= `--keep-edge` (100 units), which
keeps them. If a hole shows up anyway, run with `--probe=x,y` at that point to see
whether the triangle exists in the source and at which stage it disappears; a point
with no triangle in the game's physics or visual meshes is just empty in the source.

## Known limitations

- One flat colour per material: the stone/plank/metal detail comes from procedural
  shader patterns in `ViewerMap3D.vue`, not from the original textures. Warm tones in
  the real game come from its lightmaps, which are not reproduced (the viewer uses a
  warm-tinted light instead).
- Static visual meshes only: baked static doors and props are there; entities that
  open, move or spawn at runtime are not.
- Aggressive simplification (~10x) rounds off small props.
- Fully solid buildings are drawn as solid blocks; only enterable buildings open up
  with the roof-cut slider (the cut is relative to each vertex's own walkable floor).
- Terrain "skirts" below the walkable area are not removed, so the camera is kept
  above the horizon.
- Linux/WSL only for the auto-downloaded CLI; pass `--cli` for another platform.
