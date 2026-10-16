import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import { TERM_SIZE_POLL_INTERVAL_MS, TMUX_LIST_PANES_TIMEOUT_MS } from './constants.js';
import type { TmuxLocation } from './providers/hook/claude/claudeSessionRegistry.js';

const execFileAsync = promisify(execFile);

const WINDOW_ID = /^@\d+$/;
const PANE_ID = /^%\d+$/;
const SOCKET_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_DIMENSION = 500;
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;
const THROWAWAY_PREFIX = 'pa-web-';
const THROWAWAY_ID_BYTES = 8;
const THROWAWAY_SESSION = new RegExp(`^${THROWAWAY_PREFIX}[0-9a-f]{${THROWAWAY_ID_BYTES * 2}}$`);

/** A fresh name for the grouped session one /ws/term attach creates. */
export function throwawaySessionName(): string {
  return `${THROWAWAY_PREFIX}${randomBytes(THROWAWAY_ID_BYTES).toString('hex')}`;
}

let warnedSocketName = false;

export function tmuxSocketName(): string | undefined {
  const name = process.env.PIXEL_AGENTS_TMUX_SOCKET;
  if (!name) return undefined;
  if (SOCKET_NAME.test(name)) return name;
  if (!warnedSocketName) {
    warnedSocketName = true;
    console.warn(
      `[Pixel Agents] Ignoring PIXEL_AGENTS_TMUX_SOCKET=${JSON.stringify(name)}: it must be a tmux -L name of letters, digits, '_' or '-'. Reading the default tmux server.`,
    );
  }
  return undefined;
}

/** `-L <name>` when PIXEL_AGENTS_TMUX_SOCKET is set, otherwise nothing. */
export function tmuxSocketArgs(): string[] {
  const name = tmuxSocketName();
  return name ? ['-L', name] : [];
}

export function isSafeTmuxLocation(location: TmuxLocation): boolean {
  if (!location.session || location.session.startsWith('-')) return false;
  if (/[\s;\0]/.test(location.session)) return false;
  if (THROWAWAY_SESSION.test(location.session)) return false;
  return WINDOW_ID.test(location.windowId) && PANE_ID.test(location.paneId);
}

/**
 * Argv for a throwaway grouped session that shares the target's windows.
 *
 * Only session options go on the throwaway session. `window-size` is a
 * window option in tmux 3.7, so setting it here would stick on the user's
 * shared window. The pty is sized to the window instead (readPaneClientSize).
 */
export function buildAttachArgv(location: TmuxLocation, sessionName: string): string[] {
  return [
    ...tmuxSocketArgs(),
    'new-session',
    '-t',
    `=${location.session}`,
    '-s',
    sessionName,
    '-f',
    'ignore-size',
    ';',
    'set-option',
    '-t',
    sessionName,
    'destroy-unattached',
    'on',
    ';',
    'select-window',
    '-t',
    location.windowId,
    ';',
    'select-pane',
    '-t',
    location.paneId,
  ];
}

function statusLineCount(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === 'on') return 1;
  if (trimmed === 'off') return 0;
  if (trimmed === '') return null;
  const count = Number(trimmed);
  if (Number.isInteger(count) && count >= 0 && count <= 5) return count;
  return null;
}

async function readStatusLines(paneId: string): Promise<number> {
  const prefix = tmuxSocketArgs();
  const queries = [
    [...prefix, 'show-options', '-v', '-t', paneId, 'status'],
    [...prefix, 'show-options', '-gv', 'status'],
  ];
  for (const args of queries) {
    try {
      const { stdout } = await execFileAsync('tmux', args, { timeout: 2000 });
      const count = statusLineCount(stdout);
      if (count !== null) return count;
    } catch {
      /* try the next query */
    }
  }
  return 1;
}

function clampDimension(value: number): number {
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_DIMENSION);
}

/**
 * Pty size that matches the target window. With `window-size latest` and no
 * other client attached, the window follows this client, so rows include the
 * status line to keep the window height unchanged.
 */
