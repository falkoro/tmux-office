import { execFile, spawnSync } from 'node:child_process';
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
  type ProcReader,
  type TmuxLocation,
} from '../src/providers/hook/claude/claudeSessionRegistry.js';
import {
  listTmuxPanes,
  listTmuxPanesArgv,
  parseTmuxPaneList,
  resolvePaneLocation,
  throwawaySessionName,
  type TmuxPaneRecord,
} from '../src/tmuxTerminal.js';

const execFileAsync = promisify(execFile);

const PID = process.pid;
const movedPane: TmuxPaneRecord = { paneId: '%5', panePid: PID, session: 'work-5', windowId: '@9' };
const registryTmux: TmuxLocation = { session: 'work-3', windowId: '@5', paneId: '%5' };

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

describe('resolveLiveTmuxLocations', () => {
  const sessions = [{ sessionId: 's1', pid: PID, tmux: registryTmux }];

  it('follows a pane that moved to another session', () => {
    const locations = resolveLiveTmuxLocations(sessions, [movedPane]);
    expect(locations.get('s1')).toEqual({ session: 'work-5', windowId: '@9', paneId: '%5' });
  });

  it('keeps the registry session when a grouped session also lists the pane', () => {
    const view: TmuxPaneRecord = { paneId: '%5', panePid: PID, session: 'view', windowId: '@5' };
    const own: TmuxPaneRecord = { paneId: '%5', panePid: PID, session: 'work-3', windowId: '@5' };
    expect(resolveLiveTmuxLocations(sessions, [own, view]).get('s1')).toEqual(registryTmux);
    expect(resolveLiveTmuxLocations(sessions, [view, own]).get('s1')).toEqual(registryTmux);
  });

  it('takes the first listing when no grouped session is the registry one', () => {
    const view: TmuxPaneRecord = { paneId: '%5', panePid: PID, session: 'view', windowId: '@9' };
    const locations = resolveLiveTmuxLocations(sessions, [movedPane, view]);
    expect(locations.get('s1')).toEqual({ session: 'work-5', windowId: '@9', paneId: '%5' });
  });

  it('clears the location when the pane is gone', () => {
    const locations = resolveLiveTmuxLocations(sessions, [
      { paneId: '%9', panePid: PID, session: 'work-5', windowId: '@9' },
    ]);
    expect(locations.get('s1')).toBeNull();
  });

  it('keeps registry locations when the pane list is unavailable', () => {
    const locations = resolveLiveTmuxLocations(sessions, null);
    expect(locations.get('s1')).toEqual(registryTmux);
  });

  it('drops a registry location in our own throwaway session when the pane list is unavailable', () => {
    const locations = resolveLiveTmuxLocations(
      [
        {
          sessionId: 's1',
          pid: PID,
          tmux: { ...registryTmux, session: 'pa-web-0123456789abcdef' },
        },
      ],
      null,
    );
    expect(locations.get('s1')).toBeNull();
  });

  it('rejects unsafe names from the pane list', () => {
    for (const session of ['bad name', '-flag', 'bad;name']) {
      const locations = resolveLiveTmuxLocations(sessions, [{ ...movedPane, session }]);
      expect(locations.get('s1')).toBeNull();
    }
    const badWindow = resolveLiveTmuxLocations(sessions, [{ ...movedPane, windowId: '9' }]);
    expect(badWindow.get('s1')).toBeNull();
  });

  it('keeps the real session when a web terminal groups onto it', () => {
    const panes = parseTmuxPaneList(`%5 ${PID} demo @2\n%5 ${PID} pa-web-0123456789abcdef @2\n`);
    const locations = resolveLiveTmuxLocations(
      [{ sessionId: 's1', pid: PID, tmux: { session: 'demo', windowId: '@2', paneId: '%5' } }],
      panes,
    );
    expect(locations.get('s1')).toEqual({ session: 'demo', windowId: '@2', paneId: '%5' });
  });

  it('keeps a user session whose name only starts like a web terminal', () => {
    const panes = parseTmuxPaneList(`%5 ${PID} pa-web-dev @2\n`);
    const locations = resolveLiveTmuxLocations(
      [{ sessionId: 's1', pid: PID, tmux: { session: 'demo', windowId: '@2', paneId: '%5' } }],
      panes,
    );
    expect(locations.get('s1')).toEqual({ session: 'pa-web-dev', windowId: '@2', paneId: '%5' });
  });

  describe('a pane listed only under another session', () => {
    const stat = (pid: number, ppid: number) => `${pid} (node) S ${ppid} 1 1 0`;
    const proc = (parents: Record<number, number>): ProcReader => ({
      stat: (pid) => (pid in parents ? stat(pid, parents[pid]!) : null),
      pidNamespace: () => null,
    });
    const claude = [{ sessionId: 's1', pid: 300, tmux: registryTmux }];
    const elsewhere: TmuxPaneRecord = { ...movedPane, panePid: 200 };

    it('follows it when Claude runs in that pane', () => {
      const locations = resolveLiveTmuxLocations(
        claude,
        [elsewhere],
        proc({ 300: 250, 250: 200, 200: 1 }),
      );
      expect(locations.get('s1')).toEqual({ session: 'work-5', windowId: '@9', paneId: '%5' });
    });

    it('drops the location when it is another tmux server pane with the same id', () => {
      const locations = resolveLiveTmuxLocations(claude, [elsewhere], proc({ 300: 250, 250: 1 }));
      expect(locations.get('s1')).toBeNull();
    });

    it('drops the location when the process tree cannot be read', () => {
      expect(resolveLiveTmuxLocations(claude, [elsewhere], proc({})).get('s1')).toBeNull();
    });
  });

  describe('a pane listed under the registry session', () => {
    const stat = (pid: number, ppid: number) => `${pid} (node) S ${ppid} 1 1 0`;
    const proc = (parents: Record<number, number>): ProcReader => ({
      stat: (pid) => (pid in parents ? stat(pid, parents[pid]!) : null),
      pidNamespace: () => null,
    });
    const claude = [{ sessionId: 's1', pid: 300, tmux: registryTmux }];
    const sameName: TmuxPaneRecord = {
      paneId: registryTmux.paneId,
      panePid: 200,
      session: registryTmux.session,
      windowId: '@7',
    };

    it('drops it on Linux when Claude does not run in it: another server, same name and id', () => {
      const locations = resolveLiveTmuxLocations(claude, [sameName], proc({ 300: 250, 250: 1 }));
      expect(locations.get('s1')).toBeNull();
    });

    it('keeps it where /proc cannot tell, as on macOS', () => {
      expect(resolveLiveTmuxLocations(claude, [sameName], proc({})).get('s1')).toEqual({
        session: registryTmux.session,
        windowId: '@7',
        paneId: registryTmux.paneId,
      });
    });
  });

  it('leaves a session that has no tmux unset', () => {
    const locations = resolveLiveTmuxLocations(
      [{ sessionId: 's1', pid: PID, tmux: null }],
      [movedPane],
    );
    expect(locations.get('s1')).toBeNull();
  });
});

