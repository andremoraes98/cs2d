#!/usr/bin/env node
/**
 * Exports a CS2 map's collision geometry as a compact, simplified triangle mesh
 * that the viewer renders in its 3D mode.
 *
 *   node .claude/skills/map-export/export-map.mjs <map> [--tris=120000]
 *        [--cs2=<CS2 install dir>] [--cli=<Source2Viewer-CLI>]
 *
 * Pipeline: <map>.vpk --Source2Viewer-CLI--> (a) world_physics glb: playable-area
 * walkable floors + height cap; (b) worldnodes glbs (the visual meshes with their
 * materials): each surface is coloured with the average colour of its ORIGINAL
 * colour texture, then everything is welded and simplified (meshoptimizer, colour
 * as an attribute) --> apps/app/public/maps/<map>.mesh.bin.gz
 * No texture is copied: only one average colour per material ends up in the file.
 *
 * The VPKs and the extracted meshes are Valve assets: they stay in the cache dir
 * (~/.cache/cs2d/map-export) and are never written into the repo. Only the
 * simplified mesh is.
 *
 * File layout (gzip of): "C2M3" | u32 headerLen | header JSON (padded to 4 bytes)
 *   | Int16 positions (x, y, z in game units; padded to 4 bytes) | Uint32 indices
 *   | Uint8 RGB colours (sRGB, padded to 4 bytes) | Uint8 height above own floor
 * The header gives the counts and each group's (kind, translucent) vertex/index range.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import v8 from 'node:v8'
import { spawnSync } from 'node:child_process'

// The visual meshes hold millions of triangles: re-run ourselves with a bigger heap.
if (v8.getHeapStatistics().heap_size_limit < 6 * 1024 ** 3 && !process.env.MAP_EXPORT_CHILD) {
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, MAP_EXPORT_CHILD: '1' },
  })
  process.exit(r.status ?? 1)
}

const args = process.argv.slice(2)
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : def
}
const flagEarly = flag
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const CAL_FILE = path.join(ROOT, 'apps/app/src/viewer/domain/calibration.ts')
const OUT_DIR = path.join(ROOT, 'apps/app/public/maps')
const CACHE = path.join(os.homedir(), '.cache/cs2d/map-export')
const S2V_VERSION = '20.1'
const DEFAULT_CS2 = '/mnt/c/Program Files (x86)/Steam/steamapps/common/Counter-Strike Global Offensive'
// Physics groups that are not visible/solid geometry for the viewer.
const SKIP_GROUP = /npcclip|playerclip|grenadeclip|sky|passbullets|unknown/
const RADAR_PX = 1024
const FLOOR_CELL = 16
/** Geometry farther than this (game units) from the playable area is dropped (skybox, terrain). */
const PLAYABLE_MARGIN = Number(flagEarly('margin', 250))
/** Geometry higher than this above the top playable floors is dropped. */
const MAX_ABOVE_FLOOR = 700
/** Triangles with an edge at least this long (game units) are never simplified away. */
const KEEP_EDGE = Number(flagEarly('keep-edge', 100))

const map = args.find((a) => !a.startsWith('--'))
if (!map) {
  console.error('usage: export-map.mjs <map> [--tris=120000] [--cs2=<dir>] [--cli=<path>]')
  process.exit(1)
}
const TRI_BUDGET = Number(flag('tris', 250000))
// Debug aid: --probe=x,y reports, per stage, the triangles whose XY footprint covers that point.
const PROBE = flag('probe', null)?.split(',').map(Number)
/** Triangles of (pos, idx) covering the probe point, as "z/z/z" strings. */
function probeHits(pos, idx) {
  if (!PROBE) return []
  const [px, py] = PROBE
  const hits = []
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const d = (pos[b + 1] - pos[c + 1]) * (pos[a] - pos[c]) + (pos[c] - pos[b]) * (pos[a + 1] - pos[c + 1])
    if (!d) continue
    const l1 = ((pos[b + 1] - pos[c + 1]) * (px - pos[c]) + (pos[c] - pos[b]) * (py - pos[c + 1])) / d
    const l2 = ((pos[c + 1] - pos[a + 1]) * (px - pos[c]) + (pos[a] - pos[c]) * (py - pos[c + 1])) / d
    if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) hits.push(`${Math.round(pos[a + 2])}/${Math.round(pos[b + 2])}/${Math.round(pos[c + 2])}`)
  }
  return hits
}
const cs2Dir = flag('cs2', process.env.CS2_DIR || DEFAULT_CS2)

