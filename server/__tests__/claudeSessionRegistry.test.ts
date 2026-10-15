import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import {
  ClaudeSessionRegistry,
  parseSessionFile,
  parseTmuxLocation,
  transcriptPathForSession,
} from '../src/providers/hook/claude/claudeSessionRegistry.js';

const deadPid = 2_147_483_646;

describe('parseTmuxLocation', () => {
  it('parses session, window id and pane id', () => {
    expect(parseTmuxLocation('emperor-6:@12.%12')).toEqual({
      session: 'emperor-6',
      windowId: '@12',
      paneId: '%12',
    });
  });

  it.each(['', 'emperor-6', 'emperor-6:12.12', '-bad:@1.%1', 'bad name:@1.%1', 'a;b:@1.%1'])(
    'rejects %j',
    (value) => {
      expect(parseTmuxLocation(value)).toBeNull();
    },
  );
});

describe('parseSessionFile', () => {
  const configDir = '/home/me/.claude-work';

  it('reads the fields the registry keeps and ignores the rest', () => {
    const raw = JSON.stringify({
      pid: 7951,
      sessionId: '44325277-1111-1111-1111-111111111111',
      cwd: '/home/me/repos/reddit-fetch',
      tmux: 'emperor-6:@12.%12',
      status: 'idle',
      name: 'reddit-fetch-88',
      extra: { secret: 'nope' },
    });
    expect(parseSessionFile(raw, configDir)).toEqual({
      pid: 7951,
      sessionId: '44325277-1111-1111-1111-111111111111',
      configDir,
      cwd: '/home/me/repos/reddit-fetch',
      tmux: { session: 'emperor-6', windowId: '@12', paneId: '%12' },
      status: 'idle',
      name: 'reddit-fetch-88',
    });
  });

  it('strips a BOM and treats a missing tmux field as null', () => {
    const parsed = parseSessionFile(
      `\uFEFF${JSON.stringify({ pid: 4, sessionId: 's', cwd: '/work' })}`,
      configDir,
    );
    expect(parsed?.tmux).toBeNull();
    expect(parsed?.status).toBeNull();
    expect(parsed?.name).toBeNull();
  });

  it('drops a file whose tmux string or pid is unusable', () => {
    expect(
      parseSessionFile(
        JSON.stringify({ pid: 4, sessionId: 's', cwd: '/work', tmux: 'not-tmux' }),
        configDir,
      ),
    ).toBeNull();
    expect(
      parseSessionFile(JSON.stringify({ pid: 0, sessionId: 's', cwd: '/work' }), configDir),
    ).toBeNull();
    expect(parseSessionFile('{', configDir)).toBeNull();
  });
});

describe('ClaudeSessionRegistry', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function home(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-sessions-'));
    dirs.push(dir);
    return dir;
  }

  function writeSession(root: string, configName: string, fileName: string, body: unknown): void {
    const sessions = path.join(root, configName, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, fileName), JSON.stringify(body));
  }

  it('keeps live sessions from every config dir and drops dead, bak, and malformed files', () => {
    const root = home();
    writeSession(root, '.claude', '1.json', {
      pid: process.pid,
      sessionId: 'live-a',
      cwd: '/work/a',
      tmux: 'demo:@1.%2',
      status: 'busy',
      name: 'alpha',
    });
    writeSession(root, '.claude-work', '2.json', {
      pid: process.pid,
      sessionId: 'live-b',
      cwd: '/work/b',
      name: 'beta',
    });
    writeSession(root, '.claude', 'dead.json', {
      pid: deadPid,
      sessionId: 'dead',
      cwd: '/work/dead',
    });
    writeSession(root, '.claude', 'bad.json', '{');
    fs.mkdirSync(path.join(root, '.claude.bak-old', 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude.bak-old', 'sessions', '9.json'),
      JSON.stringify({ pid: process.pid, sessionId: 'bak', cwd: '/nope' }),
    );

    const registry = new ClaudeSessionRegistry({ homeDir: root });
    expect(registry.size()).toBe(0);
    registry.refresh();
    expect(registry.size()).toBe(2);
    expect(registry.get('live-a')?.tmux).toEqual({ session: 'demo', windowId: '@1', paneId: '%2' });
    expect(registry.get('live-b')?.tmux).toBeNull();
    expect(registry.get('dead')).toBeUndefined();
    expect(registry.get('bak')).toBeUndefined();
  });

  it('prefers the duplicate that names a tmux pane', () => {
    const root = home();
    writeSession(root, '.claude', 'a.json', {
      pid: process.pid,
      sessionId: 'same',
      cwd: '/work',
    });
    writeSession(root, '.claude-work', 'b.json', {
      pid: process.pid,
      sessionId: 'same',
      cwd: '/work',
      tmux: 'demo:@3.%4',
    });
    const registry = new ClaudeSessionRegistry({ homeDir: root });
    registry.refresh();
    expect(registry.get('same')?.configDir).toBe(path.join(root, '.claude-work'));
    expect(registry.get('same')?.tmux?.paneId).toBe('%4');
  });
});

describe('live session adoption', () => {
  const dirs: string[] = [];
  let runtime: AgentRuntime | undefined;

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function home(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-live-'));
    dirs.push(dir);
    return dir;
  }

  function plant(root: string, watch: 'all' | 'tracked' | 'off'): AgentStateStore {
    const cwd = path.join(root, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const projectDir = path.join(root, '.claude-work', 'projects', normalizeProjectPath(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    const jsonl = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(jsonl, '{"type":"user"}\n');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(jsonl, old, old);
    fs.mkdirSync(path.join(root, '.claude-work', 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude-work', 'sessions', '1.json'),
      JSON.stringify({
        pid: process.pid,
        sessionId,
        cwd,
        tmux: 'demo:@2.%3',
        status: 'idle',
        name: 'zeta',
      }),
    );

    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    if (watch === 'tracked') runtime.startProjectScan(projectDir);
    if (watch === 'all') runtime.forceWatchAll = true;
    runtime.startLiveSessionRegistry(
      new ClaudeSessionRegistry({ homeDir: root }),
      async () => null,
    );
    return store;
  }

  it('adopts a small old transcript when watch-all is forced', () => {
    const store = plant(home(), 'all');
    expect(store.size).toBe(1);
    const agent = [...store.values()][0];
    expect(agent?.registryName).toBe('zeta');
    expect(agent?.tmux).toEqual({ session: 'demo', windowId: '@2', paneId: '%3' });
  });

  it('adopts a seeded transcript in a tracked project dir', () => {
    const store = plant(home(), 'tracked');
    expect(store.size).toBe(1);
    expect([...store.values()][0]?.tmux?.paneId).toBe('%3');
  });

  it('does not adopt when watch-all is off and the project dir is untracked', () => {
    const store = plant(home(), 'off');
    expect(store.size).toBe(0);
  });

  it('resolves the transcript path', () => {
    const root = home();
    const cwd = path.join(root, 'Work');
    const sessionId = 'abc';
    const projectDir = path.join(root, '.claude', 'projects', normalizeProjectPath(cwd));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '{}\n');
    const session = parseSessionFile(
      JSON.stringify({ pid: 1, sessionId, cwd, tmux: null }),
      path.join(root, '.claude'),
    );
    expect(session).not.toBeNull();
    expect(transcriptPathForSession(session!)).toBe(path.join(projectDir, `${sessionId}.jsonl`));
  });
});
