/**
 * A kit of small, charming characters built from primitives. Each character is
 * one skinned mesh with rigid parts on ten bones, so a scene full of them costs
 * one draw call each. The kit knows nothing about desks, rooms or React: it
 * builds characters, and `characterPose` says where their bones go for a mood.
 */
import type { BufferGeometry } from 'three';
import {
  Bone,
  BoxGeometry,
  BufferAttribute,
  Color,
  CylinderGeometry,
  Euler,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Sphere,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const CHARACTER_KINDS = [
  'robot',
  'cat',
  'astronaut',
  'wizard',
  'chef',
  'dog',
  'penguin',
  'frog',
  'knight',
] as const;
export type CharacterKind = (typeof CHARACTER_KINDS)[number];

export const isCharacterKind = (value: unknown): value is CharacterKind =>
  (CHARACTER_KINDS as readonly unknown[]).includes(value);

/** Every kind the kit builds. Goblins are kept for sub-agent helpers, so nobody picks one. */
export type ActorKind = CharacterKind | 'goblin';

/** What a character is doing. The host maps its own states onto these. */
export type CharacterMood = 'work' | 'alert' | 'ask' | 'cheer' | 'rest' | 'doze';

/** Top of the seat a seated character sits on, in character units (about a metre tall). */
export const CHARACTER_SEAT_HEIGHT = 0.475;
/** How long the one-off cheer lasts before the host should switch to 'rest'. */
export const CHEER_SECONDS = 1.8;
/** Pose channels: fill a Float32Array of this length and pass it to `Character.apply`. */
export const POSE_SIZE = 16;

// ── Palette ─────────────────────────────────────────────────
const INK = 0x1c1a22;
const WHITE = 0xf7f5f0;
const SKIN = 0xf2c7a0;
const BLUSH = 0xf29a9a;
const PINK = 0xf5a3b5;
const GOLD = 0xf2c14e;
const STEEL = 0xb9c2cf;
const DARK_STEEL = 0x6b7482;

// ── Geometry building ───────────────────────────────────────
export type Prim = 'box' | 'sphere' | 'ball' | 'cyl' | 'post' | 'cone' | 'ring' | 'quad' | 'plane';
/** A flat colour, or a vertical gradient from the bottom to the top of the primitive. */
export type Paint = number | readonly [number, number];

const units = new Map<Prim, BufferGeometry>();
function unit(prim: Prim): BufferGeometry {
  let geo = units.get(prim);
  if (!geo) {
    geo = {
      box: () => new BoxGeometry(1, 1, 1),
      sphere: () => new SphereGeometry(0.5, 16, 12),
      ball: () => new SphereGeometry(0.5, 9, 7),
      cyl: () => new CylinderGeometry(0.5, 0.5, 1, 16),
      post: () => new CylinderGeometry(0.5, 0.5, 1, 6),
      cone: () => new CylinderGeometry(0, 0.5, 1, 14),
      ring: () => new TorusGeometry(0.5, 0.14, 6, 18).rotateX(Math.PI / 2),
      quad: () => new PlaneGeometry(1, 1),
      plane: () => new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    }[prim]();
    units.set(prim, geo);
  }
  return geo;
}

const M = new Matrix4();
const Q = new Quaternion();
const E = new Euler();
const P = new Vector3();
const S = new Vector3();
const UP = new Vector3(0, 1, 0);
const DIR = new Vector3();
const C0 = new Color();
const C1 = new Color();

/** A transform for one part: position, scale (size of the unit primitive), rotation. The matrix is shared. */
export function at(
  x: number,
  y: number,
  z: number,
  sx: number,
  sy = sx,
  sz = sx,
  rx = 0,
  ry = 0,
  rz = 0,
): Matrix4 {
  return M.compose(P.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz)), S.set(sx, sy, sz));
}

/** A transform that stretches a unit primitive from `a` to `b`, `thick` across. */
export function span(
  a: readonly number[],
  b: readonly number[],
  thick: number,
  depth = thick,
): Matrix4 {
  DIR.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = DIR.length();
  Q.setFromUnitVectors(UP, DIR.normalize());
  P.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return M.compose(P, Q, S.set(thick, len, depth));
}

/**
 * Collects primitives with baked transforms and vertex colours and merges them
 * into one geometry. With `skin`, every part is rigidly bound to one bone.
 */
export class PartBuilder {
  private readonly parts: BufferGeometry[] = [];
  private readonly uv: boolean;
  private readonly skin: boolean;

  constructor(opts: { uv?: boolean; skin?: boolean } = {}) {
    this.uv = opts.uv ?? false;
    this.skin = opts.skin ?? false;
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  add(prim: Prim, paint: Paint, matrix: Matrix4, bone = 0): this {
    const geo = unit(prim).clone();
    const pos = geo.attributes.position;
    const n = pos.count;
    const colors = new Float32Array(n * 3);
    C0.setHex(typeof paint === 'number' ? paint : paint[0]);
    C1.setHex(typeof paint === 'number' ? paint : paint[1]);
    for (let i = 0; i < n; i++) {
      const k = Math.min(1, Math.max(0, pos.getY(i) + 0.5));
      colors[i * 3] = C0.r + (C1.r - C0.r) * k;
      colors[i * 3 + 1] = C0.g + (C1.g - C0.g) * k;
      colors[i * 3 + 2] = C0.b + (C1.b - C0.b) * k;
    }
    geo.setAttribute('color', new BufferAttribute(colors, 3));
    if (!this.uv) geo.deleteAttribute('uv');
    if (this.skin) {
      const index = new Uint16Array(n * 4);
      const weight = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        index[i * 4] = bone;
        weight[i * 4] = 1;
      }
      geo.setAttribute('skinIndex', new BufferAttribute(index, 4));
      geo.setAttribute('skinWeight', new BufferAttribute(weight, 4));
    }
    geo.applyMatrix4(matrix);
    this.parts.push(geo);
    return this;
  }