// --- calibration: read the map's entry out of calibration.ts -------------------
function readCalibration() {
  const src = fs.readFileSync(CAL_FILE, 'utf8')
  const start = src.indexOf(`${map}: {`)
  if (start < 0) throw new Error(`no MAP_CALIBRATION entry for ${map} in calibration.ts`)
  let i = src.indexOf('{', start)
  let depth = 0
  const from = i
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) break
  }
  // The entry is a plain JS object literal (may hold Infinity and comments).
  return new Function(`return (${src.slice(from, i + 1)})`)()
}

// --- Source2Viewer-CLI ---------------------------------------------------------
function ensureCli() {
  const given = flag('cli', process.env.S2V_CLI)
  if (given) return given
  const dir = path.join(CACHE, `s2v-${S2V_VERSION}`)
  const bin = path.join(dir, 'Source2Viewer-CLI')
  if (fs.existsSync(bin)) return bin
  fs.mkdirSync(dir, { recursive: true })
  const url = `https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/${S2V_VERSION}/cli-linux-x64.zip`
  console.log(`downloading Source2Viewer-CLI ${S2V_VERSION}...`)
  execFileSync('curl', ['-sSfL', '-o', path.join(dir, 'cli.zip'), url])
  execFileSync('unzip', ['-q', '-o', path.join(dir, 'cli.zip'), '-d', dir])
  fs.chmodSync(bin, 0o755)
  return bin
}

function extractPhysics() {
  const vpk = path.join(cs2Dir, 'game/csgo/maps', `${map}.vpk`)
  if (!fs.existsSync(vpk)) throw new Error(`map VPK not found: ${vpk} (use --cs2=<install dir>)`)
  const out = path.join(CACHE, map)
  const glb = path.join(out, 'maps', map, 'world_physics_physics.glb')
  if (fs.existsSync(glb) && fs.statSync(glb).mtimeMs > fs.statSync(vpk).mtimeMs) return glb
  fs.mkdirSync(out, { recursive: true })
  console.log(`extracting ${map} physics...`)
  execFileSync(
    ensureCli(),
    ['-i', vpk, '-f', `maps/${map}/world_physics.vmdl_c`, '-o', out, '-d', '--gltf_export_format', 'glb'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  if (!fs.existsSync(glb)) throw new Error('extraction produced no world_physics_physics.glb')
  return glb
}

// --- glb reading ---------------------------------------------------------------
function loadGlb(file) {
  const b = fs.readFileSync(file)
  const jl = b.readUInt32LE(12)
  const json = JSON.parse(b.toString('utf8', 20, 20 + jl))
  const bin = b.subarray(20 + jl + 8)
  const accessor = (i) => {
    const a = json.accessors[i]
    const v = json.bufferViews[a.bufferView]
    const off = (v.byteOffset || 0) + (a.byteOffset || 0)
    const T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array }[a.componentType]
    const n = a.count * { SCALAR: 1, VEC3: 3 }[a.type]
    return new T(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + n * T.BYTES_PER_ELEMENT))
  }
  return { json, accessor }
}

const materialOf = (meshName) => meshName.replace(/^physics_group_?/, '') || 'default'

// --- weld + simplify -----------------------------------------------------------
async function loadSimplifier() {
  const req = createRequire(path.join(ROOT, 'apps/app/package.json'))
  const { MeshoptSimplifier } = await import(pathToFileURL(req.resolve('meshoptimizer')).href)
  await MeshoptSimplifier.ready
  return MeshoptSimplifier
}

/** Distance (game units) from a world point to the nearest playable radar pixel
 *  (0 inside). The radar's alpha marks the walkable area; fully transparent pixels
 *  are outside the map. Infinity beyond the radar's frame. */
