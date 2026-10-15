/**
 * Everything in the office that stands still, built from primitives and merged
 * per material: lit furniture that casts shadows, glowing parts (window skies,
 * lamp shades, fairy lights) and soft light pools on the floor. However many
 * rooms there are, that is three draw calls. It is rebuilt only when the plan changes.
 */
import type { Texture } from 'three';
import {
  AdditiveBlending,
  DataTexture,
  Group,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';

import {
  OFFICE3D_COLORS as C,
  OFFICE3D_DESK_HEIGHT as DH,
  OFFICE3D_DESK_Z as DZ,
  OFFICE3D_FLOOR_Y as FLOOR,
  OFFICE3D_POD_SIGN_DEPTH as SIGN_DEPTH,
  OFFICE3D_ROOM_PAD_BACK,
  OFFICE3D_ROOM_PAD_X as PAD_X,
  OFFICE3D_SEAT_Z as SZ,
  OFFICE3D_WALL_HEIGHT as WALL_H,
} from '../constants.js';
import type { Paint, Prim } from './characters.js';
import { at, hash, PartBuilder, span } from './characters.js';
import type { DeskSpot, OfficePlan, PodSpot, RoomSpot } from './layout.js';

const UP = new Vector3(0, 1, 0);
const P = new Vector3();
const Q = new Quaternion();
const S = new Vector3();

/** A colour scaled toward black (or brighter, clamped). */
export const shade = (hex: number, k: number): number =>
  (Math.min(255, Math.round(((hex >> 16) & 255) * k)) << 16) |
  (Math.min(255, Math.round(((hex >> 8) & 255) * k)) << 8) |
  Math.min(255, Math.round((hex & 255) * k));

type Rng = () => number;

/** A repeatable random sequence per name, so decor never reshuffles between rebuilds. */
function rng(seed: string): Rng {
  let s = hash(seed) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}
const pick = <T>(list: readonly T[], r: number): T =>
  list[Math.floor(r * list.length) % list.length];

const compose = (x: number, y: number, z: number, yaw: number, sx = 1, sy = sx, sz = sx) =>
  new Matrix4().compose(
    new Vector3(x, y, z),
    new Quaternion().setFromAxisAngle(UP, yaw),
    new Vector3(sx, sy, sz),
  );

// ── The desk slot, local to its centre on the floor; the camera looks from +z ──
const MONITOR_X = -0.5;
const MONITOR_Z = DZ - 0.02;
const SCREEN_Y = 0.36;
const MONITOR = compose(MONITOR_X, DH, MONITOR_Z, Math.atan2(-MONITOR_X, SZ - MONITOR_Z));

/** Local transforms of a desk slot's live parts, for the scene's instanced effects. */
export const SLOT = {
  /** The monitor face, a unit quad facing the seat. */
  screen: MONITOR.clone().multiply(compose(0, SCREEN_Y, 0.019, 0, 0.52, 0.3, 1)),
  /** Screen light falling on its user, a unit quad. */
  glow: MONITOR.clone().multiply(compose(0, SCREEN_Y - 0.05, 0.3, 0, 1.3, 1.0, 1)),
  /** The status light pool on the floor around the desk, a unit floor quad. */
  // Both sit high enough to clear a rug even on a porch desk, which is scaled down.
  pool: compose(0, 0.045, -0.1, 0, 2.3, 1, 2.2),
  /** Rings and beams stand around the seat. */
  seat: compose(0, 0.05, SZ, 0),
};

/** A white disc that fades to black at the rim, for additive light. */
export function radialTexture(size = 64): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const r = Math.hypot(((i + 0.5) / size) * 2 - 1, ((j + 0.5) / size) * 2 - 1);
      const v = Math.round(255 * Math.max(0, 1 - r * r) ** 2);
      const k = (j * size + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = v;
      data[k + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

type Placement = [
  x: number,
  y: number,
  z: number,
  sx: number,
  sy?: number,
  sz?: number,
  rx?: number,
  ry?: number,
  rz?: number,
];

/** Three part builders and a placement frame, so each piece is written in its own coordinates. */
class Decor {
  readonly solid = new PartBuilder();
  readonly glow = new PartBuilder();
  readonly pools = new PartBuilder({ uv: true });
  private readonly base = new Matrix4();
  private readonly frame = new Matrix4();
  private readonly m = new Matrix4();

  /** Later parts are relative to this floor point, turned by `yaw` and scaled by `scale`. */
  spot(x: number, z: number, yaw = 0, scale = 1, y = FLOOR): this {
    this.base.compose(P.set(x, y, z), Q.setFromAxisAngle(UP, yaw), S.setScalar(scale));
    this.frame.copy(this.base);
    return this;
  }

  /** A frame nested in the spot, such as a monitor turned on a desk. */
  nest(local: Matrix4): this {
    this.frame.multiplyMatrices(this.base, local);
    return this;
  }

  unnest(): this {
    this.frame.copy(this.base);
    return this;
  }

  s(prim: Prim, paint: Paint, ...t: Placement): this {
    return this.put(this.solid, prim, paint, at(...t));
  }

  g(prim: Prim, paint: Paint, ...t: Placement): this {
    return this.put(this.glow, prim, paint, at(...t));
  }

  line(paint: Paint, a: readonly number[], b: readonly number[], thick: number): this {
    return this.put(this.solid, 'cyl', paint, span(a, b, thick));
  }

  pool(paint: number, x: number, z: number, sx: number, sz = sx, y = 0.028): this {
    return this.put(this.pools, 'plane', paint, at(x, y, z, sx, 1, sz));
  }

  private put(b: PartBuilder, prim: Prim, paint: Paint, local: Matrix4): this {
    b.add(prim, paint, this.m.multiplyMatrices(this.frame, local));
    return this;
  }
}

// ── Pieces, each in its own frame, front toward +z ──────────
function plant(d: Decor, r: Rng, size = 1, x = 0, z = 0): void {
  const pot = 0.34 * size;
  const h = 0.36 * size;
  d.s('cyl', [shade(C.pot, 0.7), C.pot], x, h / 2, z, pot, h, pot);
  d.s('cyl', shade(C.pot, 1.1), x, h, z, pot * 1.12, 0.05 * size, pot * 1.12);
  const leaf = pick(C.leaves, r());
  const other = pick(C.leaves, r());
  if (r() < 0.4) {
    d.s('ball', leaf, x, h + 0.3 * size, z, 0.5 * size);
    d.s('ball', other, x + 0.14 * size, h + 0.2 * size, z + 0.08 * size, 0.32 * size);
    d.s('ball', other, x - 0.15 * size, h + 0.24 * size, z - 0.04 * size, 0.34 * size);
    d.s('ball', leaf, x + 0.02 * size, h + 0.55 * size, z, 0.3 * size);
    return;
  }
  const blades = 7;
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + r();
    const tilt = 0.3 + r() * 0.45;
    const len = (0.55 + r() * 0.35) * size;
    const reach = (len / 2) * Math.sin(tilt);
    d.s(
      'sphere',
      i % 2 ? leaf : other,
      x + Math.sin(a) * reach,
      h + (len / 2) * Math.cos(tilt),
      z + Math.cos(a) * reach,
      0.12 * size,
      len,
      0.05 * size,
      Math.cos(a) * tilt,
      0,
      -Math.sin(a) * tilt,
    );
  }
}

function floorLamp(d: Decor, x = 0, z = 0): void {
  d.s('cyl', C.lampMetal, x, 0.015, z, 0.32, 0.03, 0.32);
  d.s('post', C.lampMetal, x, 0.7, z, 0.035, 1.38);
  d.g('cyl', [C.lampShade, shade(C.lampShade, 0.85)], x, 1.42, z, 0.42, 0.3, 0.42);
  d.pool(shade(C.lampPool, 0.5), x, z, 3.2);
}

function tableLamp(d: Decor, x: number, y: number, z: number): void {
  d.s('cyl', C.lampMetal, x, y + 0.01, z, 0.12, 0.02, 0.12);
  d.s('post', C.lampMetal, x, y + 0.12, z, 0.02, 0.22);
  d.g('cyl', [C.lampShade, shade(C.lampShade, 0.85)], x, y + 0.27, z, 0.2, 0.14, 0.2);
  d.pool(shade(C.lampPool, 0.35), x, z, 1.8);
}

function sofa(d: Decor, coat: number, cushion: number, w: number, x = 0, z = 0): void {
  const seats = w > 1.3 ? 2 : 1;
  d.s('box', shade(coat, 0.75), x, 0.2, z, w, 0.24, 0.82);
  d.s('box', [shade(coat, 0.85), coat], x, 0.6, z - 0.31, w, 0.52, 0.2, -0.08);
  for (const side of [-1, 1]) {
    d.s('box', coat, x + side * (w / 2 - 0.09), 0.43, z + 0.02, 0.18, 0.3, 0.8);
    d.s('post', C.deskLeg, x + side * (w / 2 - 0.1), 0.04, z + 0.3, 0.05, 0.08);
    d.s('post', C.deskLeg, x + side * (w / 2 - 0.1), 0.04, z - 0.3, 0.05, 0.08);
  }
  const seatW = (w - 0.36) / seats;
  for (let i = 0; i < seats; i++) {
    const sx = x - w / 2 + 0.18 + seatW * (i + 0.5);
    d.s('box', [shade(coat, 0.9), coat], sx, 0.38, z + 0.06, seatW - 0.03, 0.12, 0.62);
  }
  d.s('sphere', cushion, x - w / 2 + 0.38, 0.6, z - 0.14, 0.34, 0.3, 0.12, -0.2, 0, 0.3);
  if (seats > 1) {
    d.s(
      'sphere',
      shade(cushion, 0.85),
      x + w / 2 - 0.38,
      0.6,
      z - 0.14,
      0.32,
      0.28,
      0.12,
      -0.2,
      0,
      -0.25,
    );
  }
}

function coffeeTable(d: Decor, r: Rng, x = 0, z = 0): void {
  d.s('box', C.deskTop, x, 0.36, z, 1.0, 0.05, 0.55);
  for (const [dx, dz] of [
    [-0.44, -0.22],
    [0.44, -0.22],
    [-0.44, 0.22],
    [0.44, 0.22],
  ]) {
    d.s('post', C.deskLeg, x + dx, 0.17, z + dz, 0.04, 0.34);
  }
  d.s('box', pick(C.books, r()), x - 0.2, 0.4, z + 0.02, 0.26, 0.035, 0.2, 0, 0.3);
  d.s('box', pick(C.books, r()), x - 0.2, 0.43, z + 0.02, 0.22, 0.03, 0.17, 0, 0.1);
  d.s('cyl', pick(C.mug, r()), x + 0.25, 0.43, z - 0.05, 0.08, 0.1);
}

/** A rug: a thin border slab, a field and an inner line, each a hair higher than the last. */
function rug(
  d: Decor,
  x: number,
  z: number,
  w: number,
  depth: number,
  field: number,
  border: number,
): void {
  d.s('box', border, x, 0.01, z, w, 0.02, depth);
  d.s('box', field, x, 0.0125, z, w - 0.22, 0.02, depth - 0.22);
  if (w < 1.2 || depth < 1.2) return;
  const inset = 0.32;
  for (const side of [-1, 1]) {
    d.s('box', border, x, 0.015, z + side * (depth / 2 - inset), w - 2 * inset, 0.02, 0.04);
    d.s('box', border, x + side * (w / 2 - inset), 0.015, z, 0.04, 0.02, depth - 2 * inset);
  }
}

function bookRow(
  d: Decor,
  r: Rng,
  x0: number,
  x1: number,
  y: number,
  z: number,
  depth: number,
): void {
  let x = x0;
  while (x < x1 - 0.05) {
    const w = 0.035 + r() * 0.04;
    if (r() < 0.12) {
      x += w * 2;
      continue;
    }
    const h = 0.18 + r() * 0.12;
    const lean = r() < 0.1 ? 0.25 : 0;
    d.s(
      'box',
      pick(C.books, r()),
      x + w / 2,
      y + h / 2,
      z,
      w,
      h,
      depth * (0.75 + r() * 0.2),
      0,
      0,
      lean,
    );
    x += w + 0.005 + (lean ? 0.04 : 0);
  }
}

function bookcase(d: Decor, r: Rng, w = 1.0, h = 1.35, x = 0, z = 0.17): void {
  const depth = 0.32;
  d.s('box', shade(C.shelf, 0.7), x, h / 2, z - depth / 2 + 0.01, w, h, 0.02);
  for (const side of [-1, 1])
    d.s('box', C.shelf, x + side * (w / 2 - 0.02), h / 2, z, 0.04, h, depth);
  const shelves = 3;
  for (let i = 0; i <= shelves; i++) {
    const y = 0.03 + (i * (h - 0.06)) / shelves;
    d.s('box', C.shelf, x, y, z, w - 0.04, 0.035, depth);
    if (i < shelves) bookRow(d, r, x - w / 2 + 0.06, x + w / 2 - 0.06, y + 0.018, z, depth - 0.04);
  }
  plant(d, r, 0.4, x + w * 0.25, z);
}

/** A window on a wall whose inner face is at z = 0. */
function wallWindow(d: Decor, r: Rng, curtain: number): void {
  const y = 1.0;
  const w = 1.1;
  const h = 0.8;
  d.g('quad', [C.skyBottom, C.skyTop], 0, y, 0.012, w, h, 1);
  if (r() < 0.75) {
    const cx = (r() - 0.5) * 0.5;
    const cy = y + 0.1 + r() * 0.15;
    d.g('ball', C.white, cx, cy, 0.016, 0.26, 0.08, 0.01);
    d.g('ball', C.white, cx + 0.07, cy + 0.035, 0.017, 0.16, 0.09, 0.01);
  }
  for (const side of [-1, 1]) {
    d.s('box', C.windowFrame, 0, y + (side * (h + 0.06)) / 2, 0.035, w + 0.12, 0.06, 0.07);
    d.s('box', C.windowFrame, (side * (w + 0.06)) / 2, y, 0.035, 0.06, h, 0.07);
    d.s(
      'box',
      [shade(curtain, 0.7), curtain],
      side * (w / 2 + 0.12),
      y + 0.05,
      0.09,
      0.24,
      h + 0.42,
      0.06,
    );
  }
  d.s('box', C.windowFrame, 0, y, 0.03, 0.035, h, 0.04);
  d.s('box', C.windowFrame, 0, y + 0.06, 0.03, w, 0.035, 0.04);
  d.s('box', C.windowFrame, 0, y - h / 2 - 0.05, 0.08, w + 0.24, 0.05, 0.16);
  d.s('cyl', C.lampMetal, 0, y + h / 2 + 0.2, 0.11, 0.03, w + 0.75, 0.03, 0, 0, Math.PI / 2);
  d.pool(shade(C.windowPool, 0.3), 0, 1.0, 2.0, 1.6);
}

function picture(d: Decor, r: Rng, x: number, y: number, w: number, h: number): void {
  d.s('box', C.pictureFrame, x, y, 0.02, w, h, 0.04);
  d.s('box', C.white, x, y, 0.041, w - 0.06, h - 0.06, 0.005);
  d.s('box', pick(C.art, r()), x, y + h * 0.12, 0.045, w - 0.12, h * 0.45 - 0.06, 0.01);
  d.s('box', pick(C.art, r()), x, y - h * 0.22, 0.045, w - 0.12, h * 0.3 - 0.06, 0.01);
  d.s('ball', pick(C.art, r()), x + w * 0.2, y + h * 0.18, 0.05, h * 0.18, h * 0.18, 0.01);
}

function clock(d: Decor, x: number, y: number): void {
  d.s('cyl', C.clockFace, x, y, 0.03, 0.34, 0.04, 0.34, Math.PI / 2);
  d.s('ring', C.trim, x, y, 0.04, 0.36, 0.36, 0.36, Math.PI / 2);
  d.s('box', C.wire, x, y + 0.05, 0.055, 0.022, 0.11, 0.01);
  d.s('box', C.wire, x + 0.035, y - 0.02, 0.055, 0.09, 0.018, 0.01, 0, 0, -0.5);
}

function wallShelf(d: Decor, r: Rng, y: number): void {
  d.s('box', C.shelf, 0, y, 0.11, 0.9, 0.04, 0.22);
  bookRow(d, r, -0.4, 0.05, y + 0.02, 0.11, 0.16);
  d.s('cyl', C.pot, 0.25, y + 0.07, 0.11, 0.1, 0.1);
  d.s('ball', pick(C.leaves, r()), 0.25, y + 0.16, 0.11, 0.16, 0.13, 0.16);
}

function stoolTable(d: Decor, r: Rng): void {
  d.s('cyl', C.deskTop, 0, 0.7, 0, 0.8, 0.05, 0.8);
  d.s('post', C.deskLeg, 0, 0.35, 0, 0.07, 0.7);
  d.s('cyl', C.deskLeg, 0, 0.02, 0, 0.45, 0.04, 0.45);
  for (const side of [-1, 1]) {
    d.s('cyl', pick(C.chairSeat, r()), side * 0.62, 0.48, 0.05, 0.36, 0.06, 0.36);
    d.s('post', C.deskLeg, side * 0.62, 0.24, 0.05, 0.04, 0.46);
  }
  d.s('cyl', pick(C.mug, r()), 0.12, 0.77, 0.05, 0.08, 0.1);
  d.s('cyl', C.white, -0.15, 0.735, -0.05, 0.24, 0.02, 0.24);
}

function bench(d: Decor, w = 1.4): void {
  d.s('box', C.railing, 0, 0.42, 0, w, 0.05, 0.42);
  d.s('box', C.railing, 0, 0.7, -0.2, w, 0.3, 0.05, -0.15);
  for (const side of [-1, 1]) d.s('box', C.deskLeg, side * (w / 2 - 0.08), 0.2, 0, 0.06, 0.4, 0.38);
}

// ── Rooms ───────────────────────────────────────────────────
const WALL_T = 0.14;
const NOOK_W = 3.2;

/** Planks across the floor, with the slab showing through the joins. */
function planks(d: Decor, r: Rng, room: RoomSpot, woods: readonly number[], row: number): void {
  const x0 = room.x - room.width / 2;
  const x1 = x0 + room.width;
  const z0 = room.z - room.depth / 2;
  const z1 = z0 + room.depth;
  d.spot(0, 0);
  for (let z = z0; z < z1 - 0.01; z += row) {
    const depth = Math.min(row, z1 - z) - 0.02;
    let x = x0 - r() * 1.4;
    while (x < x1) {
      const len = 1.4 + r() * 1.4;
      const a = Math.max(x, x0);
      const b = Math.min(x + len, x1);
      if (b - a > 0.05) {
        const wood = shade(pick(woods, r()), 0.92 + r() * 0.12);
        d.s('plane', wood, (a + b) / 2, 0.002, z + depth / 2 + 0.01, b - a - 0.02, 1, depth);
      }
      x += len;
    }
  }
}

function backWall(d: Decor, r: Rng, room: RoomSpot, top: number): void {
  const w = room.width;
  const wall = pick(C.walls, r());
  const curtain = pick(C.curtains, r());
  const wallY = (WALL_H - FLOOR) / 2;
  d.spot(room.x, top);
  d.s(
    'box',
    [shade(wall, 0.82), wall],
    0,
    wallY,
    -WALL_T / 2,
    w + 2 * WALL_T,
    WALL_H + FLOOR,
    WALL_T,
  );
  d.s('box', [shade(C.wainscot, 0.85), C.wainscot], 0, 0.28, 0.012, w, 0.56, 0.024);
  d.s('box', C.trim, 0, 0.58, 0.025, w, 0.045, 0.05);
  d.s('box', C.trim, 0, WALL_H, -WALL_T / 2, w + 2 * WALL_T + 0.04, 0.07, WALL_T + 0.06);
  const tall = Math.min(room.depth, OFFICE3D_ROOM_PAD_BACK + 0.4);
  const low = room.depth - tall;
  for (const side of [-1, 1]) {
    d.spot(room.x + side * (w / 2 + WALL_T / 2), top);
    d.s(
      'box',
      [shade(wall, 0.7), shade(wall, 0.9)],
      0,
      wallY,
      tall / 2,
      WALL_T,
      WALL_H + FLOOR,
      tall,
    );
    d.s('box', C.trim, 0, WALL_H, tall / 2, WALL_T + 0.04, 0.07, tall + 0.02);
    if (low <= 0) continue;
    d.s('box', shade(wall, 0.75), 0, (0.44 - FLOOR) / 2, tall + low / 2, WALL_T, 0.44 + FLOOR, low);
    d.s('box', C.trim, 0, 0.45, tall + low / 2, WALL_T + 0.04, 0.05, low);
  }

  const slots = Math.max(1, Math.floor((w - 1.0) / 2.3));
  const mid = Math.floor(slots / 2);
  const coat = pick(C.sofa, r());
  const cushion = pick(C.cushion, r());
  for (let i = 0; i < slots; i++) {
    const x = room.x - w / 2 + 0.5 + ((i + 0.5) * (w - 1.0)) / slots;
    d.spot(x, top);
    if (i === mid) {
      wallWindow(d, r, curtain);
      sofa(d, coat, cushion, 1.7, 0, 0.5);
      if (slots > 1) floorLamp(d, 1.25, 0.35);
      continue;
    }
    if ((i - mid) % 2 === 0) {
      wallWindow(d, r, curtain);
      if (r() < 0.5) plant(d, r, 0.7, 0.75, 0.3);
      continue;
    }
    const kind = Math.floor(r() * 4);
    if (kind === 0) {
      bookcase(d, r, 1.0, 1.35);
    } else if (kind === 1) {
      picture(d, r, -0.2, 1.1, 0.6, 0.5);
      picture(d, r, 0.35, 1.2, 0.36, 0.44);
      plant(d, r, 0.9, 0.1, 0.3);
    } else if (kind === 2) {
      clock(d, 0, 1.35);
      wallShelf(d, r, 0.95);
      sofa(d, pick(C.sofa, r()), pick(C.cushion, r()), 0.95, 0, 0.55);
    } else {
      bookcase(d, r, 0.8, 1.15, -0.25);
      plant(d, r, 1.1, 0.5, 0.3);
    }
  }
}

function porchRail(d: Decor, r: Rng, room: RoomSpot, top: number): void {
  const w = room.width;
  const posts = Math.max(3, Math.round(w / 1.6) + 1);
  const step = w / (posts - 1);
  d.spot(room.x, top);
  d.s('box', C.railing, 0, 0.9, 0, w, 0.06, 0.1);
  d.s('box', C.railing, 0, 0.45, 0, w, 0.04, 0.06);
  for (const side of [-1, 1]) {
    d.s('box', C.railing, (side * w) / 2, 0.9, room.depth * 0.3, 0.1, 0.06, room.depth * 0.6);
    d.s('post', C.railing, (side * w) / 2, 0.45, room.depth * 0.6, 0.08, 0.9);
  }
  for (let i = 0; i < posts; i++) {
    const x = -w / 2 + i * step;
    d.s('box', C.railing, x, 0.45, 0, 0.09, 0.9, 0.09);
    if (i % 2 === 0) d.s('post', C.railing, x, 0.8, 0, 0.05, 1.6);
  }
  // Fairy lights sag between the tall posts.
  for (let i = 0; i + 2 < posts; i += 2) {
    const x0 = -w / 2 + i * step;
    const x1 = x0 + 2 * step;
    const n = 8;
    let prev = [x0, 1.58, 0.02];
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      const cur = [x0 + (x1 - x0) * u, 1.58 - 0.28 * Math.sin(Math.PI * u), 0.02];
      d.line(C.wire, prev, cur, 0.012);
      if (k < n) {
        const bulb = pick([C.bulb, C.lampShade, C.white], r());
        d.g('ball', bulb, cur[0], cur[1] - 0.05, 0.02, 0.07, 0.09, 0.07);
      }
      prev = cur;
    }
  }
}

function sidePads(d: Decor, r: Rng, room: RoomSpot, top: number, porch: boolean): void {
  const front = room.z + room.depth / 2;
  const z0 = top + OFFICE3D_ROOM_PAD_BACK * (porch ? 0.4 : 1) + 0.4;
  for (const side of [-1, 1]) {
    const x = room.x + side * (room.width / 2 - PAD_X / 2);
    let k = Math.floor(r() * 3);
    for (let z = z0; z < front - 0.6; z += 2.6) {
      d.spot(x, z, (-side * Math.PI) / 2);
      if (porch) {
        if (k % 2 === 0) bench(d, 1.2);
        else plant(d, r, 1.1);
      } else if (k % 3 === 0) plant(d, r, 1.15);
      else if (k % 3 === 1) floorLamp(d);
      else sofa(d, pick(C.sofa, r()), pick(C.cushion, r()), 0.95);
      k++;
    }
  }
}

/** Free floor beside a row of pods becomes lounges, reading corners and plant groups. */
function nooks(d: Decor, r: Rng, room: RoomSpot): void {
  const rows = new Map<number, PodSpot[]>();
  for (const pod of room.pods) {
    const key = Math.round((pod.z + pod.depth / 2) * 100);
    rows.set(key, [...(rows.get(key) ?? []), pod]);
  }
  const roomLeft = room.x - room.width / 2 + PAD_X;
  const roomRight = room.x + room.width / 2 - PAD_X;
  for (const pods of rows.values()) {
    const left = Math.min(...pods.map((p) => p.x - p.width / 2));
    const right = Math.max(...pods.map((p) => p.x + p.width / 2));
    const zFront = pods[0].z + pods[0].depth / 2 - SIGN_DEPTH * 0.6;
    const zBack = Math.min(...pods.map((p) => p.z - p.depth / 2));
    for (const [a, b, dir] of [
      [roomLeft, left - 0.5, -1],
      [right + 0.5, roomRight, 1],
    ] as const) {
      const n = Math.floor((b - a) / NOOK_W);
      for (let i = 0; i < n; i++) {
        // Fill from the pods outward, so the nearest nook always sits beside the pods.
        const x = dir > 0 ? a + (i + 0.5) * NOOK_W : b - (i + 0.5) * NOOK_W;
        nook(d, r, x, (zFront + zBack) / 2, zFront - zBack, room.background);
      }
    }
  }
}

function nook(d: Decor, r: Rng, x: number, z: number, depth: number, porch: boolean): void {
  d.spot(x, z);
  const kind = Math.floor(r() * (porch ? 2 : 4));
  if (kind === 0) {
    plant(d, r, 1.2, -0.6, -0.2);
    plant(d, r, 0.8, 0.3, 0.25);
    plant(d, r, 0.55, 0.85, -0.3);
    return;
  }
  if (kind === 1) {
    stoolTable(d, r);
    if (!porch) floorLamp(d, 1.1, -0.5);
    return;
  }
  const [field, border] = pick(C.rugs, r());
  rug(d, 0, 0, NOOK_W - 0.5, Math.min(depth, 2.4), field, border);
  if (kind === 2) {
    sofa(d, pick(C.sofa, r()), pick(C.cushion, r()), 1.8, 0, -0.45);
    coffeeTable(d, r, 0, 0.45);
    plant(d, r, 0.8, 1.15, -0.6);
  } else {
    sofa(d, pick(C.sofa, r()), pick(C.cushion, r()), 0.95, -0.45, -0.2);
    floorLamp(d, -1.05, -0.5);
    bookcase(d, r, 0.9, 1.25, 0.7, -0.6);
  }
}

function podFloor(d: Decor, pod: PodSpot): void {
  const top = pod.z - pod.depth / 2;
  const signZ = pod.z + pod.depth / 2 - SIGN_DEPTH / 2;
  const rugDepth = pod.depth - SIGN_DEPTH + 0.2;
  d.spot(pod.x, top + rugDepth / 2);
  const [field, border] = pod.pinned
    ? [C.pinnedRug, C.pinnedTrim]
    : C.rugs[hash(pod.id) % C.rugs.length];
  rug(d, 0, 0, pod.width, rugDepth, field, border);
  if (pod.pinned) d.pool(shade(C.lampPool, 0.5), 0, 0, pod.width + 1.6, rugDepth + 1.2);

  d.spot(pod.x, signZ);
  const board = pod.pinned ? C.pinnedTrim : C.sign;
  for (const side of [-1, 1]) d.s('post', C.signPost, side * 0.4, 0.17, -0.05, 0.05, 0.34);
  d.s('box', [shade(board, 0.8), board], 0, 0.3, -0.05, 1.0, 0.2, 0.05);
  if (!pod.pinned) return;
  // Brass stanchions and a velvet rope along the front of the pinned pod.
  const half = pod.width / 2 - 0.1;
  const posts = [-half, -0.75, 0.75, half];
  for (const px of posts) {
    d.s('cyl', C.pinnedTrim, px, 0.02, 0.15, 0.2, 0.04);
    d.s('post', C.pinnedTrim, px, 0.3, 0.15, 0.045, 0.6);
    d.s('ball', C.pinnedTrim, px, 0.62, 0.15, 0.08);
  }
  for (const [a, b] of [
    [posts[0], posts[1]],
    [posts[2], posts[3]],
  ]) {
    const n = 6;
    let prev = [a, 0.56, 0.15];
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      const cur = [a + (b - a) * u, 0.56 - 0.14 * Math.sin(Math.PI * u), 0.15];
      d.line(C.rope, prev, cur, 0.035);
      prev = cur;
    }
  }
}

