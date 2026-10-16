import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { DismissalTracker } from '../src/dismissalTracker.js';
import { reassignAgentToFile, setDismissalTracker } from '../src/fileWatcher.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SessionRouter } from '../src/sessionRouter.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 0,
    sessionId: 'test-session',
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

/** The last agentStatus a client saw live, and the one a reconnecting client is replayed. */
function liveAndReplayedStatus(drive: (store: AgentStateStore) => void) {
  const store = new AgentStateStore();
  store.set(1, createTestAgent({ id: 1 }));
  const live: Array<Record<string, unknown>> = [];
  store.on('broadcast', (msg) => live.push(msg));
  drive(store);
  const replayed: Array<Record<string, unknown>> = [];
  resendAgentActivity((msg) => replayed.push(msg), store);
  const lastStatus = (msgs: Array<Record<string, unknown>>) =>
    msgs.filter((m) => m.type === 'agentStatus').at(-1);
  return { live: lastStatus(live), replayed: lastStatus(replayed) };
}

describe('resendAgentActivity', () => {
  it('replays an agent waiting for input as waiting for input, not done', () => {
    const { live, replayed } = liveAndReplayedStatus((store) => {
      const handler = new HookEventHandler(
        store,
        new Map(),
        new Map(),
        claudeProvider,
        new SessionRouter(),
      );
      handler.registerAgent('sess-1', 1);
      handler.handleEvent('claude', {
        hook_event_name: 'Notification',
        session_id: 'sess-1',
        notification_type: 'idle_prompt',
      });
    });
    expect(live).toMatchObject({ status: 'waiting', awaitingInput: true });
    expect(replayed).toEqual(live);
  });

  it('replays an agent mid-turn with no open tool as active', () => {
    const { live, replayed } = liveAndReplayedStatus((store) => {
      const line = JSON.stringify({ type: 'user', message: { content: 'next task' } });
      processTranscriptLine(1, line, store, new Map(), new Map());
    });
    expect(live).toEqual({ type: 'agentStatus', id: 1, status: 'active' });
    expect(replayed).toEqual(live);
  });

  it('replays no active status after /clear follows a finished turn', () => {
    const { live, replayed } = liveAndReplayedStatus((store) => {
      for (const record of [
        { type: 'user', message: { content: 'task' } },
        { type: 'system', subtype: 'turn_duration' },
        {
          type: 'user',
          isMeta: true,
          message: { content: '<local-command-caveat>Caveat</local-command-caveat>' },
        },
        {
          type: 'user',
          message: {
            content: '<command-name>/clear</command-name>\n<command-args></command-args>',
          },
        },
      ]) {
        processTranscriptLine(1, JSON.stringify(record), store, new Map(), new Map());
      }
    });
    expect(live).toMatchObject({ status: 'waiting' });
    expect(replayed).toEqual(live);
  });

  it('ends the turn when a local command prints its output', () => {
    const { live, replayed } = liveAndReplayedStatus((store) => {
      for (const record of [
        { type: 'user', message: { content: 'task' } },
        { type: 'system', subtype: 'turn_duration' },
        {
          type: 'user',
          message: {
            content: '<command-name>/model</command-name>\n<command-args></command-args>',
          },
        },
        {
          type: 'user',
          message: { content: '<local-command-stdout>Set model to Opus</local-command-stdout>' },
        },
      ]) {
        processTranscriptLine(1, JSON.stringify(record), store, new Map(), new Map());
      }
    });
    expect(live).toMatchObject({ status: 'waiting' });
    expect(replayed).toEqual(live);
  });

  it('replays no active status for an agent moved to its /clear transcript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-resend-'));
    const pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
    try {
      const next = path.join(dir, 'next.jsonl');
      fs.writeFileSync(next, '');
      setDismissalTracker(new DismissalTracker());
      const { live, replayed } = liveAndReplayedStatus((store) => {
        const prompt = JSON.stringify({ type: 'user', message: { content: 'task' } });
        processTranscriptLine(1, prompt, store, new Map(), new Map());
        const done = JSON.stringify({ type: 'system', subtype: 'turn_duration' });
        processTranscriptLine(1, done, store, new Map(), new Map());
        reassignAgentToFile(
          1,
          next,
          store,
          new Map(),
          pollingTimers,
          new Map(),
          new Map(),
          () => {},
        );
      });
      expect(live).toMatchObject({ status: 'waiting' });
      expect(replayed).toEqual(live);
    } finally {
      for (const timer of pollingTimers.values()) clearInterval(timer);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends messages in order: team info, tools, waiting, context', () => {
    const store = new AgentStateStore();
    store.set(
      1,
      createTestAgent({
        id: 1,
        teamName: 'test-team',
        activeToolStatuses: new Map([['tool-1', 'Running']]),
        activeToolNames: new Map([['tool-1', 'Bash']]),
        isWaiting: true,
        contextTokens: 50_000,
      }),
    );
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), store);

    expect(sent.map((m) => m.type)).toEqual([
      'agentTeamInfo',
      'agentToolStart',
      'agentStatus',
      'agentContextUsage',
    ]);
  });

  it('includes basic fields for regular tools', () => {
    const store = new AgentStateStore();
    store.set(
      1,
      createTestAgent({
        id: 1,
        activeToolStatuses: new Map([['tool-1', 'Running']]),
        activeToolNames: new Map([['tool-1', 'Bash']]),
      }),
    );
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), store);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'agentToolStart',
      id: 1,
      toolId: 'tool-1',
      status: 'Running',
      toolName: 'Bash',
    });
  });

  it('handles background tools with flags and promoted skip logic', () => {
    const store = new AgentStateStore();
    // Lead with three background tools: unnamed, named spawn, and promoted
    store.set(
      1,
      createTestAgent({
        id: 1,
        // A teamed lead: the webview routes agentToolStart by the parent's
        // teamName, so the team message has to land before the tool replays or
        // a background spawn is routed as if the lead had no team.
        teamName: 'test-team',
        activeToolStatuses: new Map([
          ['bg-unnamed', 'Subtask: Unnamed'],
          ['bg-named', 'Subtask: Named'],
          ['bg-promoted', 'Subtask: Promoted'],
        ]),
        activeToolNames: new Map([
          ['bg-unnamed', 'Agent'],
          ['bg-named', 'Agent'],
          ['bg-promoted', 'Agent'],
        ]),
        backgroundAgentToolIds: new Set(['bg-unnamed', 'bg-named', 'bg-promoted']),
        teammateSpawnToolIds: new Set(['bg-named']),
      }),
    );
    // Promoted teammate (should cause bg-promoted to be skipped)
    store.set(
      2,
      createTestAgent({
        id: 2,
        leadAgentId: 1,
        spawnToolUseId: 'bg-promoted',
        agentName: 'promoted-agent',
      }),
    );
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), store);

    const toolStarts = sent.filter((m) => m.type === 'agentToolStart');
    expect(toolStarts).toHaveLength(2); // unnamed + named, NOT promoted

    // Team info first: the webview reads the parent's teamName to decide whether
    // a background agentToolStart becomes a Subtask sub-character, so a replay
    // that arrives before it is routed against stale team state.
    const teamIdx = sent.findIndex((m) => m.type === 'agentTeamInfo' && m.id === 1);
    const firstBgToolIdx = sent.findIndex((m) => m.type === 'agentToolStart' && m.id === 1);
    expect(teamIdx).toBeGreaterThanOrEqual(0);
    expect(teamIdx).toBeLessThan(firstBgToolIdx);

    // Unnamed: runInBackground=true, no isTeammateSpawn. toolName is required —
    // without it the webview cannot recreate the Subtask after agentToolsClear.
    const unnamed = toolStarts.find((t) => t.toolId === 'bg-unnamed');
    expect(unnamed).toMatchObject({ runInBackground: true, toolName: 'Agent' });
    expect(unnamed?.isTeammateSpawn).toBeUndefined();

    // Named: runInBackground=true, isTeammateSpawn=true, toolName present.
    const named = toolStarts.find((t) => t.toolId === 'bg-named');
    expect(named).toMatchObject({
      runInBackground: true,
      isTeammateSpawn: true,
      toolName: 'Agent',
    });
  });

  it('sends team info for any team field trigger, omits when none present', () => {
    // teamName trigger
    let store = new AgentStateStore();
    store.set(1, createTestAgent({ id: 1, teamName: 'my-team' }));
    let sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), store);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'agentTeamInfo', id: 1, teamName: 'my-team' });

    // agentName trigger (derived team)
    store = new AgentStateStore();
    store.set(2, createTestAgent({ id: 2, agentName: 'worker-1', leadAgentId: 1 }));
    sent = [];
    resendAgentActivity((msg) => sent.push(msg), store);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'agentTeamInfo', id: 2, agentName: 'worker-1' });

    // isTeamLead trigger
    store = new AgentStateStore();
    store.set(3, createTestAgent({ id: 3, isTeamLead: true }));
    sent = [];
    resendAgentActivity((msg) => sent.push(msg), store);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'agentTeamInfo', id: 3, isTeamLead: true });

    // No team fields: no message
    store = new AgentStateStore();
    store.set(4, createTestAgent({ id: 4 }));
    sent = [];
    resendAgentActivity((msg) => sent.push(msg), store);
    expect(sent.filter((m) => m.type === 'agentTeamInfo')).toHaveLength(0);
  });

  it('sends waiting status only when agent is waiting', () => {
    let store = new AgentStateStore();
    store.set(1, createTestAgent({ id: 1, isWaiting: true }));
    let sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), store);
    expect(sent).toEqual([{ type: 'agentStatus', id: 1, status: 'waiting', awaitingInput: false }]);

    store = new AgentStateStore();
    store.set(2, createTestAgent({ id: 2, isWaiting: false }));
    sent = [];
    resendAgentActivity((msg) => sent.push(msg), store);
    expect(sent).toHaveLength(0);
  });

  it('replays a pending permission wait after the tool it marks', () => {
    const store = new AgentStateStore();
    store.set(
      1,
      createTestAgent({
        id: 1,
        permissionSent: true,
        activeToolStatuses: new Map([['tool-1', 'Running: git push']]),
        activeToolNames: new Map([['tool-1', 'Bash']]),
      }),
    );
    store.set(2, createTestAgent({ id: 2 }));
    const sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), store);
    expect(sent.map((m) => `${m.type}#${m.id}`)).toEqual([
      'agentToolStart#1',
      'agentToolPermission#1',
    ]);
  });

  it('sends context usage only when agent has tokens', () => {
    let store = new AgentStateStore();
    store.set(1, createTestAgent({ id: 1, contextTokens: 50_000, maxContextTokens: 200_000 }));
    let sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), store);
    expect(sent).toEqual([
      { type: 'agentContextUsage', id: 1, contextTokens: 50_000, maxContextTokens: 200_000 },
    ]);

    store = new AgentStateStore();
    store.set(2, createTestAgent({ id: 2, contextTokens: 0, maxContextTokens: 200_000 }));
    sent = [];
    resendAgentActivity((msg) => sent.push(msg), store);
    expect(sent).toHaveLength(0);
  });

  it('handles edge cases: empty store and multiple agents', () => {
    // Empty store
    let store = new AgentStateStore();
    let sent: Array<Record<string, unknown>> = [];
    resendAgentActivity((msg) => sent.push(msg), store);
    expect(sent).toHaveLength(0);

    // Multiple agents with different activity
    store = new AgentStateStore();
    store.set(
      1,
      createTestAgent({
        id: 1,
        activeToolStatuses: new Map([['tool-1', 'Running']]),
        activeToolNames: new Map([['tool-1', 'Bash']]),
      }),
    );
    store.set(2, createTestAgent({ id: 2, isWaiting: true }));
    sent = [];
    resendAgentActivity((msg) => sent.push(msg), store);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ type: 'agentToolStart', id: 1 });
    expect(sent[1]).toMatchObject({ type: 'agentStatus', id: 2, status: 'waiting' });
  });
});
