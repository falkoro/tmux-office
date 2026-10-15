import type { Texture } from 'three';
import {
  Box3,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  MathUtils,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  MOUSE,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Raycaster,
  Scene,
  Spherical,
  SRGBColorSpace,
  TOUCH,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

import {
  OFFICE3D_CAMERA_FOV,
  OFFICE3D_CAMERA_MAX_POLAR,
  OFFICE3D_CAMERA_MIN_DISTANCE,
  OFFICE3D_CAMERA_POLAR,
  OFFICE3D_CAMERA_POLAR_NARROW,
  OFFICE3D_CLICK_SLOP_PX,
  OFFICE3D_COLORS as C,
  OFFICE3D_COMPACT_LABEL_PX,
  OFFICE3D_DESK_PITCH_X,
  OFFICE3D_FIT_MARGIN,
  OFFICE3D_FLOOR_Y as FLOOR,
  OFFICE3D_FOCUS_DURATION_MS,
  OFFICE3D_FULL_LABEL_PX,
  OFFICE3D_HELPER_SCALE,
  OFFICE3D_HELPERS_PER_COLUMN,
  OFFICE3D_INSET_BOTTOM_PX,
  OFFICE3D_INSET_SIDE_PX,
  OFFICE3D_INSET_TOP_PX,
  OFFICE3D_MAX_PIXEL_RATIO,
  OFFICE3D_MIN_PIXEL_RATIO,
  OFFICE3D_NARROW_ASPECT,
  OFFICE3D_PIXEL_RATIO_STEP,
  OFFICE3D_POD_SIGN_DEPTH,
  OFFICE3D_POSE_BLEND_S,
  OFFICE3D_ROOM_GAP,
  OFFICE3D_SEAT_Z as SEAT_Z,
  OFFICE3D_SLOW_FRAME_MS,
  OFFICE3D_SMOOTH_FRAME_MS,
  OFFICE3D_STATS_INTERVAL_MS,
  OFFICE3D_WALL_HEIGHT,
} from '../constants.js';
import { loadCharacter, saveCharacter } from './characterChoice.js';
import type {
  ActorKind,
  Character,
  CharacterKind,
  CharacterMood,
  PoseOptions,
} from './characters.js';
import {
  CHARACTER_KINDS,
  CharacterKit,
  characterLabel,
  characterMoving,
  characterPose,
  characterSeed,
  characterVariant,
  CHEER_SECONDS,
  isCharacterKind,
  nextIdleIn,
  POSE_SIZE,
} from './characters.js';
import type { DeskLight } from './effects.js';
import { Effects } from './effects.js';
import type { OfficeFurniture } from './furniture.js';
import { buildOffice, radialTexture } from './furniture.js';
import type { DeskSpot, OfficePlan, PodSpot, RoomSpot } from './layout.js';
import { planOffice } from './layout.js';
import type { DeskModel, DeskStatus, HelperModel, PodModel, RoomModel } from './model.js';
import { BACKGROUND_ROOM_ID, roomDesks, roomHeat, STATUS_TEXT } from './model.js';

export interface OfficeSnapshot {
  rooms: RoomModel[];
  selectedId: number | null;
}

export interface SceneCallbacks {
  onPick(agentId: number): void;
  /** A room id, a pod id, or null for the whole office. */
  onFocus(id: string | null): void;
}

const MOOD: Record<DeskStatus, CharacterMood> = {
  working: 'work',
  'needs-permission': 'alert',
  'waiting-input': 'ask',
  done: 'rest',
  idle: 'doze',
};

const BADGE: Record<DeskStatus, string> = {
  working: '',
  'needs-permission': '!',
  'waiting-input': '?',
  done: '✓',
  idle: 'z',
};

const HEAT_ORDER: readonly DeskStatus[] = [
  'needs-permission',
  'waiting-input',
  'working',
  'done',
  'idle',
];

// Desk-local heights and offsets, in metres at desk scale 1.
const LABEL_Z = 0.95;
const BADGE_SEATED_Y = 1.4;
const BADGE_STANDING_Y = 1.85;
const HELPER_BADGE_Y = 1.45;
const HELPER_TURN = -0.7;
/** Tallest thing a camera fit keeps in view: the back walls and their labels. */
const FIT_HEIGHT = OFFICE3D_WALL_HEIGHT + 0.4;

const V = new Vector3();
const V2 = new Vector3();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.append(node);
  return node;
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** What the views need from the scene. */
interface Ctx {
  kit: CharacterKit;
  pick(agentId: number): void;
  choose(name: string, kind: CharacterKind): void;
  kindFor(name: string): CharacterKind;
  focus(id: string): void;
}

/** One character: its mood, and the blend from the last pose into the next. */
class Actor {
  character: Character;
  status: DeskStatus | null = null;
  private kind: ActorKind;
  private mood: CharacterMood = 'doze';
  private moodStart = 0;
  private blendStart = -Infinity;
  private readonly seed: number;
  private readonly opts: PoseOptions;
  private readonly from = new Float32Array(POSE_SIZE);
  private readonly to = new Float32Array(POSE_SIZE);
  private readonly pose = new Float32Array(POSE_SIZE);

  constructor(kit: CharacterKit, kind: ActorKind, variant: number, seed: number, seated: boolean) {
    this.kind = kind;
    this.seed = seed;
    this.opts = { seated, reduced: false };
    this.character = kit.create(kind, variant);
  }

  reskin(kit: CharacterKit, kind: ActorKind, variant: number): void {
    const old = this.character;
    this.character = kit.create(kind, variant);
    this.character.mesh.position.copy(old.mesh.position);
    old.mesh.parent?.add(this.character.mesh);
    old.dispose();
    this.kind = kind;
    this.character.apply(this.pose);
  }

  /** Returns true when a task just finished, which earns a cheer. */
  setStatus(status: DeskStatus, t: number, reduced: boolean): boolean {
    if (status === this.status) return false;
    const first = this.status === null;
    const cheer = status === 'done' && !first && !reduced;
    this.status = status;
    this.setMood(cheer ? 'cheer' : MOOD[status], first ? -Infinity : t, t);
    return cheer;
  }

  private setMood(mood: CharacterMood, blendStart: number, t: number): void {
    this.from.set(this.pose);
    this.mood = mood;
    this.moodStart = t;
    this.blendStart = blendStart;
  }

  /** Pose for time `t`; true while the actor still needs frames. */
  step(t: number, reduced: boolean): boolean {
    if (this.mood === 'cheer' && t - this.moodStart >= CHEER_SECONDS) this.setMood('rest', t, t);
    this.opts.reduced = reduced;
    characterPose(this.kind, this.mood, t, t - this.moodStart, this.seed, this.opts, this.to);
    const raw = reduced ? 1 : Math.min(1, (t - this.blendStart) / OFFICE3D_POSE_BLEND_S);
    const k = raw * raw * (3 - 2 * raw);
    for (let i = 0; i < POSE_SIZE; i++)
      this.pose[i] = this.from[i] + (this.to[i] - this.from[i]) * k;
    this.character.apply(this.pose);
    return raw < 1 || this.mood === 'cheer' || characterMoving(this.mood, t, this.seed, reduced);
  }

  wakeIn(t: number, reduced: boolean): number {
    return reduced ? Infinity : nextIdleIn(t, this.seed);
  }
}

interface HelperView {
  agentId: number;
  group: Group;
  actor: Actor;
  hit: Box3;
  badge: CSS2DObject;
  badgeEl: HTMLDivElement;
}

/** A desk's character, helpers, label and badge. The desk itself is furniture. */
class DeskView {
  readonly group = new Group();
  readonly hit = new Box3();
  readonly agentId: number;
  name: string;
  status: DeskStatus | null = null;
  helperList: HelperView[] = [];
  private kind: CharacterKind;
  private readonly actor: Actor;
  private readonly helpers = new Map<number, HelperView>();
  private readonly ctx: Ctx;
  private readonly el: HTMLDivElement;
  private readonly nameEl: HTMLSpanElement;
  private readonly crewEl: HTMLSpanElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly pickEl: HTMLSelectElement;
  private readonly badge: CSS2DObject;
  private readonly badgeEl: HTMLDivElement;
  private ppm = '';

  constructor(ctx: Ctx, model: DeskModel) {
    this.ctx = ctx;
    this.agentId = model.agentId;
    this.name = model.name;
    this.kind = ctx.kindFor(model.name);
    this.actor = new Actor(
      ctx.kit,
      this.kind,
      characterVariant(model.name),
      characterSeed(model.name),
      true,
    );
    this.actor.character.mesh.position.z = SEAT_Z;
    this.group.add(this.actor.character.mesh);
    this.group.matrixAutoUpdate = false;

    this.el = el('div', 'o3d-desk');
    const main = el('button', 'o3d-desk-main', this.el);
    main.type = 'button';
    const row = el('span', 'o3d-desk-row', main);
    el('span', 'o3d-dot', row);
    this.nameEl = el('span', 'o3d-desk-name', row);
    this.crewEl = el('span', 'o3d-desk-crew', row);
    this.statusEl = el('span', 'o3d-desk-status', main);
    main.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.pick(this.agentId);
    });
    this.pickEl = el('select', 'o3d-pick', this.el);
    // One option until the viewer opens it, so idle pickers stay light.
    el('option', '', this.pickEl);
    this.syncPick();
    const fill = () => {
      if (this.pickEl.options.length > 1) return;
      this.pickEl.replaceChildren();
      for (const kind of CHARACTER_KINDS) {
        const option = el('option', '', this.pickEl);
        option.value = kind;
        option.textContent = characterLabel(kind);
      }
      this.pickEl.value = this.kind;
    };
    this.pickEl.addEventListener('pointerdown', fill);
    this.pickEl.addEventListener('focus', fill);
    this.pickEl.addEventListener('change', () => {
      const kind = this.pickEl.value;
      if (isCharacterKind(kind)) ctx.choose(this.name, kind);
    });
    const label = new CSS2DObject(this.el);
    label.position.set(0, 0, LABEL_Z);
    this.badgeEl = el('div', 'o3d-badge');
    this.badge = new CSS2DObject(this.badgeEl);
    this.badge.position.set(0, BADGE_SEATED_Y, SEAT_Z);
    this.group.add(label, this.badge);
  }

  place(spot: DeskSpot): void {
    const s = spot.scale;
    this.group.position.set(spot.x, FLOOR, spot.z);
    this.group.scale.setScalar(s);
    this.group.updateMatrix();
    this.el.dataset.background = String(s < 1);
    this.hit.setFromCenterAndSize(
      V.set(spot.x, FLOOR + 0.75 * s, spot.z - 0.1 * s),
      V2.set(1.5 * s, 1.5 * s, 1.4 * s),
    );
    this.placeHelpers();
  }

  /** Size the label to this desk's own pixels per metre, so a far row's labels narrow with its pitch. */
  scaleLabel(ppmAtUnitDepth: number, camera: PerspectiveCamera): void {
    camera.getWorldDirection(V2);
    const depth = V.setFromMatrixPosition(this.group.matrixWorld).sub(camera.position).dot(V2);
    const ppm = ((ppmAtUnitDepth / depth) * this.group.scale.x).toFixed(0);
    if (ppm === this.ppm) return;
    this.ppm = ppm;
    this.el.style.setProperty('--o3d-ppm', ppm);
  }

  /** Where confetti starts: just above the seat, in world space. */
  seat(out: Vector3): Vector3 {
    const s = this.group.scale.x;
    return out.copy(this.group.position).add(V.set(0, 1.1 * s, SEAT_Z * s));
  }

  get scale(): number {
    return this.group.scale.x;
  }

  private syncPick(): void {
    if (this.pickEl.options.length === 1) {
      this.pickEl.options[0].value = this.kind;
      this.pickEl.options[0].textContent = characterLabel(this.kind);
    }
    this.pickEl.value = this.kind;
  }

  setKind(kind: CharacterKind): void {
    this.kind = kind;
    this.syncPick();
    this.actor.reskin(this.ctx.kit, kind, characterVariant(this.name));
  }

  /** Returns true when the desk just finished a task. */
  apply(model: DeskModel, selected: boolean, t: number, reduced: boolean): boolean {
    if (model.name !== this.name) {
      this.name = model.name;
      this.setKind(this.ctx.kindFor(model.name));
    }
    const { status } = model;
    const cheer = this.actor.setStatus(status, t, reduced);
    if (status !== this.status) {
      this.status = status;
      this.badgeEl.dataset.status = status;
      this.badgeEl.textContent = BADGE[status];
      this.badge.visible = BADGE[status] !== '';
      this.badge.position.y = status === 'needs-permission' ? BADGE_STANDING_Y : BADGE_SEATED_Y;
    }
    const activity = model.tool ?? STATUS_TEXT[status];
    this.el.dataset.status = status;
    this.el.dataset.selected = String(selected);
    this.el.title = `${model.name}: ${activity}`;
    this.pickEl.title = `Character for ${model.name}`;
    this.pickEl.ariaLabel = `Character for ${model.name}`;
    setText(this.nameEl, model.name);
    setText(this.crewEl, model.helpers.length > 0 ? `+${model.helpers.length}` : '');
    setText(this.statusEl, status === 'working' ? activity : STATUS_TEXT[status]);
    this.syncHelpers(model.helpers, t, reduced);
    return cheer;
  }

  private syncHelpers(models: HelperModel[], t: number, reduced: boolean): void {
    const live = new Set(models.map((h) => h.agentId));
    let changed = false;
    for (const [id, h] of this.helpers) {
      if (live.has(id)) continue;
      h.actor.character.dispose();
      h.badgeEl.remove();
      h.group.removeFromParent();
      this.helpers.delete(id);
      changed = true;
    }
    models.forEach((model, i) => {
      let h = this.helpers.get(model.agentId);
      if (!h) {
        const actor = new Actor(
          this.ctx.kit,
          'goblin',
          characterVariant(this.name) + 1 + i,
          characterSeed(`${this.name}#${i}`),
          false,
        );
        const group = new Group();
        group.scale.setScalar(OFFICE3D_HELPER_SCALE);
        group.rotation.y = HELPER_TURN;
        group.add(actor.character.mesh);
        const badgeEl = el('div', 'o3d-badge o3d-badge-small');
        const badge = new CSS2DObject(badgeEl);
        badge.position.y = HELPER_BADGE_Y;
        group.add(badge);
        this.group.add(group);
        h = { agentId: model.agentId, group, actor, hit: new Box3(), badge, badgeEl };
        this.helpers.set(model.agentId, h);
        changed = true;
      }
      if (h.actor.status !== model.status) {
        const asks = model.status === 'needs-permission' || model.status === 'waiting-input';
        h.badge.visible = asks;
        h.badgeEl.dataset.status = model.status;
        h.badgeEl.textContent = asks ? BADGE[model.status] : '';
      }
      h.actor.setStatus(model.status, t, reduced);
    });
    if (!changed) return;
    this.helperList = models.flatMap((m) => this.helpers.get(m.agentId) ?? []);
    this.placeHelpers();
  }

  private placeHelpers(): void {
    const s = this.group.scale.x;
    const p = this.group.position;
    this.helperList.forEach((h, i) => {
      const x = 0.95 + Math.floor(i / OFFICE3D_HELPERS_PER_COLUMN) * 0.3;
      const z = -0.55 + (i % OFFICE3D_HELPERS_PER_COLUMN) * 0.35;
      h.group.position.set(x, 0, z);
      h.hit.setFromCenterAndSize(
        V.set(p.x + x * s, p.y + 0.3 * s, p.z + z * s),
        V2.set(0.45 * s, 0.6 * s, 0.45 * s),
      );
    });
  }

  step(t: number, reduced: boolean): boolean {
    let busy = this.actor.step(t, reduced);
    for (const h of this.helperList) busy = h.actor.step(t, reduced) || busy;
    return busy;
  }

  wakeIn(t: number, reduced: boolean): number {
    let wake = this.actor.wakeIn(t, reduced);
    for (const h of this.helperList) wake = Math.min(wake, h.actor.wakeIn(t, reduced));
    return wake;
  }

  dispose(): void {
    this.actor.character.dispose();
    for (const h of this.helperList) {
      h.actor.character.dispose();
      h.badgeEl.remove();
    }
    this.el.remove();
    this.badgeEl.remove();
    this.group.removeFromParent();
  }
}