  build(): BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    for (const part of this.parts) part.dispose();
    this.parts.length = 0;
    if (!merged) throw new Error('PartBuilder: parts do not share attributes');
    return merged;
  }
}

// ── Rig ─────────────────────────────────────────────────────
const ROOT = 0;
const BODY = 1;
const HEAD = 2;
const ARM_L = 3;
const ARM_R = 4;
const LEG_L = 5;
const LEG_R = 6;
const ACC = 7;
const EYES = 8;
const ACC2 = 9;

const HIP_Y = 0.3;
const NECK_Y = 0.62;
const HEAD_Y = 0.81;
const SHOULDER: readonly number[] = [0.205, 0.565, 0];
const HAND: readonly number[] = [0.235, 0.33, 0.01];
const LEG_X = 0.085;

type V3 = readonly [number, number, number];

interface KindSpec {
  label: string;
  coats: readonly number[];
  /** The swinging accessory (tail, hat, plume, antenna) and what it hangs from. */
  acc: { parent: typeof BODY | typeof HEAD; at: V3 };
  /** A part that puffs or blinks, always on the head. */
  acc2: V3;
  eyes: V3;
  build(d: Draw, coat: number): void;
}

/** Thin wrapper so the kind builders read as a list of parts. */
class Draw {
  private readonly b: PartBuilder;

  constructor(b: PartBuilder) {
    this.b = b;
  }

  part(prim: Prim, paint: Paint, bone: number, p: V3, s: V3, r: V3 = [0, 0, 0]): this {
    this.b.add(prim, paint, at(p[0], p[1], p[2], s[0], s[1], s[2], r[0], r[1], r[2]), bone);
    return this;
  }

  limb(
    prim: Prim,
    paint: Paint,
    bone: number,
    a: readonly number[],
    b: readonly number[],
    thick: number,
  ): this {
    this.b.add(prim, paint, span(a, b, thick), bone);
    return this;
  }

  /** Head-relative part: offsets from the head centre. */
  head(prim: Prim, paint: Paint, p: V3, s: V3, r: V3 = [0, 0, 0], bone = HEAD): this {
    return this.part(prim, paint, bone, [p[0], HEAD_Y + p[1], p[2]], s, r);
  }

  arms(sleeve: Paint, hand: Paint, thick = 0.1): this {
    for (const [side, bone] of [
      [1, ARM_L],
      [-1, ARM_R],
    ] as const) {
      this.limb(
        'sphere',
        sleeve,
        bone,
        [SHOULDER[0] * side, SHOULDER[1], 0],
        [HAND[0] * side, HAND[1] + 0.03, HAND[2]],
        thick,
      );
      this.part('ball', hand, bone, [HAND[0] * side, HAND[1], HAND[2]], [0.105, 0.105, 0.105]);
    }
    return this;
  }

  legs(leg: Paint, foot: Paint, thick = 0.12): this {
    for (const [side, bone] of [
      [1, LEG_L],
      [-1, LEG_R],
    ] as const) {
      this.limb(
        'sphere',
        leg,
        bone,
        [LEG_X * side, HIP_Y + 0.02, 0],
        [LEG_X * side, 0.07, 0],
        thick,
      );
      this.part('sphere', foot, bone, [LEG_X * side, 0.04, 0.035], [0.12, 0.08, 0.18]);
    }
    return this;
  }

  /** Two eyes on the eye bone, so a blink squashes them in place. */
  eyes(color: number, size = 0.055, spread = 0.075, z = 0.19, y = 0.02): this {
    for (const side of [1, -1]) {
      this.head(
        'ball',
        color,
        [spread * side, y, z],
        [size, size * 1.25, size * 0.6],
        [0, 0, 0],
        EYES,
      );
    }
    return this;
  }

  cheeks(color = BLUSH, spread = 0.12, y = -0.05, z = 0.16): this {
    for (const side of [1, -1])
      this.head('ball', color, [spread * side, y, z], [0.06, 0.035, 0.03]);
    return this;
  }
}

