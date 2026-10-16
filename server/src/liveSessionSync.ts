import type { AgentStateStore } from './agentStateStore.js';
import type {
  LiveClaudeSession,
  TmuxLocation,
} from './providers/hook/claude/claudeSessionRegistry.js';
import type { AgentState } from './types.js';

export interface AgentTerminalInfo {
  name: string | null;
  tmux: TmuxLocation | null;
}

export function sameTmux(
  a: TmuxLocation | null | undefined,
  b: TmuxLocation | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.session === b.session && a.windowId === b.windowId && a.paneId === b.paneId;
}

/** Fields spread onto `agentCreated` when the registry already knows the agent. */
export function agentCreatedTerminalFields(agent: AgentState): {
  name?: string;
  tmux?: TmuxLocation;
} {
  const fields: { name?: string; tmux?: TmuxLocation } = {};
  if (agent.registryName) fields.name = agent.registryName;
  if (agent.tmux) fields.tmux = agent.tmux;
  return fields;
}

/** `existingAgents.agentTerminals`, omitted by the caller when empty. */
export function agentTerminalMap(store: AgentStateStore): Record<string, AgentTerminalInfo> {
  const map: Record<string, AgentTerminalInfo> = {};
  for (const [id, agent] of store) {
    if (!agent.tmux && !agent.registryName) continue;
    map[String(id)] = { name: agent.registryName ?? null, tmux: agent.tmux ?? null };
  }
  return map;
}

/**
 * Copy live tmux/name onto agents that share a session id. Broadcasts
 * `agentTerminal` only when the location or name changed. A session that
 * left the registry clears the location so the panel closes. A teammate that
 * shares its lead's session id runs in the lead's pane, so it takes the pane
 * but keeps its own name.
 */
export function syncLiveSessionMetadata(
  store: AgentStateStore,
  registry: { get(sessionId: string): LiveClaudeSession | undefined },
): void {
  for (const [id, agent] of store) {
    if (!agent.sessionId) continue;
    const inLeadSession =
      agent.leadAgentId !== undefined &&
      store.get(agent.leadAgentId)?.sessionId === agent.sessionId;
    const own = registry.get(agent.sessionId);
    if (own) delete agent.clearedFromSessionId;
    const live =
      own ?? (agent.clearedFromSessionId ? registry.get(agent.clearedFromSessionId) : undefined);
    const nextTmux = live?.tmux ?? null;
    const nextName = inLeadSession ? null : (live?.name ?? null);
    const had = agent.tmux !== undefined || agent.registryName !== undefined;
    if (!live && !had) continue;
    if (
      had &&
      sameTmux(agent.tmux ?? null, nextTmux) &&
      (agent.registryName ?? null) === nextName
    ) {
      continue;
    }
    agent.tmux = nextTmux;
    agent.registryName = nextName;
    store.broadcast({ type: 'agentTerminal', id, name: nextName, tmux: nextTmux });
  }
}
