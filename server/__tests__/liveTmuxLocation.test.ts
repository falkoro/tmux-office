import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CLAUDE_SESSION_POLL_INTERVAL_MS } from '../src/constants.js';
import { resolveLiveTmuxLocations } from '../src/liveTmuxLocation.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import {
  ClaudeSessionRegistry,
  type TmuxLocation,
} from '../src/providers/hook/claude/claudeSessionRegistry.js';
import {
  listTmuxPanes,
  listTmuxPanesArgv,
  parseTmuxPaneList,
  type TmuxPaneRecord,
} from '../src/tmuxTerminal.js';

const execFileAsync = promisify(execFile);

const movedPane: TmuxPaneRecord = { paneId: '%5', session: 'emperor-5', windowId: '@9' };
const registryTmux: TmuxLocation = { session: 'emperor-3', windowId: '@5', paneId: '%5' };

describe('resolveLiveTmuxLocations', () => {
  const sessions = [{ sessionId: 's1', tmux: registryTmux }];

  it('follows a pane that moved to another session', () => {
    const locations = resolveLiveTmuxLocations(sessions, [movedPane]);
    expect(locations.get('s1')).toEqual({ session: 'emperor-5', windowId: '@9', paneId: '%5' });
  });

  it('clears the location when the pane is gone', () => {
    const locations = resolveLiveTmuxLocations(sessions, [
      { paneId: '%9', session: 'emperor-5', windowId: '@9' },
    ]);
    expect(locations.get('s1')).toBeNull();
  });

  it('keeps registry locations when the pane list is unavailable', () => {
    const locations = resolveLiveTmuxLocations(sessions, null);
    expect(locations.get('s1')).toEqual(registryTmux);
  });

  it('rejects unsafe names from the pane list', () => {
    for (const session of ['bad name', '-flag', 'bad;name']) {
      const locations = resolveLiveTmuxLocations(sessions, [{ ...movedPane, session }]);
      expect(locations.get('s1')).toBeNull();
    }
    const badWindow = resolveLiveTmuxLocations(sessions, [{ ...movedPane, windowId: '9' }]);
    expect(badWindow.get('s1')).toBeNull();
  });

  it('leaves a session that has no tmux unset', () => {
    const locations = resolveLiveTmuxLocations([{ sessionId: 's1', tmux: null }], [movedPane]);
    expect(locations.get('s1')).toBeNull();
  });
});

describe('tmux pane list', () => {
  it('parses pane id, session name, and window id', () => {
    expect(parseTmuxPaneList('%5 emperor-5 @9\n%1 demo @1\n')).toEqual([
      movedPane,
      { paneId: '%1', session: 'demo', windowId: '@1' },
    ]);
    expect(parseTmuxPaneList('%5 bad name @9\n')).toEqual([{ ...movedPane, session: 'bad name' }]);
    expect(parseTmuxPaneList('')).toEqual([]);
  });

  it('asks tmux for every pane on the configured socket', () => {
    const previous = process.env.PIXEL_AGENTS_TMUX_SOCKET;
    process.env.PIXEL_AGENTS_TMUX_SOCKET = 'pa-test-unit';
    try {
      expect(listTmuxPanesArgv()).toEqual([
        '-L',
        'pa-test-unit',
        'list-panes',
        '-a',
        '-F',
        '#{pane_id} #{session_name} #{window_id}',
      ]);
    } finally {
      if (previous === undefined) delete process.env.PIXEL_AGENTS_TMUX_SOCKET;
      else process.env.PIXEL_AGENTS_TMUX_SOCKET = previous;
    }
    expect(listTmuxPanesArgv()).toEqual([
      'list-panes',
      '-a',
      '-F',
      '#{pane_id} #{session_name} #{window_id}',
    ]);
  });

  it('reads panes from a private tmux socket', async () => {
    const socketName = `pa-test-panes-${process.pid}-${Date.now()}`;
    const previous = process.env.PIXEL_AGENTS_TMUX_SOCKET;
    process.env.PIXEL_AGENTS_TMUX_SOCKET = socketName;
    try {
      await execFileAsync(
        'tmux',
        ['-L', socketName, 'new-session', '-d', '-s', 'emperor-5', '-x', '80', '-y', '24'],
        { timeout: 4000 },
      );
      const identity = (
        await execFileAsync(
          'tmux',
          ['-L', socketName, 'display-message', '-p', '-t', 'emperor-5', '#{pane_id} #{window_id}'],
          { timeout: 4000 },
        )
      ).stdout
        .trim()
        .split(/\s+/);
      const paneId = identity[0];
      const windowId = identity[1];
      expect(paneId).toMatch(/^%\d+$/);
      expect(windowId).toMatch(/^@\d+$/);
      await expect(listTmuxPanes()).resolves.toEqual([{ paneId, session: 'emperor-5', windowId }]);
    } finally {
      if (previous === undefined) delete process.env.PIXEL_AGENTS_TMUX_SOCKET;
      else process.env.PIXEL_AGENTS_TMUX_SOCKET = previous;
      await execFileAsync('tmux', ['-L', socketName, 'kill-server'], { timeout: 4000 }).catch(
        () => undefined,
      );
    }
  });
});

