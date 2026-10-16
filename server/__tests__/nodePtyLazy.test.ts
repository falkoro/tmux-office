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

  beforeAll(() => {
    process.env.PIXEL_AGENTS_TMUX_SOCKET = socketName;
    tmux('new-session', '-d', '-s', 'demo', '-x', '80', '-y', '24');
    [paneId, windowId] = tmux(
      'display-message',
      '-p',
      '-t',
      'demo',
      '#{pane_id} #{window_id}',
    ).split(' ') as [string, string];
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
      () => undefined,
      () => undefined,
    );
    term.stop();
    expect(nodePty.loads).toBe(1);
  });

  it('groups with the session that holds the pane now, not a stale stored one', async () => {
    tmux('new-window', '-d', '-t', 'demo');
    tmux('new-session', '-d', '-s', 'moved', '-x', '80', '-y', '24');
    tmux('move-window', '-s', `demo:${windowId}`, '-t', 'moved:');
    const { attachTmuxPane } = await import('../src/tmuxTerminal.js');
    nodePty.spawns.length = 0;
    const term = await attachTmuxPane(
      { session: 'demo', windowId, paneId },
      () => undefined,
      () => undefined,
    );
    term.stop();
    const argv = nodePty.spawns[0]!;
    expect(argv[argv.indexOf('new-session') + 2]).toBe('=moved');
    expect(argv[argv.indexOf('select-window') + 2]).toBe(windowId);
    expect(argv[argv.indexOf('select-pane') + 2]).toBe(paneId);
  });
});