const SPECS: Record<ActorKind, KindSpec> = {
  robot: {
    label: 'Robot',
    coats: [0x8fa7c0, 0x7cc7ae, 0xe59a52],
    acc: { parent: HEAD, at: [0, HEAD_Y + 0.17, 0] },
    acc2: [0, HEAD_Y + 0.33, 0],
    eyes: [0, HEAD_Y + 0.01, 0.18],
    build(d, coat) {
      d.head('box', [coat, 0xdfe7ef], [0, 0, 0], [0.42, 0.34, 0.34]);
      d.head('box', 0x1d2633, [0, 0, 0.17], [0.34, 0.17, 0.02]);
      d.head('box', 0x6ff7ff, [0.075, 0.01, 0.185], [0.07, 0.06, 0.02], [0, 0, 0], EYES);
      d.head('box', 0x6ff7ff, [-0.075, 0.01, 0.185], [0.07, 0.06, 0.02], [0, 0, 0], EYES);
      d.head('cyl', DARK_STEEL, [0.22, 0, 0], [0.09, 0.05, 0.09], [0, 0, Math.PI / 2]);
      d.head('cyl', DARK_STEEL, [-0.22, 0, 0], [0.09, 0.05, 0.09], [0, 0, Math.PI / 2]);
      d.head('cyl', DARK_STEEL, [0, 0.235, 0], [0.025, 0.13, 0.025], [0, 0, 0], ACC);
      d.head('ball', 0xff5a4f, [0, 0.33, 0], [0.085, 0.085, 0.085], [0, 0, 0], ACC2);
      d.part('box', [coat, 0xdfe7ef], BODY, [0, 0.45, 0], [0.36, 0.33, 0.26]);
      d.part('box', 0x2b3442, BODY, [0, 0.47, 0.13], [0.2, 0.13, 0.02]);
      d.part('ball', 0xff5a4f, BODY, [-0.05, 0.47, 0.145], [0.035, 0.035, 0.02]);
      d.part('ball', 0xffd84f, BODY, [0, 0.47, 0.145], [0.035, 0.035, 0.02]);
      d.part('ball', 0x5fe08a, BODY, [0.05, 0.47, 0.145], [0.035, 0.035, 0.02]);
      d.arms(STEEL, DARK_STEEL, 0.08);
      d.legs(STEEL, DARK_STEEL, 0.1);
    },
  },
  cat: {
    label: 'Cat',
    coats: [0xeb9a4f, 0x9b9ea6, 0x3d383a],
    acc: { parent: BODY, at: [0.1, 0.33, -0.12] },
    acc2: [0, HEAD_Y + 0.2, 0],
    eyes: [0, HEAD_Y + 0.02, 0.19],
    build(d, coat) {
      d.head('sphere', coat, [0, 0, 0], [0.46, 0.4, 0.4]);
      d.head('sphere', WHITE, [0, -0.07, 0.15], [0.18, 0.11, 0.1]);
      d.head('ball', PINK, [0, -0.025, 0.2], [0.05, 0.035, 0.03]);
      for (const side of [1, -1]) {
        d.head('cone', coat, [0.12 * side, 0.2, 0], [0.15, 0.17, 0.08], [0, 0, -0.35 * side], ACC2);
        d.head(
          'cone',
          PINK,
          [0.118 * side, 0.19, 0.03],
          [0.08, 0.11, 0.02],
          [0, 0, -0.35 * side],
          ACC2,
        );
        for (const tilt of [0.12, -0.08]) {
          d.head(
            'box',
            INK,
            [0.16 * side, -0.06 + tilt * 0.2, 0.16],
            [0.12, 0.006, 0.006],
            [0, 0, tilt * side],
          );
        }
      }
      d.eyes(0x2a3a1a, 0.06);
      d.cheeks();
      d.part('sphere', coat, BODY, [0, 0.45, 0], [0.34, 0.42, 0.28]);
      d.part('sphere', WHITE, BODY, [0, 0.43, 0.1], [0.2, 0.28, 0.1]);
      d.arms(coat, WHITE);
      d.legs(coat, WHITE);
      const base: V3 = [0.1, 0.33, -0.12];
      d.limb('sphere', coat, ACC, base, [0.27, 0.42, -0.2], 0.075);
      d.limb('sphere', coat, ACC, [0.27, 0.42, -0.2], [0.33, 0.66, -0.16], 0.075);
      d.part('ball', coat === WHITE ? INK : WHITE, ACC, [0.335, 0.69, -0.15], [0.08, 0.09, 0.08]);
    },
  },
  astronaut: {
    label: 'Astronaut',
    coats: [0xf08a24, 0x3d7bd9, 0xd9443d],
    acc: { parent: HEAD, at: [0.17, HEAD_Y + 0.12, -0.04] },
    acc2: [0.21, HEAD_Y + 0.28, -0.05],
    eyes: [0, HEAD_Y + 0.02, 0.2],
    build(d, coat) {
      d.head('sphere', [0xdedede, WHITE], [0, 0.01, 0], [0.5, 0.48, 0.48]);
      d.head('sphere', [0x0f1a33, 0x2c4373], [0, 0, 0.1], [0.38, 0.3, 0.3]);
      d.head('ball', 0xbfefff, [0.07, 0.02, 0.24], [0.05, 0.07, 0.02], [0, 0, 0], EYES);
      d.head('ball', 0xbfefff, [-0.07, 0.02, 0.24], [0.05, 0.07, 0.02], [0, 0, 0], EYES);
      d.head('ball', WHITE, [-0.1, 0.08, 0.235], [0.06, 0.03, 0.02], [0, 0, 0.5]);
      d.head('ring', coat, [0, -0.22, 0], [0.34, 0.34, 0.34]);
      d.head('cyl', 0x9aa0a8, [0.21, 0.2, -0.05], [0.02, 0.16, 0.02], [0, 0, 0], ACC);
      d.head('ball', coat, [0.21, 0.28, -0.05], [0.06, 0.06, 0.06], [0, 0, 0], ACC2);
      d.part('box', [0xdedede, WHITE], BODY, [0, 0.45, 0], [0.38, 0.34, 0.28]);
      d.part('box', 0xdedede, BODY, [0, 0.47, -0.19], [0.32, 0.36, 0.14]);
      d.part('box', coat, BODY, [0, 0.46, 0.145], [0.18, 0.11, 0.03]);
      d.part('ball', 0x5fe08a, BODY, [-0.04, 0.47, 0.165], [0.03, 0.03, 0.02]);
      d.part('ball', 0xffd84f, BODY, [0.04, 0.47, 0.165], [0.03, 0.03, 0.02]);
      d.arms(WHITE, coat, 0.12);
      d.legs(WHITE, coat, 0.13);
    },
  },
  wizard: {
    label: 'Wizard',
    coats: [0x5b3fa0, 0x2f5fa8, 0x2f7a4f],
    acc: { parent: HEAD, at: [0, HEAD_Y + 0.13, 0] },
    acc2: [0, HEAD_Y + 0.2, 0.2],
    eyes: [0, HEAD_Y + 0.03, 0.18],
    build(d, coat) {
      d.head('sphere', SKIN, [0, 0, 0], [0.38, 0.38, 0.38]);
      d.head('cone', [0xd9d9d9, WHITE], [0, -0.16, 0.11], [0.28, 0.3, 0.16], [Math.PI, 0, 0]);
      d.head('sphere', WHITE, [0.05, -0.05, 0.17], [0.1, 0.05, 0.05], [0, 0, -0.3]);
      d.head('sphere', WHITE, [-0.05, -0.05, 0.17], [0.1, 0.05, 0.05], [0, 0, 0.3]);
      d.head('ball', 0xe8a98a, [0, -0.005, 0.2], [0.06, 0.06, 0.06]);
      d.eyes(INK, 0.045, 0.07, 0.17, 0.04);
      d.head('cyl', coat, [0, 0.14, 0], [0.56, 0.035, 0.56], [0, 0, 0], ACC);
      d.head('cone', coat, [0, 0.33, -0.02], [0.32, 0.38, 0.32], [-0.12, 0, 0], ACC);
      d.head('cone', coat, [0, 0.55, -0.1], [0.12, 0.16, 0.12], [-0.6, 0, 0], ACC);
      d.head('ball', GOLD, [0.08, 0.3, 0.12], [0.06, 0.06, 0.03], [0, 0, 0.4], ACC);
      d.head('ball', GOLD, [-0.07, 0.4, 0.07], [0.04, 0.04, 0.02], [0, 0, 0.4], ACC);
      d.head('ring', GOLD, [0, 0.165, 0], [0.33, 0.2, 0.33], [0, 0, 0], ACC);
      d.part('cone', coat, BODY, [0, 0.36, 0], [0.42, 0.56, 0.36]);
      d.part('ring', GOLD, BODY, [0, 0.42, 0], [0.27, 0.3, 0.22]);
      d.arms(coat, SKIN, 0.12);
      d.legs(coat, 0x4a3328);
    },
  },
  chef: {
    label: 'Chef',
    coats: [0xd63c3c, 0x2f6fd6, 0x3aa35a],
    acc: { parent: HEAD, at: [0, HEAD_Y + 0.17, 0] },
    acc2: [0, HEAD_Y + 0.37, 0],
    eyes: [0, HEAD_Y + 0.03, 0.18],
    build(d, coat) {
      d.head('sphere', SKIN, [0, 0, 0], [0.4, 0.38, 0.38]);
      d.head('ball', 0xe8a98a, [0, -0.01, 0.2], [0.075, 0.07, 0.07]);
      d.head('sphere', 0x4a2e1e, [0.06, -0.06, 0.18], [0.11, 0.045, 0.05], [0, 0, -0.35]);
      d.head('sphere', 0x4a2e1e, [-0.06, -0.06, 0.18], [0.11, 0.045, 0.05], [0, 0, 0.35]);
      d.eyes(INK, 0.045, 0.07, 0.175, 0.05);
      d.cheeks();
      d.head('cyl', WHITE, [0, 0.2, 0], [0.32, 0.14, 0.32], [0, 0, 0], ACC);
      for (const [x, z] of [
        [0.08, 0.04],
        [-0.08, 0.04],
        [0, -0.07],
        [0, 0.08],
      ]) {
        d.head('sphere', WHITE, [x, 0.34, z], [0.22, 0.2, 0.22], [0, 0, 0], ACC2);
      }
      d.part('sphere', [0xe6e6e6, WHITE], BODY, [0, 0.45, 0], [0.36, 0.42, 0.3]);
      d.part('cone', coat, BODY, [0, 0.6, 0.08], [0.2, 0.1, 0.12], [Math.PI + 0.3, 0, 0]);
      for (const y of [0.5, 0.42, 0.34]) {
        d.part('ball', INK, BODY, [0.045, y, 0.145], [0.025, 0.025, 0.02]);
        d.part('ball', INK, BODY, [-0.045, y, 0.145], [0.025, 0.025, 0.02]);
      }
      d.arms(WHITE, SKIN);
      d.legs(0x3a3a44, INK);
    },
  },
  dog: {
    label: 'Dog',
    coats: [0xc98f55, 0xf0e4d2, 0x4a3d36],
    acc: { parent: BODY, at: [0.06, 0.38, -0.13] },
    acc2: [0, HEAD_Y + 0.05, 0],
    eyes: [0, HEAD_Y + 0.04, 0.18],
    build(d, coat) {
      const ear = coat === 0xf0e4d2 ? 0x8a5a3a : coat === 0x4a3d36 ? 0x2c2420 : 0x8f5f36;
      d.head('sphere', coat, [0, 0, 0], [0.42, 0.4, 0.4]);
      d.head('sphere', 0xf3e7d6, [0, -0.07, 0.15], [0.2, 0.15, 0.17]);
      d.head('ball', INK, [0, -0.03, 0.235], [0.07, 0.05, 0.05]);
      d.head('box', PINK, [0, -0.13, 0.2], [0.05, 0.05, 0.015], [0.2, 0, 0]);
      for (const side of [1, -1]) {
        d.head(
          'sphere',
          ear,
          [0.2 * side, -0.04, -0.01],
          [0.09, 0.26, 0.15],
          [0, 0, 0.3 * side],
          ACC2,
        );
      }
      d.eyes(INK, 0.05, 0.08, 0.17, 0.05);
      d.head('ring', 0xd63c3c, [0, -0.2, 0], [0.3, 0.3, 0.3]);
      d.head('ball', GOLD, [0, -0.25, 0.14], [0.05, 0.05, 0.02]);
      d.part('sphere', coat, BODY, [0, 0.45, 0], [0.34, 0.4, 0.3]);
      d.part('sphere', 0xf3e7d6, BODY, [0, 0.43, 0.1], [0.2, 0.26, 0.1]);
      d.arms(coat, 0xf3e7d6);
      d.legs(coat, 0xf3e7d6);
      d.limb('sphere', ear, ACC, [0.06, 0.38, -0.13], [0.2, 0.62, -0.2], 0.07);
    },
  },
  penguin: {
    label: 'Penguin',
    coats: [0x23262e, 0x2d4a73, 0x3b3550],
    acc: { parent: BODY, at: [0, 0.6, 0.14] },
    acc2: [0, HEAD_Y - 0.03, 0.2],
    eyes: [0, HEAD_Y + 0.04, 0.17],
    build(d, coat) {
      d.head('sphere', coat, [0, 0, 0], [0.42, 0.4, 0.4]);
      d.head('sphere', WHITE, [0.065, 0.02, 0.12], [0.16, 0.2, 0.16]);
      d.head('sphere', WHITE, [-0.065, 0.02, 0.12], [0.16, 0.2, 0.16]);
      d.head('cone', 0xf5a623, [0, -0.04, 0.24], [0.1, 0.12, 0.06], [Math.PI / 2, 0, 0], ACC2);
      d.eyes(INK, 0.045, 0.07, 0.2, 0.04);
      d.cheeks(0xf7b5c2, 0.13, -0.06, 0.15);
      d.part('sphere', coat, BODY, [0, 0.4, 0], [0.42, 0.56, 0.36]);
      d.part('sphere', WHITE, BODY, [0, 0.38, 0.1], [0.3, 0.44, 0.2]);
      d.part('cone', 0xd63c3c, ACC, [0.045, 0.6, 0.17], [0.07, 0.08, 0.04], [0, 0, Math.PI / 2]);
      d.part('cone', 0xd63c3c, ACC, [-0.045, 0.6, 0.17], [0.07, 0.08, 0.04], [0, 0, -Math.PI / 2]);
      for (const [side, bone] of [
        [1, ARM_L],
        [-1, ARM_R],
      ] as const) {
        d.part(
          'sphere',
          coat,
          bone,
          [0.22 * side, 0.42, 0],
          [0.07, 0.3, 0.16],
          [0, 0, 0.25 * side],
        );
        d.part(
          'sphere',
          0xf5a623,
          side === 1 ? LEG_L : LEG_R,
          [0.09 * side, 0.03, 0.06],
          [0.12, 0.05, 0.2],
        );
      }
    },
  },
  frog: {
    label: 'Frog',
    coats: [0x5fae4e, 0x3b8fd9, 0xd9a43b],
    acc: { parent: HEAD, at: [0, HEAD_Y + 0.12, 0] },
    acc2: [0, HEAD_Y - 0.12, 0.1],
    eyes: [0, HEAD_Y + 0.15, 0.13],
    build(d, coat) {
      const belly = 0xeef2c8;
      d.head('sphere', coat, [0, 0, 0], [0.5, 0.32, 0.4]);
      for (const side of [1, -1]) {
        d.head('sphere', coat, [0.11 * side, 0.13, 0.06], [0.16, 0.15, 0.15]);
        d.head('sphere', WHITE, [0.11 * side, 0.15, 0.12], [0.11, 0.11, 0.06], [0, 0, 0], EYES);
        d.head('ball', INK, [0.11 * side, 0.15, 0.15], [0.055, 0.065, 0.03], [0, 0, 0], EYES);
      }
      d.head('sphere', 0x7a2e2e, [0, -0.06, 0.18], [0.2, 0.02, 0.04]);
      d.cheeks(0xf29a9a, 0.15, -0.03, 0.15);
      d.head('sphere', belly, [0, -0.12, 0.1], [0.2, 0.1, 0.14], [0, 0, 0], ACC2);
      d.head('cyl', GOLD, [0, 0.17, -0.04], [0.15, 0.05, 0.15], [0, 0, 0], ACC);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        d.head(
          'cone',
          GOLD,
          [0.06 * Math.sin(a), 0.22, -0.04 + 0.06 * Math.cos(a)],
          [0.04, 0.06, 0.04],
          [0, 0, 0],
          ACC,
        );
      }
      d.part('sphere', coat, BODY, [0, 0.43, 0], [0.38, 0.38, 0.3]);
      d.part('sphere', belly, BODY, [0, 0.41, 0.1], [0.24, 0.26, 0.12]);
      d.arms(coat, coat);
      d.legs(coat, coat, 0.13);
    },
  },
  knight: {
    label: 'Knight',
    coats: [0xc8322f, 0x2f5fc8, 0xe0a82e],
    acc: { parent: HEAD, at: [0, HEAD_Y + 0.2, -0.02] },
    acc2: [0, HEAD_Y + 0.03, 0.2],
    eyes: [0, HEAD_Y + 0.03, 0.2],
    build(d, coat) {
      d.head('cyl', [DARK_STEEL, STEEL], [0, -0.03, 0], [0.4, 0.34, 0.4]);
      d.head('sphere', STEEL, [0, 0.13, 0], [0.4, 0.26, 0.4]);
      d.head('box', 0x15161b, [0, 0.03, 0.195], [0.26, 0.045, 0.03], [0, 0, 0], EYES);
      d.head('box', 0x15161b, [0, -0.06, 0.195], [0.035, 0.12, 0.03]);
      d.head('box', DARK_STEEL, [0, 0.1, 0.2], [0.04, 0.14, 0.02]);
      d.head('sphere', coat, [0, 0.29, 0.02], [0.08, 0.16, 0.16], [0.3, 0, 0], ACC);
      d.head('sphere', coat, [0, 0.3, -0.12], [0.08, 0.16, 0.18], [-0.5, 0, 0], ACC);
      d.head('sphere', coat, [0, 0.21, -0.24], [0.07, 0.14, 0.16], [-1.1, 0, 0], ACC);
      d.part('box', [DARK_STEEL, STEEL], BODY, [0, 0.45, 0], [0.36, 0.34, 0.27]);
      d.part('box', coat, BODY, [0, 0.42, 0.14], [0.22, 0.3, 0.02]);
      d.part('box', GOLD, BODY, [0, 0.45, 0.152], [0.04, 0.18, 0.01]);
      d.part('box', GOLD, BODY, [0, 0.48, 0.152], [0.13, 0.04, 0.01]);
      for (const side of [1, -1]) {
        d.part(
          'sphere',
          STEEL,
          side === 1 ? ARM_L : ARM_R,
          [0.2 * side, 0.58, 0],
          [0.16, 0.12, 0.18],
        );
      }
      d.arms(STEEL, DARK_STEEL, 0.1);
      d.legs(STEEL, DARK_STEEL);
    },
  },
  goblin: {
    label: 'Goblin',
    coats: [0x7bb04a, 0x5f9e5a, 0x9bb83c],
    acc: { parent: HEAD, at: [0, HEAD_Y + 0.2, -0.02] },
    acc2: [0, HEAD_Y + 0.03, 0],
    eyes: [0, HEAD_Y + 0.04, 0.17],
    build(d, coat) {
      const leather = 0x7a4f2c;
      d.head('sphere', coat, [0, 0, 0], [0.4, 0.36, 0.36]);
      for (const side of [1, -1]) {
        d.head('cone', coat, [0.25 * side, 0.03, 0], [0.1, 0.3, 0.06], [0, 0, -1.25 * side], ACC2);
        d.head(
          'cone',
          PINK,
          [0.24 * side, 0.03, 0.02],
          [0.05, 0.18, 0.02],
          [0, 0, -1.25 * side],
          ACC2,
        );
      }
      d.eyes(0xffd84f, 0.07, 0.085, 0.16, 0.04);
      d.head('ball', INK, [0.085, 0.04, 0.2], [0.03, 0.04, 0.02]);
      d.head('ball', INK, [-0.085, 0.04, 0.2], [0.03, 0.04, 0.02]);
      d.head('cone', coat, [0, -0.02, 0.2], [0.08, 0.14, 0.08], [1.35, 0, 0]);
      d.head('box', WHITE, [0.05, -0.12, 0.165], [0.035, 0.04, 0.02]);
      d.head('box', WHITE, [-0.05, -0.12, 0.165], [0.035, 0.04, 0.02]);
      d.head('cone', leather, [0, 0.2, -0.02], [0.3, 0.22, 0.3], [-0.2, 0, 0], ACC);
      d.part('sphere', leather, BODY, [0, 0.44, 0], [0.32, 0.36, 0.26]);
      d.part('box', 0x4a3020, BODY, [0, 0.36, 0.01], [0.33, 0.05, 0.27]);
      d.part('box', GOLD, BODY, [0, 0.36, 0.14], [0.06, 0.05, 0.01]);
      d.arms(coat, coat, 0.09);
      d.limb(
        'cyl',
        0x8a6a45,
        ARM_R,
        [-HAND[0], HAND[1], HAND[2] - 0.02],
        [-HAND[0], HAND[1], 0.26],
        0.035,
      );
      d.part('box', DARK_STEEL, ARM_R, [-HAND[0], HAND[1], 0.27], [0.08, 0.16, 0.09]);
      d.legs(0x4a3020, leather, 0.1);
    },
  },
};

