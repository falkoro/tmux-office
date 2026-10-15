import { type DeskStatus, deskStatus } from '../../../core/src/deskStatus.js';
import type { OfficeRooms } from '../../../core/src/messages.js';
import { matchesRoomPattern } from '../../../core/src/roomPatterns.js';
import type { Character, ToolActivity } from '../office/types.js';

export { type DeskStatus, deskStatus };

export interface HelperModel {
  agentId: number;
  status: DeskStatus;
  tool: string | null;
}

export interface DeskModel {
  agentId: number;
  name: string;
  /** The name on the desk's card. See deskLabels. */
  label: string;
  pane: { session: string; windowId: string; paneId: string } | null;
  status: DeskStatus;
  tool: string | null;
  contextRatio: number;
  helpers: HelperModel[];
}

/** What the office reads from an AgentTerminalMeta, declared here so tests stay DOM-free. */
export interface TerminalMeta {
  name: string | null;
  tmux: DeskModel['pane'];
}

/** The desks of one tmux session inside a room. */
export interface PodModel {
  /** The tmux session name, or NO_PANE_POD_ID for agents without a pane. */
  id: string;
  title: string;
  pinned: boolean;
  /** True when desks[0] oversees the rest. The no-pane pod shares no session, so it has none. */
  hasOverseer: boolean;
  desks: DeskModel[];
}

export interface RoomModel {
  id: string;
  title: string;
  pods: PodModel[];
}

/** tmux turns ':' in a session name into '_', so these ids never collide with a session. */
export const BACKGROUND_ROOM_ID = ':background';
export const BACKGROUND_ROOM_TITLE = 'Background';
export const NO_PANE_POD_ID = ':no-pane';
export const NO_PANE_POD_TITLE = 'No tmux';

export type OfficeConfig = Pick<OfficeRooms, 'rooms' | 'pinned' | 'overseers' | 'background'>;

/** What the camera frames: a room, or one session's pod. Rooms and sessions can share a name. */
export interface Focus {
  kind: 'room' | 'pod';
  id: string;
}

/** Session names never contain ':', so this prefix cannot be part of one. */
const SESSION_HASH = 'session:';

/** A focus as a URL hash: its name, or `session:<name>` for a session named like a room. */
export function focusHash(rooms: readonly RoomModel[], focus: Focus): string {
  return focus.kind === 'pod' && rooms.some((r) => r.id === focus.id)
    ? SESSION_HASH + focus.id
    : focus.id;
}

/** What a URL hash names in these rooms, a room before a session; null when it is not here. */
export function focusFromHash(rooms: readonly RoomModel[], hash: string | null): Focus | null {
  if (hash === null) return null;
  if (rooms.some((r) => r.id === hash)) return { kind: 'room', id: hash };
  const id = hash.startsWith(SESSION_HASH) ? hash.slice(SESSION_HASH.length) : hash;
  return rooms.some((r) => r.pods.some((p) => p.id === id)) ? { kind: 'pod', id } : null;
}

/** A deep link and what it names now. Only the user changes the link; the rooms only resolve it. */
export class FocusLink {
  hash: string | null;
  focus: Focus | null = null;

  constructor(hash: string | null) {
    this.hash = hash;
  }

  /** Resolves the link against new rooms. True when the focus changed. */
  resolve(rooms: readonly RoomModel[]): boolean {
    const next = focusFromHash(rooms, this.hash);
    const changed = next?.kind !== this.focus?.kind || next?.id !== this.focus?.id;
    this.focus = next;
    return changed;
  }
}

export const roomDesks = (room: RoomModel): DeskModel[] => room.pods.flatMap((pod) => pod.desks);

export const STATUS_TEXT: Record<DeskStatus, string> = {
  working: 'Working',
  'needs-permission': 'Needs permission',
  'waiting-input': 'Waiting for you',
  done: 'Done',
  idle: 'Idle',
};

/** Desks that need the owner, most urgent first. */
export const ATTENTION_STATUSES: readonly DeskStatus[] = ['needs-permission', 'waiting-input'];

