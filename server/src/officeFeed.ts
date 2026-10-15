import { type DeskStatus, deskStatus, type StatusInput } from '../../core/src/deskStatus.js';
import type { OfficeRooms } from '../../core/src/messages.js';
import { matchesRoomPattern } from '../../core/src/roomPatterns.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { AgentState } from './types.js';

export interface FeedDesk {
  name: string;
  session: string | null;
  /** Configured room (or the session without rooms); null is the background. */
  room: string | null;
  pinned: boolean;
  status: DeskStatus;
  helpers: DeskStatus[];
}

export interface OfficeFeed {
  desks: FeedDesk[];
}

export interface FeedToolNames {
  subagentToolNames: ReadonlySet<string>;
  questionTools?: ReadonlySet<string>;
}

interface Helper {
  active: boolean;
  permission: boolean;
  open: Set<string>;
}

interface Desk extends StatusInput {
  questions: Set<string>;
  helpers: Map<string, Helper>;
  background: Set<string>;
}

type Msg = Record<string, unknown>;

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * A JSON view of the office for pages that cannot speak /ws, such as the
 * house walkthrough. It folds the same broadcasts the webview folds in
 * useExtensionMessages.ts, so a desk here has the status the office shows.
 * Names, sessions and statuses only: tool text and paths never leave.
 */
export class OfficeFeedState {
  private readonly desks = new Map<number, Desk>();

  constructor(
    private readonly store: AgentStateStore,
    private readonly tools: FeedToolNames,
  ) {
    store.on('broadcast', (msg) => this.apply(msg));
  }

  private desk(id: number): Desk {
    let desk = this.desks.get(id);
    if (!desk) {
      desk = {
        ...seed(this.store.get(id)),
        questions: new Set(),
        helpers: new Map(),
        background: new Set(),
      };
      this.desks.set(id, desk);
    }
    return desk;
  }

  private helper(desk: Desk, parentToolId: string): Helper {
    let helper = desk.helpers.get(parentToolId);
    if (!helper) {
      helper = { active: true, permission: false, open: new Set() };
      desk.helpers.set(parentToolId, helper);
    }
    return helper;
  }

  apply(msg: Msg): void {
    const id = msg.id;
    if (typeof id !== 'number') return;
    const toolId = String(msg.toolId ?? '');
    const parentToolId = String(msg.parentToolId ?? '');
    switch (msg.type) {
      case 'agentClosed':
        this.desks.delete(id);
        return;
      case 'agentToolStart': {
        const desk = this.desk(id);
        const toolName = typeof msg.toolName === 'string' ? msg.toolName : '';
        desk.isActive = true;
        if (this.tools.questionTools?.has(toolName)) desk.questions.add(toolId);
        if (!msg.permissionActive && desk.bubbleType === 'permission') desk.bubbleType = null;
        if (msg.runInBackground) desk.background.add(toolId);
        const parentHasTeam = !!this.store.get(id)?.teamName;
        if (
          this.tools.subagentToolNames.has(toolName) &&
          !msg.isTeammateSpawn &&
          (!msg.runInBackground || !parentHasTeam)
        ) {
          this.helper(desk, toolId);
        }
        return;
      }
      case 'agentToolDone':
        this.desk(id).questions.delete(toolId);
        return;
      case 'agentToolsClear': {
        const desk = this.desk(id);
        const agent = this.store.get(id);
        desk.questions.clear();
        if (!(agent?.teamName && agent.isTeamLead && !agent.teamUsesTmux)) {
          for (const key of desk.helpers.keys()) {
            if (!desk.background.has(key)) desk.helpers.delete(key);
          }
        }
        if (desk.bubbleType === 'permission') desk.bubbleType = null;
        return;
      }
      case 'agentStatus': {
        const desk = this.desk(id);
        desk.isActive = msg.status === 'active';
        if (msg.status === 'waiting') {
          desk.bubbleType = 'waiting';
          desk.waitingAwaitingInput = msg.awaitingInput === true;
        }
        return;
      }
      case 'agentToolPermission':
        this.desk(id).bubbleType = 'permission';
        return;
      case 'agentToolPermissionClear': {
        const desk = this.desk(id);
        if (desk.bubbleType === 'permission') desk.bubbleType = null;
        for (const helper of desk.helpers.values()) helper.permission = false;
        return;
      }
      case 'subagentToolPermission': {
        const helper = this.desk(id).helpers.get(parentToolId);
        if (helper) helper.permission = true;
        return;
      }
      case 'subagentToolStart': {
        const desk = this.desk(id);
        if (!desk.helpers.has(parentToolId)) desk.background.add(parentToolId);
        const helper = this.helper(desk, parentToolId);
        helper.active = true;
        helper.open.add(toolId);
        return;
      }
      case 'subagentToolDone': {
        const helper = this.desk(id).helpers.get(parentToolId);
        if (!helper) return;
        helper.open.delete(toolId);
        if (helper.open.size === 0) helper.active = false;
        return;
      }
      case 'subagentClear': {
        const desk = this.desk(id);
        desk.helpers.delete(parentToolId);
        desk.background.delete(parentToolId);
        return;
      }
    }
  }

  snapshot(config: OfficeRooms | null): OfficeFeed {
    const named = config && config.rooms.length > 0 ? config.rooms : null;
    const desks: FeedDesk[] = [];
    for (const [id, agent] of this.store) {
      const session = agent.tmux?.session ?? null;
      const room =
        session && named
          ? (named.find((r) => matchesRoomPattern(r.patterns, session))?.name ?? null)
          : session;
      if (room === null && config?.background === false) continue;
      const desk = this.desks.get(id);
      desks.push({
        name: agent.registryName || agent.agentName || agent.folderName || `Agent ${id}`,
        session,
        room,
        pinned: !!session && matchesRoomPattern(config?.pinned ?? [], session),
        status: desk
          ? deskStatus({ ...desk, asking: desk.questions.size > 0 })
          : deskStatus(seed(agent)),
        helpers: [...(desk?.helpers.values() ?? [])].map((h) =>
          deskStatus({ bubbleType: h.permission ? 'permission' : null, isActive: h.active }),
        ),
      });
    }
    return {
      desks: desks.sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          natural.compare(a.session ?? '￿', b.session ?? '￿') ||
          natural.compare(a.name, b.name),
      ),
    };
  }
}

/** An agent the feed has not heard about yet, read from server state. */
function seed(agent: AgentState | undefined): StatusInput {
  return {
    bubbleType: agent?.permissionSent ? 'permission' : agent?.isWaiting ? 'waiting' : null,
    isActive: !(agent?.isWaiting ?? false),
  };
}