export const characterLabel = (kind: ActorKind): string => SPECS[kind].label;

/** FNV-1a: stable across reloads, servers and browsers. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const defaultCharacterKind = (name: string): CharacterKind =>
  CHARACTER_KINDS[hash(name) % CHARACTER_KINDS.length];

/** Which of a kind's colourways a name wears. */
export const characterVariant = (name: string): number => (hash(name) >>> 8) % 3;

/** A seed in [0, 1) that spreads idle gestures of different characters apart. */
export const characterSeed = (name: string): number => (hash(name) >>> 4) / 0x10000000;

// ── Characters ──────────────────────────────────────────────
const BOUNDS = new Sphere(new Vector3(0, 0.75, 0), 1.1);

export class Character {
  readonly mesh: SkinnedMesh;
  private readonly bones: Bone[];

  constructor(geometry: BufferGeometry, material: MeshStandardMaterial, spec: KindSpec) {
    const rest: V3[] = [
      [0, 0, 0],
      [0, HIP_Y, 0],
      [0, NECK_Y, 0],
      [SHOULDER[0], SHOULDER[1], 0],
      [-SHOULDER[0], SHOULDER[1], 0],
      [LEG_X, HIP_Y, 0],
      [-LEG_X, HIP_Y, 0],
      spec.acc.at,
      spec.eyes,
      spec.acc2,
    ];
    const parents = [-1, ROOT, BODY, BODY, BODY, ROOT, ROOT, spec.acc.parent, HEAD, HEAD];
    this.bones = rest.map(() => new Bone());
    this.bones.forEach((bone, i) => {
      const parent = parents[i];
      const [x, y, z] = rest[i];
      if (parent < 0) {
        bone.position.set(x, y, z);
        return;
      }
      const [px, py, pz] = rest[parent];
      bone.position.set(x - px, y - py, z - pz);
      this.bones[parent].add(bone);
    });
    this.mesh = new SkinnedMesh(geometry, material);
    this.mesh.add(this.bones[ROOT]);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new Skeleton(this.bones));
    this.mesh.boundingSphere = BOUNDS;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
  }

  apply(p: ArrayLike<number>): void {
    const b = this.bones;
    b[ROOT].position.y = p[ROOT_Y];
    b[ROOT].rotation.y = p[YAW];
    b[BODY].rotation.set(p[BODY_X], 0, p[BODY_Z]);
    b[HEAD].rotation.set(p[HEAD_X], p[HEAD_TURN], p[HEAD_Z]);
    b[ARM_L].rotation.set(p[ARM_L_X], 0, p[ARM_L_Z]);
    b[ARM_R].rotation.set(p[ARM_R_X], 0, -p[ARM_R_Z]);
    const legs = -1.45 * p[SIT];
    b[LEG_L].rotation.set(legs, 0, 0.08 * p[SIT]);
    b[LEG_R].rotation.set(legs, 0, -0.08 * p[SIT]);
    b[ACC].rotation.set(p[ACC_X], 0, p[ACC_Z]);
    b[EYES].scale.set(1, p[EYES_S], 1);
    b[ACC2].scale.setScalar(p[ACC2_S]);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.skeleton.dispose();
  }
}