// A fixed locale, so every viewer sees one order.
const natural = new Intl.Collator('en', { numeric: true });

/** Natural order: `work-2` before `work-10`. Names the collator ties fall back to code units. */
export const naturalCompare = (a: string, b: string): number =>
  natural.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

function activityText(
  ch: Character,
  tools: ToolActivity[] | undefined,
  status: DeskStatus,
): string | null {
  if (tools && tools.length > 0) {
    const open = [...tools].reverse().find((t) => !t.done);
    if (open) return open.status;
    if (status === 'working') return tools[tools.length - 1].status;
  }
  return status === 'working' ? ch.currentTool : null;
}

/**
 * Turn the live character map into rooms of session pods of desks. Without
 * configured rooms, one room per tmux session in natural order. With them,
 * every configured room appears in config order, even with no desks, and a
 * desk joins the first room whose glob matches its session. A desk with no pane
 * or no matching room goes to the background, last, unless the config hides
 * the background. Inside a room, pinned pods come first, then sessions in
 * natural order, then the no-pane pod; desks in a pod sort by window, pane,
 * and agent id, except that a session's overseer comes first: its first agent
 * whose name matches `config.overseers`, else the agent in the session's oldest
 * window (tmux window id order). Sub-agents ride along as helpers of their
 * parent's desk. `agentTools` supplies the human activity label
 * ("Reading App.tsx"); without it the bare tool name is used.
 */
export function deriveOffice(
  chars: Iterable<Character>,
  terminals: Record<number, TerminalMeta>,
  agentTools: Record<number, ToolActivity[]> = {},
  config: OfficeConfig | null = null,
): RoomModel[] {
  const desks = new Map<number, DeskModel>();
  const subagents: Character[] = [];

  for (const ch of chars) {
    if (ch.matrixEffect === 'despawn') continue;
    if (ch.isSubagent) {
      subagents.push(ch);
      continue;
    }
    const meta = terminals[ch.id];
    const tools = agentTools[ch.id];
    const name = meta?.name || ch.sessionName || ch.folderName || `Agent ${ch.id}`;
    const status = deskStatus({
      bubbleType: ch.bubbleType,
      waitingAwaitingInput: ch.waitingAwaitingInput,
      isActive: ch.isActive,
      asking: tools?.some((t) => t.question && !t.done),
    });
    desks.set(ch.id, {
      agentId: ch.id,
      name,
      label: name,
      pane: meta ? meta.tmux : (ch.tmux ?? null),
      status,
      tool: activityText(ch, tools, status),
      contextRatio:
        ch.maxContextTokens > 0
          ? Math.min(1, Math.max(0, ch.contextTokens / ch.maxContextTokens))
          : 0,
      helpers: [],
    });
  }

  for (const sub of subagents.sort((a, b) => b.id - a.id)) {
    const parent = sub.parentAgentId === null ? undefined : desks.get(sub.parentAgentId);
    if (!parent) continue;
    parent.helpers.push({ agentId: sub.id, status: deskStatus(sub), tool: sub.currentTool });
  }

  const paneOrder = (a: DeskModel, b: DeskModel): number =>
    naturalCompare(a.pane?.windowId ?? '', b.pane?.windowId ?? '') ||
    naturalCompare(a.pane?.paneId ?? '', b.pane?.paneId ?? '') ||
    a.agentId - b.agentId;
  const podOrder = (a: PodModel, b: PodModel): number =>
    Number(b.pinned) - Number(a.pinned) ||
    Number(a.id === NO_PANE_POD_ID) - Number(b.id === NO_PANE_POD_ID) ||
    naturalCompare(a.id, b.id);
  const pinned = config?.pinned ?? [];
  const overseers = config?.overseers ?? [];
  const overseerFirst = (sorted: DeskModel[]): DeskModel[] => {
    const i = sorted.findIndex((d) => matchesRoomPattern(overseers, d.name));
    return i <= 0 ? sorted : [sorted[i], ...sorted.slice(0, i), ...sorted.slice(i + 1)];
  };
  const toPods = (roomDeskList: DeskModel[]): PodModel[] => {
    const bySession = new Map<string, DeskModel[]>();
    for (const desk of roomDeskList) {
      const id = desk.pane?.session ?? NO_PANE_POD_ID;
      const list = bySession.get(id) ?? [];
      list.push(desk);
      bySession.set(id, list);
    }
    return [...bySession]
      .map(([id, podDesks]) => ({
        id,
        title: id === NO_PANE_POD_ID ? NO_PANE_POD_TITLE : id,
        pinned: id !== NO_PANE_POD_ID && matchesRoomPattern(pinned, id),
        hasOverseer: id !== NO_PANE_POD_ID,
        desks:
          id === NO_PANE_POD_ID
            ? podDesks.sort(paneOrder)
            : overseerFirst(podDesks.sort(paneOrder)),
      }))
      .sort(podOrder);
  };

  const named = config && config.rooms.length > 0 ? config.rooms : null;
  const roomOf = (session: string | undefined): string | undefined =>
    session && named
      ? named.find((room) => matchesRoomPattern(room.patterns, session))?.name
      : session;
  const byRoom = new Map<string, DeskModel[]>(named?.map((room) => [room.name, []]));
  const background: DeskModel[] = [];
  for (const desk of desks.values()) {
    const id = roomOf(desk.pane?.session);
    if (id === undefined) {
      background.push(desk);
      continue;
    }
    const list = byRoom.get(id) ?? [];
    list.push(desk);
    byRoom.set(id, list);
  }

  const ids = named ? [...byRoom.keys()] : [...byRoom.keys()].sort(naturalCompare);
  const rooms: RoomModel[] = ids.map((id) => ({
    id,
    title: id,
    pods: toPods(byRoom.get(id) ?? []),
  }));
  if (background.length > 0 && config?.background !== false) {
    rooms.push({ id: BACKGROUND_ROOM_ID, title: BACKGROUND_ROOM_TITLE, pods: toPods(background) });
  }
  deskLabels(rooms, overseers);
  return rooms;
}

