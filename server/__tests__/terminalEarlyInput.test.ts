import { afterAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { AttachedTerminal } from '../src/tmuxTerminal.js';

const written: string[] = [];
let finishAttach: ((term: AttachedTerminal) => void) | null = null;
let paneOutput: ((data: string) => void) | null = null;

vi.mock('../src/tmuxTerminal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tmuxTerminal.js')>()),
  attachTmuxPane: (_location: unknown, onData: (data: string) => void) =>
    new Promise<AttachedTerminal>((resolve) => {
      paneOutput = onData;
      finishAttach = resolve;
    }),
}));

const { AgentStateStore } = await import('../src/agentStateStore.js');
const { createHttpServer } = await import('../src/httpServer.js');

describe('/ws/term input during attach', () => {
  const store = new AgentStateStore();
  store.set(1, {
    id: 1,
    tmux: { session: 'demo', windowId: '@1', paneId: '%1' },
  } as unknown as Parameters<typeof store.set>[1]);
  const ready = createHttpServer({
    embedded: true,
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    store,
    insecureLocalTerminal: true,
  });

  afterAll(async () => {
    await (await ready).app.close();
  });

  it('types keystrokes sent before tmux first draws, in order, once it draws', async () => {
    const { port } = await ready;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/term?agentId=1&token=test-token`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.send(Buffer.from('ec'));
    socket.send(Buffer.from('ho hi\r'));
    await vi.waitFor(() => expect(finishAttach).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 50));

    finishAttach!({
      pty: {
        write: (data: Buffer | string) => written.push(data.toString()),
        onExit: () => undefined,
      },
      sessionName: 'pa-web-test',
      stop: () => undefined,
    } as unknown as AttachedTerminal);
    socket.send(Buffer.from('ls\r'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(written).toEqual([]);

    paneOutput!('\x1b[?1049h');
    socket.send(Buffer.from('y'));

    await vi.waitFor(() => expect(written.join('')).toBe('echo hi\rls\ry'));
    socket.close();
  });

  it('closes as too big when more than 64 KiB is typed before tmux draws', async () => {
    const { port } = await ready;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/term?agentId=1&token=test-token`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.send(Buffer.alloc(64 * 1024, 'a'));
    socket.send(Buffer.from('b'));
    expect(await closed).toBe(1009);
  });
});