/** Builds characters; geometry is shared per kind and colourway, the material by all. */
export class CharacterKit {
  readonly material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
  private readonly geometries = new Map<string, BufferGeometry>();

  create(kind: ActorKind, variant: number): Character {
    const spec = SPECS[kind];
    const coat = spec.coats[variant % spec.coats.length];
    const key = `${kind}:${coat}`;
    let geometry = this.geometries.get(key);
    if (!geometry) {
      const builder = new PartBuilder({ skin: true });
      spec.build(new Draw(builder), coat);
      geometry = builder.build();
      this.geometries.set(key, geometry);
    }
    return new Character(geometry, this.material, spec);
  }

  dispose(): void {
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
    this.material.dispose();
  }
}

// ── Poses ───────────────────────────────────────────────────
const SIT = 0;
const ROOT_Y = 1;
const YAW = 2;
const BODY_X = 3;
const BODY_Z = 4;
const HEAD_X = 5;
const HEAD_TURN = 6;
const HEAD_Z = 7;
const ARM_L_X = 8;
const ARM_L_Z = 9;
const ARM_R_X = 10;
const ARM_R_Z = 11;
const ACC_X = 12;
const ACC_Z = 13;
const EYES_S = 14;
const ACC2_S = 15;

const SEATED_Y = CHARACTER_SEAT_HEIGHT - HIP_Y;