async function playableDistance(cal) {
  const req = createRequire(path.join(ROOT, 'apps/app/package.json'))
  const { PNG } = req('pngjs')
  const radars = [cal.radar, ...(cal.levels ?? []).map((l) => l.radar).filter(Boolean)]
  const N = RADAR_PX
  const dist = new Float32Array(N * N).fill(Infinity)
  for (const r of new Set(radars)) {
    const png = PNG.sync.read(fs.readFileSync(path.join(ROOT, 'apps/app/public', r)))
    if (png.width !== N || png.height !== N) throw new Error(`${r} is not ${N}px`)
    for (let i = 0; i < N * N; i++) if (png.data[i * 4 + 3] > 24) dist[i] = 0
  }
  // Two-pass chamfer distance transform (pixels).
  const D = Math.SQRT2
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x
      let d = dist[i]
      if (x > 0) d = Math.min(d, dist[i - 1] + 1)
      if (y > 0) {
        d = Math.min(d, dist[i - N] + 1)
        if (x > 0) d = Math.min(d, dist[i - N - 1] + D)
        if (x < N - 1) d = Math.min(d, dist[i - N + 1] + D)
      }
      dist[i] = d
    }
  }
  for (let y = N - 1; y >= 0; y--) {
    for (let x = N - 1; x >= 0; x--) {
      const i = y * N + x
      let d = dist[i]
      if (x < N - 1) d = Math.min(d, dist[i + 1] + 1)
      if (y < N - 1) {
        d = Math.min(d, dist[i + N] + 1)
        if (x < N - 1) d = Math.min(d, dist[i + N + 1] + D)
        if (x > 0) d = Math.min(d, dist[i + N - 1] + D)
      }
      dist[i] = d
    }
  }
  return (x, y) => {
    const px = Math.floor((x - cal.posX) / cal.scale)
    const py = Math.floor((cal.posY - y) / cal.scale)
    return px >= 0 && py >= 0 && px < N && py < N ? dist[py * N + px] * cal.scale : Infinity
  }
}

/** Collects the triangles of every kept group, welded per material and clipped
 *  to the playable area. Returns materials: name -> { pos: number[], idx: number[] }. */
function collect(glb, inside) {
  const mats = new Map()
  const { json, accessor } = glb
  for (const m of json.meshes) {
    if (SKIP_GROUP.test(m.name)) continue
    const name = materialOf(m.name)
    let mat = mats.get(name)
    if (!mat) mats.set(name, (mat = { weld: new Map(), pos: [], idx: [] }))
    for (const p of m.primitives) {
      const pos = accessor(p.attributes.POSITION)
      const idx = p.indices != null ? accessor(p.indices) : null
      const nt = (idx ? idx.length : pos.length / 3) / 3
      const vert = (i) => {
        const x = Math.round(pos[i * 3]), y = Math.round(pos[i * 3 + 1]), z = Math.round(pos[i * 3 + 2])
        const key = `${x},${y},${z}`
        let id = mat.weld.get(key)
        if (id === undefined) {
          id = mat.pos.length / 3
          mat.pos.push(x, y, z)
          mat.weld.set(key, id)
        }
        return id
      }
      for (let t = 0; t < nt; t++) {
        const i0 = idx ? idx[t * 3] : t * 3
        const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1
        const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2
        // All three corners must be near the playable area, so huge terrain
        // triangles that merely have their centroid inside it are dropped.
        if (!inside(pos[i0 * 3], pos[i0 * 3 + 1]) || !inside(pos[i1 * 3], pos[i1 * 3 + 1]) || !inside(pos[i2 * 3], pos[i2 * 3 + 1])) continue
        const a = vert(i0), b = vert(i1), c = vert(i2)
        if (a === b || b === c || a === c) continue
        mat.idx.push(a, b, c)
      }
    }
  }
  for (const mat of mats.values()) delete mat.weld
  return mats
}

// --- walkable floors ------------------------------------------------------------
// The viewer's roof cut hides everything higher than N units above the surface a
// player could stand on beneath it. To know what is standable we sample the physics
// mesh per 16-unit column (up-facing = floor-like, down-facing = ceiling-like), keep
// the up-facing levels with enough headroom, and keep only those reachable on foot
// (stairs/ramps) from where players really walked in the repo's replays.
const STEP = 26 // largest rise between neighbouring walkable cells (stairs, ramps)
const HEADROOM = 64 // free height needed above a level to stand on it
const CLUSTER = 12 // up-facing samples closer than this form one level
const H_STEP = 4 // quantisation of the per-vertex height above floor
const TOL = 20 // a vertex this far below a level still counts as standing on it

const uniqueSorted = (a) => {
  a.sort((x, y) => x - y)
  return a.filter((v, i) => i === 0 || v !== a[i - 1])
}

