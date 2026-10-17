import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import {
  CLAUDE_SESSION_POLL_INTERVAL_MS,
  DISMISSED_COOLDOWN_MS,
  EXTERNAL_SCAN_INTERVAL_MS,
  PROJECT_SCAN_INTERVAL_MS,
} from '../src/constants.js';
import { reassignAgentToFile, setTerminalAdapter } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { ClaudeSessionRegistry } from '../src/providers/hook/claude/claudeSessionRegistry.js';
import { CLAUDE_TERMINAL_NAME_PREFIX } from '../src/providers/hook/claude/constants.js';
import type { AgentState, PersistedAgent } from '../src/types.js';

const claudeTerminal = {
  activeTerminal: () => ({ name: `${CLAUDE_TERMINAL_NAME_PREFIX} 1` }),
  allTerminals: () => [{ name: `${CLAUDE_TERMINAL_NAME_PREFIX} 1` }],
};

function bareAgent(
  overrides: Partial<AgentState> & Pick<AgentState, 'id' | 'sessionId'>,
): AgentState {
  return {
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/tmp',
    jsonlFile: '/tmp/session.jsonl',
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
  };
}

function mockAdapter(initial: PersistedAgent[]): StateAdapter {
  return {
    loadAgents: () => initial,
    saveAgents: () => {},
    loadSeats: () => ({}),
    saveSeats: () => {},
    getSetting: <T>(_key: string, defaultValue: T): T => defaultValue,
    setSetting: () => {},
  };
}

