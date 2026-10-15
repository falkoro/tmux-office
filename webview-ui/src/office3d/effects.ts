/**
 * Status light, drawn with one instanced mesh per kind of effect: monitor faces,
 * the screen glow on each face, light pools on the floor, rings and beams for
 * the desks that need the owner, confetti for a finished task, and the
 * selection ring. Instances are rewritten when the desks change; per frame only
 * the pulsing rings, beams and confetti move, without allocating.
 */
import type { BufferGeometry, Material, Texture } from 'three';
import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Vector3,
} from 'three';

import {
  OFFICE3D_BEAM_HEIGHT as BEAM_H,
  OFFICE3D_COLORS as C,
  OFFICE3D_CONFETTI_S as CONFETTI_S,
  OFFICE3D_STATUS_COLORS as STATUS,
} from '../constants.js';
import { SLOT } from './furniture.js';
import type { DeskStatus } from './model.js';

const POOL: Record<DeskStatus, number> = {
  working: 0.4,
  'needs-permission': 1,
  'waiting-input': 0.8,
  done: 0.3,
  idle: 0,
};
const GLOW: Record<DeskStatus, number> = {
  working: 0.55,
  'needs-permission': 0.5,
  'waiting-input': 0.5,
  done: 0.35,
  idle: 0,
};

const PIECES = 160;
const PER_BURST = 28;
const GRAVITY = -6;
const CONFETTI_COLORS = [...Object.values(STATUS).slice(0, 4), ...C.art];

/** What the effects need to know about one desk. */
export interface DeskLight {
  /** The desk slot's transform (position and scale). */
  matrix: Matrix4;
  status: DeskStatus;
}

/** An instanced mesh that grows when more instances are needed. */
class Layer {
  mesh: InstancedMesh;
  private readonly parent: Group;
  private readonly geometry: BufferGeometry;
  private readonly material: Material;
  private readonly order: number;

  constructor(parent: Group, geometry: BufferGeometry, material: Material, order: number) {
    this.parent = parent;
    this.geometry = geometry;
    this.material = material;
    this.order = order;
    this.mesh = this.make(16);
  }

  private make(capacity: number): InstancedMesh {
    const mesh = new InstancedMesh(this.geometry, this.material, capacity);
    mesh.frustumCulled = false;
    mesh.renderOrder = this.order;
    mesh.count = 0;
    mesh.visible = false;
    this.parent.add(mesh);
    return mesh;
  }

  /** Set the instance count, growing the buffers first if needed. */
  size(n: number): void {
    if (n > this.mesh.instanceMatrix.count) {
      this.mesh.removeFromParent();
      this.mesh.dispose();
      this.mesh = this.make(Math.max(n, this.mesh.instanceMatrix.count * 2));
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
  }

  set(i: number, matrix: Matrix4, color: Color): void {
    this.mesh.setMatrixAt(i, matrix);
    this.mesh.setColorAt(i, color);
  }

  flush(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}

/** An open cone of light whose brightness lives in vertex colours: none below head height. */
function beamGeometry(): BufferGeometry {
  const geo = new CylinderGeometry(0.32, 0.5, BEAM_H, 24, 12, true).translate(0, BEAM_H / 2, 0);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const rise = Math.min(1, Math.max(0, (y - 1.35) / 0.5));
    const v = rise * rise * (1 - Math.max(0, y - 1.85) / (BEAM_H - 1.85)) ** 1.4;
    colors.fill(v, i * 3, i * 3 + 3);
  }
  geo.setAttribute('color', new BufferAttribute(colors, 3));
  return geo;
}

export class Effects {
  readonly group = new Group();
  private readonly geometries: BufferGeometry[];
  private readonly materials: Material[];
  private readonly screens: Layer;
  private readonly glows: Layer;
  private readonly pools: Layer;
  private readonly rings: Layer;
  private readonly beams: Layer;
  private readonly confetti: Layer;
  private readonly selection: Mesh;
  /** Seat transforms and statuses of the desks with a ring, permission first. */
  private ringBase: Matrix4[] = [];
  private ringStatus: DeskStatus[] = [];
  private beamCount = 0;
  private readonly piece = new Float32Array(PIECES * 8);
  private nextPiece = 0;
  private confettiUntil = 0;
  private readonly m = new Matrix4();
  private readonly s = new Matrix4();
  private readonly color = new Color();
  private readonly p = new Vector3();
  private readonly q = new Quaternion();
  private readonly e = new Euler();
  private readonly v = new Vector3();