function sampleColumns(mats, cal) {
  const n = Math.ceil((cal.scale * RADAR_PX) / FLOOR_CELL)
  const up = new Array(n * n).fill(null)
  const down = new Array(n * n).fill(null)
  const S = FLOOR_CELL / 2
  for (const { pos, idx } of mats.values()) {
    for (let t = 0; t < idx.length; t += 3) {
      const A = idx[t] * 3, B = idx[t + 1] * 3, C = idx[t + 2] * 3
      const e1x = pos[B] - pos[A], e1y = pos[B + 1] - pos[A + 1], e1z = pos[B + 2] - pos[A + 2]
      const e2x = pos[C] - pos[A], e2y = pos[C + 1] - pos[A + 1], e2z = pos[C + 2] - pos[A + 2]
      const nz = e1x * e2y - e1y * e2x
      const len = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, nz)
      if (!len) continue
      const dir = nz / len
      const list = dir >= 0.7 ? up : dir <= -0.5 ? down : null
      if (!list) continue
      const k = Math.min(100, Math.max(1, Math.ceil(Math.max(Math.hypot(e1x, e1y), Math.hypot(e2x, e2y)) / S)))
      for (let a = 0; a <= k; a++) {
        for (let c = 0; c <= k - a; c++) {
          const u = a / k, v = c / k
          const x = pos[A] + e1x * u + e2x * v
          const y = pos[A + 1] + e1y * u + e2y * v
          const z = pos[A + 2] + e1z * u + e2z * v
          const ci = Math.floor((x - cal.posX) / FLOOR_CELL)
          const cj = Math.floor((cal.posY - y) / FLOOR_CELL)
          if (ci < 0 || cj < 0 || ci >= n || cj >= n) continue
          const cell = cj * n + ci
          ;(list[cell] ??= []).push(Math.round(z / H_STEP) * H_STEP)
        }
      }
    }
  }
  return { n, up, down }
}

/** Per cell: the up-facing levels (top of each cluster) that have headroom. */
function buildLevels({ n, up, down }) {
  const levels = new Array(n * n).fill(null)
  for (let cell = 0; cell < n * n; cell++) {
    if (!up[cell]) continue
    const zs = uniqueSorted(up[cell])
    const ds = down[cell] ? uniqueSorted(down[cell]) : []
    const out = []
    for (let i = 0; i < zs.length; i++) {
      if (i + 1 < zs.length && zs[i + 1] - zs[i] <= CLUSTER) continue // not the top of its cluster
      const z = zs[i]
      if (!ds.some((d) => d > z + 8 && d < z + HEADROOM)) out.push(z)
    }
    if (out.length) levels[cell] = Int16Array.from(out)
  }
  return levels
}

/** Positions where players really were in this map's replays (repo + public previews). */
function loadSeeds(cal, n) {
  const files = []
  const walk = (d, re) => {
    if (!fs.existsSync(d)) return
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f, re)
      else if (re.test(e.name)) files.push(f)
    }
  }
  walk(path.join(ROOT, 'replays'), /\.cs2dv$/)
  walk(path.join(ROOT, 'apps/app/public/replays'), /\.json$/)
  const seen = new Set()
  const seeds = []
  let used = 0
  for (const f of files) {
    let replay
    try {
      const raw = fs.readFileSync(f)
      if (f.endsWith('.json')) replay = JSON.parse(raw.toString('utf8'))
      else {
        const b = zlib.gunzipSync(raw)
        let o = 6 // "CS2DV1"
        const rd = () => {
          const l = b.readUInt32LE(o)
          o += 4
          const d = b.subarray(o, o + l)
          o += l
          return d
        }
        rd() // meta
        replay = JSON.parse(rd().toString('utf8'))
      }
    } catch {
      continue
    }
    if (replay.map !== map) continue
    used++
    for (const round of replay.rounds ?? []) {
      for (let fi = 0; fi < (round.frames ?? []).length; fi += 3) {
        for (const p of round.frames[fi].players) {
          if (!p.alive) continue
          const ci = Math.floor((p.x - cal.posX) / FLOOR_CELL)
          const cj = Math.floor((cal.posY - p.y) / FLOOR_CELL)
          if (ci < 0 || cj < 0 || ci >= n || cj >= n) continue
          const key = `${cj * n + ci},${Math.round(p.z / 8)}`
          if (seen.has(key)) continue
          seen.add(key)
          seeds.push([cj * n + ci, p.z])
        }
      }
    }
  }
  console.log(`seeds: ${seeds.length} walked cells from ${used} replay(s) of ${map}`)
  return seeds
}

