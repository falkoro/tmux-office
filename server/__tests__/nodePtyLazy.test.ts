import { execFileSync, spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const nodePty = vi.hoisted(() => ({ loads: 0, spawns: [] as string[][] }));

vi.mock('node-pty', () => {
  nodePty.loads++;
  return {
    spawn: (_file: string, args: string[]) => {
      nodePty.spawns.push(args);
      return {
        onData: () => undefined,
        onExit: () => undefined,
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
      };
    },
  };
});

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

describe('node-pty loading', () => {
  it('stays unloaded until a pane is attached, so a host without its native build still loads', async () => {
    await import('../src/httpServer.js');
    await import('../src/agentRuntime.js');
    expect(nodePty.loads).toBe(0);
  });
});

describe.skipIf(!hasTmux)('attaching a pane', () => {
  const socketName = `pa-test-pty-${process.pid}-${Date.now()}`;
  const previous = process.env.PIXEL_AGENTS_TMUX_SOCKET;
  const tmux = (...args: string[]) =>
    execFileSync('tmux', ['-f', '/dev/null', '-L', socketName, ...args], {
      encoding: 'utf8',
    }).trim();
  let paneId = '';
  let windowId = '';
  let panePid = 0;

  beforeAll(() => {
    process.env.PIXEL_AGENTS_TMUX_SOCKET = socketName;
    tmux('new-session', '-d', '-s', 'demo', '-x', '80', '-y', '24');
    let pid: string;
    [paneId, windowId, pid] = tmux(
      'display-message',
      '-p',
      '-t',
      'demo',
      '#{pane_id} #{window_id} #{pane_pid}',
    ).split(' ') as [string, string, string];
    panePid = Number(pid);
  });

  afterAll(() => {
    if (previous === undefined) delete process.env.PIXEL_AGENTS_TMUX_SOCKET;
    else process.env.PIXEL_AGENTS_TMUX_SOCKET = previous;
    spawnSync('tmux', ['-L', socketName, 'kill-server']);
  });

  it('loads node-pty once a pane is attached, so the mock above is the module the attach path uses', async () => {
    const { attachTmuxPane } = await import('../src/tmuxTerminal.js');
    const term = await attachTmuxPane(
      { session: 'demo', windowId, paneId },
      panePid,
      () => undefined,
      () => undefined,
    );
    term.stop();
    expect(nodePty.loads).toBe(1);
  });

  it('does not follow a pane moved out of its stored session; the registry tick does', async () => {
    tmux('new-window', '-d', '-t', 'demo');
    tmux('new-session', '-d', '-s', 'moved', '-x', '80', '-y', '24');
    tmux('move-window', '-s', `demo:${windowId}`, '-t', 'moved:');
    const { attachTmuxPane } = await import('../src/tmuxTerminal.js');
    nodePty.spawns.length = 0;
    await expect(
      attachTmuxPane(
        { session: 'demo', windowId, paneId },
        panePid,
        () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow('tmux pane not found');
    expect(nodePty.spawns).toEqual([]);
  });
});
