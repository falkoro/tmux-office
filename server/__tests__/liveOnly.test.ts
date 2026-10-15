import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  CLAUDE_SESSION_POLL_INTERVAL_MS,
  EXTERNAL_SCAN_INTERVAL_MS,
  PROJECT_SCAN_INTERVAL_MS,
} from '../src/constants.js';
import { setTerminalAdapter } from '../src/fileWatcher.js';
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

  it('leaves the agent in place when live-only is off and the session file disappears', async () => {
    vi.useFakeTimers();
    const planted = plant(false, true);
    expect(planted.store.size).toBe(1);
    fs.rmSync(planted.sessionFile);
    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect(planted.store.size).toBe(1);
  });

  it('ends as one agent for the new session id when the registry session is replaced', async () => {
    vi.useFakeTimers();
    const planted = plant(true);
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
    const agents = [...planted.store.values()];
    expect(agents.map((agent) => agent.sessionId)).toEqual([nextSession]);
    expect(planted.runtime.dismissalTracker.isDismissed(nextJsonl)).toBe(false);
    expect(planted.runtime.dismissalTracker.isPermanentlyDismissed(planted.jsonl)).toBe(false);
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