/** Flood-fills the standable levels from the seeds across stairs and ramps. */
function findReachable(levels, n, seeds, isPlayable) {
  const reach = levels.map((l) => (l ? new Uint8Array(l.length) : null))
  const queue = []
  const mark = (cell, k) => {
    if (reach[cell][k]) return
    reach[cell][k] = 1
    queue.push(cell, k)
  }
  if (seeds.length) {
    for (const [cell, z] of seeds) {
      const lv = levels[cell]
      if (!lv) continue
      let best = -1
      for (let k = 0; k < lv.length; k++) if (Math.abs(lv[k] - z) <= 48 && (best < 0 || Math.abs(lv[k] - z) < Math.abs(lv[best] - z))) best = k
      if (best >= 0) mark(cell, best)
    }
  } else {
    // No replay for this map: assume the lowest standable level of each playable column.
    for (let cell = 0; cell < n * n; cell++) if (levels[cell] && isPlayable(cell)) mark(cell, 0)
  }
  for (let q = 0; q < queue.length; q += 2) {
    const cell = queue[q], z = levels[cell][queue[q + 1]]
    const cx = cell % n, cy = (cell - cx) / n
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = cx + dx, y = cy + dy
      if (x < 0 || y < 0 || x >= n || y >= n) continue
      const nc = y * n + x
      const lv = levels[nc]
      if (!lv) continue
      for (let k = 0; k < lv.length; k++) if (Math.abs(lv[k] - z) <= STEP) mark(nc, k)
    }
  }
  return reach
}

/** Height of a vertex above the highest reachable floor at or below it, looking at
 *  its column and the 8 around it (walls sit on a cell border). 0 when none. */
function heightAboveFloor(levels, reach, n, cal, x, y, z) {
  const ci = Math.floor((x - cal.posX) / FLOOR_CELL)
  const cj = Math.floor((cal.posY - y) / FLOOR_CELL)
  let best = -Infinity
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const i = ci + di, j = cj + dj
      if (i < 0 || j < 0 || i >= n || j >= n) continue
      const lv = levels[j * n + i]
      if (!lv) continue
      const r = reach[j * n + i]
      for (let k = 0; k < lv.length; k++) if (r[k] && lv[k] <= z + TOL && lv[k] > best) best = lv[k]
    }
  }
  return best === -Infinity ? 0 : Math.max(0, z - best)
}

