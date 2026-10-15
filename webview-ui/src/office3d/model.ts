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

export type OfficeConfig = Pick<OfficeRooms, 'rooms' | 'pinned' | 'background'>;

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

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Natural order: `emperor-2` before `emperor-10`. */
export const naturalCompare = (a: string, b: string): number => natural.compare(a, b);

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
 * and agent id. Sub-agents ride along as helpers of
 * their parent's desk. `agentTools` supplies the human activity label
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
    const status = deskStatus({
      bubbleType: ch.bubbleType,
      waitingAwaitingInput: ch.waitingAwaitingInput,
      isActive: ch.isActive,
      asking: tools?.some((t) => t.question && !t.done),
    });
    desks.set(ch.id, {
      agentId: ch.id,
      name: meta?.name || ch.sessionName || ch.folderName || `Agent ${ch.id}`,
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
        desks: podDesks.sort(paneOrder),
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
  return rooms;
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