interface PodSign {
  obj: CSS2DObject;
  el: HTMLButtonElement;
  name: HTMLSpanElement;
}

/** A room's labels: its title and counts, its pod signs, and the name list for far zooms. */
class RoomView {
  readonly group = new Group();
  private readonly ctx: Ctx;
  private readonly label: CSS2DObject;
  private readonly labelEl: HTMLButtonElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly chipsEl: HTMLSpanElement;
  private chipsKey = '';
  private readonly roster: CSS2DObject;
  private readonly rosterEl: HTMLDivElement;
  private rosterKey = '';
  private readonly signs = new Map<string, PodSign>();

  constructor(ctx: Ctx, id: string, background: boolean) {
    this.ctx = ctx;
    this.labelEl = el('button', 'o3d-room');
    this.labelEl.type = 'button';
    this.titleEl = el('span', 'o3d-room-title', this.labelEl);
    this.chipsEl = el('span', 'o3d-room-chips', this.labelEl);
    this.labelEl.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.focus(id);
    });
    this.label = new CSS2DObject(this.labelEl);
    // Hangs from the top of the back wall (the porch railing), so it never reaches the room behind.
    this.label.center.set(0.5, 0);
    // When desks are too small on screen for their own labels, the room lists
    // its agents instead: one readable line each, still clickable.
    this.rosterEl = el('div', 'o3d-roster');
    if (background) this.rosterEl.dataset.background = 'true';
    this.roster = new CSS2DObject(this.rosterEl);
    this.roster.center.set(0.5, 1);
    this.group.add(this.label, this.roster);
  }

  place(spot: RoomSpot): void {
    const top = spot.z - spot.depth / 2;
    const y = spot.background ? FLOOR + 1.2 : FLOOR + OFFICE3D_WALL_HEIGHT;
    this.label.position.set(spot.x, y, top);
    this.roster.position.set(spot.x, FLOOR, spot.z + spot.depth / 2 - 0.15);
    // The list may spill into the gap between rooms, never past half of it.
    this.rosterEl.style.setProperty(
      '--o3d-room-w',
      (spot.width + OFFICE3D_ROOM_GAP * 0.9).toFixed(2),
    );
    for (const pod of spot.pods) {
      const sign = this.signs.get(pod.id);
      if (!sign) continue;
      sign.obj.position.set(pod.x, FLOOR, pod.z + pod.depth / 2 - OFFICE3D_POD_SIGN_DEPTH / 4);
    }
  }

  apply(room: RoomModel): void {
    setText(this.titleEl, room.title);
    this.labelEl.title = `Focus ${room.title}`;
    const heat = roomHeat(room);
    this.labelEl.dataset.heat =
      heat === 'needs-permission' || heat === 'waiting-input' ? heat : 'calm';
    this.labelEl.dataset.pinned = String(room.pods.some((pod) => pod.pinned));
    this.syncSigns(room);
    this.syncRoster(room);

    const counts = new Map<DeskStatus, number>();
    for (const desk of roomDesks(room)) counts.set(desk.status, (counts.get(desk.status) ?? 0) + 1);
    const chips = HEAT_ORDER.filter((s) => counts.has(s));
    const chipsKey = chips.map((s) => `${s}:${counts.get(s)}`).join(',');
    if (chipsKey === this.chipsKey) return;
    this.chipsKey = chipsKey;
    this.chipsEl.replaceChildren(
      ...chips.map((s) => {
        const chip = el('span', 'o3d-chip');
        chip.dataset.status = s;
        chip.title = `${counts.get(s)} ${STATUS_TEXT[s].toLowerCase()}`;
        chip.textContent = String(counts.get(s));
        return chip;
      }),
    );
  }

  private syncSigns(room: RoomModel): void {
    const live = new Set(room.pods.map((p) => p.id));
    for (const [id, sign] of this.signs) {
      if (live.has(id)) continue;
      sign.el.remove();
      sign.obj.removeFromParent();
      this.signs.delete(id);
    }
    // A room that is just one session needs no sign repeating its name.
    const alone = room.pods.length === 1 && room.pods[0].id === room.id;
    for (const pod of room.pods) {
      let sign = this.signs.get(pod.id);
      if (!sign) {
        const node = el('button', 'o3d-pod');
        node.type = 'button';
        el('span', 'o3d-pod-kind', node).textContent = 'session';
        const name = el('span', 'o3d-pod-name', node);
        node.addEventListener('click', (e) => {
          e.stopPropagation();
          this.ctx.focus(pod.id);
        });
        sign = { obj: new CSS2DObject(node), el: node, name };
        // Hangs from the rug's front edge, clear of the desk labels above it.
        sign.obj.center.set(0.5, 0);
        this.signs.set(pod.id, sign);
        this.group.add(sign.obj);
      }
      sign.obj.visible = !alone;
      setText(sign.name, pod.title);
      sign.el.title = `Focus ${pod.title}`;
      sign.el.dataset.pinned = String(pod.pinned);
      sign.el.dataset.heat = podHeat(pod);
    }
  }

  private syncRoster(room: RoomModel): void {
    const desks = roomDesks(room);
    const key = JSON.stringify(desks.map((d) => [d.agentId, d.name, d.status]));
    if (key === this.rosterKey) return;
    this.rosterKey = key;
    this.rosterEl.replaceChildren(
      ...desks.map((desk) => {
        const item = el('button', 'o3d-roster-item');
        item.type = 'button';
        item.dataset.status = desk.status;
        item.title = `${desk.name}: ${STATUS_TEXT[desk.status]}`;
        el('span', 'o3d-dot', item);
        el('span', 'o3d-roster-name', item).textContent = desk.name;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          this.ctx.pick(desk.agentId);
        });
        return item;
      }),
    );
  }

  dispose(): void {
    this.labelEl.remove();
    this.rosterEl.remove();
    for (const sign of this.signs.values()) sign.el.remove();
    this.group.removeFromParent();
  }
}