export async function readPaneClientSize(
  paneId: string,
): Promise<{ cols: number; rows: number } | null> {
  if (!PANE_ID.test(paneId)) return null;
  try {
    const { stdout } = await execFileAsync(
      'tmux',
      [
        ...tmuxSocketArgs(),
        'display-message',
        '-p',
        '-t',
        paneId,
        '#{window_width} #{window_height}',
      ],
      { timeout: 2000 },
    );
    const [widthRaw, heightRaw] = stdout.trim().split(/\s+/);
    const width = Number(widthRaw);
    const height = Number(heightRaw);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      return null;
    }
    const status = await readStatusLines(paneId);
    return { cols: clampDimension(width), rows: clampDimension(height + status) };
  } catch {
    return null;
  }
}

/** One pane from `tmux list-panes -a`. Session may still be unsafe. */
export interface TmuxPaneRecord {
  paneId: string;
  session: string;
  windowId: string;
}

/** Argv for the read-only pane listing. Socket flags match the rest of the server. */
export function listTmuxPanesArgv(): string[] {
  return [...tmuxSocketArgs(), 'list-panes', '-a', '-F', '#{pane_id} #{session_name} #{window_id}'];
}

/**
 * Parse `list-panes` output. The session name is whatever sits between the
 * pane id and the window id, so a name with spaces survives for the safety check.
 */
export function parseTmuxPaneList(stdout: string): TmuxPaneRecord[] {
  const panes: TmuxPaneRecord[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) {
      continue;
    }
    const parts = line.split(' ');
    if (parts.length < 3) {
      continue;
    }
    const paneId = parts[0] ?? '';
    const windowId = parts[parts.length - 1] ?? '';
    const session = parts.slice(1, -1).join(' ');
    if (!paneId || !session || !windowId || THROWAWAY_SESSION.test(session)) {
      continue;
    }
    panes.push({ paneId, session, windowId });
  }
  return panes;
}

/**
 * Every pane on the tmux server, or null when tmux could not be asked.
 * Read-only. An empty array is a successful listing with no panes.
 */
export async function listTmuxPanes(): Promise<TmuxPaneRecord[] | null> {
  try {
    const { stdout } = await execFileAsync('tmux', listTmuxPanesArgv(), {
      timeout: TMUX_LIST_PANES_TIMEOUT_MS,
    });
    return parseTmuxPaneList(stdout);
  } catch {
    return null;
  }
}

export async function killThrowawaySession(sessionName: string): Promise<void> {
  if (!THROWAWAY_SESSION.test(sessionName)) return;
  try {
    await execFileAsync('tmux', [...tmuxSocketArgs(), 'kill-session', '-t', sessionName], {
      timeout: 2000,
    });
  } catch {
    /* destroy-unattached already removed it */
  }
}

/** The members of node-pty's IPty this module uses. */
interface Pty {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: () => void): unknown;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface NodePty {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string },
  ): Pty;
}

const NODE_PTY = 'node-pty';

export interface AttachedTerminal {
  pty: Pty;
  sessionName: string;
  stop(): void;
}

export async function attachTmuxPane(
  location: TmuxLocation,
  onData: (data: string) => void,
  onSize: (cols: number, rows: number) => void,
): Promise<AttachedTerminal> {
  if (!isSafeTmuxLocation(location)) {
    throw new Error('unsafe tmux location');
  }
  const sessionName = throwawaySessionName();
  const size = (await readPaneClientSize(location.paneId)) ?? {
    cols: FALLBACK_COLS,
    rows: FALLBACK_ROWS,
  };
  // Loaded here, not at the top: the VS Code extension bundles this module and
  // must load on hosts where node-pty's native build is missing.
  const { spawn } = (await import(NODE_PTY)) as NodePty;
  const term = spawn('tmux', buildAttachArgv(location, sessionName), {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: process.env.HOME || '/tmp',
  });
  term.onData(onData);
  onSize(size.cols, size.rows);

  let current = size;
  const timer = setInterval(() => {
    void readPaneClientSize(location.paneId).then((next) => {
      if (!next) return;
      if (next.cols === current.cols && next.rows === current.rows) return;
      current = next;
      try {
        term.resize(next.cols, next.rows);
      } catch {
        /* pty already closed */
      }
      onSize(next.cols, next.rows);
    });
  }, TERM_SIZE_POLL_INTERVAL_MS);

  let stopped = false;
  return {
    pty: term,
    sessionName,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        term.kill();
      } catch {
        /* already dead */
      }
      void killThrowawaySession(sessionName);
    },
  };
}