describe('live pane following', () => {
  const dirs: string[] = [];
  let runtime: AgentRuntime | undefined;

  afterEach(() => {
    vi.useRealTimers();
    runtime?.dispose();
    runtime = undefined;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-pane-'));
    dirs.push(dir);
    return dir;
  }

  function writeSession(root: string, tmux: string): ClaudeSessionRegistry {
    const cwd = path.join(root, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const projectDir = path.join(root, '.claude-work', 'projects', normalizeProjectPath(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '{"type":"user"}\n');
    const sessionsDir = path.join(root, '.claude-work', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, '1.json'),
      JSON.stringify({
        pid: process.pid,
        sessionId,
        cwd,
        tmux,
        status: 'idle',
        name: 'zeta',
      }),
    );
    return new ClaudeSessionRegistry({ homeDir: root });
  }

  it('broadcasts agentTerminal when a pane moves to another session', async () => {
    vi.useFakeTimers();
    const root = tempDir();
    const registry = writeSession(root, 'emperor-3:@5.%5');
    const store = new AgentStateStore();
    const messages: Record<string, unknown>[] = [];
    store.on('broadcast', (message) => messages.push(message));
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.forceWatchAll = true;
    runtime.startLiveSessionRegistry(registry, () => Promise.resolve([movedPane]));
    await vi.advanceTimersByTimeAsync(0);

    const agent = [...store.values()][0];
    expect(agent?.tmux).toEqual({ session: 'emperor-5', windowId: '@9', paneId: '%5' });
    const terminals = messages.filter((message) => message.type === 'agentTerminal');
    expect(terminals.at(-1)).toEqual({
      type: 'agentTerminal',
      id: agent?.id,
      name: 'zeta',
      tmux: { session: 'emperor-5', windowId: '@9', paneId: '%5' },
    });
  });

  it('adopts a new session at the pane current location', async () => {
    vi.useFakeTimers();
    const root = tempDir();
    let calls = 0;
    let releaseSecond: ((panes: readonly TmuxPaneRecord[] | null) => void) | undefined;
    const listPanes = (): Promise<readonly TmuxPaneRecord[] | null> => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve([movedPane]);
      }
      return new Promise((resolve) => {
        releaseSecond = resolve;
      });
    };
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.forceWatchAll = true;
    runtime.startLiveSessionRegistry(new ClaudeSessionRegistry({ homeDir: root }), listPanes);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.size).toBe(0);

    writeSession(root, 'emperor-3:@5.%5');
    vi.advanceTimersByTime(CLAUDE_SESSION_POLL_INTERVAL_MS);

    expect(calls).toBe(2);
    expect([...store.values()][0]?.tmux).toEqual({
      session: 'emperor-5',
      windowId: '@9',
      paneId: '%5',
    });
    releaseSecond?.(null);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('restores the registry location when a later pane list fails', async () => {
    vi.useFakeTimers();
    const root = tempDir();
    const registry = writeSession(root, 'emperor-3:@5.%5');
    const results: Array<readonly TmuxPaneRecord[] | null> = [[movedPane], null];
    const listPanes = (): Promise<readonly TmuxPaneRecord[] | null> =>
      Promise.resolve(results.length > 0 ? (results.shift() ?? null) : null);
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.forceWatchAll = true;
    runtime.startLiveSessionRegistry(registry, listPanes);
    await vi.advanceTimersByTimeAsync(0);
    expect([...store.values()][0]?.tmux?.session).toBe('emperor-5');

    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect([...store.values()][0]?.tmux).toEqual(registryTmux);
  });
});