function podHeat(pod: PodModel): string {
  const heat = roomHeat({ id: pod.id, title: pod.title, pods: [pod] });
  return heat === 'needs-permission' || heat === 'waiting-input' ? heat : 'calm';
}

interface Tween {
  start: number;
  fromTarget: Vector3;
  fromOrbit: Spherical;
  toTarget: Vector3;
  toOrbit: Spherical;
}

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * The 3D office: owns the renderer, camera, controls, labels and every mesh.
 * It draws on demand: every animation frame while something moves, nothing
 * while the office is still or the tab is hidden. Furniture and its shadows
 * are rebuilt only when the layout changes.
 */
export class OfficeScene {
  private readonly renderer: WebGLRenderer;
  private readonly labels = new CSS2DRenderer();
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(OFFICE3D_CAMERA_FOV, 1, 0.5, 600);
  private readonly fitCamera = new PerspectiveCamera(OFFICE3D_CAMERA_FOV, 1, 0.5, 600);
  private readonly controls: OrbitControls;
  private readonly kit = new CharacterKit();
  private readonly light: Texture = radialTexture();
  private readonly fx: Effects;
  private furniture: OfficeFurniture | null = null;
  private furnitureKey = '';
  private readonly key = new DirectionalLight(C.keyLight, 2.2);
  private readonly fog = new Fog(C.background, 60, 200);
  private readonly ground: Mesh<PlaneGeometry, MeshStandardMaterial>;
  private readonly environment: Texture;
  private readonly rooms = new Map<string, RoomView>();
  private readonly desks = new Map<number, DeskView>();
  private deskList: DeskView[] = [];
  private readonly podIndex = new Map<string, PodSpot>();
  private readonly picks = new Map<string, CharacterKind>();
  private readonly ctx: Ctx;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly hitPoint = new Vector3();
  private readonly cleanup: Array<() => void> = [];
  private snapshot: OfficeSnapshot = { rooms: [], selectedId: null };
  private plan: OfficePlan = planOffice([], 1);
  private planKey = '';
  private focusId: string | null = null;
  private pendingHash: string | null;
  private userMoved = false;
  private tween: Tween | null = null;
  private readonly tweenTarget = new Vector3();
  private readonly tweenOrbit = new Spherical();
  private reduced = false;
  private raf = 0;
  private timer = 0;
  private lastFrame = 0;
  private slowSum = 0;
  private slowCount = 0;
  private labelsDirty = true;
  private readonly lastCamera = new Matrix4();
  private labelKey = '';
  private readonly stats: HTMLDivElement | null;
  private statStart = 0;
  private statFrames = 0;
  private width = 0;
  private height = 0;
  private down: { x: number; y: number; button: number; dragged: boolean } | null = null;
  private disposed = false;
  private readonly host: HTMLElement;
  private readonly callbacks: SceneCallbacks;

