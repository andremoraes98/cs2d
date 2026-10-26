// Dynamic layer of the 3D map view: gunfire tracers, grenade flight arcs and their
// detonation effects (smoke / fire / HE / flash), kill markers and the C4. It
// mirrors what the 2D canvas draws (same timings and radii) but in scene space:
// X = game X, Y = game Z (height), Z = -game Y.
//
// Everything is built once per round (`rebuild`) and then only toggled/animated by
// `update(t)`, so playback stays cheap.
import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  type Material,
  type Scene,
  type Texture,
} from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import type { GrenadePath, PlayerState, Round } from '@/viewer/domain/schema'
import { DEFAULT_BLAST_RADIUS } from '@/viewer/domain/calibration'

type GrenadeEvent = Extract<Round['events'][number], { type: 'grenade' }>
type KillEvent = Extract<Round['events'][number], { type: 'kill' }>
type ShotEvent = Extract<Round['events'][number], { type: 'shot' }>

// Same timings/sizes as ViewerMap.vue / useGrenadeRendering.ts.
const KILL_FADE = 1.4
const SHOT_FADE = 0.16 // a bit longer than 2D (0.12 s) so the tracer reads in 3D
const SHOT_LEN = 1400
const BLAST_TIME = 0.8
const SMOKE_RADIUS = 144
const FIRE_RADIUS = 150
const GRAVITY = 800 // sv_gravity, game units / s^2
const TRACER_POOL = 40