describe('tmux pane list', () => {
  it('parses pane id, pane pid, session name, and window id', () => {
    expect(parseTmuxPaneList(`%5 ${PID} work-5 @9\n%1 7 demo @1\n`)).toEqual([
      movedPane,
      { paneId: '%1', panePid: 7, session: 'demo', windowId: '@1' },
    ]);
    expect(parseTmuxPaneList(`%5 ${PID} bad name @9\n`)).toEqual([
      { ...movedPane, session: 'bad name' },
    ]);
    expect(parseTmuxPaneList('%5 work-5 @9\n')).toEqual([]);
    expect(parseTmuxPaneList('')).toEqual([]);
  });

  it('keeps a window name only when tmux does not rename the window itself', () => {
    expect(
      parseTmuxPaneList(`%5 ${PID} work-5 @9\t0office: night shift\n%1 7 demo @1\t1zsh\n`),
    ).toEqual([
      { ...movedPane, windowName: 'office: night shift' },
      { paneId: '%1', panePid: 7, session: 'demo', windowId: '@1' },
    ]);
  });

  it('leaves out the throwaway sessions web terminals create', () => {
    expect(
      parseTmuxPaneList(`%5 ${PID} ${throwawaySessionName()} @9\n%5 ${PID} work-5 @9\n`),
    ).toEqual([movedPane]);
  });

  it('gives up on a hung tmux before the next live-session poll', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-tmux-'));
    fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexec sleep 10\n', { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
    try {
      const started = Date.now();
      await expect(listTmuxPanes()).resolves.toBeNull();
      expect(Date.now() - started).toBeLessThan(CLAUDE_SESSION_POLL_INTERVAL_MS);
    } finally {
      process.env.PATH = previous;
      fs.rmSync(bin, { recursive: true, force: true });
    }
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
        '#{pane_id} #{pane_pid} #{session_name} #{window_id}\t#{automatic-rename}#{window_name}',
      ]);
    } finally {
      if (previous === undefined) delete process.env.PIXEL_AGENTS_TMUX_SOCKET;
      else process.env.PIXEL_AGENTS_TMUX_SOCKET = previous;
    }
    expect(listTmuxPanesArgv()).toEqual([
      'list-panes',
      '-a',
      '-F',
      '#{pane_id} #{pane_pid} #{session_name} #{window_id}\t#{automatic-rename}#{window_name}',
    ]);
  });

  it('warns once and reads the default server when the socket name is not a tmux -L name', () => {
    const previous = process.env.PIXEL_AGENTS_TMUX_SOCKET;
    process.env.PIXEL_AGENTS_TMUX_SOCKET = 'my.sock';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(listTmuxPanesArgv()[0]).toBe('list-panes');
      expect(listTmuxPanesArgv()[0]).toBe('list-panes');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('my.sock');
    } finally {
      warn.mockRestore();
      if (previous === undefined) delete process.env.PIXEL_AGENTS_TMUX_SOCKET;
      else process.env.PIXEL_AGENTS_TMUX_SOCKET = previous;
    }
  });

  it.skipIf(!hasTmux)(
    'reads the default server, not the tmux server it runs inside, without a socket name',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-tmux-env-'));
      const socket = path.join(dir, 'inside');
      const emptyTmpdir = path.join(dir, 'default');
      fs.mkdirSync(emptyTmpdir);
      const saved = {
        socket: process.env.PIXEL_AGENTS_TMUX_SOCKET,
        tmux: process.env.TMUX,
        tmpdir: process.env.TMUX_TMPDIR,
      };
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      try {
        await execFileAsync(
          'tmux',
          ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'inside'],
          { timeout: 4000 },
        );
        delete process.env.PIXEL_AGENTS_TMUX_SOCKET;
        process.env.TMUX = `${socket},1,0`;
        process.env.TMUX_TMPDIR = emptyTmpdir;

        await expect(listTmuxPanes()).resolves.toBeNull();
      } finally {
        restore('PIXEL_AGENTS_TMUX_SOCKET', saved.socket);
        restore('TMUX', saved.tmux);
        restore('TMUX_TMPDIR', saved.tmpdir);
        await execFileAsync('tmux', ['-S', socket, 'kill-server'], { timeout: 4000 }).catch(
          () => undefined,
        );
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasTmux)('reads panes from a private tmux socket', async () => {
    const socketName = `pa-test-panes-${process.pid}-${Date.now()}`;
    const previous = process.env.PIXEL_AGENTS_TMUX_SOCKET;
    process.env.PIXEL_AGENTS_TMUX_SOCKET = socketName;
    try {
      await execFileAsync(
        'tmux',
        [
          '-f',
          '/dev/null',
          '-L',
          socketName,
          'new-session',
          '-d',
          '-s',
          'work-5',
          '-x',
          '80',
          '-y',
          '24',
        ],
        { timeout: 4000 },
      );
      const identity = (
        await execFileAsync(
          'tmux',
          [
            '-L',
            socketName,
            'display-message',
            '-p',
            '-t',
            'work-5',
            '#{pane_id} #{pane_pid} #{window_id}',
          ],
          { timeout: 4000 },
        )
      ).stdout
        .trim()
        .split(/\s+/);
      const paneId = identity[0];
      const panePid = Number(identity[1]);
      const windowId = identity[2];
      expect(paneId).toMatch(/^%\d+$/);
      expect(windowId).toMatch(/^@\d+$/);
      await expect(listTmuxPanes()).resolves.toEqual([
        { paneId, panePid, session: 'work-5', windowId },
      ]);
      await execFileAsync('tmux', ['-L', socketName, 'rename-window', '-t', 'work-5', 'office'], {
        timeout: 4000,
      });
      await expect(listTmuxPanes()).resolves.toEqual([
        { paneId, panePid, session: 'work-5', windowId, windowName: 'office' },
      ]);
      await expect(
        resolvePaneLocation({ session: 'work-5', windowId: '@0', paneId: paneId! }, panePid),
      ).resolves.toEqual({ session: 'work-5', windowId, paneId });
      await expect(
        resolvePaneLocation({ session: 'other-6', windowId, paneId: paneId! }, panePid),
      ).resolves.toBeNull();
      // This test process does not run in that pane: same name and id, another Claude.
      await expect(
        resolvePaneLocation({ session: 'work-5', windowId, paneId: paneId! }, process.pid),
      ).resolves.toBeNull();
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

  function writeSession(
    root: string,
    tmux: string,
    extra: Record<string, unknown> = {},
  ): ClaudeSessionRegistry {
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
        ...extra,
      }),
    );
    return new ClaudeSessionRegistry({ homeDir: root });
  }

  it('broadcasts agentTerminal when a pane moves to another session', async () => {
    vi.useFakeTimers();
    const root = tempDir();
    const registry = writeSession(root, 'work-3:@5.%5');
    const store = new AgentStateStore();
    const messages: Record<string, unknown>[] = [];
    store.on('broadcast', (message) => messages.push(message));
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.forceWatchAll = true;
    runtime.startLiveSessionRegistry(registry, () => Promise.resolve([movedPane]));
    await vi.advanceTimersByTimeAsync(0);

    const agent = [...store.values()][0];
    expect(agent?.tmux).toEqual({ session: 'work-5', windowId: '@9', paneId: '%5' });
    const terminals = messages.filter((message) => message.type === 'agentTerminal');
    expect(terminals.at(-1)).toEqual({
      type: 'agentTerminal',
      id: agent?.id,
      name: 'zeta',
      tmux: { session: 'work-5', windowId: '@9', paneId: '%5' },
    });
  });

  it('names a desk after its tmux window unless the session was renamed', async () => {
    vi.useFakeTimers();
    const office: TmuxPaneRecord = { ...movedPane, windowName: 'office' };
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.forceWatchAll = true;
    runtime.startLiveSessionRegistry(writeSession(tempDir(), 'work-3:@5.%5'), () =>
      Promise.resolve([office]),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect([...store.values()][0]?.registryName).toBe('office');
    runtime.dispose();

    const renamed = new AgentStateStore();
    runtime = new AgentRuntime(renamed, claudeProvider);
    runtime.forceWatchAll = true;
    runtime.startLiveSessionRegistry(
      writeSession(tempDir(), 'work-3:@5.%5', { nameSource: 'user' }),
      () => Promise.resolve([office]),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect([...renamed.values()][0]?.registryName).toBe('zeta');
  });

  it('shows a session the registry adopts under its working folder', async () => {
    vi.useFakeTimers();
    const registry = writeSession(tempDir(), 'work-3:@5.%5');
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.forceWatchAll = true;
    runtime.startLiveSessionRegistry(registry, () => Promise.resolve([movedPane]));
    await vi.advanceTimersByTimeAsync(0);

    expect([...store.values()][0]?.folderName).toBe('work');
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

    writeSession(root, 'work-3:@5.%5');
    vi.advanceTimersByTime(CLAUDE_SESSION_POLL_INTERVAL_MS);

    expect(calls).toBe(2);
    expect([...store.values()][0]?.tmux).toEqual({
      session: 'work-5',
      windowId: '@9',
      paneId: '%5',
    });
    releaseSecond?.(null);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('restores the registry location when a later pane list fails', async () => {
    vi.useFakeTimers();
    const root = tempDir();
    const registry = writeSession(root, 'work-3:@5.%5');
    const results: Array<readonly TmuxPaneRecord[] | null> = [[movedPane], null];
    const listPanes = (): Promise<readonly TmuxPaneRecord[] | null> =>
      Promise.resolve(results.length > 0 ? (results.shift() ?? null) : null);
    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.forceWatchAll = true;
    runtime.startLiveSessionRegistry(registry, listPanes);
    await vi.advanceTimersByTimeAsync(0);
    expect([...store.values()][0]?.tmux?.session).toBe('work-5');

    await vi.advanceTimersByTimeAsync(CLAUDE_SESSION_POLL_INTERVAL_MS);
    expect([...store.values()][0]?.tmux).toEqual(registryTmux);
  });
});
