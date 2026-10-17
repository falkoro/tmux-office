import { afterAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { AttachedTerminal } from '../src/tmuxTerminal.js';

const written: string[] = [];
let finishAttach: ((term: AttachedTerminal) => void) | null = null;
let paneOutput: ((data: string) => void) | null = null;

vi.mock('../src/tmuxTerminal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tmuxTerminal.js')>()),
  attachTmuxPane: (
    _location: unknown,
    _pid: number,
    _size: unknown,
    onData: (data: string) => void,
  ) =>
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
    livePid: 1234,
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

  it('never types the rejected input when tmux draws before the close completes', async () => {
    const { port } = await ready;
    finishAttach = null;
    written.length = 0;
    let stops = 0;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/term?agentId=1&token=test-token`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await vi.waitFor(() => expect(finishAttach).not.toBeNull());
    socket.send(Buffer.alloc(64 * 1024, 'a'));
    socket.send(Buffer.from('b'));
    socket.pause();
    await new Promise((resolve) => setTimeout(resolve, 100));

    finishAttach!({
      pty: {
        write: (data: Buffer | string) => written.push(data.toString()),
        onExit: () => undefined,
      },
      sessionName: 'pa-web-test',
      stop: () => stops++,
    } as unknown as AttachedTerminal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    paneOutput!('$ ');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(written).toEqual([]);
    expect(stops).toBe(1);
    socket.terminate();
  });

  it('types a paste over 64 KiB into a terminal tmux already draws', async () => {
    const { port } = await ready;
    finishAttach = null;
    written.length = 0;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/term?agentId=1&token=test-token`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await vi.waitFor(() => expect(finishAttach).not.toBeNull());
    finishAttach!({
      pty: {
        write: (data: Buffer | string) => written.push(data.toString()),
        onExit: () => undefined,
      },
      sessionName: 'pa-web-test',
      stop: () => undefined,
    } as unknown as AttachedTerminal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    paneOutput!('$ ');
    let closeCode: number | null = null;
    socket.once('close', (code) => (closeCode = code));

    const paste = 'p'.repeat(100 * 1024);
    socket.send(Buffer.from(paste));

    await vi.waitFor(() => expect(written.join('')).toBe(paste));
    expect(closeCode).toBeNull();
    socket.close();
  });
});
