import {
  OFFICE3D_BACKGROUND_ROSTER_NAME_W,
  OFFICE3D_BACKGROUND_SCALE,
  OFFICE3D_COMPACT_LABEL_PX,
  OFFICE3D_CREW_PER_ROW,
  OFFICE3D_CREW_SCALE,
  OFFICE3D_DEPTH_FORESHORTEN,
  OFFICE3D_DESK_PITCH_X,
  OFFICE3D_DESK_PITCH_Z,
  OFFICE3D_FULL_LABEL_PX,
  OFFICE3D_NARROW_ASPECT,
  OFFICE3D_NARROW_ROSTER_COLUMNS,
  OFFICE3D_POD_FOCUS_PAD,
  OFFICE3D_POD_GAP,
  OFFICE3D_POD_PAD,
  OFFICE3D_POD_SIGN_DEPTH,
  OFFICE3D_ROOM_GAP,
  OFFICE3D_ROOM_PAD_BACK,
  OFFICE3D_ROOM_PAD_FRONT,
  OFFICE3D_ROOM_PAD_X,
  OFFICE3D_ROSTER_LINE_DEPTH,
} from '../constants.js';
import type { Focus, PodModel, RoomModel } from './model.js';
import { BACKGROUND_ROOM_ID, roomDesks } from './model.js';

/** Centre of one desk slot on the floor plane (x right, z toward the viewer). */
export interface DeskSpot {
  agentId: number;
  x: number;
  z: number;
  /**
   * 1 for an overseer, OFFICE3D_CREW_SCALE for its crew, times OFFICE3D_BACKGROUND_SCALE
   * in the background. Smaller desks keep the spacing across, so labels fit.
   */
  scale: number;
  overseer: boolean;
}

interface Rect {
  x: number;
  z: number;
  width: number;
  depth: number;
}

export interface PodSpot extends Rect {
  id: string;
  pinned: boolean;
  desks: DeskSpot[];
}

export interface RoomSpot extends Rect {
  id: string;
  background: boolean;
  pods: PodSpot[];
  desks: DeskSpot[];
}

