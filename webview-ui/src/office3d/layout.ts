import {
  OFFICE3D_BACKGROUND_ROSTER_PER_LINE,
  OFFICE3D_BACKGROUND_SCALE,
  OFFICE3D_DEPTH_FORESHORTEN,
  OFFICE3D_DESK_PITCH_X,
  OFFICE3D_DESK_PITCH_Z,
  OFFICE3D_NARROW_ASPECT,
  OFFICE3D_NARROW_ROSTER_COLUMNS,
  OFFICE3D_POD_GAP,
  OFFICE3D_POD_PAD,
  OFFICE3D_POD_SIGN_DEPTH,
  OFFICE3D_ROOM_GAP,
  OFFICE3D_ROOM_PAD_BACK,
  OFFICE3D_ROOM_PAD_FRONT,
  OFFICE3D_ROOM_PAD_X,
  OFFICE3D_ROSTER_LINE_DEPTH,
} from '../constants.js';
import type { PodModel, RoomModel } from './model.js';
import { BACKGROUND_ROOM_ID, roomDesks } from './model.js';

/** Centre of one desk slot on the floor plane (x right, z toward the viewer). */
export interface DeskSpot {
  agentId: number;
  x: number;
  z: number;
  /** 1 in a room, OFFICE3D_BACKGROUND_SCALE in the background. Spacing across stays the same so labels fit. */
  scale: number;
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
  width: number;
  depth: number;
}

/** Desks per row inside a pod: a short pod is one row, a big one is close to square. */
export const podColumns = (desks: number): number =>
  desks <= 3 ? Math.max(1, desks) : Math.ceil(Math.sqrt(desks));

interface PodBox {
  pod: PodModel;
  width: number;
  depth: number;
}

function podBox(pod: PodModel, scale: number): PodBox {
  const n = pod.desks.length;
  const cols = podColumns(n);
  return {
    pod,
    width: cols * OFFICE3D_DESK_PITCH_X + 2 * OFFICE3D_POD_PAD,
    depth:
      Math.ceil(Math.max(1, n) / cols) * OFFICE3D_DESK_PITCH_Z * scale +
      OFFICE3D_POD_PAD +
      OFFICE3D_POD_SIGN_DEPTH,
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
  /** Floor in front of the pods: the walkway, plus a name list on narrow viewports. */
  front: number;
  scale: number;
}

const EMPTY_INNER_W = OFFICE3D_DESK_PITCH_X + 2 * OFFICE3D_POD_PAD;
const EMPTY_INNER_D = OFFICE3D_DESK_PITCH_Z * 0.6;

/**
 * Pack a room's pods into rows, trying every row width the pods allow and
 * keeping the one whose on-screen shape is closest to `target` (width/height).
 */
function shapeRoom(room: RoomModel, target: number, narrow: boolean, scale: number): RoomShape {
  const boxes = room.pods.map((pod) => podBox(pod, scale));
  const desks = roomDesks(room).length;
  const roster = narrow
    ? Math.ceil(desks / OFFICE3D_NARROW_ROSTER_COLUMNS) * OFFICE3D_ROSTER_LINE_DEPTH
    : scale < 1
      ? Math.ceil(desks / OFFICE3D_BACKGROUND_ROSTER_PER_LINE) * OFFICE3D_ROSTER_LINE_DEPTH
      : 0;
  const front = OFFICE3D_ROOM_PAD_FRONT + roster;
  const padBack = OFFICE3D_ROOM_PAD_BACK * scale;
  if (boxes.length === 0) {
    return {
      room,
      rows: [],
      width: EMPTY_INNER_W + 2 * OFFICE3D_ROOM_PAD_X,
      inner: padBack + EMPTY_INNER_D,
      front,
      scale,
    };
  }
  const widest = Math.max(...boxes.map((b) => b.width));
  const candidates = new Set<number>([widest]);
  let sum = 0;
  for (const box of boxes) {
    sum += (sum > 0 ? OFFICE3D_POD_GAP : 0) + box.width;
    candidates.add(Math.max(widest, sum));
  }
  let best: RoomShape | null = null;
  let bestScore = Infinity;
  for (const maxWidth of [...candidates].sort((a, b) => a - b)) {
    const rows = packRows(boxes, maxWidth);
    const width = Math.max(...rows.map(rowWidth)) + 2 * OFFICE3D_ROOM_PAD_X;
    const inner = padBack + rowsDepth(rows);
    const shape = Math.log(width / ((inner + front) * OFFICE3D_DEPTH_FORESHORTEN) / target);
    if (Math.abs(shape) < bestScore - 1e-9) {
      bestScore = Math.abs(shape);
      best = { room, rows, width, inner, front, scale };
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
      const n = box.pod.desks.length;
      const cols = podColumns(n);
      const pitchZ = OFFICE3D_DESK_PITCH_Z * shape.scale;
      pods.push({
        id: box.pod.id,
        pinned: box.pod.pinned,
        x: cx,
        z: top + box.depth / 2,
        width: box.width,
        depth: box.depth,
        desks: box.pod.desks.map((desk, d) => {
          const r = Math.floor(d / cols);
          const inRow = Math.min(cols, n - r * cols);
          return {
            agentId: desk.agentId,
            x: cx + ((d % cols) - (inRow - 1) / 2) * OFFICE3D_DESK_PITCH_X,
            z: top + OFFICE3D_POD_PAD + (r + 0.5) * pitchZ,
            scale: shape.scale,
          };
        }),
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
 * behind the grid, as wide as it, with smaller desks and a wrapped name list. On
 * a narrow viewport rooms are too small on screen for per-desk labels, so each
 * room gets extra floor at the front for a list of its agents.
 */
export function planOffice(rooms: RoomModel[], aspect: number): OfficePlan {
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

  const bgShape = (width: number): RoomShape | null => {
    if (!background) return null;
    const shape = shapeRoom(background, 1e6, narrow, OFFICE3D_BACKGROUND_SCALE);
    // As wide as the grid: re-pack the pods into that width.
    const innerMax = Math.max(width, shape.width) - 2 * OFFICE3D_ROOM_PAD_X;
    const boxes = shape.rows.flat();
    const rows = boxes.length > 0 ? packRows(boxes, innerMax) : [];
    const inner = OFFICE3D_ROOM_PAD_BACK * OFFICE3D_BACKGROUND_SCALE + rowsDepth(rows);
    return {
      ...shape,
      rows,
      width: Math.max(width, shape.width),
      inner: rows.length > 0 ? inner : shape.inner,
    };
  };

  const measure = (shapes: RoomShape[], columns: number) => {
    const g = layoutRows(shapes, columns);
    const bg = bgShape(g.width);
    const bgDepth = bg ? bg.inner + bg.front : 0;
    const width = Math.max(g.width, bg?.width ?? 0);
    const depth = g.depth + (bg ? bgDepth + (n > 0 ? OFFICE3D_ROOM_GAP : 0) : 0);
    const scale = Math.min(aspect / width, 1 / (depth * OFFICE3D_DEPTH_FORESHORTEN));
    return { columns, g, bg, bgDepth, width, depth, scale };
  };

  let best = measure([], 1);
  best.scale = -1;
  for (const target of ROOM_TARGETS) {
    const shapes = grid.map((room) => shapeRoom(room, target, narrow, 1));
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
    width,
    depth,
    rooms: rooms.flatMap((room) => spots.get(room) ?? []),
  };
}