// --- visual meshes (worldnodes) -------------------------------------------------
function extractVisual() {
  const vpk = path.join(cs2Dir, 'game/csgo/maps', `${map}.vpk`)
  const out = path.join(CACHE, map, 'visual')
  const marker = path.join(out, '.done')
  if (fs.existsSync(marker) && fs.statSync(marker).mtimeMs > fs.statSync(vpk).mtimeMs) return out
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  console.log('extracting visual meshes + materials (about a minute)...')
  execFileSync(
    ensureCli(),
    ['-i', vpk, '-f', `maps/${map}/worldnodes/`, '-e', 'vmdl_c', '-o', out, '-d', '--threads', '4', '--gltf_export_format', 'glb', '--gltf_export_materials'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  fs.writeFileSync(marker, '')
  return out
}

/** Procedural-texture family the viewer's shader applies on top of the colour. */
const KIND = { plaster: 0, wood: 1, metal: 2, terrain: 3, other: 4 }
function classify(vmatName) {
  const n = vmatName.toLowerCase()
  if (/glass|window/.test(n)) return { kind: KIND.other, glass: true }
  if (/wood|plank|door|crate|pallet|barrel|bench|table|chair|shelf/.test(n)) return { kind: KIND.wood }
  if (/metal|rust|iron|steel|pipe|vent|wire|fence|tin|ac_unit|dumpster|vehicle|car_/.test(n)) return { kind: KIND.metal }
  if (/ground|dirt|sand|rock|terrain|cliff|gravel|grass|plant|foliage|palm|tree|bush|cloth|tarp|rug|carpet/.test(n)) return { kind: KIND.terrain }
  if (/stone|plaster|wall|brick|concrete|arch|tile|dust_|roof|trim|floor|stairs|pillar|column/.test(n)) return { kind: KIND.plaster }
  return { kind: KIND.other }
}

const avgCache = new Map()
/** Average sRGB colour (0-255) of a PNG's opaque pixels, and its see-through fraction. */
async function averageColor(file) {
  let hit = avgCache.get(file)
  if (hit) return hit
  const req = createRequire(path.join(ROOT, 'apps/app/package.json'))
  const { PNG } = req('pngjs')
  try {
    const png = PNG.sync.read(fs.readFileSync(file))
    const step = Math.max(1, Math.floor(Math.min(png.width, png.height) / 128))
    let r = 0, g = 0, b = 0, n = 0, seeThrough = 0, total = 0
    for (let y = 0; y < png.height; y += step) {
      for (let x = 0; x < png.width; x += step) {
        const o = (y * png.width + x) * 4
        total++
        if (png.data[o + 3] < 128) { seeThrough++; continue }
        r += png.data[o]; g += png.data[o + 1]; b += png.data[o + 2]; n++
      }
    }
    hit = n ? { rgb: [r / n, g / n, b / n], seeThrough: seeThrough / total } : null
  } catch {
    hit = null
  }
  avgCache.set(file, hit)
  return hit
}

/** Open-addressing vertex welder keyed by (x, y, z, colour). */
class Welder {
  constructor() {
    this.cap = 1 << 20
    this.table = new Int32Array(this.cap).fill(-1)
    this.n = 0
    this.pos = []
    this.col = []
    this.k = new Int32Array(this.cap / 2 * 4)
  }
  grow() {
    this.cap *= 2
    this.table = new Int32Array(this.cap).fill(-1)
    const nk = new Int32Array(this.cap / 2 * 4)
    nk.set(this.k)
    this.k = nk
    for (let id = 0; id < this.n; id++) this.table[this.slot(this.k[id * 4], this.k[id * 4 + 1], this.k[id * 4 + 2], this.k[id * 4 + 3])] = id
  }
  slot(x, y, z, c) {
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(c, 2654435761)) >>> 0
    h &= this.cap - 1
    while (this.table[h] !== -1) {
      const id = this.table[h]
      const o = id * 4
      if (this.k[o] === x && this.k[o + 1] === y && this.k[o + 2] === z && this.k[o + 3] === c) return h
      h = (h + 1) & (this.cap - 1)
    }
    return h
  }
  add(x, y, z, c, rgb) {
    if (this.n * 2 >= this.cap) this.grow()
    const h = this.slot(x, y, z, c)
    let id = this.table[h]
    if (id === -1) {
      id = this.n++
      this.table[h] = id
      const o = id * 4
      this.k[o] = x; this.k[o + 1] = y; this.k[o + 2] = z; this.k[o + 3] = c
      this.pos.push(x, y, z)
      this.col.push(rgb[0], rgb[1], rgb[2])
    }
    return id
  }
}

/** Reads every worldnode glb and groups its triangles by (kind, see-through),
 *  coloured with the original materials' average colours. */
async function collectVisual(dir, distAt, zCap) {
  const groups = new Map()
  const group = (key) => {
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { weld: new Welder(), idx: [] }))
    return g
  }
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isDirectory()) walk(f)
      else if (f.endsWith('.glb')) files.push(f)
    }
  }
  walk(dir)
  let kept = 0, seen = 0
  for (const f of files) {
    const glb = loadGlb(f)
    const { json, accessor } = glb
    const mats = []
    for (const m of json.materials ?? []) {
      const vmatName = m.extras?.vmat?.Name ?? m.name ?? ''
      const uri = m.pbrMetallicRoughness?.baseColorTexture != null
        ? json.images?.[json.textures[m.pbrMetallicRoughness.baseColorTexture.index].source]?.uri
        : null
      const avg = uri ? await averageColor(path.join(path.dirname(f), uri)) : null
      const tint = m.extras?.vmat?.VectorParams?.g_vColorTint ?? [1, 1, 1]
      const cls = classify(vmatName)
      const rgb = avg
        ? avg.rgb.map((v, i) => Math.max(0, Math.min(255, Math.round(v * Math.min(1, tint[i] ?? 1)))))
        : [160, 160, 160]
      // Editor tool brushes (block light, nodraw...) and particle/light-shaft effects are not geometry.
      const hidden = /(^|\/)(tools|effects)\//i.test(vmatName)
      mats.push({ rgb, cls, hidden, see: !!avg && avg.seeThrough > 0.3 })
    }
    for (const m of json.meshes ?? []) {
      for (const p of m.primitives) {
        const mat = mats[p.material] ?? { rgb: [160, 160, 160], cls: { kind: KIND.other }, see: false }
        if (mat.hidden) continue
        const g = group(`${mat.cls.kind}|${mat.cls.glass || mat.see ? 1 : 0}`)
        const colorKey = (mat.rgb[0] << 16) | (mat.rgb[1] << 8) | mat.rgb[2]
        const pos = accessor(p.attributes.POSITION)
        const idx = p.indices != null ? accessor(p.indices) : null
        const nt = (idx ? idx.length : pos.length / 3) / 3
        // glTF (X, Y, Z) in metres  ->  game (x, y, z) = (Z, X, Y) / 0.0254
        const gx = (i) => pos[i * 3 + 2] / 0.0254
        const gy = (i) => pos[i * 3] / 0.0254
        const gz = (i) => pos[i * 3 + 1] / 0.0254
        for (let t = 0; t < nt; t++) {
          const i0 = idx ? idx[t * 3] : t * 3
          const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1
          const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2
          seen++
          if ((gz(i0) + gz(i1) + gz(i2)) / 3 > zCap) continue
          // All three corners must be near the playable area, so huge terrain
          // triangles that merely touch it are dropped.
          if (distAt(gx(i0), gy(i0)) > PLAYABLE_MARGIN || distAt(gx(i1), gy(i1)) > PLAYABLE_MARGIN || distAt(gx(i2), gy(i2)) > PLAYABLE_MARGIN) continue
          const a = g.weld.add(Math.round(gx(i0)), Math.round(gy(i0)), Math.round(gz(i0)), colorKey, mat.rgb)
          const b = g.weld.add(Math.round(gx(i1)), Math.round(gy(i1)), Math.round(gz(i1)), colorKey, mat.rgb)
          const c = g.weld.add(Math.round(gx(i2)), Math.round(gy(i2)), Math.round(gz(i2)), colorKey, mat.rgb)
          if (a === b || b === c || a === c) continue
          g.idx.push(a, b, c)
          kept++
        }
      }
    }
  }
  console.log(`visual: ${files.length} models, ${seen} triangles, ${kept} in the playable area`)
  return groups
}

