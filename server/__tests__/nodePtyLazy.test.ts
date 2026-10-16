import { describe, expect, it, vi } from 'vitest';

const nodePty = vi.hoisted(() => ({ loads: 0 }));

vi.mock('node-pty', () => {
  nodePty.loads++;
  return {
    spawn: () => ({
      onData: () => undefined,
      onExit: () => undefined,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
    }),
  };
});

describe('node-pty loading', () => {
  it('stays unloaded until a pane is attached, so a host without its native build still loads', async () => {
    await import('../src/httpServer.js');
    await import('../src/agentRuntime.js');
    expect(nodePty.loads).toBe(0);
  });

  it('loads once a pane is attached, so the mock above is the module the attach path uses', async () => {
    const previous = process.env.PIXEL_AGENTS_TMUX_SOCKET;
    process.env.PIXEL_AGENTS_TMUX_SOCKET = `pa-test-none-${process.pid}`;
    try {
      const { attachTmuxPane } = await import('../src/tmuxTerminal.js');
      const term = await attachTmuxPane(
        { session: 'demo', windowId: '@1', paneId: '%1' },
        () => undefined,
        () => undefined,
      );
      term.stop();
      expect(nodePty.loads).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.PIXEL_AGENTS_TMUX_SOCKET;
      else process.env.PIXEL_AGENTS_TMUX_SOCKET = previous;
    }
  });
});
