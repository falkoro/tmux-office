import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import type { IPty } from 'node-pty';
import * as pty from 'node-pty';

import { TERM_SIZE_POLL_INTERVAL_MS } from './constants.js';
import type { TmuxLocation } from './providers/hook/claude/claudeSessionRegistry.js';

const execFileAsync = promisify(execFile);

const WINDOW_ID = /^@\d+$/;
const PANE_ID = /^%\d+$/;
const SOCKET_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_DIMENSION = 500;
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;

export function tmuxSocketName(): string | undefined {
  const name = process.env.PIXEL_AGENTS_TMUX_SOCKET;
  if (!name || !SOCKET_NAME.test(name)) return undefined;
  return name;
}

/** `-L <name>` when PIXEL_AGENTS_TMUX_SOCKET is set, otherwise nothing. */
export function tmuxSocketArgs(): string[] {
  const name = tmuxSocketName();
  return name ? ['-L', name] : [];
}

export function isSafeTmuxLocation(location: TmuxLocation): boolean {
  if (!location.session || location.session.startsWith('-')) return false;
  if (/[\s;\0]/.test(location.session)) return false;
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
    location.session,
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
    if (!paneId || !session || !windowId) {
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
    const { stdout } = await execFileAsync('tmux', listTmuxPanesArgv(), { timeout: 2000 });
    return parseTmuxPaneList(stdout);
  } catch {
    return null;
  }
}

export async function killThrowawaySession(sessionName: string): Promise<void> {
  if (!sessionName.startsWith('pa-web-')) return;
  try {
    await execFileAsync('tmux', [...tmuxSocketArgs(), 'kill-session', '-t', sessionName], {
      timeout: 2000,
    });
  } catch {
    /* destroy-unattached already removed it */
  }
}

export interface AttachedTerminal {
  pty: IPty;
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
  const sessionName = `pa-web-${randomBytes(8).toString('hex')}`;
  const size = (await readPaneClientSize(location.paneId)) ?? {
    cols: FALLBACK_COLS,
    rows: FALLBACK_ROWS,
  };
  const term = pty.spawn('tmux', buildAttachArgv(location, sessionName), {
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