export interface OfficePlan {
  rooms: RoomSpot[];
  columns: number;
  /** The stage is narrow: each room's name list sits on floor in front of its pods. */
  narrow: boolean;
  width: number;
  depth: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const focusRect = (plan: OfficePlan, focus: Focus) =>
  focus.kind === 'room'
    ? plan.rooms.find((r) => r.id === focus.id)
    : plan.rooms.flatMap((r) => r.pods).find((p) => p.id === focus.id);

/** The floor the camera frames for a focus; the whole office when the focus is not in the plan. */
export function focusArea(plan: OfficePlan, focus: Focus | null): Bounds {
  const rect = focus && focusRect(plan, focus);
  if (!rect) {
    return {
      minX: -plan.width / 2,
      maxX: plan.width / 2,
      minZ: -plan.depth / 2,
      maxZ: plan.depth / 2,
    };
  }
  const pad = focus?.kind === 'pod' ? OFFICE3D_POD_FOCUS_PAD : 0;
  return {
    minX: rect.x - rect.width / 2 - pad,
    maxX: rect.x + rect.width / 2 + pad,
    minZ: rect.z - rect.depth / 2 - pad,
    maxZ: rect.z + rect.depth / 2 + pad,
  };
}

/**
 * The scene refits the camera whenever this changes. Null while the focus is
 * missing from the plan, so a brief drop-out holds the view instead of gliding
 * to the whole office and back.
 */
export const fitKey = (plan: OfficePlan, focus: Focus | null): string | null =>
  focus && !focusRect(plan, focus) ? null : JSON.stringify(focusArea(plan, focus));

/** Desks per row inside a pod: a short pod is one row, a big one is close to square. */
export const podColumns = (desks: number): number =>
  desks <= 3 ? Math.max(1, desks) : Math.ceil(Math.sqrt(desks));

/** A desk spot relative to its pod: dx from the centre line, dz from the back edge. */
type Slot = Omit<DeskSpot, 'x' | 'z'> & { dx: number; dz: number };

interface PodBox {
  pod: PodModel;
  width: number;
  depth: number;
  slots: Slot[];
}

/**
 * A pod's overseer sits alone at the back; its crew sits in front of it at
 * OFFICE3D_CREW_SCALE, up to OFFICE3D_CREW_PER_ROW to a row. A pod without an
 * overseer is a plain grid of podColumns.
 */
function podBox(pod: PodModel, scale: number): PodBox {
  const pitchZ = OFFICE3D_DESK_PITCH_Z * scale;
  const [overseer, ...crew] = pod.desks;
  const led = pod.hasOverseer && overseer !== undefined;
  const rest = led ? crew : pod.desks;
  const deskScale = led ? scale * OFFICE3D_CREW_SCALE : scale;
  const cols = Math.max(
    1,
    led ? Math.min(rest.length, OFFICE3D_CREW_PER_ROW) : podColumns(rest.length),
  );
  const front = OFFICE3D_POD_PAD + (led ? pitchZ : 0);
  const slots = rest.map((desk, d): Slot => {
    const r = Math.floor(d / cols);
    const inRow = Math.min(cols, rest.length - r * cols);
    return {
      agentId: desk.agentId,
      dx: ((d % cols) - (inRow - 1) / 2) * OFFICE3D_DESK_PITCH_X,
      dz: front + (r + 0.5) * pitchZ,
      scale: deskScale,
      overseer: false,
    };
  });
  if (led) {
    slots.unshift({
      agentId: overseer.agentId,
      dx: 0,
      dz: OFFICE3D_POD_PAD + pitchZ / 2,
      scale,
      overseer: true,
    });
  }
  const rows = (led ? 1 : 0) + Math.ceil(rest.length / cols);
  return {
    pod,
    slots,
    width: cols * OFFICE3D_DESK_PITCH_X + 2 * OFFICE3D_POD_PAD,
    depth: OFFICE3D_POD_PAD + Math.max(1, rows) * pitchZ + OFFICE3D_POD_SIGN_DEPTH,
  };
}

/** Pods packed into rows no wider than `maxWidth`, in order; the pinned pods form their own front row. */
function packRows(boxes: PodBox[], maxWidth: number): PodBox[][] {
  const pinned = boxes.filter((b) => b.pod.pinned);
  const rows: PodBox[][] = [];
  let row: PodBox[] = [];
  let width = 0;
  const flush = () => {
    if (row.length > 0) rows.push(row);
    row = [];
    width = 0;
  };
  for (const box of boxes.filter((b) => !b.pod.pinned)) {
    const next = width + (row.length > 0 ? OFFICE3D_POD_GAP : 0) + box.width;
    if (row.length > 0 && next > maxWidth + 1e-9) flush();
    width += (row.length > 0 ? OFFICE3D_POD_GAP : 0) + box.width;
    row.push(box);
  }
  flush();
  for (const box of pinned) {
    const next = width + (row.length > 0 ? OFFICE3D_POD_GAP : 0) + box.width;
    if (row.length > 0 && next > maxWidth + 1e-9) flush();
    width += (row.length > 0 ? OFFICE3D_POD_GAP : 0) + box.width;
    row.push(box);
  }
  flush();
  return rows;
}

const rowWidth = (row: PodBox[]): number =>
  row.reduce((sum, b) => sum + b.width, 0) + Math.max(0, row.length - 1) * OFFICE3D_POD_GAP;
const rowDepth = (row: PodBox[]): number => Math.max(...row.map((b) => b.depth));
const rowsDepth = (rows: PodBox[][]): number =>
  rows.reduce((sum, r) => sum + rowDepth(r), 0) + Math.max(0, rows.length - 1) * OFFICE3D_POD_GAP;

interface RoomShape {
  room: RoomModel;
  rows: PodBox[][];
  width: number;
  /** Floor from the back wall to the front of the last pod row. */
  inner: number;
  /** Floor in front of the pods: the walkway, plus the lines of its name list. */
  front: number;
  scale: number;
}

const EMPTY_INNER_W = OFFICE3D_DESK_PITCH_X + 2 * OFFICE3D_POD_PAD;
const EMPTY_INNER_D = OFFICE3D_DESK_PITCH_Z * 0.6;

/** Names per line of a room's name list on a wide viewport; office3d.css lays it out in as many columns. */
export function porchRosterColumns(width: number): number {
  return Math.max(1, Math.floor(width / OFFICE3D_BACKGROUND_ROSTER_NAME_W));
}

/**
 * Label density for a desk pitch of `pitchPx` screen pixels. The name list only
 * shows when `rosterFloor` says the plan holds floor for it in front of the pods.
 */
export function labelDensity(pitchPx: number, rosterFloor: boolean): 'full' | 'compact' | 'roster' {
  if (pitchPx >= OFFICE3D_FULL_LABEL_PX) return 'full';
  return pitchPx >= OFFICE3D_COMPACT_LABEL_PX || !rosterFloor ? 'compact' : 'roster';
}

/**
 * Every row packing of a room's pods, from the narrowest the pods and
 * `minWidth` allow up to one row.
 */
function roomShapes(
  room: RoomModel,
  narrow: boolean,
  roster: boolean,
  scale: number,
  minWidth = 0,
): RoomShape[] {
  const boxes = room.pods.map((pod) => podBox(pod, scale));
  const desks = roomDesks(room).length;
  // A wide roster also needs a line for the plaques that hang into the same floor.
  const lines = (width: number) =>
    narrow
      ? Math.ceil(desks / OFFICE3D_NARROW_ROSTER_COLUMNS)
      : roster
        ? Math.ceil(desks / porchRosterColumns(width)) + 1
        : scale < 1
          ? Math.ceil(desks / porchRosterColumns(width))
          : 0;
  const front = (width: number) =>
    OFFICE3D_ROOM_PAD_FRONT + lines(width) * OFFICE3D_ROSTER_LINE_DEPTH;
  const padBack = OFFICE3D_ROOM_PAD_BACK * scale;
  if (boxes.length === 0) {
    const width = Math.max(minWidth, EMPTY_INNER_W + 2 * OFFICE3D_ROOM_PAD_X);
    return [{ room, rows: [], width, inner: padBack + EMPTY_INNER_D, front: front(width), scale }];
  }
  const narrowest = Math.max(...boxes.map((b) => b.width), minWidth - 2 * OFFICE3D_ROOM_PAD_X);
  const candidates = new Set<number>([narrowest]);
  let sum = 0;
  for (const box of boxes) {
    sum += (sum > 0 ? OFFICE3D_POD_GAP : 0) + box.width;
    candidates.add(Math.max(narrowest, sum));
  }
  return [...candidates]
    .sort((a, b) => a - b)
    .map((maxWidth) => {
      const rows = packRows(boxes, maxWidth);
      const width = Math.max(minWidth, Math.max(...rows.map(rowWidth)) + 2 * OFFICE3D_ROOM_PAD_X);
      return { room, rows, width, inner: padBack + rowsDepth(rows), front: front(width), scale };
    });
}

/** The row packing whose on-screen shape is closest to `target` (width/height). */
function shapeRoom(
  room: RoomModel,
  target: number,
  narrow: boolean,
  roster: boolean,
  scale: number,
): RoomShape {
  let best: RoomShape | null = null;
  let bestScore = Infinity;
  for (const shape of roomShapes(room, narrow, roster, scale)) {
    const score = Math.abs(
      Math.log(shape.width / ((shape.inner + shape.front) * OFFICE3D_DEPTH_FORESHORTEN) / target),
    );
    if (score < bestScore - 1e-9) {
      bestScore = score;
      best = shape;
    }
  }
  return best as RoomShape;
}

function placeShape(shape: RoomShape, x: number, top: number, depth: number): RoomSpot {
  const pods: PodSpot[] = [];
  let z = top + OFFICE3D_ROOM_PAD_BACK * shape.scale;
  for (const row of shape.rows) {
    let left = x - rowWidth(row) / 2;
    const depth = rowDepth(row);
    for (const box of row) {
      const cx = left + box.width / 2;
      // Pods in a row line up at the front, so their signs read as one line.
      const top = z + depth - box.depth;
      pods.push({
        id: box.pod.id,
        pinned: box.pod.pinned,
        x: cx,
        z: top + box.depth / 2,
        width: box.width,
        depth: box.depth,
        desks: box.slots.map(({ dx, dz, ...slot }) => ({ ...slot, x: cx + dx, z: top + dz })),
      });
      left += box.width + OFFICE3D_POD_GAP;
    }
    z += depth + OFFICE3D_POD_GAP;
  }
  return {
    id: shape.room.id,
    background: shape.scale < 1,
    x,
    z: top + depth / 2,
    width: shape.width,
    depth,
    pods,
    desks: pods.flatMap((p) => p.desks),
  };
}

/** Room shapes (on-screen width/height) the planner tries for every column count. */
const ROOM_TARGETS = [0.5, 0.7, 0.9, 1.2, 1.6, 2.1, 2.8];

/**
 * Lay the office out on the floor plane, centred on the origin. Each room packs
 * its session pods into rows, pinned pods alone in the front row, centred. Rooms
 * then fill rows of a grid in reading order from the back-left, back walls in
 * line, with a short last row centred. The planner tries every column count and
 * a few room shapes and keeps the one that lets the whole office fill the most of
 * a viewport with the given width/height `aspect`. The background is a porch
 * behind the grid, at least as wide as it, with smaller desks and a wrapped name
 * list; its pods take the row width that fills the viewport best. When rooms
 * are too small on screen for per-desk labels they list their agents instead,
 * so each room gets extra floor at the front for that list: always on a narrow
 * viewport, and on a wide one when `roster` says the overview shows the lists.
 */
export function planOffice(rooms: RoomModel[], aspect: number, roster = false): OfficePlan {
  const narrow = aspect < OFFICE3D_NARROW_ASPECT;
  const grid = rooms.filter((r) => r.id !== BACKGROUND_ROOM_ID);
  const background = rooms.find((r) => r.id === BACKGROUND_ROOM_ID);
  const n = grid.length;

  const layoutRows = (shapes: RoomShape[], columns: number) => {
    const rows: RoomShape[][] = [];
    for (let i = 0; i < n; i += columns) rows.push(shapes.slice(i, i + columns));
    const widths = rows.map(
      (row) => row.reduce((s, r) => s + r.width, 0) + (row.length - 1) * OFFICE3D_ROOM_GAP,
    );
    const depths = rows.map((row) => Math.max(...row.map((r) => r.inner + r.front)));
    return {
      rows,
      widths,
      depths,
      width: Math.max(0, ...widths),
      depth: depths.reduce((s, d) => s + d, 0) + Math.max(0, rows.length - 1) * OFFICE3D_ROOM_GAP,
    };
  };

  const fit = (g: ReturnType<typeof layoutRows>, bg: RoomShape | null, columns: number) => {
    const bgDepth = bg ? bg.inner + bg.front : 0;
    const width = Math.max(g.width, bg?.width ?? 0);
    const depth = g.depth + (bg ? bgDepth + (n > 0 ? OFFICE3D_ROOM_GAP : 0) : 0);
    const scale = Math.min(aspect / width, 1 / (depth * OFFICE3D_DEPTH_FORESHORTEN));
    return { columns, g, bg, bgDepth, width, depth, scale };
  };

  const measure = (shapes: RoomShape[], columns: number) => {
    const g = layoutRows(shapes, columns);
    const porches = background
      ? roomShapes(background, narrow, roster, OFFICE3D_BACKGROUND_SCALE, g.width)
      : [null];
    let best: ReturnType<typeof fit> | null = null;
    for (const bg of porches) {
      const m = fit(g, bg, columns);
      if (!best || m.scale > best.scale + 1e-9) best = m;
    }
    return best!;
  };

  let best = measure([], 1);
  best.scale = -1;
  for (const target of ROOM_TARGETS) {
    const shapes = grid.map((room) => shapeRoom(room, target, narrow, roster, 1));
    for (let c = 1; c <= Math.max(1, n); c++) {
      const m = measure(shapes, c);
      if (m.scale > best.scale + 1e-9) best = m;
    }
  }

  const { g, bg, bgDepth, width, depth, columns } = best;
  const spots = new Map<RoomModel, RoomSpot>();
  let top = -depth / 2;
  if (bg) {
    spots.set(bg.room, placeShape(bg, 0, top, bgDepth));
    top += bgDepth + OFFICE3D_ROOM_GAP;
  }
  g.rows.forEach((row, r) => {
    let left = -g.widths[r] / 2;
    for (const shape of row) {
      spots.set(
        shape.room,
        placeShape(shape, left + shape.width / 2, top, shape.inner + shape.front),
      );
      left += shape.width + OFFICE3D_ROOM_GAP;
    }
    top += g.depths[r] + OFFICE3D_ROOM_GAP;
  });

  return {
    columns,
    narrow,
    width,
    depth,
    rooms: rooms.flatMap((room) => spots.get(room) ?? []),
  };
}