/** An agent name's trailing id of two hex characters, as in `triage-c9`. */
const NAME_ID = /[-_][0-9a-f]{2}$/i;
const SEPARATOR = /[-_\s]/;

/**
 * Card names that read like names. A label drops the name's trailing hex id and turns `-` and
 * `_` into spaces. An overseer's label also drops the literal start of the glob that made it one,
 * when that start ends at a word boundary, since its star says that already. Two desks whose
 * labels would match keep their whole names.
 */
function deskLabels(rooms: RoomModel[], overseers: readonly string[]): void {
  const short = new Map<DeskModel, string>();
  for (const room of rooms) {
    for (const pod of room.pods) {
      pod.desks.forEach((desk, i) => {
        let text = desk.name.replace(NAME_ID, '');
        if (pod.hasOverseer && i === 0) {
          const glob = overseers.find((g) => matchesRoomPattern([g], desk.name));
          const role = glob?.split('*')[0] ?? '';
          const boundary =
            SEPARATOR.test(role.slice(-1)) || SEPARATOR.test(text.charAt(role.length));
          const rest = text.slice(role.length).replace(/^[-_\s]+/, '');
          if (role && boundary && text.startsWith(role) && rest) text = rest;
        }
        short.set(desk, spaced(text || desk.name));
      });
    }
  }
  const seen = new Map<string, number>();
  for (const text of short.values()) seen.set(text, (seen.get(text) ?? 0) + 1);
  for (const [desk, text] of short) {
    desk.label = seen.get(text) === 1 ? text : spaced(desk.name);
  }
}

function spaced(name: string): string {
  return name.replace(/[-_]+/g, ' ');
}

/** The most urgent status in a room, used to heat its floor and label. */
export function roomHeat(room: RoomModel): DeskStatus | null {
  for (const status of ATTENTION_STATUSES) {
    const desks = roomDesks(room);
    if (desks.some((d) => d.status === status || d.helpers.some((h) => h.status === status))) {
      return status;
    }
  }
  return null;
}