// sit, rootY, yaw, bodyX, bodyZ, headX, headTurn, headZ, armLX, armLZ, armRX, armRZ (positive = out)
type Base = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const SEATED: Record<CharacterMood, Base> = {
  work: [1, SEATED_Y, -0.45, 0.12, 0, 0.12, 0, 0, -1.25, -0.12, -1.25, -0.12],
  alert: [0, CHARACTER_SEAT_HEIGHT, 0, -0.05, 0, -0.18, 0, 0.08, -0.15, 0.3, -2.85, 0.25],
  ask: [1, SEATED_Y, 0, -0.04, 0, -0.06, 0, 0.22, -0.3, 0.1, -1.55, -0.05],
  cheer: [0.5, SEATED_Y, 0, -0.1, 0, -0.2, 0, 0, -2.7, 0.5, -2.7, 0.5],
  rest: [1, SEATED_Y, 0.15, -0.2, 0, -0.12, 0, 0.06, -0.65, -0.35, -0.65, -0.35],
  doze: [1, SEATED_Y, 0.1, 0.18, 0.05, 0.42, 0, 0.15, -0.5, -0.1, -0.5, -0.1],
};

const STANDING: Record<CharacterMood, Base> = {
  work: [0, 0, 0, 0.08, 0, 0.35, 0, 0, -1.0, -0.2, -1.0, -0.2],
  alert: [0, 0, 0, -0.05, 0, -0.18, 0, 0.08, -0.15, 0.3, -2.85, 0.25],
  ask: [0, 0, 0, 0, 0, -0.06, 0, 0.22, -0.2, 0.1, -1.55, -0.05],
  cheer: [0, 0, 0, -0.1, 0, -0.2, 0, 0, -2.7, 0.5, -2.7, 0.5],
  rest: [0, 0, 0, 0, 0, -0.05, 0, 0.05, -0.1, 0.12, -0.1, 0.12],
  doze: [0, 0, 0, 0.1, 0, 0.45, 0, 0.12, 0, 0.05, 0, 0.05],
};

