// Geometry for the 3D map view. Loads the per-map `<map>.mesh.bin.gz` (produced
// by the /map-export skill: the simplified visual mesh coloured with the original
// materials' average colours, plus each vertex's height above its walkable floor) into three.js geometries.
//
// Scene space: X = game X, Y = game Z (height), Z = -game Y, so the radar's
// top/north edge sits at the smallest Z. That mapping is a rotation, so triangle
// winding is preserved.
import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from 'three'

export const RADAR_PX = 1024

interface MeshHeader {
  version: 3
  map: string
  origin: { posX: number; posY: number; scale: number }
  nv: number
  ni: number
  /** Game units per step of the per-vertex height-above-floor byte. */
  hStep: number
  /** Typical floor height of the playable area (where the camera looks). */
  focusZ: number
  /** Triangles are grouped by procedural-texture `kind` and see-through-ness. */
  groups: { kind: number; translucent: boolean; vStart: number; vCount: number; iStart: number; iCount: number }[]
}

export interface MapMesh {
  header: MeshHeader
  /** Game-space positions (x, y, z), 3 per vertex. */
  positions: Int16Array
  indices: Uint32Array
  /** sRGB colour per vertex (3 bytes): the average of the original material's colour texture. */
  colors: Uint8Array
  /** Height of each vertex above the walkable floor beneath it (bytes, `hStep` units each). */
  heights: Uint8Array
}

const cache = new Map<string, Promise<MapMesh | null>>()
export function loadMapMesh(src: string): Promise<MapMesh | null> {
  let hit = cache.get(src)
  if (!hit) {
    hit = fetchMesh(src)
      .catch(() => null)
      // Never remember a failure (file not exported yet, network hiccup): the next
      // time the map is opened it is fetched again instead of staying blank until reload.
      .then((mesh) => {
        if (!mesh) cache.delete(src)
        return mesh
      })
    cache.set(src, hit)
  }
  return hit
}

async function fetchMesh(src: string): Promise<MapMesh | null> {
  const res = await fetch(src)
  if (!res.ok) return null
  // Some hosts transparently gunzip a `.gz` (Content-Encoding), others serve it
  // raw: sniff the gzip magic and only decompress ourselves when still packed.
  const raw = await res.arrayBuffer()
  const packed = new Uint8Array(raw, 0, 2)
  const buf =
    packed[0] === 0x1f && packed[1] === 0x8b
      ? await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
      : raw
  const dv = new DataView(buf)
  if (dv.getUint32(0, true) !== 0x334d3243) return null // "C2M3"
  const hl = dv.getUint32(4, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl))) as MeshHeader
  // Blocks after the header are each padded to 4 bytes.
  const align = (n: number) => (n + 3) & ~3
  let off = 8 + hl
  const positions = new Int16Array(buf, off, header.nv * 3)
  off = align(off + header.nv * 6)
  const indices = new Uint32Array(buf, off, header.ni)
  off += header.ni * 4
  const colors = new Uint8Array(buf, off, header.nv * 3)
  off = align(off + header.nv * 3)
  const heights = new Uint8Array(buf, off, header.nv)
  return { header, positions, indices, colors, heights }
}

// sRGB byte -> linear float, so vertex colours match three's colour management.
const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
})

/** Opaque and see-through geometries sharing one set of vertex attributes. */
export function buildGeometries(mesh: MapMesh): { solid: BufferGeometry; glass: BufferGeometry | null } {
  const { header, positions, indices, colors, heights } = mesh
  const pos = new Float32Array(header.nv * 3)
  for (let i = 0; i < header.nv; i++) {
    pos[i * 3] = positions[i * 3]
    pos[i * 3 + 1] = positions[i * 3 + 2]
    pos[i * 3 + 2] = -positions[i * 3 + 1]
  }
  const col = new Float32Array(header.nv * 3)
  for (let i = 0; i < col.length; i++) col[i] = SRGB_TO_LINEAR[colors[i]]
  const kind = new Float32Array(header.nv)
  const aH = new Float32Array(header.nv)
  for (let i = 0; i < header.nv; i++) aH[i] = heights[i] * header.hStep
  const solidIdx: number[] = []
  const glassIdx: number[] = []
  for (const g of header.groups) {
    kind.fill(g.kind, g.vStart, g.vStart + g.vCount)
    const dst = g.translucent ? glassIdx : solidIdx
    for (let i = g.iStart; i < g.iStart + g.iCount; i++) dst.push(indices[i])
  }
  const position = new Float32BufferAttribute(pos, 3)
  const color = new Float32BufferAttribute(col, 3)
  const mat = new Float32BufferAttribute(kind, 1)
  const hgt = new Float32BufferAttribute(aH, 1)
  const make = (idx: number[]) => {
    const g = new BufferGeometry()
    g.setAttribute('position', position)
    g.setAttribute('color', color)
    g.setAttribute('aMat', mat)
    g.setAttribute('aH', hgt)
    g.setIndex(new Uint32BufferAttribute(Uint32Array.from(idx), 1))
    return g
  }
  return { solid: make(solidIdx), glass: glassIdx.length ? make(glassIdx) : null }
}
