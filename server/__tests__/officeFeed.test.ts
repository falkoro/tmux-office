import { afterEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { createHttpServer, type HttpServerHandle } from '../src/httpServer.js';
import { OfficeFeedState } from '../src/officeFeed.js';
import type { AgentState } from '../src/types.js';

const tools = {
  subagentToolNames: new Set(['Agent']),
  questionTools: new Set(['AskUserQuestion']),
};

function agent(id: number, session: string | null, extra: Partial<AgentState> = {}): AgentState {
  return {
    id,
    isWaiting: true,
    permissionSent: false,
    folderName: `folder-${id}`,
    tmux: session ? { session, windowId: '@1', paneId: `%${id}` } : undefined,
    ...extra,
  } as AgentState;
}

function setup(...agents: AgentState[]) {
  const store = new AgentStateStore();
  for (const a of agents) store.set(a.id, a);
  return { store, feed: new OfficeFeedState(store, tools) };
}

const rooms = {
  type: 'officeRooms' as const,
  rooms: [{ name: 'emperor', patterns: ['emperor-*'] }],
  pinned: ['emperor-8'],
  background: false,
};

describe('OfficeFeedState', () => {
  it('reads unseen agents from server state', () => {
    const { feed } = setup(
      agent(1, 'a', { isWaiting: false }),
      agent(2, 'b', { permissionSent: true }),
      agent(3, 'c'),
    );
    expect(feed.snapshot(null).desks.map((d) => d.status)).toEqual([
      'working',
      'needs-permission',
      'done',
    ]);
  });

  it('folds broadcasts the way the office does', () => {
    const { store, feed } = setup(agent(1, 'a'));
    const status = () => feed.snapshot(null).desks[0].status;

    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting', awaitingInput: true });
    expect(status()).toBe('waiting-input');

    store.broadcast({ type: 'agentToolStart', id: 1, toolId: 't1', toolName: 'Bash', status: '' });
    expect(status()).toBe('working');

    store.broadcast({ type: 'agentToolPermission', id: 1 });
    expect(status()).toBe('needs-permission');
    store.broadcast({ type: 'agentToolPermissionClear', id: 1 });
    expect(status()).toBe('working');

    store.broadcast({
      type: 'agentToolStart',
      id: 1,
      toolId: 'q',
      toolName: 'AskUserQuestion',
      status: '',
    });
    expect(status()).toBe('waiting-input');
    store.broadcast({ type: 'agentToolDone', id: 1, toolId: 'q' });
    expect(status()).toBe('working');

    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting' });
    expect(status()).toBe('done');
  });

  it('tracks helpers and keeps background ones past a turn end', () => {
    const { store, feed } = setup(agent(1, 'a'));
    const helpers = () => feed.snapshot(null).desks[0].helpers;

    store.broadcast({ type: 'agentToolStart', id: 1, toolId: 'fg', toolName: 'Agent', status: '' });
    store.broadcast({
      type: 'agentToolStart',
      id: 1,
      toolId: 'bg',
      toolName: 'Agent',
      runInBackground: true,
      status: '',
    });
    store.broadcast({
      type: 'subagentToolStart',
      id: 1,
      parentToolId: 'bg',
      toolId: 's1',
      status: '',
    });
    store.broadcast({ type: 'subagentToolPermission', id: 1, parentToolId: 'bg' });
    expect(helpers()).toEqual(['working', 'needs-permission']);

    store.broadcast({ type: 'agentToolsClear', id: 1 });
    expect(helpers()).toEqual(['needs-permission']);

    store.broadcast({ type: 'agentToolPermissionClear', id: 1 });
    store.broadcast({ type: 'subagentToolDone', id: 1, parentToolId: 'bg', toolId: 's1' });
    expect(helpers()).toEqual(['idle']);

    store.broadcast({ type: 'subagentClear', id: 1, parentToolId: 'bg' });
    expect(helpers()).toEqual([]);
  });

  it('places desks in rooms, pins first and hides the background when asked', () => {
    const { feed } = setup(
      agent(1, 'emperor-10'),
      agent(2, 'emperor-8'),
      agent(3, 'emperor-2'),
      agent(4, 'scratch'),
      agent(5, null),
    );
    expect(feed.snapshot(rooms).desks.map((d) => [d.session, d.room, d.pinned])).toEqual([
      ['emperor-8', 'emperor', true],
      ['emperor-2', 'emperor', false],
      ['emperor-10', 'emperor', false],
    ]);
    expect(feed.snapshot({ ...rooms, background: true }).desks.map((d) => d.room)).toEqual([
      'emperor',
      'emperor',
      'emperor',
      null,
      null,
    ]);
    expect(feed.snapshot(null).desks.map((d) => d.room)).toEqual([
      'emperor-2',
      'emperor-8',
      'emperor-10',
      'scratch',
      null,
    ]);
  });

  it('forgets closed agents', () => {
    const { store, feed } = setup(agent(1, 'a'));
    store.broadcast({ type: 'agentToolPermission', id: 1 });
    store.delete(1);
    store.broadcast({ type: 'agentClosed', id: 1 });
    expect(feed.snapshot(null).desks).toEqual([]);
  });
});

describe('GET /api/office', () => {
  let handle: HttpServerHandle | undefined;
  afterEach(async () => {
    await handle?.app.close();
    handle = undefined;
  });

  async function start(officeEmbedOrigins: string[]) {
    const { store, feed } = setup(agent(1, 'emperor-8', { isWaiting: false }));
    handle = await createHttpServer({
      embedded: true,
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      store,
      officeFeed: feed,
      officeEmbedOrigins,
    });
    return handle.app;
  }

  it('serves the feed without an Origin and to an allowed one', async () => {
    const app = await start(['http://127.0.0.1:8820']);
    for (const headers of [{}, { origin: 'http://127.0.0.1:8820' }]) {
      const res = await app.inject({ method: 'GET', url: '/api/office', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json().desks[0]).toMatchObject({ session: 'emperor-8', status: 'working' });
    }
  });

  it('refuses any other browser origin', async () => {
    const app = await start(['http://127.0.0.1:8820']);
    const res = await app.inject({
      method: 'GET',
      url: '/api/office',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('emperor-8');
  });

  it('never leaks tool text or paths', async () => {
    const app = await start([]);
    const res = await app.inject({ method: 'GET', url: '/api/office' });
    expect(Object.keys(res.json().desks[0]).sort()).toEqual(
      ['helpers', 'name', 'pinned', 'room', 'session', 'status'].sort(),
    );
  });
});