const KIND_COLOR: Record<string, number> = {
  smoke: 0xced3de,
  fire: 0xff7820,
  he: 0xff5a3c,
  flash: 0xffeeaa,
  decoy: 0x8c96a5,
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const easeOut = (k: number) => 1 - (1 - k) * (1 - k)
const scene3 = (x: number, y: number, z: number, out = new Vector3()) => out.set(x, z, -y)

/** Small deterministic hash in [0, 1) for stable per-effect randomness. */
function hash01(a: number, b: number) {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// --- shared geometries / textures -------------------------------------------------
const smokeGeo = new SphereGeometry(SMOKE_RADIUS, 28, 18)
const heGeo = new SphereGeometry(1, 20, 14)
const fireDiscGeo = new CircleGeometry(FIRE_RADIUS, 36)
fireDiscGeo.rotateX(-Math.PI / 2)
const flameGeo = new ConeGeometry(14, 1, 7)
flameGeo.translate(0, 0.5, 0) // base on the floor, grows upward when scaled in Y
const tracerGeo = new CylinderGeometry(0.9, 0.9, 1, 6)
tracerGeo.rotateX(Math.PI / 2) // axis along +Z so `lookAt` aims it
tracerGeo.translate(0, 0, 0.5) // start at the origin, extend along +Z
const c4Geo = new BoxGeometry(34, 18, 14)
const beaconGeo = new CylinderGeometry(5, 5, 320, 8)
beaconGeo.translate(0, 160, 0)
const headGeo = new SphereGeometry(7, 12, 8)

const numberTextures = new Map<number, Texture>()
function numberTexture(n: number): Texture {
  let tex = numberTextures.get(n)
  if (!tex) {
    const cv = document.createElement('canvas')
    cv.width = cv.height = 64
    const g = cv.getContext('2d')!
    g.font = '700 40px Inter, system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.lineWidth = 6
    g.strokeStyle = 'rgba(0,0,0,0.85)'
    g.strokeText(String(n), 32, 34)
    g.fillStyle = '#ffffff'
    g.fillText(String(n), 32, 34)
    tex = new CanvasTexture(cv)
    tex.colorSpace = SRGBColorSpace
    numberTextures.set(n, tex)
  }
  return tex
}

let crossTex: Texture | null = null
function killTexture(): Texture {
  if (!crossTex) {
    const cv = document.createElement('canvas')
    cv.width = cv.height = 64
    const g = cv.getContext('2d')!
    g.lineCap = 'round'
    g.lineWidth = 9
    g.strokeStyle = 'rgba(0,0,0,0.6)'
    for (const w of [14, 0]) {
      g.strokeStyle = w ? 'rgba(0,0,0,0.6)' : '#ff4d5e'
      g.lineWidth = w ? 14 : 8
      g.beginPath()
      g.moveTo(14, 14)
      g.lineTo(50, 50)
      g.moveTo(50, 14)
      g.lineTo(14, 50)
      g.stroke()
    }
    crossTex = new CanvasTexture(cv)
    crossTex.colorSpace = SRGBColorSpace
  }
  return crossTex
}

interface Arc {
  path: GrenadePath
  t0: number
  t1: number
  times: number[]
  pts: Vector3[]
  line: Line2
  head: Mesh
}
interface Fx {
  ev: GrenadeEvent
  group: Group
  timer: Sprite | null
  timerN: number
  parts: { smoke?: Mesh; inner?: Mesh; he?: Mesh; flash?: Mesh; disc?: Mesh; flames?: { m: Mesh; phase: number; h: number }[] }
}
interface KillMarker {
  ev: KillEvent
  sprite: Sprite
}

export interface EffectsDeps {
  scene: Scene
  round: () => Round | null
  /** Live players of the current frame (to place tracers at the shooter's height). */
  players: () => PlayerState[]
  levelRange: () => { minZ: number; maxZ: number } | null
  bombBlink: () => boolean
  blastRadius: () => number | undefined
  requestRender: () => void
}

export function useMapEffects3D(deps: EffectsDeps) {
  const root = new Group()
  deps.scene.add(root)
  const owned: Material[] = []
  const own = <T extends Material>(m: T): T => {
    owned.push(m)
    return m
  }

  let arcs: Arc[] = []
  let fxs: Fx[] = []
  let kills: KillMarker[] = []
  let shots: ShotEvent[] = []
  let bombGroup: Group | null = null
  let bombBeacon: Mesh | null = null
  let bombBlast: Mesh | null = null
  const tracers: Mesh[] = []
  const resolution = new Vector2(1, 1)

  const onLevel = (z: number) => {
    const l = deps.levelRange()
    return !l || (z >= l.minZ && z < l.maxZ)
  }

  function clear() {
    root.clear()
    for (const m of owned) m.dispose()
    owned.length = 0
    for (const a of arcs) a.line.geometry.dispose()
    arcs = []
    fxs = []
    kills = []
    shots = []
    tracers.length = 0
    bombGroup = bombBeacon = bombBlast = null
  }

  /** z where a path's grenade detonated: the nearest same-kind grenade event. */
  function detonationZ(path: GrenadePath, round: Round): number | null {
    const last = path.points[path.points.length - 1]
    let best: number | null = null
    let bestD = Infinity
    for (const e of round.events) {
      if (e.type !== 'grenade' || e.kind !== path.kind) continue
      const d = Math.hypot(e.x - last.x, e.y - last.y)
      if (d < bestD) {
        bestD = d
        best = e.z
      }
    }
    return best
  }

  function buildArc(path: GrenadePath, round: Round): Arc | null {
    const p = path.points
    if (p.length < 2) return null
    const t0 = p[0].t
    const t1 = p[p.length - 1].t
    const T = Math.max(0.05, t1 - t0)
    const z1 = detonationZ(path, round) ?? path.throw?.z ?? 0
    const z0 = path.throw?.z ?? z1 + 90
    // The replay only has X/Y per sample; the height follows a ballistic arc that
    // starts at the release and lands at the detonation height.
    const vz = (z1 - z0 + (GRAVITY / 2) * T * T) / T
    const pts = p.map((s) => {
      const tau = s.t - t0
      return scene3(s.x, s.y, z0 + vz * tau - (GRAVITY / 2) * tau * tau)
    })
    const flat: number[] = []
    for (const v of pts) flat.push(v.x, v.y, v.z)
    const geo = new LineGeometry()
    geo.setPositions(flat)
    const mat = own(
      new LineMaterial({
        color: KIND_COLOR[path.kind] ?? 0xdce0e8,
        linewidth: 2.5,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    )
    mat.resolution.copy(resolution)
    const line = new Line2(geo, mat)
    line.renderOrder = 8
    line.visible = false
    const head = new Mesh(headGeo, own(new MeshBasicMaterial({ color: KIND_COLOR[path.kind] ?? 0xdce0e8, depthTest: false })))
    head.renderOrder = 9
    head.visible = false
    root.add(line, head)
    return { path, t0, t1, times: p.map((s) => s.t), pts, line, head }
  }

  function timerSprite(parent: Group, y: number): Sprite {
    const s = new Sprite(own(new SpriteMaterial({ map: numberTexture(0), depthTest: false, transparent: true })))
    s.scale.set(44, 44, 1)
    s.position.y = y
    s.renderOrder = 10
    parent.add(s)
    return s
  }

  function buildFx(ev: GrenadeEvent): Fx | null {
    if (ev.kind === 'decoy') return null
    const group = new Group()
    scene3(ev.x, ev.y, ev.z, group.position)
    group.visible = false
    const fx: Fx = { ev, group, timer: null, timerN: -1, parts: {} }
    if (ev.kind === 'smoke') {
      fx.parts.smoke = new Mesh(smokeGeo, own(new MeshBasicMaterial({ color: 0xc8cdd6, transparent: true, opacity: 0.6, depthWrite: false })))
      fx.parts.smoke.position.y = SMOKE_RADIUS * 0.55
      fx.parts.inner = new Mesh(smokeGeo, own(new MeshBasicMaterial({ color: 0x9aa1ad, transparent: true, opacity: 0.25, depthWrite: false })))
      fx.parts.inner.position.y = SMOKE_RADIUS * 0.55
      fx.parts.inner.scale.setScalar(0.72)
      group.add(fx.parts.smoke, fx.parts.inner)
      fx.timer = timerSprite(group, SMOKE_RADIUS * 1.3)
    } else if (ev.kind === 'fire') {
      fx.parts.disc = new Mesh(fireDiscGeo, own(new MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.5, depthWrite: false })))
      fx.parts.disc.position.y = 3
      group.add(fx.parts.disc)
      fx.parts.flames = []
      const flameMat = own(new MeshBasicMaterial({ color: 0xffb030, transparent: true, opacity: 0.85, depthWrite: false }))
      for (let i = 0; i < 12; i++) {
        const a = hash01(ev.x + i, ev.y) * Math.PI * 2
        const r = Math.sqrt(hash01(ev.y - i, ev.x)) * FIRE_RADIUS * 0.85
        const m = new Mesh(flameGeo, flameMat)
        m.position.set(Math.cos(a) * r, 3, Math.sin(a) * r)
        group.add(m)
        fx.parts.flames.push({ m, phase: hash01(i, ev.x) * 6.28, h: 50 + hash01(ev.x, i) * 40 })
      }
      fx.timer = timerSprite(group, 90)
    } else if (ev.kind === 'he') {
      fx.parts.he = new Mesh(heGeo, own(new MeshBasicMaterial({ color: 0xffa02e, transparent: true, opacity: 0.6, depthWrite: false })))
      fx.parts.he.position.y = 30
      group.add(fx.parts.he)
    } else {
      fx.parts.flash = new Mesh(heGeo, own(new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false })))
      fx.parts.flash.position.y = 50
      group.add(fx.parts.flash)
    }
    root.add(group)
    return fx
  }

  function buildKill(ev: KillEvent): KillMarker {
    const sprite = new Sprite(own(new SpriteMaterial({ map: killTexture(), depthTest: false, transparent: true })))
    sprite.scale.set(60, 60, 1)
    scene3(ev.x, ev.y, ev.z + 45, sprite.position)
    sprite.renderOrder = 9
    sprite.visible = false
    root.add(sprite)
    return { ev, sprite }
  }

  function buildBomb() {
    bombGroup = new Group()
    bombGroup.visible = false
    const c4 = new Mesh(c4Geo, own(new MeshBasicMaterial({ color: 0x4a5a3a })))
    c4.position.y = 6
    bombBeacon = new Mesh(beaconGeo, own(new MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.35, depthWrite: false })))
    bombGroup.add(c4, bombBeacon)
    bombBlast = new Mesh(heGeo, own(new MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.5, depthWrite: false })))
    bombBlast.visible = false
    root.add(bombGroup, bombBlast)
  }

  function buildTracers() {
    for (let i = 0; i < TRACER_POOL; i++) {
      const m = new Mesh(tracerGeo, own(new MeshBasicMaterial({ color: 0xffeeaa, transparent: true, opacity: 0, depthWrite: false })))
      m.visible = false
      m.renderOrder = 7
      root.add(m)
      tracers.push(m)
    }
  }

  function rebuild() {
    clear()
    const round = deps.round()
    if (!round) return
    for (const path of round.grenadePaths) {
      const a = buildArc(path, round)
      if (a) arcs.push(a)
    }
    for (const ev of round.events) {
      if (ev.type === 'grenade') {
        const fx = buildFx(ev)
        if (fx) fxs.push(fx)
      } else if (ev.type === 'kill') kills.push(buildKill(ev))
      else if (ev.type === 'shot') shots.push(ev)
    }
    shots.sort((a, b) => a.t - b.t)
    buildBomb()
    buildTracers()
    update(0)
  }

  // --- per-frame update ---------------------------------------------------------
  function setSecs(fx: Fx, remaining: number) {
    if (!fx.timer) return
    const n = Math.max(0, Math.ceil(remaining))
    if (n === fx.timerN) return
    fx.timerN = n
    ;(fx.timer.material as SpriteMaterial).map = numberTexture(n)
  }

  function nearestPlayerZ(x: number, y: number): number | null {
    let best: number | null = null
    let bd = 90
    for (const p of deps.players()) {
      const d = Math.hypot(p.x - x, p.y - y)
      if (d < bd) {
        bd = d
        best = p.z
      }
    }
    return best
  }

  function update(t: number) {
    const round = deps.round()
    if (!round) return

    // grenade arcs: revealed up to t while airborne (and a moment after landing)
    for (const a of arcs) {
      const show = t >= a.t0 && t <= a.t1 + 0.25 && onLevel(a.pts[a.pts.length - 1].y)
      a.line.visible = show
      a.head.visible = show && t <= a.t1
      if (!show) continue
      let k = 0
      while (k + 1 < a.times.length && a.times[k + 1] <= t) k++
      ;(a.line.geometry as LineGeometry & { instanceCount: number }).instanceCount = Math.max(1, k)
      const next = Math.min(k + 1, a.times.length - 1)
      const span = a.times[next] - a.times[k]
      const f = span > 0 ? clamp01((t - a.times[k]) / span) : 0
      a.head.position.lerpVectors(a.pts[k], a.pts[next], f)
    }

    // detonation effects
    for (const fx of fxs) {
      const { ev } = fx
      const live = t >= ev.t && t <= ev.endT && onLevel(ev.z)
      fx.group.visible = live
      if (!live) continue
      const span = Math.max(0.001, ev.endT - ev.t)
      const k = clamp01((t - ev.t) / span)
      const { smoke, inner, he, flash, disc, flames } = fx.parts
      if (smoke && inner) {
        const grow = easeOut(clamp01((t - ev.t) / 0.7))
        const fade = clamp01((ev.endT - t) / 1.6)
        smoke.scale.setScalar(0.25 + 0.75 * grow)
        inner.scale.setScalar((0.25 + 0.75 * grow) * 0.72)
        ;(smoke.material as MeshBasicMaterial).opacity = 0.6 * fade
        ;(inner.material as MeshBasicMaterial).opacity = 0.25 * fade
        setSecs(fx, ev.endT - t)
      }
      if (disc && flames) {
        const fade = clamp01((ev.endT - t) / 1.0)
        ;(disc.material as MeshBasicMaterial).opacity = 0.5 * fade
        for (const f of flames) {
          f.m.scale.set(1, f.h * fade * (0.65 + 0.35 * Math.sin(t * 9 + f.phase)), 1)
        }
        setSecs(fx, ev.endT - t)
      }
      if (he) {
        he.scale.setScalar(40 + 120 * easeOut(k))
        ;(he.material as MeshBasicMaterial).opacity = 0.6 * (1 - k)
      }
      if (flash) {
        flash.scale.setScalar(60 + 50 * k)
        ;(flash.material as MeshBasicMaterial).opacity = 0.8 * (1 - k)
      }
    }

    // kills: a red cross that fades
    for (const m of kills) {
      const age = t - m.ev.t
      const show = age >= 0 && age <= KILL_FADE && onLevel(m.ev.z)
      m.sprite.visible = show
      if (show) (m.sprite.material as SpriteMaterial).opacity = 1 - age / KILL_FADE
    }

    // shots: short tracers along the aim direction at the shooter's height
    let used = 0
    let lo = 0
    let hi = shots.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (shots[mid].t < t - SHOT_FADE) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < shots.length && shots[i].t <= t && used < tracers.length; i++) {
      const ev = shots[i]
      const z = nearestPlayerZ(ev.x, ev.y)
      if (z == null || !onLevel(z)) continue
      const a = (ev.yaw * Math.PI) / 180
      const m = tracers[used++]
      scene3(ev.x, ev.y, z + 56, m.position)
      m.lookAt(ev.x + Math.cos(a) * SHOT_LEN, z + 56, -(ev.y + Math.sin(a) * SHOT_LEN))
      m.scale.set(1, 1, SHOT_LEN)
      ;(m.material as MeshBasicMaterial).opacity = 0.9 * (1 - (t - ev.t) / SHOT_FADE)
      m.visible = true
    }
    for (let i = used; i < tracers.length; i++) tracers[i].visible = false

    updateBomb(round, t)
  }

  function updateBomb(round: Round, t: number) {
    if (!bombGroup || !bombBeacon || !bombBlast) return
    let kf: Round['bomb'][number] | null = null
    for (const k of round.bomb) {
      if (k.t <= t) kf = k
      else break
    }
    const placed = kf && (kf.state === 'ground' || kf.state === 'planted') && kf.x != null
    bombGroup.visible = !!placed && onLevel(kf!.z ?? 0)
    if (placed && kf) {
      scene3(kf.x!, kf.y ?? 0, kf.z ?? 0, bombGroup.position)
      const planted = kf.state === 'planted'
      bombBeacon.visible = planted
      if (planted) (bombBeacon.material as MeshBasicMaterial).opacity = deps.bombBlink() ? 0.6 : 0.2
    }
    // detonation shockwave at the planted spot
    const blast = round.events.find((e) => e.type === 'bomb_exploded')
    const planted = round.bomb.find((k) => k.state === 'planted')
    const age = blast ? t - blast.t : -1
    if (blast && planted && planted.x != null && age >= 0 && age <= BLAST_TIME && onLevel(planted.z ?? 0)) {
      const p = age / BLAST_TIME
      scene3(planted.x, planted.y ?? 0, planted.z ?? 0, bombBlast.position)
      bombBlast.scale.setScalar((deps.blastRadius() ?? DEFAULT_BLAST_RADIUS) * easeOut(p))
      ;(bombBlast.material as MeshBasicMaterial).opacity = 0.5 * (1 - p)
      bombBlast.visible = true
    } else {
      bombBlast.visible = false
    }
  }

  /** Fat-line materials need the viewport size to compute their pixel width. */
  function setResolution(w: number, h: number) {
    resolution.set(w, h)
    for (const a of arcs) (a.line.material as LineMaterial).resolution.set(w, h)
  }

  function dispose() {
    clear()
    deps.scene.remove(root)
  }

  return { rebuild, update, setResolution, dispose }
}