/** Idle gestures run in a short window every few seconds, so a calm office can stop drawing. */
const IDLE_WINDOW = 1.4;
const idlePeriod = (seed: number): number => 7 + 4 * ((seed * 7.31) % 1);

/** Seconds into the current idle window, or -1 outside one. */
function idleTime(t: number, seed: number): number {
  const period = idlePeriod(seed);
  const u = (((t / period + seed) % 1) + 1) % 1;
  const local = u * period;
  return local < IDLE_WINDOW ? local : -1;
}

/** Seconds until the next idle window opens (0 while one is open). */
export function nextIdleIn(t: number, seed: number): number {
  const period = idlePeriod(seed);
  const u = (((t / period + seed) % 1) + 1) % 1;
  const local = u * period;
  return local < IDLE_WINDOW ? 0 : period - local;
}

const LOOPING: ReadonlySet<CharacterMood> = new Set(['work', 'alert', 'cheer']);

/** Whether the pose changes with time right now; false means the host may stop drawing. */
export function characterMoving(
  mood: CharacterMood,
  t: number,
  seed: number,
  reduced: boolean,
): boolean {
  if (reduced) return false;
  return LOOPING.has(mood) || idleTime(t, seed) >= 0;
}

export interface PoseOptions {
  /** On a chair (desk agents) or on the floor (helpers). */
  seated: boolean;
  /** prefers-reduced-motion: the pose for the mood, with no motion layered on. */
  reduced: boolean;
}