  constructor(host: HTMLElement, callbacks: SceneCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    this.ctx = {
      kit: this.kit,
      pick: (id) => this.callbacks.onPick(id),
      choose: this.choose,
      kindFor: (name) => this.picks.get(name) ?? loadCharacter(name),
      focus: (id) => this.focus(id),
    };
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, OFFICE3D_MAX_PIXEL_RATIO));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NeutralToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.domElement.className = 'o3d-canvas';
    this.labels.domElement.className = 'o3d-labels';
    host.append(renderer.domElement, this.labels.domElement);
    this.stats = new URLSearchParams(window.location.search).has('stats')
      ? el('div', 'o3d-stats', host)
      : null;

    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.35;
    this.scene.background = new Color(C.background);
    this.scene.fog = this.fog;

    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 4;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.025;
    this.scene.add(this.key, this.key.target, new HemisphereLight(C.hemiSky, C.hemiGround, 1.1));

    this.ground = new Mesh(
      new PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
      new MeshStandardMaterial({ color: C.ground, roughness: 1 }),
    );
    this.ground.receiveShadow = true;
    this.ground.matrixAutoUpdate = false;
    this.fx = new Effects(this.light);
    this.scene.add(this.ground, this.fx.group);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls = controls;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = false;
    controls.zoomToCursor = true;
    controls.minDistance = OFFICE3D_CAMERA_MIN_DISTANCE;
    controls.minPolarAngle = 0.05;
    controls.maxPolarAngle = OFFICE3D_CAMERA_MAX_POLAR;
    controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    controls.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE };
    controls.addEventListener('change', this.requestRender);

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reduced = motion.matches;
    this.listen(motion, 'change', () => {
      this.reduced = motion.matches;
      this.requestRender();
    });

    this.pendingHash = readHash();
    this.listen(renderer.domElement, 'pointerdown', this.onPointerDown);
    this.listen(renderer.domElement, 'pointerup', this.onPointerUp);
    this.listen(renderer.domElement, 'pointermove', this.onPointerMove);
    this.listen(renderer.domElement, 'wheel', this.takeOver);
    this.listen(renderer.domElement, 'pointercancel', () => (this.down = null));
    this.listen(document, 'visibilitychange', this.onVisibility);
    this.listen(window, 'hashchange', this.onHashChange);
    this.listen(this.labels.domElement, 'wheel', this.forwardWheel, { passive: false });
    const observer = new ResizeObserver(() => this.resize());
    observer.observe(host);
    this.cleanup.push(() => observer.disconnect());
    this.resize();
  }

  update(snapshot: OfficeSnapshot): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    const t = performance.now() / 1000;
    const deskIds = new Set(snapshot.rooms.flatMap((r) => roomDesks(r).map((d) => d.agentId)));
    for (const [id, desk] of this.desks) {
      if (deskIds.has(id)) continue;
      desk.dispose();
      this.desks.delete(id);
    }
    const roomIds = new Set(snapshot.rooms.map((r) => r.id));
    for (const [id, room] of this.rooms) {
      if (roomIds.has(id)) continue;
      room.dispose();
      this.rooms.delete(id);
    }

    const sel = snapshot.selectedId;
    const cheered: DeskView[] = [];
    for (const model of snapshot.rooms) {
      let room = this.rooms.get(model.id);
      if (!room) {
        room = new RoomView(this.ctx, model.id, model.id === BACKGROUND_ROOM_ID);
        this.rooms.set(model.id, room);
        this.scene.add(room.group);
      }
      room.apply(model);
      for (const deskModel of roomDesks(model)) {
        let desk = this.desks.get(deskModel.agentId);
        if (!desk) {
          desk = new DeskView(this.ctx, deskModel);
          this.desks.set(deskModel.agentId, desk);
          this.scene.add(desk.group);
        }
        const selected =
          sel !== null &&
          (sel === deskModel.agentId || deskModel.helpers.some((h) => h.agentId === sel));
        if (desk.apply(deskModel, selected, t, this.reduced)) cheered.push(desk);
      }
    }
    this.deskList = [...this.desks.values()];

    this.layout();
    for (const desk of cheered) this.fx.burst(desk.seat(V2), desk.scale, t);
    this.syncEffects();
    if (this.focusId !== null && !this.focusable(this.focusId)) this.focus(null);
    if (this.pendingHash !== null && this.focusable(this.pendingHash)) this.focus(this.pendingHash);
    this.labelsDirty = true;
    this.requestRender();
  }

  /**
   * Glide to a room or a pod (a tmux session), or to the whole office with
   * `null`. Mirrors the choice in the URL hash.
   */
  focus(id: string | null): void {
    if (this.disposed) return;
    this.focusId = id !== null && this.focusable(id) ? id : null;
    this.pendingHash = null;
    this.userMoved = false;
    const url = new URL(window.location.href);
    url.hash = this.focusId === null ? '' : encodeURIComponent(this.focusId);
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
    this.callbacks.onFocus(this.focusId);
    this.applyFocus(true);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    for (const off of this.cleanup) off();
    this.controls.dispose();
    for (const desk of this.desks.values()) desk.dispose();
    for (const room of this.rooms.values()) room.dispose();
    this.furniture?.dispose();
    this.fx.dispose();
    this.kit.dispose();
    this.light.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.environment.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
    this.stats?.remove();
  }

  private readonly requestRender = (): void => {
    if (this.disposed || document.hidden || this.raf) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private readonly wake = (): void => {
    this.timer = 0;
    this.requestRender();
  };

  private readonly frame = (now: number): void => {
    this.raf = 0;
    this.adaptPixelRatio(now);
    const t = now / 1000;
    const tweening = this.stepTween(now);
    const moved = this.controls.update();
    let busy = false;
    for (const desk of this.deskList) busy = desk.step(t, this.reduced) || busy;
    busy = this.fx.step(t, this.reduced) || busy;
    this.syncCameraDependents();
    this.renderer.render(this.scene, this.camera);
    // The label pass walks every label in the DOM; skip it while the camera and labels hold still.
    if (this.labelsDirty || !this.lastCamera.equals(this.camera.matrixWorld)) {
      this.labelsDirty = false;
      this.lastCamera.copy(this.camera.matrixWorld);
      const ppmAtUnitDepth = this.height / (2 * Math.tan(MathUtils.degToRad(this.camera.fov / 2)));
      for (const desk of this.deskList) desk.scaleLabel(ppmAtUnitDepth, this.camera);
      this.labels.render(this.scene, this.camera);
    }
    this.countFrame(now);

    if (tweening || moved || busy) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    this.lastFrame = 0;
    let wake = Infinity;
    for (const desk of this.deskList) wake = Math.min(wake, desk.wakeIn(t, this.reduced));
    if (wake < Infinity) this.timer = window.setTimeout(this.wake, wake * 1000);
  };

  /** Step the pixel ratio down while frames run slow and back up while they run smooth. */
  private adaptPixelRatio(now: number): void {
    const last = this.lastFrame;
    this.lastFrame = now;
    if (!last) {
      this.slowSum = 0;
      this.slowCount = 0;
      return;
    }
    this.slowSum += now - last;
    if (++this.slowCount < 30) return;
    const avg = this.slowSum / this.slowCount;
    this.slowSum = 0;
    this.slowCount = 0;
    const max = Math.min(window.devicePixelRatio || 1, OFFICE3D_MAX_PIXEL_RATIO);
    const min = Math.min(OFFICE3D_MIN_PIXEL_RATIO, max);
    const ratio = this.renderer.getPixelRatio();
    let next = ratio;
    if (avg > OFFICE3D_SLOW_FRAME_MS) next = Math.max(min, ratio - OFFICE3D_PIXEL_RATIO_STEP);
    else if (avg < OFFICE3D_SMOOTH_FRAME_MS)
      next = Math.min(max, ratio + OFFICE3D_PIXEL_RATIO_STEP);
    if (next !== ratio) this.renderer.setPixelRatio(next);
  }

  private countFrame(now: number): void {
    const stats = this.stats;
    if (!stats) return;
    if (!this.statStart) this.statStart = now;
    this.statFrames++;
    const span = now - this.statStart;
    if (span < OFFICE3D_STATS_INTERVAL_MS) return;
    const info = this.renderer.info.render;
    stats.textContent =
      `${Math.round((this.statFrames * 1000) / span)} fps · ${info.calls} draws · ` +
      `${info.triangles} tris · ${this.renderer.getPixelRatio()}x`;
    this.statStart = now;
    this.statFrames = 0;
  }

  private readonly choose = (name: string, kind: CharacterKind): void => {
    saveCharacter(name, kind);
    this.picks.set(name, kind);
    for (const desk of this.deskList) if (desk.name === name) desk.setKind(kind);
    this.requestRender();
  };

  private syncEffects(): void {
    const lights: DeskLight[] = [];
    let selected: Matrix4 | null = null;
    const sel = this.snapshot.selectedId;
    for (const desk of this.deskList) {
      if (desk.status === null) continue;
      lights.push({ matrix: desk.group.matrix, status: desk.status });
      if (
        sel !== null &&
        (sel === desk.agentId || desk.helperList.some((h) => h.agentId === sel))
      ) {
        selected = desk.group.matrix;
      }
    }
    this.fx.sync(lights, selected);
  }

  /** Label size, density and fog follow the zoom. */
  private syncCameraDependents(): void {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const ppm = this.height / (2 * dist * Math.tan(MathUtils.degToRad(this.camera.fov / 2)));
    const pitch = ppm * OFFICE3D_DESK_PITCH_X;
    const density =
      pitch >= OFFICE3D_FULL_LABEL_PX
        ? 'full'
        : pitch >= OFFICE3D_COMPACT_LABEL_PX
          ? 'compact'
          : 'roster';
    const key = `${ppm.toFixed(1)}|${density}`;
    if (key === this.labelKey) return;
    this.labelKey = key;
    this.labels.domElement.style.setProperty('--o3d-ppm', ppm.toFixed(1));
    this.labels.domElement.dataset.density = density;
    this.fog.near = dist * 1.6;
    this.fog.far = dist * 4;
  }

  private layout(): void {
    const animate = this.planKey !== '';
    this.plan = planOffice(this.snapshot.rooms, this.camera.aspect);
    this.podIndex.clear();
    for (const spot of this.plan.rooms) {
      this.rooms.get(spot.id)?.place(spot);
      for (const pod of spot.pods) if (!this.podIndex.has(pod.id)) this.podIndex.set(pod.id, pod);
      for (const d of spot.desks) this.desks.get(d.agentId)?.place(d);
    }

    const names = new Map<number, string>();
    for (const desk of this.deskList) names.set(desk.agentId, desk.name);
    const furnitureKey = JSON.stringify([this.plan.rooms, [...names]]);
    if (furnitureKey !== this.furnitureKey) {
      this.furnitureKey = furnitureKey;
      this.furniture?.dispose();
      this.furniture = buildOffice(this.plan, names, this.light);
      this.scene.add(this.furniture.group);
      this.renderer.shadowMap.needsUpdate = true;
    }

    const planKey = JSON.stringify([
      this.plan.columns,
      this.plan.width,
      this.plan.depth,
      this.plan.rooms.map((r) => r.id),
    ]);
    if (planKey === this.planKey) return;
    this.planKey = planKey;

    const reach = Math.hypot(this.plan.width, this.plan.depth) / 2 + 2;
    this.key.position.set(-0.45 * reach, 1.3 * reach, 0.75 * reach);
    const cam = this.key.shadow.camera;
    cam.left = -reach;
    cam.right = reach;
    cam.top = reach;
    cam.bottom = -reach;
    cam.near = 0.5;
    cam.far = reach * 4;
    cam.updateProjectionMatrix();
    this.renderer.shadowMap.needsUpdate = true;
    this.controls.maxTargetRadius = reach;
    this.controls.maxDistance = Math.max(
      30,
      this.fitView(this.overviewBounds()).orbit.radius * 2.2,
    );

    if (!this.userMoved) this.applyFocus(animate);
  }

  private focusable(id: string): boolean {
    return this.rooms.has(id) || this.podIndex.has(id);
  }

  private overviewBounds(): Bounds {
    const { width, depth } = this.plan;
    return { minX: -width / 2, maxX: width / 2, minZ: -depth / 2, maxZ: depth / 2 };
  }

  private focusBounds(): Bounds {
    const id = this.focusId;
    const rect =
      this.plan.rooms.find((r) => r.id === id) ?? (id !== null ? this.podIndex.get(id) : undefined);
    if (!rect) return this.overviewBounds();
    // A pod is framed with a little of the floor around it.
    const pad = 'pinned' in rect ? 0.5 : 0;
    return {
      minX: rect.x - rect.width / 2 - pad,
      maxX: rect.x + rect.width / 2 + pad,
      minZ: rect.z - rect.depth / 2 - pad,
      maxZ: rect.z + rect.depth / 2 + pad,
    };
  }

  private applyFocus(animate: boolean): void {
    const to = this.fitView(this.focusBounds());
    if (!animate) {
      this.tween = null;
      this.setView(to.target, to.orbit);
    } else {
      this.tween = {
        start: performance.now(),
        fromTarget: this.controls.target.clone(),
        fromOrbit: new Spherical().setFromVector3(
          V.copy(this.camera.position).sub(this.controls.target),
        ),
        toTarget: to.target,
        toOrbit: to.orbit,
      };
    }
    this.requestRender();
  }

  private setView(target: Vector3, orbit: Spherical): void {
    this.controls.target.copy(target);
    this.camera.position.setFromSpherical(orbit).add(target);
    this.camera.lookAt(target);
  }

  private stepTween(now: number): boolean {
    const tween = this.tween;
    if (!tween) return false;
    const k = Math.min(1, (now - tween.start) / OFFICE3D_FOCUS_DURATION_MS);
    const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    const { fromOrbit: a, toOrbit: b } = tween;
    let dTheta = b.theta - a.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    this.tweenTarget.lerpVectors(tween.fromTarget, tween.toTarget, e);
    this.tweenOrbit.set(
      MathUtils.lerp(a.radius, b.radius, e),
      MathUtils.lerp(a.phi, b.phi, e),
      a.theta + dTheta * e,
    );
    this.setView(this.tweenTarget, this.tweenOrbit);
    if (k >= 1) this.tween = null;
    return true;
  }

  /**
   * Camera that frames `b` (plus the height of walls and labels) inside the
   * viewport minus the room bar and toolbar, looking straight down -z.
   */
  private fitView(b: Bounds): { target: Vector3; orbit: Spherical } {
    const aspect = this.camera.aspect;
    const polar =
      aspect < OFFICE3D_NARROW_ASPECT ? OFFICE3D_CAMERA_POLAR_NARROW : OFFICE3D_CAMERA_POLAR;
    const cam = this.fitCamera;
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    const h = Math.max(1, this.height);
    const w = Math.max(1, this.width);
    const xMax = Math.min(OFFICE3D_FIT_MARGIN, 1 - (2 * OFFICE3D_INSET_SIDE_PX) / w);
    const yMax = Math.min(OFFICE3D_FIT_MARGIN, 1 - (2 * OFFICE3D_INSET_TOP_PX) / h);
    const yMin = Math.max(-OFFICE3D_FIT_MARGIN, -1 + (2 * OFFICE3D_INSET_BOTTOM_PX) / h);
    const corners: Vector3[] = [];
    for (const x of [b.minX, b.maxX]) {
      for (const z of [b.minZ, b.maxZ]) {
        for (const y of [0, FIT_HEIGHT]) corners.push(new Vector3(x, y, z));
      }
    }
    const target = new Vector3((b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2);
    const p = new Vector3();
    const project = (radius: number) => {
      cam.position.set(0, Math.cos(polar), Math.sin(polar)).multiplyScalar(radius).add(target);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const c of corners) {
        p.copy(c).project(cam);
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y);
        y1 = Math.max(y1, p.y);
      }
      return { x0, x1, y0, y1 };
    };
    const tanHalf = Math.tan(MathUtils.degToRad(cam.fov / 2));
    let radius = 20;
    for (let pass = 0; pass < 4; pass++) {
      let lo = 0.5;
      let hi = 800;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const r = project(mid);
        if (r.x0 >= -xMax && r.x1 <= xMax && r.y0 >= yMin && r.y1 <= yMax) hi = mid;
        else lo = mid;
      }
      radius = hi;
      const r = project(radius);
      target.x += ((r.x0 + r.x1) / 2) * radius * tanHalf * aspect;
      target.z -= (((r.y0 + r.y1) / 2 - (yMin + yMax) / 2) * radius * tanHalf) / Math.cos(polar);
    }
    return { target, orbit: new Spherical(radius, polar, 0) };
  }

  private resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.labelKey = '';
    this.planKey = '';
    this.labelsDirty = true;
    this.layout();
    this.syncEffects();
    this.requestRender();
  }

  /** The nearest desk or helper under the pointer. */
  private pick(e: PointerEvent): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const ray = this.raycaster.ray;
    let best: number | null = null;
    let bestDist = Infinity;
    const test = (box: Box3, id: number) => {
      if (!ray.intersectBox(box, this.hitPoint)) return;
      const d = this.hitPoint.distanceToSquared(ray.origin);
      if (d < bestDist) {
        bestDist = d;
        best = id;
      }
    };
    for (const desk of this.deskList) {
      test(desk.hit, desk.agentId);
      for (const h of desk.helperList) test(h.hit, h.agentId);
    }
    return best;
  }

  private listen<T extends EventTarget>(
    target: T,
    type: string,
    handler: (e: never) => void,
    options?: AddEventListenerOptions,
  ): void {
    const fn = handler as EventListener;
    target.addEventListener(type, fn, options);
    this.cleanup.push(() => target.removeEventListener(type, fn, options));
  }

  /** The user steered the camera: stop gliding and stop refitting on layout changes. */
  private readonly takeOver = (): void => {
    this.tween = null;
    this.userMoved = true;
  };

  // A click must not count as steering, or the first pick would freeze the fit.
  private readonly onPointerDown = (e: PointerEvent): void => {
    this.down = { x: e.clientX, y: e.clientY, button: e.button, dragged: false };
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const down = this.down;
    this.down = null;
    if (!down || down.dragged || down.button !== 0) return;
    const id = this.pick(e);
    if (id !== null) this.callbacks.onPick(id);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const down = this.down;
    if (down) {
      if (
        !down.dragged &&
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > OFFICE3D_CLICK_SLOP_PX
      ) {
        down.dragged = true;
        this.takeOver();
      }
      return;
    }
    if (e.buttons !== 0 || e.pointerType !== 'mouse') return;
    this.renderer.domElement.style.cursor = this.pick(e) === null ? '' : 'pointer';
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(this.raf);
      clearTimeout(this.timer);
      this.raf = 0;
      this.timer = 0;
      this.lastFrame = 0;
    } else {
      this.requestRender();
    }
  };

  private readonly onHashChange = (): void => {
    const id = readHash();
    if (id === null || this.focusable(id)) this.focus(id);
    else this.pendingHash = id;
  };

  private readonly forwardWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.renderer.domElement.dispatchEvent(new WheelEvent('wheel', e));
  };
}

function readHash(): string | null {
  const raw = window.location.hash.slice(1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
