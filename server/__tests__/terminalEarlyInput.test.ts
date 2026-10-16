import { afterAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { AttachedTerminal } from '../src/tmuxTerminal.js';

const written: string[] = [];
let finishAttach: ((term: AttachedTerminal) => void) | null = null;

vi.mock('../src/tmuxTerminal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tmuxTerminal.js')>()),
  attachTmuxPane: () =>
    new Promise<AttachedTerminal>((resolve) => {
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

  it('types keystrokes sent before the pane attached, in order, once it attaches', async () => {
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

    await vi.waitFor(() => expect(written.join('')).toBe('echo hi\rls\r'));
    socket.close();
  });
});