// --- main ----------------------------------------------------------------------
const cal = readCalibration()
const glb = loadGlb(extractPhysics())
const distAt = await playableDistance(cal)
const mats = collect(glb, (x, y) => distAt(x, y) <= PLAYABLE_MARGIN)
const cols = sampleColumns(mats, cal)
const levels = buildLevels(cols)
const gridN = cols.n
const seeds = loadSeeds(cal, gridN)
const reach = findReachable(levels, gridN, seeds, (cell) =>
  distAt(cal.posX + ((cell % gridN) + 0.5) * FLOOR_CELL, cal.posY - (Math.floor(cell / gridN) + 0.5) * FLOOR_CELL) === 0,
)
let zCap = Infinity
let focusZ = 0
{
  const zs = []
  for (let c = 0; c < gridN * gridN; c++) if (levels[c]) for (let k = 0; k < levels[c].length; k++) if (reach[c][k]) zs.push(levels[c][k])
  zs.sort((x, y) => x - y)
  const q = (f) => zs[Math.floor(zs.length * f)]
  console.log(`reachable floor levels: ${zs.length}; z p1 ${q(0.01)} p50 ${q(0.5)} p99 ${q(0.99)}`)
  focusZ = q(0.5)
  // Skybox spires/antennas far above the playable floors are not worth the triangles.
  zCap = q(0.99) + MAX_ABOVE_FLOOR
}

const groups = await collectVisual(extractVisual(), distAt, zCap)
const simplifier = await loadSimplifier()
let total = 0
for (const g of groups.values()) total += g.idx.length / 3
const ratio = Math.min(1, TRI_BUDGET / total)
console.log(`${total} triangles to simplify, target ratio ${ratio.toFixed(3)}`)