  constructor(light: Texture) {
    const additive = (extra: Partial<MeshBasicMaterial> = {}) =>
      Object.assign(
        new MeshBasicMaterial({
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
        extra,
      );
    const quad = new PlaneGeometry(1, 1);
    const floor = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const ring = new RingGeometry(0.42, 0.53, 40).rotateX(-Math.PI / 2);
    const selection = new RingGeometry(0.62, 0.7, 48).rotateX(-Math.PI / 2);
    const beam = beamGeometry();
    const bit = new PlaneGeometry(0.07, 0.04);
    this.geometries = [quad, floor, ring, selection, beam, bit];
    const screenMat = new MeshBasicMaterial({ toneMapped: false });
    const glowMat = additive({ map: light, side: DoubleSide });
    const poolMat = additive({ map: light });
    const ringMat = additive();
    const beamMat = additive({ vertexColors: true, side: DoubleSide });
    const bitMat = new MeshBasicMaterial({ side: DoubleSide, toneMapped: false });
    const selMat = new MeshBasicMaterial({ color: C.selection, toneMapped: false });
    this.materials = [screenMat, glowMat, poolMat, ringMat, beamMat, bitMat, selMat];
    this.screens = new Layer(this.group, quad, screenMat, 0);
    this.pools = new Layer(this.group, floor, poolMat, 2);
    this.rings = new Layer(this.group, ring, ringMat, 3);
    this.glows = new Layer(this.group, quad, glowMat, 4);
    this.beams = new Layer(this.group, beam, beamMat, 5);
    this.confetti = new Layer(this.group, bit, bitMat, 0);
    this.selection = new Mesh(selection, selMat);
    this.selection.matrixAutoUpdate = false;
    this.selection.visible = false;
    this.group.add(this.selection);
  }

  /** Rewrite the per-desk instances. `selected` is the selected desk's slot transform. */
  sync(desks: readonly DeskLight[], selected: Matrix4 | null): void {
    const n = desks.length;
    this.screens.size(n);
    this.glows.size(n);
    this.pools.size(n);
    desks.forEach((desk, i) => {
      const hex = STATUS[desk.status];
      this.screens.set(
        i,
        this.m.multiplyMatrices(desk.matrix, SLOT.screen),
        this.color.setHex(desk.status === 'idle' ? C.screenOff : hex),
      );
      this.glows.set(
        i,
        this.m.multiplyMatrices(desk.matrix, SLOT.glow),
        this.color.setHex(hex).multiplyScalar(GLOW[desk.status]),
      );
      this.pools.set(
        i,
        this.m.multiplyMatrices(desk.matrix, SLOT.pool),
        this.color.setHex(hex).multiplyScalar(POOL[desk.status]),
      );
    });
    this.screens.flush();
    this.glows.flush();
    this.pools.flush();

    const marked = desks
      .filter((d) => d.status === 'needs-permission' || d.status === 'waiting-input')
      .sort(
        (a, b) => Number(b.status === 'needs-permission') - Number(a.status === 'needs-permission'),
      );
    this.ringBase = marked.map((d) => new Matrix4().multiplyMatrices(d.matrix, SLOT.seat));
    this.ringStatus = marked.map((d) => d.status);
    this.beamCount = marked.filter((d) => d.status === 'needs-permission').length;
    this.rings.size(marked.length);
    this.beams.size(this.beamCount);

    this.selection.visible = selected !== null;
    if (selected) this.selection.matrix.multiplyMatrices(selected, SLOT.seat);
  }

  /** Throw a handful of confetti above a seat (world position, desk scale). */
  burst(at: Vector3, scale: number, now: number): void {
    this.confetti.size(PIECES);
    for (let k = 0; k < PER_BURST; k++) {
      const i = this.nextPiece;
      this.nextPiece = (i + 1) % PIECES;
      const a = Math.random() * Math.PI * 2;
      const out = (0.6 + Math.random() * 0.9) * scale;
      this.piece.set(
        [
          at.x,
          at.y,
          at.z,
          Math.cos(a) * out,
          (2.4 + Math.random() * 1.4) * scale,
          Math.sin(a) * out,
          now,
          4 + Math.random() * 8,
        ],
        i * 8,
      );
      this.confetti.mesh.setColorAt(
        i,
        this.color.setHex(CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)]),
      );
    }
    this.confettiUntil = now + CONFETTI_S;
    this.confetti.flush();
  }

  /** Move the live effects to time `t` (seconds). True while something still moves. */
  step(t: number, reduced: boolean): boolean {
    const pulse = !reduced && this.beamCount > 0;
    for (let i = 0; i < this.ringBase.length; i++) {
      const asking = this.ringStatus[i] === 'needs-permission';
      const phase = asking && !reduced ? (t * 0.9 + i * 0.37) % 1 : 0;
      const grow = asking && !reduced ? 1 + phase * 1.1 : 1;
      const k = asking ? (reduced ? 1 : 1 - phase) : 0.75;
      this.s.makeScale(grow, 1, grow);
      this.rings.set(
        i,
        this.m.multiplyMatrices(this.ringBase[i], this.s),
        this.color.setHex(STATUS[this.ringStatus[i]]).multiplyScalar(k),
      );
      if (i < this.beamCount) {
        const glow = reduced ? 0.85 : 0.65 + 0.35 * Math.sin(t * 4 + i);
        this.beams.set(
          i,
          this.ringBase[i],
          this.color.setHex(STATUS[this.ringStatus[i]]).multiplyScalar(glow),
        );
      }
    }
    this.rings.flush();
    this.beams.flush();
    return pulse || this.stepConfetti(t);
  }

  private stepConfetti(t: number): boolean {
    if (this.confetti.mesh.count === 0) return false;
    if (t > this.confettiUntil) {
      this.confetti.size(0);
      return false;
    }
    const d = this.piece;
    for (let i = 0; i < PIECES; i++) {
      const age = t - d[i * 8 + 6];
      const live = d[i * 8 + 6] > 0 && age >= 0 && age < CONFETTI_S;
      const shrink = live ? Math.min(1, (CONFETTI_S - age) / 0.3) : 0;
      this.p.set(
        d[i * 8] + d[i * 8 + 3] * age,
        d[i * 8 + 1] + d[i * 8 + 4] * age + 0.5 * GRAVITY * age * age,
        d[i * 8 + 2] + d[i * 8 + 5] * age,
      );
      const spin = d[i * 8 + 7] * age;
      this.q.setFromEuler(this.e.set(spin, spin * 0.7, spin * 0.3));
      this.m.compose(this.p, this.q, this.v.setScalar(shrink));
      this.confetti.mesh.setMatrixAt(i, this.m);
    }
    this.confetti.mesh.instanceMatrix.needsUpdate = true;
    return true;
  }

  dispose(): void {
    for (const layer of [
      this.screens,
      this.glows,
      this.pools,
      this.rings,
      this.beams,
      this.confetti,
    ]) {
      layer.dispose();
    }
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.group.removeFromParent();
  }
}
