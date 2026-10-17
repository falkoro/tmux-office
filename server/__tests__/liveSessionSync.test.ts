import { describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { syncLiveSessionMetadata } from '../src/liveSessionSync.js';
import type { LiveClaudeSession } from '../src/providers/hook/claude/claudeSessionRegistry.js';
import type { AgentState } from '../src/types.js';

function agent(id: number, sessionId: string, leadAgentId?: number): AgentState {
  return { id, sessionId, leadAgentId } as AgentState;
}

function live(sessionId: string, name: string, paneId: string): LiveClaudeSession {
  return {
    pid: 1,
    sessionId,
    configDir: '/home/me/.claude',
    cwd: '/work',
    tmux: { session: 'work-1', windowId: '@1', paneId },
    status: 'busy',
    name,
  };
}

describe('syncLiveSessionMetadata', () => {
  it("gives a teammate that shares its lead's session the lead's pane but not its name", () => {
    const store = new AgentStateStore();
    store.set(1, agent(1, 'lead-session'));
    store.set(2, agent(2, 'lead-session', 1));
    store.set(3, agent(3, 'own-session', 1));
    const sessions = new Map([
      ['lead-session', live('lead-session', 'zeta-c9', '%1')],
      ['own-session', live('own-session', 'researcher', '%2')],
    ]);

    syncLiveSessionMetadata(store, sessions);

    expect(store.get(1)?.registryName).toBe('zeta-c9');
    expect(store.get(2)?.registryName).toBeNull();
    expect(store.get(2)?.tmux?.paneId).toBe('%1');
    expect(store.get(3)?.registryName).toBe('researcher');
    expect(store.get(3)?.tmux?.paneId).toBe('%2');
  });
});