// ── Desks ───────────────────────────────────────────────────
/** A desk slot. Its things follow the agent's name, so a desk keeps its mug and its duck. */
function desk(d: Decor, spot: DeskSpot, name: string): void {
  const r = rng(name);
  d.spot(spot.x, spot.z, 0, spot.scale);
  const seat = C.chairSeat[hash(name) % C.chairSeat.length];
  d.s('box', [shade(seat, 0.8), seat], 0, 0.435, SZ - 0.02, 0.5, 0.08, 0.46);
  d.s('box', [shade(seat, 0.75), seat], 0, 0.78, SZ - 0.27, 0.48, 0.5, 0.07, -0.1);
  d.s('post', C.chairBase, 0, 0.22, SZ - 0.02, 0.05, 0.36);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    d.s(
      'box',
      C.chairBase,
      Math.sin(a) * 0.15,
      0.04,
      SZ - 0.02 + Math.cos(a) * 0.15,
      0.04,
      0.035,
      0.3,
      0,
      a,
    );
  }
  d.s('box', C.deskTop, 0, DH - 0.025, DZ, 1.3, 0.05, 0.6);
  for (const side of [-1, 1]) {
    d.s('box', C.deskLeg, side * 0.61, (DH - 0.05) / 2, DZ, 0.04, DH - 0.05, 0.56);
  }
  d.s('box', shade(C.deskTop, 0.7), 0, DH * 0.62, DZ + 0.26, 1.18, DH * 0.5, 0.025);
  d.s('box', C.keyboard, -0.17, DH + 0.012, DZ - 0.12, 0.4, 0.022, 0.13, 0, -0.45);
  d.s('box', C.keyboard, 0.17, DH + 0.01, DZ - 0.1, 0.07, 0.02, 0.1);
  d.s('cyl', pick(C.mug, r()), 0.32, DH + 0.045, DZ - 0.12, 0.075, 0.09);
  d.nest(MONITOR);
  d.s('box', C.monitor, 0, 0.01, -0.03, 0.24, 0.02, 0.16);
  d.s('box', C.monitor, 0, 0.14, -0.05, 0.05, 0.26, 0.03);
  d.s('box', C.monitor, 0, SCREEN_Y, 0, 0.58, 0.36, 0.035);
  d.unnest();
  const places: Array<[number, number]> = [
    [0.5, DZ + 0.12],
    [0.15, DZ + 0.16],
  ];
  const kinds = [0, 1, 2, 3, 4].sort(() => r() - 0.5);
  const things = r() < 0.5 ? 1 : 2;
  for (let i = 0; i < things; i++) {
    const [x, z] = places[i];
    const y = DH;
    switch (kinds[i]) {
      case 0:
        d.s('cyl', C.pot, x, y + 0.06, z, 0.13, 0.12);
        d.s('ball', pick(C.leaves, r()), x, y + 0.17, z, 0.2, 0.16, 0.2);
        d.s('ball', pick(C.leaves, r()), x + 0.05, y + 0.23, z - 0.02, 0.12);
        break;
      case 1:
        for (let k = 0; k < 3; k++) {
          const tilt = (r() - 0.5) * 0.4;
          d.s(
            'box',
            pick(C.books, r()),
            x,
            y + 0.02 + k * 0.04,
            z,
            0.24 - k * 0.02,
            0.04,
            0.17,
            0,
            tilt,
          );
        }
        break;
      case 2:
        d.s('box', C.pictureFrame, x, y + 0.08, z, 0.16, 0.14, 0.02, -0.2, 0.25);
        d.s('box', pick(C.art, r()), x, y + 0.083, z + 0.012, 0.12, 0.1, 0.005, -0.2, 0.25);
        break;
      case 3:
        tableLamp(d, x, y, z);
        break;
      default:
        d.s('ball', C.duck, x, y + 0.05, z, 0.14, 0.1, 0.12);
        d.s('ball', C.duck, x, y + 0.12, z + 0.03, 0.09);
        d.s('cone', C.beak, x, y + 0.115, z + 0.085, 0.04, 0.05, 0.04, Math.PI / 2);
    }
  }
}

