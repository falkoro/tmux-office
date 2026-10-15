import { execFile } from 'node:child_process';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { promisify } from 'node:util';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { accessCertsUrl, createAccessVerifier, type JwksDocument } from '../src/accessJwt.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { createHttpServer, type HttpServerHandle } from '../src/httpServer.js';
import { ClaudeSessionRegistry } from '../src/providers/hook/claude/claudeSessionRegistry.js';
import { buildAttachArgv } from '../src/tmuxTerminal.js';
import type { AgentState } from '../src/types.js';

const execFileAsync = promisify(execFile);

function bareAgent(sessionId: string): AgentState {
  return {
    id: 1,
    sessionId,
    isExternal: true,
    projectDir: '/tmp',
    jsonlFile: '/tmp/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
  };
}

async function tmux(socketName: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-L', socketName, ...args], { timeout: 4000 });
  return stdout;
}

async function waitFor(check: () => Promise<boolean>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out');
}

describe('terminal argv', () => {
  it('targets a throwaway grouped session and adds -L from the env', () => {
    const previous = process.env.PIXEL_AGENTS_TMUX_SOCKET;
    process.env.PIXEL_AGENTS_TMUX_SOCKET = 'pa-test-unit';
    try {
      const argv = buildAttachArgv({ session: 'demo', windowId: '@1', paneId: '%1' }, 'pa-web-abc');
      expect(argv.slice(0, 2)).toEqual(['-L', 'pa-test-unit']);
      expect(argv).toContain('ignore-size');
      expect(argv).toContain('destroy-unattached');
      expect(argv).not.toContain('window-size');
      expect(argv).toContain('@1');
      expect(argv).not.toContain('send-keys');
    } finally {
      if (previous === undefined) delete process.env.PIXEL_AGENTS_TMUX_SOCKET;
      else process.env.PIXEL_AGENTS_TMUX_SOCKET = previous;
    }
  });
});

describe('/ws/term gate', () => {
  const handles: HttpServerHandle[] = [];

  afterAll(async () => {
    await Promise.all(handles.map((handle) => handle.app.close()));
  });

  async function listen(
    extra: Partial<Parameters<typeof createHttpServer>[0]>,
  ): Promise<HttpServerHandle> {
    const handle = await createHttpServer({
      embedded: true,
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      store: new AgentStateStore(),
      ...extra,
    });
    handles.push(handle);
    return handle;
  }

  it('returns 403 when Access is unset and the insecure flag is off', async () => {
    const handle = await listen({});
    const response = await fetch(`http://127.0.0.1:${handle.port}/ws/term?agentId=1`);
    expect(response.status).toBe(403);
  });

  it('returns 403 for a wrong token or a cross-site origin with the insecure flag on', async () => {
    const handle = await listen({ insecureLocalTerminal: true });
    const base = `http://127.0.0.1:${handle.port}/ws/term?agentId=1`;
    expect((await fetch(`${base}&token=wrong`)).status).toBe(403);
    expect((await fetch(base)).status).toBe(403);
    const crossSite = await fetch(`${base}&token=test-token`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(crossSite.status).toBe(403);
    // The router decodes %74 to `t`; the gate must still run on that path.
    const encoded = `http://127.0.0.1:${handle.port}/ws/%74erm?agentId=1&token=wrong`;
    expect((await fetch(encoded)).status).toBe(403);
  });

  it('keeps an encoded /ws/term path closed when Access is unset and the flag is off', async () => {
    const handle = await listen({});
    const encoded = `http://127.0.0.1:${handle.port}/ws/%74erm?agentId=1&token=test-token`;
    expect((await fetch(encoded)).status).toBe(403);
  });

  it('returns 403 for any route without a JWT when Access is configured', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    const kid = 'gate-key';
    const team = 'example.cloudflareaccess.com';
    const aud = 'aud-gate';
    const verifier = createAccessVerifier({ teamDomain: team, aud }, async (url) => {
      expect(url).toBe(accessCertsUrl(team));
      const doc: JwksDocument = { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
      return doc;
    });
    const handle = await listen({ access: verifier });
    const base = `http://127.0.0.1:${handle.port}`;

    expect((await fetch(`${base}/api/health`)).status).toBe(403);
    expect((await fetch(`${base}/ws`)).status).toBe(403);
    expect((await fetch(`${base}/ws/term?agentId=1`)).status).toBe(403);

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        aud,
        iss: `https://${team}`,
        exp: now + 60,
        email: 'a@b',
      }),
    ).toString('base64url');
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${body}`);
    signer.end();
    const token = `${header}.${body}.${signer.sign(privateKey).toString('base64url')}`;

    const allowed = await fetch(`${base}/api/health`, {
      headers: { 'cf-access-jwt-assertion': token },
    });
    expect(allowed.status).toBe(200);

    const hookOk = await fetch(`${base}/api/hooks/claude`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(hookOk.status).toBe(200);

    const hookDenied = await fetch(`${base}/api/hooks/claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(hookDenied.status).toBe(401);

    // Only the matched hook POST route is exempt, not every URL under the prefix.
    expect((await fetch(`${base}/api/hooks/claude`)).status).toBe(403);
  });
});