describe('live-only', () => {
  const dirs: string[] = [];
  let runtime: AgentRuntime | undefined;

  afterEach(() => {
    vi.useRealTimers();
    runtime?.dispose();
    runtime = undefined;
    setTerminalAdapter({
      activeTerminal: () => undefined,
      allTerminals: () => [],
    });
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-live-only-'));
    dirs.push(dir);
    return dir;
  }

  function startRuntime(store = new AgentStateStore()): {
    store: AgentStateStore;
    runtime: AgentRuntime;
  } {
    runtime = new AgentRuntime(store, claudeProvider);
    return { store, runtime };
  }

  /** Empty project dir, then a just-written transcript the external scanner would adopt. */
  function armExternalScan(rt: AgentRuntime, dir: string): string {
    rt.startProjectScan(dir);
    const file = path.join(dir, 'recent.jsonl');
    fs.writeFileSync(file, '{"type":"user"}\n');
    rt.startExternalScanning(dir);
    return file;
  }

  /** New JSONL plus a Claude-named terminal, the project scan's adoption path. */
  function armProjectScan(rt: AgentRuntime, dir: string): string {
    rt.hooksEnabled.current = false;
    setTerminalAdapter(claudeTerminal);
    rt.startProjectScan(dir);
    const file = path.join(dir, 'new-term.jsonl');
    fs.writeFileSync(file, '{"type":"assistant"}\n');
    return file;
  }

  interface Planted {
    root: string;
    cwd: string;
    projectDir: string;
    jsonl: string;
    sessionFile: string;
    sessionId: string;
    store: AgentStateStore;
    runtime: AgentRuntime;
  }

  function plant(liveOnly: boolean, watchAll = false): Planted {
    const root = tempDir();
    const cwd = path.join(root, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const projectDir = path.join(root, '.claude-work', 'projects', normalizeProjectPath(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonl = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(jsonl, '{"type":"user"}\n');
    const sessionsDir = path.join(root, '.claude-work', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, '1.json');
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        pid: process.pid,
        sessionId,
        cwd,
        tmux: 'demo:@2.%3',
        status: 'idle',
        name: 'zeta',
      }),
    );
    const { store, runtime: rt } = startRuntime();
    rt.liveOnly.current = liveOnly;
    if (watchAll) rt.forceWatchAll = true;
    rt.startLiveSessionRegistry(new ClaudeSessionRegistry({ homeDir: root }), async () => null);
    return { root, cwd, projectDir, jsonl, sessionFile, sessionId, store, runtime: rt };
  }

  function tracks(store: AgentStateStore, file: string): boolean {
    for (const agent of store.values()) {
      if (agent.jsonlFile === file) return true;
    }
    return false;
  }

  it('adopts a live session without a tracked project dir', () => {
    const { store } = plant(true);
    expect(store.size).toBe(1);
    const agent = [...store.values()][0];
    expect(agent?.registryName).toBe('zeta');
    expect(agent?.tmux).toEqual({ session: 'demo', windowId: '@2', paneId: '%3' });
  });

  it('adopts a recent transcript from the external scanner when live-only is off', async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const { store, runtime: rt } = startRuntime();
    const file = armExternalScan(rt, dir);
    await vi.advanceTimersByTimeAsync(EXTERNAL_SCAN_INTERVAL_MS);
    expect(tracks(store, file)).toBe(true);
  });

  it('does not adopt a non-live transcript from the external scanner in live-only mode', async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const { store, runtime: rt } = startRuntime();
    rt.liveOnly.current = true;
    const file = armExternalScan(rt, dir);
    await vi.advanceTimersByTimeAsync(EXTERNAL_SCAN_INTERVAL_MS);
    expect(tracks(store, file)).toBe(false);
  });

  it('adopts a new JSONL from the project scan when live-only is off', async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const { store, runtime: rt } = startRuntime();
    const file = armProjectScan(rt, dir);
    await vi.advanceTimersByTimeAsync(PROJECT_SCAN_INTERVAL_MS);
    expect(tracks(store, file)).toBe(true);
  });

  it('does not adopt a non-live transcript from the project scan in live-only mode', async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const { store, runtime: rt } = startRuntime();
    rt.liveOnly.current = true;
    const file = armProjectScan(rt, dir);
    await vi.advanceTimersByTimeAsync(PROJECT_SCAN_INTERVAL_MS);
    expect(tracks(store, file)).toBe(false);
  });

  it('still adopts a named background teammate of a live lead from the project scan', async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const { store, runtime: rt } = startRuntime();
    rt.liveOnly.current = true;
    const lead = bareAgent({
      id: 1,
      sessionId: 'lead-sess',
      projectDir: dir,
      jsonlFile: path.join(dir, 'lead-sess.jsonl'),
      backgroundAgentToolIds: new Set(['toolu_1']),
    });
    fs.writeFileSync(lead.jsonlFile, '{"type":"user"}\n');
    store.set(1, lead);
    store.nextAgentId.current = 2;
    const subDir = path.join(dir, 'lead-sess', 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-a.jsonl'), '');
    fs.writeFileSync(
      path.join(subDir, 'agent-a.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        toolUseId: 'toolu_1',
        name: 'ghost-writer',
      }),
    );
    const stray = armProjectScan(rt, dir);
    await vi.advanceTimersByTimeAsync(PROJECT_SCAN_INTERVAL_MS);
    const teammate = [...store.values()].find((agent) => agent.agentName === 'ghost-writer');
    expect(teammate?.leadAgentId).toBe(1);
    expect(tracks(store, stray)).toBe(false);
  });

  it('does not adopt a non-live session from a hook when live-only is on', () => {
    const root = tempDir();
    const jsonl = path.join(root, 'hook-sess.jsonl');
    fs.writeFileSync(jsonl, '{"type":"user"}\n');
    const { store, runtime: rt } = startRuntime();
    rt.liveOnly.current = true;
    rt.watchAllSessions.current = true;
    rt.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'hook-sess',
      source: 'startup',
      transcript_path: jsonl,
      cwd: root,
    });
    rt.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: 'hook-sess' });
    expect(tracks(store, jsonl)).toBe(false);
  });

  it('adopts that same hook session when live-only is off', () => {
    const root = tempDir();
    const jsonl = path.join(root, 'hook-sess.jsonl');
    fs.writeFileSync(jsonl, '{"type":"user"}\n');
    const { store, runtime: rt } = startRuntime();
    rt.watchAllSessions.current = true;
    rt.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'hook-sess',
      source: 'startup',
      transcript_path: jsonl,
      cwd: root,
    });
    rt.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: 'hook-sess' });
    expect(tracks(store, jsonl)).toBe(true);
  });

  it('keeps a hook session the user closed closed after claude --resume', () => {
    const root = tempDir();
    const jsonl = path.join(root, 'hook-sess.jsonl');
    fs.writeFileSync(jsonl, '{"type":"user"}\n');
    const { store, runtime: rt } = startRuntime();
    rt.watchAllSessions.current = true;
    const start = (sessionId: string, source: string) => {
      rt.handleHookEvent('claude', {
        hook_event_name: 'SessionStart',
        session_id: sessionId,
        source,
        transcript_path: jsonl,
        cwd: root,
      });
      rt.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: sessionId });
    };
    start('hook-sess', 'startup');
    const id = [...store.keys()][0]!;
    handleClientMessage({ type: 'closeAgent', id }, () => undefined, {
      store,
      runtime: rt,
      cache: null,
    });
    expect(tracks(store, jsonl)).toBe(false);
    rt.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'hook-sess',
      reason: 'prompt_input_exit',
    });

    start('hook-sess-resumed', 'resume');

    expect(tracks(store, jsonl)).toBe(false);
  });

  it('does not restore a non-live transcript in live-only mode', () => {
    const root = tempDir();
    const jsonl = path.join(root, 'dead.jsonl');
    fs.writeFileSync(jsonl, '{}\n');
    const persisted: PersistedAgent[] = [
      {
        id: 4,
        sessionId: 'dead-sess',
        terminalName: '',
        isExternal: true,
        jsonlFile: jsonl,
        projectDir: root,
      },
    ];
    const off = new AgentStateStore();
    off.setAdapter(mockAdapter(persisted));
    const offRuntime = new AgentRuntime(off, claudeProvider);
    try {
      offRuntime.restoreExternalAgents();
      expect(off.get(4)?.sessionId).toBe('dead-sess');
    } finally {
      offRuntime.dispose();
    }

    const on = new AgentStateStore();
    on.setAdapter(mockAdapter(persisted));
    const { runtime: rt } = startRuntime(on);
    rt.liveOnly.current = true;
    rt.restoreExternalAgents();
    expect(on.size).toBe(0);
  });

  it('removes an agent when its session leaves and adopts the same session again', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    expect(planted.store.size).toBe(1);
    const removed: number[] = [];
    planted.store.on('agentRemoved', (id) => removed.push(id));
    const id = [...planted.store.keys()][0];
    fs.rmSync(planted.sessionFile);
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(planted.store.size).toBe(0);
    expect(removed).toEqual([id]);
    expect(planted.runtime.dismissalTracker.isDismissed(planted.jsonl)).toBe(false);
    expect(planted.runtime.dismissalTracker.isPermanentlyDismissed(planted.jsonl)).toBe(false);

    fs.writeFileSync(
      planted.sessionFile,
      JSON.stringify({
        pid: process.pid,
        sessionId: planted.sessionId,
        cwd: planted.cwd,
        tmux: 'demo:@2.%3',
        status: 'idle',
        name: 'zeta',
      }),
    );
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(planted.store.size).toBe(1);
    expect([...planted.store.values()][0]?.sessionId).toBe(planted.sessionId);
    expect(planted.runtime.dismissalTracker.isDismissed(planted.jsonl)).toBe(false);
  });

  it('keeps a live session the user closed closed after the dismissal cooldown', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    const id = [...planted.store.keys()][0]!;
    handleClientMessage({ type: 'closeAgent', id }, () => undefined, {
      store: planted.store,
      runtime: planted.runtime,
      cache: null,
    });
    expect(planted.store.size).toBe(0);

    await vi.advanceTimersByTimeAsync(DISMISSED_COOLDOWN_MS + CLAUDE_SESSION_POLL_INTERVAL_MS);

    expect(planted.store.size).toBe(0);
  });

  it('closing a lead also removes its teammate and its watched sub-agent', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    const lead = [...planted.store.values()][0]!;
    const teammateFile = path.join(planted.projectDir, 'researcher.jsonl');
    fs.writeFileSync(teammateFile, '');
    planted.store.set(
      40,
      bareAgent({
        id: 40,
        sessionId: lead.sessionId,
        projectDir: planted.projectDir,
        jsonlFile: teammateFile,
        leadAgentId: lead.id,
        agentName: 'researcher',
        spawnToolUseId: 'toolu_team',
      }),
    );
    const subFile = path.join(planted.projectDir, 'sub.jsonl');
    fs.writeFileSync(subFile, '');
    planted.runtime.subagentWatch.watch(lead, lead.id, {
      jsonlPath: subFile,
      toolUseId: 'toolu_sub',
    });

    handleClientMessage({ type: 'closeAgent', id: lead.id }, () => undefined, {
      store: planted.store,
      runtime: planted.runtime,
      cache: null,
    });
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);

    expect(planted.store.size).toBe(0);
    expect(planted.runtime.subagentWatch.isWatching(subFile)).toBe(false);
  });

  it('keeps the live own-session teammate of a closed lead closed after the cooldown', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    const lead = [...planted.store.values()][0]!;
    const teammateSession = '55555555-5555-5555-5555-555555555555';
    const teammateJsonl = path.join(planted.projectDir, `${teammateSession}.jsonl`);
    fs.writeFileSync(teammateJsonl, '{"type":"user"}\n');
    fs.writeFileSync(
      path.join(path.dirname(planted.sessionFile), '2.json'),
      JSON.stringify({ pid: process.pid, sessionId: teammateSession, cwd: planted.cwd }),
    );
    planted.store.set(
      40,
      bareAgent({
        id: 40,
        sessionId: teammateSession,
        projectDir: planted.projectDir,
        jsonlFile: teammateJsonl,
        leadAgentId: lead.id,
        agentName: 'researcher',
      }),
    );

    handleClientMessage({ type: 'closeAgent', id: lead.id }, () => undefined, {
      store: planted.store,
      runtime: planted.runtime,
      cache: null,
    });
    expect(planted.store.size).toBe(0);

    await vi.advanceTimersByTimeAsync(DISMISSED_COOLDOWN_MS + CLAUDE_SESSION_POLL_INTERVAL_MS);

    expect(planted.store.size).toBe(0);
  });

  it('removes a teammate whose lead is gone once its own session leaves', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    const orphanFile = path.join(planted.projectDir, 'orphan.jsonl');
    fs.writeFileSync(orphanFile, '');
    planted.store.set(
      40,
      bareAgent({
        id: 40,
        sessionId: 'gone',
        projectDir: planted.projectDir,
        jsonlFile: orphanFile,
        leadAgentId: 999,
      }),
    );

    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);

    expect(planted.store.has(40)).toBe(false);
    expect(planted.store.size).toBe(1);
  });

  it('keeps a live own-session teammate as a top-level agent when its lead session leaves', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    const lead = [...planted.store.values()][0]!;
    const teammateSession = '55555555-5555-5555-5555-555555555555';
    const teammateJsonl = path.join(planted.projectDir, `${teammateSession}.jsonl`);
    fs.writeFileSync(teammateJsonl, '{"type":"user"}\n');
    fs.writeFileSync(
      path.join(path.dirname(planted.sessionFile), '2.json'),
      JSON.stringify({ pid: process.pid, sessionId: teammateSession, cwd: planted.cwd }),
    );
    planted.store.set(
      40,
      bareAgent({
        id: 40,
        sessionId: teammateSession,
        projectDir: planted.projectDir,
        jsonlFile: teammateJsonl,
        leadAgentId: lead.id,
        agentName: 'researcher',
      }),
    );
    const inlineFile = path.join(planted.projectDir, 'writer.jsonl');
    fs.writeFileSync(inlineFile, '');
    planted.store.set(
      41,
      bareAgent({
        id: 41,
        sessionId: lead.sessionId,
        projectDir: planted.projectDir,
        jsonlFile: inlineFile,
        leadAgentId: lead.id,
        agentName: 'writer',
        spawnToolUseId: 'toolu_team',
      }),
    );

    fs.rmSync(planted.sessionFile);
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);

    expect([...planted.store.keys()]).toEqual([40]);
    expect(planted.store.get(40)!.leadAgentId).toBeUndefined();

    await vi.advanceTimersByTimeAsync(DISMISSED_COOLDOWN_MS + CLAUDE_SESSION_POLL_INTERVAL_MS);

    expect([...planted.store.keys()]).toEqual([40]);
  });

  function plantTeammateSession(planted: Planted, teamName: string): string {
    const teammateSession = '66666666-6666-6666-6666-666666666666';
    const teammateJsonl = path.join(planted.projectDir, `${teammateSession}.jsonl`);
    fs.writeFileSync(
      teammateJsonl,
      JSON.stringify({ type: 'user', teamName, agentName: 'researcher' }) + '\n',
    );
    fs.writeFileSync(
      path.join(path.dirname(planted.sessionFile), '2.json'),
      JSON.stringify({ pid: process.pid, sessionId: teammateSession, cwd: planted.cwd }),
    );
    return teammateJsonl;
  }

  it('leaves a teammate session of a tracked lead to team discovery when hooks are on', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    [...planted.store.values()][0]!.teamName = 'session-abcd1234';
    const teammateJsonl = plantTeammateSession(planted, 'session-abcd1234');

    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);

    expect(tracks(planted.store, teammateJsonl)).toBe(false);
  });

  it('adopts a teammate session of a tracked lead from the registry when hooks are off', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    planted.runtime.hooksEnabled.current = false;
    [...planted.store.values()][0]!.teamName = 'session-abcd1234';
    const teammateJsonl = plantTeammateSession(planted, 'session-abcd1234');

    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);

    expect(tracks(planted.store, teammateJsonl)).toBe(true);
  });

  it('leaves the agent in place when live-only is off and the session file disappears', async () => {
    vi.useFakeTimers();
    const planted = plant(false, true);
    expect(planted.store.size).toBe(1);
    fs.rmSync(planted.sessionFile);
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(planted.store.size).toBe(1);
  });

  it('keeps the same agent and pane when /clear replaces its session with hooks off', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    planted.runtime.hooksEnabled.current = false;
    const agent = [...planted.store.values()][0]!;
    const tmuxBefore = agent.tmux;
    const lifecycle: string[] = [];
    planted.store.on('agentAdded', (id) => lifecycle.push(`added ${id}`));
    planted.store.on('agentRemoved', (id) => lifecycle.push(`removed ${id}`));
    const nextSession = '22222222-2222-2222-2222-222222222222';
    const nextJsonl = path.join(planted.projectDir, `${nextSession}.jsonl`);
    fs.writeFileSync(nextJsonl, '{"type":"user"}\n');
    fs.writeFileSync(
      planted.sessionFile,
      JSON.stringify({
        pid: process.pid,
        sessionId: nextSession,
        cwd: planted.cwd,
        tmux: 'demo:@2.%3',
        status: 'busy',
        name: 'zeta',
      }),
    );
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(lifecycle).toEqual([]);
    expect([...planted.store.keys()]).toEqual([agent.id]);
    expect(planted.store.get(agent.id)?.sessionId).toBe(nextSession);
    expect(planted.store.get(agent.id)?.jsonlFile).toBe(nextJsonl);
    expect(planted.store.get(agent.id)?.tmux).toEqual(tmuxBefore);

    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(lifecycle).toEqual([]);
  });

  it('keeps the agent through /clear when the new transcript appears a tick after the registry switches', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    planted.runtime.hooksEnabled.current = false;
    const agent = [...planted.store.values()][0]!;
    const tmuxBefore = agent.tmux;
    const lifecycle: string[] = [];
    planted.store.on('agentAdded', (id) => lifecycle.push(`added ${id}`));
    planted.store.on('agentRemoved', (id) => lifecycle.push(`removed ${id}`));
    const nextSession = '66666666-6666-6666-6666-666666666666';
    const nextJsonl = path.join(planted.projectDir, `${nextSession}.jsonl`);
    fs.writeFileSync(
      planted.sessionFile,
      JSON.stringify({
        pid: process.pid,
        sessionId: nextSession,
        cwd: planted.cwd,
        tmux: 'demo:@2.%3',
      }),
    );
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(lifecycle).toEqual([]);
    expect(planted.store.get(agent.id)?.tmux).toEqual(tmuxBefore);

    fs.writeFileSync(nextJsonl, '{"type":"user"}\n');
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(lifecycle).toEqual([]);
    expect(planted.store.get(agent.id)?.sessionId).toBe(nextSession);
    expect(planted.store.get(agent.id)?.jsonlFile).toBe(nextJsonl);
    expect(planted.store.get(agent.id)?.tmux).toEqual(tmuxBefore);
  });

  it('follows /clear and then a resume back to the cleared session with hooks off', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    planted.runtime.hooksEnabled.current = false;
    const agent = [...planted.store.values()][0]!;
    const lifecycle: string[] = [];
    planted.store.on('agentAdded', (id) => lifecycle.push(`added ${id}`));
    planted.store.on('agentRemoved', (id) => lifecycle.push(`removed ${id}`));
    const live = (sessionId: string) =>
      fs.writeFileSync(
        planted.sessionFile,
        JSON.stringify({ pid: process.pid, sessionId, cwd: planted.cwd, tmux: 'demo:@2.%3' }),
      );
    const statuses: unknown[] = [];
    planted.store.on('broadcast', (msg) => {
      if (msg.type === 'agentStatus') statuses.push(msg.status);
    });
    const turnEnd = '{"type":"system","subtype":"turn_duration"}\n';
    const usage = (tokens: number) =>
      JSON.stringify({
        type: 'assistant',
        message: { usage: { cache_read_input_tokens: tokens }, content: [] },
      }) + '\n';
    const nextSession = '77777777-7777-7777-7777-777777777777';
    fs.writeFileSync(
      path.join(planted.projectDir, `${nextSession}.jsonl`),
      usage(150_000) + turnEnd,
    );
    live(nextSession);
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(planted.store.get(agent.id)?.sessionId).toBe(nextSession);
    expect(statuses).toContain('waiting');
    expect(planted.store.get(agent.id)?.contextTokens).toBe(150_000);

    fs.appendFileSync(planted.jsonl, usage(40_000) + turnEnd);
    vi.setSystemTime(Date.now() + EXTERNAL_SCAN_INTERVAL_MS * 2 + 1000);
    statuses.length = 0;
    live(planted.sessionId);
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(lifecycle).toEqual([]);
    expect(planted.store.get(agent.id)?.sessionId).toBe(planted.sessionId);
    expect(planted.store.get(agent.id)?.jsonlFile).toBe(planted.jsonl);
    expect(planted.store.get(agent.id)?.fileOffset).toBe(fs.statSync(planted.jsonl).size);
    expect(planted.store.get(agent.id)?.contextTokens).toBe(40_000);
    expect(statuses).not.toContain('waiting');
  });

  it('reads a transcript born after the given cutoff from its start, however old it is', () => {
    vi.useFakeTimers();
    const planted = plant(true);
    const agent = [...planted.store.values()][0]!;
    const launchedAt = Date.now() - 1000;
    const nextJsonl = path.join(planted.projectDir, 'abababab-abab-abab-abab-abababababab.jsonl');
    fs.writeFileSync(
      nextJsonl,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
        },
      }) + '\n',
    );
    vi.setSystemTime(Date.now() + EXTERNAL_SCAN_INTERVAL_MS * 2 + 1000);
    const started: unknown[] = [];
    planted.store.on('broadcast', (msg) => {
      if (msg.type === 'agentToolStart') started.push(msg.toolId);
    });

    reassignAgentToFile(
      agent.id,
      nextJsonl,
      planted.store,
      planted.runtime.fileWatchers,
      planted.runtime.pollingTimers,
      planted.runtime.waitingTimers,
      planted.runtime.permissionTimers,
      () => undefined,
      launchedAt,
    );

    expect(started).toEqual(['toolu_1']);
  });

  it('keeps the agent through /clear and a resume back before the new transcript exists', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    planted.runtime.hooksEnabled.current = false;
    const agent = [...planted.store.values()][0]!;
    const offsetBefore = agent.fileOffset;
    const lifecycle: string[] = [];
    planted.store.on('agentAdded', (id) => lifecycle.push(`added ${id}`));
    planted.store.on('agentRemoved', (id) => lifecycle.push(`removed ${id}`));
    const live = (sessionId: string) =>
      fs.writeFileSync(
        planted.sessionFile,
        JSON.stringify({ pid: process.pid, sessionId, cwd: planted.cwd, tmux: 'demo:@2.%3' }),
      );
    live('88888888-8888-8888-8888-888888888888');
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);

    live(planted.sessionId);
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(lifecycle).toEqual([]);
    expect([...planted.store.keys()]).toEqual([agent.id]);
    expect(planted.store.get(agent.id)?.sessionId).toBe(planted.sessionId);
    expect(planted.store.get(agent.id)?.jsonlFile).toBe(planted.jsonl);
    expect(planted.store.get(agent.id)?.fileOffset).toBe(offsetBefore);
  });

  it('keeps an agent closed while it awaits its /clear transcript closed once that appears', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    planted.runtime.hooksEnabled.current = false;
    const agent = [...planted.store.values()][0]!;
    const nextSession = '99999999-9999-9999-9999-999999999999';
    fs.writeFileSync(
      planted.sessionFile,
      JSON.stringify({
        pid: process.pid,
        sessionId: nextSession,
        cwd: planted.cwd,
        tmux: 'demo:@2.%3',
      }),
    );
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(planted.store.get(agent.id)?.sessionId).toBe(nextSession);

    handleClientMessage({ type: 'closeAgent', id: agent.id }, () => undefined, {
      store: planted.store,
      runtime: planted.runtime,
      cache: null,
    });
    fs.writeFileSync(path.join(planted.projectDir, `${nextSession}.jsonl`), '{"type":"user"}\n');
    await vi.advanceTimersByTimeAsync(DISMISSED_COOLDOWN_MS + CLAUDE_SESSION_POLL_INTERVAL_MS);

    expect(planted.store.size).toBe(0);
  });

  it('keeps an agent whose session id was already reassigned to the new registry session', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    const agent = [...planted.store.values()][0];
    expect(agent).toBeDefined();
    const nextSession = '33333333-3333-3333-3333-333333333333';
    const nextJsonl = path.join(planted.projectDir, `${nextSession}.jsonl`);
    fs.writeFileSync(nextJsonl, '{"type":"user"}\n');
    agent!.sessionId = nextSession;
    agent!.jsonlFile = nextJsonl;
    fs.writeFileSync(
      planted.sessionFile,
      JSON.stringify({
        pid: process.pid,
        sessionId: nextSession,
        cwd: planted.cwd,
        status: 'idle',
        name: 'zeta',
      }),
    );
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect([...planted.store.keys()]).toEqual([agent!.id]);
    expect(planted.store.get(agent!.id)?.sessionId).toBe(nextSession);
  });

  it('keeps an agent moved by /clear while the registry still shows its old session', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    const agent = [...planted.store.values()][0]!;
    agent.hookDelivered = true;
    const tmuxBefore = agent.tmux;
    expect(tmuxBefore).toBeTruthy();
    const nextSession = '44444444-4444-4444-4444-444444444444';
    const nextJsonl = path.join(planted.projectDir, `${nextSession}.jsonl`);
    fs.writeFileSync(nextJsonl, '{"type":"user"}\n');
    reassignAgentToFile(
      agent.id,
      nextJsonl,
      planted.store,
      planted.runtime.fileWatchers,
      planted.runtime.pollingTimers,
      planted.runtime.waitingTimers,
      planted.runtime.permissionTimers,
      () => undefined,
    );

    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect([...planted.store.keys()]).toEqual([agent.id]);
    expect(planted.store.get(agent.id)?.tmux).toEqual(tmuxBefore);

    fs.writeFileSync(
      planted.sessionFile,
      JSON.stringify({ pid: process.pid, sessionId: nextSession, cwd: planted.cwd }),
    );
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect([...planted.store.keys()]).toEqual([agent.id]);
    expect(planted.store.get(agent.id)?.sessionId).toBe(nextSession);

    fs.writeFileSync(
      planted.sessionFile,
      JSON.stringify({ pid: process.pid, sessionId: planted.sessionId, cwd: planted.cwd }),
    );
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(planted.store.get(agent.id)).toBeUndefined();
  });

  it('leaves the /clear successor to the hook when the registry shows it first', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    const agent = [...planted.store.values()][0]!;
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS - 100);
    planted.runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: planted.sessionId,
      reason: 'clear',
    });
    const nextSession = '55555555-5555-5555-5555-555555555555';
    const nextJsonl = path.join(planted.projectDir, `${nextSession}.jsonl`);
    fs.writeFileSync(nextJsonl, '{"type":"user"}\n');
    fs.writeFileSync(
      planted.sessionFile,
      JSON.stringify({ pid: process.pid, sessionId: nextSession, cwd: planted.cwd }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect([...planted.store.keys()]).toEqual([agent.id]);

    planted.runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: nextSession,
      source: 'clear',
      transcript_path: nextJsonl,
      cwd: planted.cwd,
    });
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect([...planted.store.keys()]).toEqual([agent.id]);
    expect(planted.store.get(agent.id)?.jsonlFile).toBe(nextJsonl);
  });

  it('keeps a sub-agent and an inline teammate of a live lead', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
    const lead = [...planted.store.values()][0];
    expect(lead).toBeDefined();
    const teammateFile = path.join(planted.projectDir, 'inline.jsonl');
    fs.writeFileSync(teammateFile, '');
    const teammate = bareAgent({
      id: 40,
      sessionId: 'inline-not-in-registry',
      projectDir: planted.projectDir,
      jsonlFile: teammateFile,
      leadAgentId: lead!.id,
    });
    planted.store.set(40, teammate);
    const subFile = path.join(planted.projectDir, 'sub.jsonl');
    fs.writeFileSync(subFile, '');
    planted.runtime.subagentWatch.watch(lead!, lead!.id, {
      jsonlPath: subFile,
      toolUseId: 'toolu_sub',
    });
    const strangerFile = path.join(planted.projectDir, 'stranger.jsonl');
    fs.writeFileSync(strangerFile, '');
    planted.store.set(
      41,
      bareAgent({
        id: 41,
        sessionId: 'gone',
        projectDir: planted.projectDir,
        jsonlFile: strangerFile,
      }),
    );

    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);

    expect(planted.store.has(lead!.id)).toBe(true);
    expect(planted.store.has(40)).toBe(true);
    expect(planted.store.has(41)).toBe(false);
    expect(planted.runtime.subagentWatch.isWatching(subFile)).toBe(true);
    expect(planted.runtime.dismissalTracker.isDismissed(planted.jsonl)).toBe(false);

    fs.rmSync(planted.sessionFile);
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(planted.store.size).toBe(0);
    expect(planted.runtime.subagentWatch.isWatching(subFile)).toBe(false);
    expect(planted.runtime.dismissalTracker.isDismissed(planted.jsonl)).toBe(false);
  });
});
