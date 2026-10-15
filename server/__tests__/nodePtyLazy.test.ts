import { describe, expect, it, vi } from 'vitest';

const nodePty = vi.hoisted(() => ({ loads: 0 }));

vi.mock('node-pty', () => {
  nodePty.loads++;
  return { spawn: vi.fn() };
});

describe('node-pty loading', () => {
  it('stays unloaded until a pane is attached, so a host without its native build still loads', async () => {
    await import('../src/httpServer.js');
    await import('../src/agentRuntime.js');
    expect(nodePty.loads).toBe(0);
  });
});