const positions = []
const indices = []
const colors = []
const heights = []
const outGroups = []
for (const [key, g] of [...groups].sort((a, b) => b[1].idx.length - a[1].idx.length)) {
  const [kind, glass] = key.split('|').map(Number)
  const idx = Uint32Array.from(g.idx)
  const pos = Float32Array.from(g.weld.pos)
  if (PROBE) console.log(`probe kind ${kind}${glass ? ' see-through' : ''}: before simplify`, probeHits(pos, idx))
  const col = Float32Array.from(g.weld.col, (v) => v / 255)
  // Height of every vertex above its own walkable floor (for the viewer's roof cut).
  const hv = new Uint8Array(g.weld.n)
  for (let v = 0; v < g.weld.n; v++) {
    const h = heightAboveFloor(levels, reach, gridN, cal, g.weld.pos[v * 3], g.weld.pos[v * 3 + 1], g.weld.pos[v * 3 + 2])
    hv[v] = Math.min(255, Math.round(h / H_STEP))
  }
  let out = idx
  if (ratio < 1 && idx.length > 90) {
    const target = Math.max(3, Math.floor((idx.length * ratio) / 3) * 3)
    // A flat triangle on its own costs nothing to collapse, so the simplifier would
    // delete big floor patches first (holes in the ground): lock the corners of every
    // large triangle so it survives.
    const lock = new Uint8Array(g.weld.n)
    let locked = 0
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
      const edge = Math.max(
        Math.hypot(pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]),
        Math.hypot(pos[b] - pos[c], pos[b + 1] - pos[c + 1], pos[b + 2] - pos[c + 2]),
        Math.hypot(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]),
      )
      if (edge >= KEEP_EDGE) {
        lock[idx[t]] = lock[idx[t + 1]] = lock[idx[t + 2]] = 1
        locked++
      }
    }
    if (locked) console.log(`  kind ${kind}${glass ? ' see-through' : ''}: ${locked} large triangles kept as they are`)
    out = simplifier.simplifyWithAttributes(idx, pos, 3, col, 3, [0.6, 0.6, 0.6], lock, target, Number(flag('error', 0.05)))[0]
  }
  if (PROBE) console.log(`probe kind ${kind}${glass ? ' see-through' : ''}: after simplify `, probeHits(pos, out))
  const remap = new Map()
  const vStart = positions.length / 3
  const iStart = indices.length
  for (const i of out) {
    let id = remap.get(i)
    if (id === undefined) {
      id = positions.length / 3
      remap.set(i, id)
      positions.push(g.weld.pos[i * 3], g.weld.pos[i * 3 + 1], g.weld.pos[i * 3 + 2])
      colors.push(g.weld.col[i * 3], g.weld.col[i * 3 + 1], g.weld.col[i * 3 + 2])
      heights.push(hv[i])
    }
    indices.push(id)
  }
  if (out.length) outGroups.push({ kind, translucent: glass === 1, vStart, vCount: positions.length / 3 - vStart, iStart, iCount: out.length })
  console.log(`  kind ${kind}${glass ? ' see-through' : ''}`.padEnd(28) + `${String(idx.length / 3).padStart(8)} -> ${out.length / 3}`)
}

const header = Buffer.from(
  JSON.stringify({
    version: 3,
    map,
    origin: { posX: cal.posX, posY: cal.posY, scale: cal.scale },
    nv: positions.length / 3,
    ni: indices.length,
    hStep: H_STEP,
    focusZ,
    groups: outGroups,
  }),
)
const padTo4 = (n) => Buffer.alloc((4 - (n % 4)) % 4)
const padded = Buffer.concat([header, Buffer.alloc((4 - (header.length % 4)) % 4, 0x20)])
const head = Buffer.alloc(8)
head.write('C2M3', 0, 'ascii')
head.writeUInt32LE(padded.length, 4)
const posBuf = Buffer.from(Int16Array.from(positions).buffer)
const colBuf = Buffer.from(Uint8Array.from(colors, (v) => Math.round(v)))
const raw = Buffer.concat([
  head,
  padded,
  posBuf,
  padTo4(posBuf.length),
  Buffer.from(Uint32Array.from(indices).buffer),
  colBuf,
  padTo4(colBuf.length),
  Buffer.from(Uint8Array.from(heights)),
])
fs.mkdirSync(OUT_DIR, { recursive: true })
const outFile = path.join(OUT_DIR, `${map}.mesh.bin.gz`)
fs.writeFileSync(outFile, zlib.gzipSync(raw, { level: 9 }))
const kb = (fs.statSync(outFile).size / 1024).toFixed(0)
console.log(`wrote ${path.relative(ROOT, outFile)} (${kb} KB; ${positions.length / 3} verts, ${indices.length / 3} tris)`)