describe('/ws/term attach', () => {
  const socketName = `pa-test-${process.pid}-${Date.now()}`;
  let handle: HttpServerHandle | undefined;
  let homeDir: string | undefined;
  let paneId = '';
  let targetWindowId = '';
  let width = 0;
  let height = 0;
  const previousSocket = process.env.PIXEL_AGENTS_TMUX_SOCKET;

  beforeAll(async () => {
    process.env.PIXEL_AGENTS_TMUX_SOCKET = socketName;
    await tmux(socketName, ['new-session', '-d', '-s', 'demo', '-x', '100', '-y', '30']);
    const fields = (
      await tmux(socketName, [
        'display-message',
        '-p',
        '-t',
        'demo',
        '#{session_name} #{window_id} #{pane_id} #{window_width} #{window_height}',
      ])
    )
      .trim()
      .split(/\s+/);
    const [session, windowId, pane, widthRaw, heightRaw] = fields;
    if (!session || !windowId || !pane)
      throw new Error(`unexpected tmux identity: ${fields.join(' ')}`);
    paneId = pane;
    targetWindowId = windowId;
    width = Number(widthRaw);
    height = Number(heightRaw);

    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-term-'));
    const sessions = path.join(homeDir, '.claude', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const sessionId = '22222222-2222-2222-2222-222222222222';
    fs.writeFileSync(
      path.join(sessions, '1.json'),
      JSON.stringify({
        pid: process.pid,
        sessionId,
        cwd: '/tmp/work',
        tmux: `${session}:${windowId}.${pane}`,
        status: 'idle',
        name: 'term-test',
      }),
    );
    const registry = new ClaudeSessionRegistry({ homeDir });
    registry.refresh();
    const store = new AgentStateStore();
    store.set(1, bareAgent(sessionId));
    handle = await createHttpServer({
      embedded: true,
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      store,
      insecureLocalTerminal: true,
      sessionRegistry: registry,
    });
  }, 20_000);

  afterAll(async () => {
    if (previousSocket === undefined) delete process.env.PIXEL_AGENTS_TMUX_SOCKET;
    else process.env.PIXEL_AGENTS_TMUX_SOCKET = previousSocket;
    await handle?.app.close();
    await execFileAsync('tmux', ['-L', socketName, 'kill-server']).catch(() => undefined);
    if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('types into the private pane and removes the throwaway session', async () => {
    if (!handle) throw new Error('server did not start');
    const socket = new WebSocket(
      `ws://127.0.0.1:${handle.port}/ws/term?agentId=1&token=test-token&tmux=nope`,
    );
    const frames: { binary: boolean; text: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const buffer = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      frames.push({ binary: isBinary, text: buffer.toString('utf8') });
    });

    await waitFor(async () =>
      frames.some((frame) => !frame.binary && frame.text.includes('"type":"size"')),
    );
    socket.send(Buffer.from('echo hi-from-test\r'));
    await waitFor(async () => {
      const captured = await tmux(socketName, ['capture-pane', '-p', '-t', paneId]);
      return captured.includes('hi-from-test');
    });

    const sizeAfter = (
      await tmux(socketName, [
        'display-message',
        '-p',
        '-t',
        paneId,
        '#{window_width} #{window_height}',
      ])
    ).trim();
    expect(sizeAfter).toBe(`${width} ${height}`);
    expect(await tmux(socketName, ['show-options', '-w', '-t', targetWindowId])).toBe('');

    socket.close();
    await waitFor(async () => {
      const names = await tmux(socketName, ['list-sessions', '-F', '#{session_name}']);
      return !names
        .split('\n')
        .map((name) => name.trim())
        .some((name) => name.startsWith('pa-web-'));
    });
    expect(frames.some((frame) => frame.binary)).toBe(true);
  }, 20_000);
});