export interface OfficeFurniture {
  readonly group: Group;
  dispose(): void;
}

/** Build the still part of the office for a plan. `names` gives each desk's agent its name. */
export function buildOffice(
  plan: OfficePlan,
  names: ReadonlyMap<number, string>,
  light: Texture,
): OfficeFurniture {
  const d = new Decor();
  for (const room of plan.rooms) {
    const r = rng(room.id);
    const top = room.z - room.depth / 2;
    d.spot(room.x, room.z, 0, 1, 0);
    d.s('box', C.slabEdge, 0, FLOOR / 2, 0, room.width, FLOOR, room.depth);
    planks(d, r, room, room.background ? C.porchWood : C.floorWood, room.background ? 0.24 : 0.32);
    if (room.background) porchRail(d, r, room, top);
    else backWall(d, r, room, top);
    sidePads(d, r, room, top, room.background);
    nooks(d, r, room);
    for (const pod of room.pods) {
      podFloor(d, pod);
      for (const spot of pod.desks) desk(d, spot, names.get(spot.agentId) ?? '');
    }
  }

  const group = new Group();
  const materials = [
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }),
    new MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    new MeshBasicMaterial({
      vertexColors: true,
      map: light,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  ];
  [d.solid, d.glow, d.pools].forEach((builder, i) => {
    if (builder.empty) return;
    const mesh = new Mesh(builder.build(), materials[i]);
    mesh.castShadow = i === 0;
    mesh.receiveShadow = i === 0;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = i === 2 ? 1 : 0;
    group.add(mesh);
  });
  return {
    group,
    dispose() {
      for (const child of group.children) (child as Mesh).geometry.dispose();
      for (const material of materials) material.dispose();
      group.removeFromParent();
    },
  };
}