/**
 * Write the pose for `mood` at time `t` (seconds) into `out`. `moodTime` is how
 * long the mood has lasted, which only the cheer uses. Under reduced motion
 * the pose is still and a cheer is the rest pose.
 */
export function characterPose(
  kind: ActorKind,
  mood: CharacterMood,
  t: number,
  moodTime: number,
  seed: number,
  opts: PoseOptions,
  out: Float32Array,
): void {
  const effective = opts.reduced && mood === 'cheer' ? 'rest' : mood;
  const base = (opts.seated ? SEATED : STANDING)[effective];
  for (let i = 0; i < base.length; i++) out[i] = base[i];
  out[ACC_X] = 0;
  out[ACC_Z] = 0;
  out[EYES_S] = effective === 'doze' ? 0.12 : 1;
  out[ACC2_S] = 1;
  if (opts.reduced) return;

  const s = seed * Math.PI * 2;
  if (effective === 'work' && kind === 'goblin' && !opts.seated) {
    // Hammering: wind up high, strike low.
    const swing = Math.sin(t * 12 + s);
    out[ARM_R_X] = -1.5 + 0.9 * swing;
    out[BODY_X] += 0.08 * swing;
    out[HEAD_X] += 0.05 * swing;
  } else if (effective === 'work') {
    const speed = opts.seated ? 14 : 11;
    out[ARM_L_X] += 0.1 * Math.sin(t * speed + s);
    out[ARM_R_X] += 0.1 * Math.sin(t * speed + s + 2.1);
    out[HEAD_X] += 0.03 * Math.sin(t * 1.7 + s);
    if (!opts.seated) out[ROOT_Y] += 0.02 * Math.abs(Math.sin(t * 5 + s));
  } else if (effective === 'alert') {
    out[ARM_R_Z] += 0.35 * Math.sin(t * 8 + s);
    out[BODY_Z] += 0.04 * Math.sin(t * 8 + s);
  } else if (effective === 'cheer') {
    const k = Math.min(1, moodTime / CHEER_SECONDS);
    const hop = Math.abs(Math.sin(k * Math.PI * 3)) * (1 - k);
    out[ROOT_Y] += 0.2 * hop;
    out[SIT] *= 1 - hop;
    out[BODY_Z] += 0.12 * Math.sin(k * Math.PI * 6);
    out[ARM_L_Z] += 0.25 * Math.sin(k * Math.PI * 6);
    out[ARM_R_Z] += 0.25 * Math.sin(k * Math.PI * 6 + 1);
    return;
  }

  const u = idleTime(t, seed);
  if (u < 0) return;
  const e = Math.sin((Math.PI * u) / IDLE_WINDOW);
  if (effective !== 'doze' && Math.abs(u - 0.4) < 0.07) out[EYES_S] = 0.1;
  if (effective === 'ask') out[ARM_R_X] += 0.3 * e * Math.sin(u * 9);
  if (effective === 'doze') {
    out[HEAD_X] -= 0.12 * e;
    return;
  }
  switch (kind) {
    case 'robot':
      out[ACC_Z] = 0.3 * e * Math.sin(u * 10);
      out[ACC2_S] = 1 + 0.5 * e;
      out[HEAD_Z] += 0.15 * e;
      break;
    case 'cat':
      out[ACC_Z] = 0.5 * e * Math.sin(u * 6);
      out[HEAD_Z] += 0.12 * e;
      break;
    case 'astronaut':
      out[HEAD_TURN] += 0.45 * e * Math.sin(u * 3);
      out[ACC2_S] = 1 + 0.4 * e;
      break;
    case 'wizard':
      out[ACC_X] = 0.25 * e * Math.sin(u * 7);
      out[ACC_Z] = 0.15 * e * Math.sin(u * 5);
      break;
    case 'chef':
      out[ACC2_S] = 1 + 0.15 * e * Math.sin(u * 9);
      out[HEAD_Z] += 0.1 * e;
      break;
    case 'dog':
      out[ACC_Z] = 0.6 * e * Math.sin(u * 16);
      out[HEAD_Z] += 0.2 * e;
      break;
    case 'penguin': {
      const flap = 0.45 * e * Math.abs(Math.sin(u * 10));
      out[ARM_L_Z] += flap;
      out[ARM_R_Z] += flap;
      break;
    }
    case 'frog':
      out[ACC2_S] = 1 + 0.6 * e;
      break;
    case 'knight':
      out[ACC_X] = 0.3 * e * Math.sin(u * 6);
      break;
    case 'goblin':
      out[ACC2_S] = 1 + 0.2 * e * Math.sin(u * 12);
      out[HEAD_TURN] += 0.4 * e * Math.sin(u * 4);
      break;
  }
}
