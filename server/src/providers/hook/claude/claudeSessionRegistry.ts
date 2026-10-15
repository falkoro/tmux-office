import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../../../../core/src/normalizeProjectPath.js';
import {
  DEFAULT_CLAUDE_CONFIG_DIR_GLOB,
  existingProjectDir,
  listClaudeConfigDirs,
} from './claudeConfigDirs.js';

/** Where a live Claude process sits inside tmux. Ids keep their sigils. */
export interface TmuxLocation {
  /** Session name, for example `work-6`. */
  session: string;
  /** Window id including `@`, for example `@12`. */
  windowId: string;
  /** Pane id including `%`, for example `%12`. */
  paneId: string;
}

/** One live Claude process, read from `<configDir>/sessions/<pid>.json`. */
export interface LiveClaudeSession {
  pid: number;
  sessionId: string;
  /** Absolute config directory, for example `/home/me/.claude-work`. */
  configDir: string;
  cwd: string;
  tmux: TmuxLocation | null;
  /** `"busy"` or `"idle"` as the session file reported it. */
  status: string | null;
  name: string | null;
}

const TMUX_LOCATION = /^(.+):(@\d+)\.(%\d+)$/;

/**
 * Parse `work-6:@12.%12`. A session name that could be read as a tmux flag
 * or command separator is rejected so it can never be passed through to argv.
 */
export function parseTmuxLocation(value: string): TmuxLocation | null {
  const match = TMUX_LOCATION.exec(value);
  if (!match) return null;
  const session = match[1] ?? '';
  const windowId = match[2] ?? '';
  const paneId = match[3] ?? '';
  if (!session || session.startsWith('-') || /[\s;\0]/.test(session)) return null;
  return { session, windowId, paneId };
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Parse one session file. Returns null for malformed input; the caller skips
 * the file. Extra fields are ignored. `tmux` absent or JSON null means the
 * process is not inside tmux. A `tmux` that does not parse, for example a
 * session name with a space, keeps the session without a location.
 */
export function parseSessionFile(raw: string, configDir: string): LiveClaudeSession | null {
  let data: unknown;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const { pid, sessionId, cwd } = record;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof cwd !== 'string' || cwd.length === 0) return null;

  const tmux = typeof record.tmux === 'string' ? parseTmuxLocation(record.tmux) : null;

  return {
    pid,
    sessionId,
    configDir,
    cwd,
    tmux,
    status: optionalString(record.status),
    name: optionalString(record.name),
  };
}

/** `kill(pid, 0)` succeeds, or the kernel refuses the signal (process exists). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ClaudeSessionRegistryOptions {
  homeDir?: string;
  configDirGlob?: string;
  isPidAlive?: (pid: number) => boolean;
}

/**
 * The only reader of `<configDir>/sessions/<pid>.json`. Owns the live map.
 * Does not scan until `refresh()`.
 */
export class ClaudeSessionRegistry {
  private readonly sessionsById = new Map<string, LiveClaudeSession>();
  private byFile = new Map<string, LiveClaudeSession>();
  private configDirs: string[] = [];

  constructor(private readonly options: ClaudeSessionRegistryOptions = {}) {}

  refresh(): void {
    const homeDir = this.options.homeDir ?? os.homedir();
    const glob = this.options.configDirGlob ?? DEFAULT_CLAUDE_CONFIG_DIR_GLOB;
    const alive = this.options.isPidAlive ?? isPidAlive;
    const found = new Map<string, LiveClaudeSession>();

    const files: { file: string; configDir: string }[] = [];
    this.configDirs = listClaudeConfigDirs(homeDir, glob, this.configDirs);
    for (const configDir of this.configDirs) {
      const sessionsDir = path.join(configDir, 'sessions');
      let names: string[];
      try {
        names = fs.readdirSync(sessionsDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        names = [...this.byFile.keys()]
          .filter((file) => path.dirname(file) === sessionsDir)
          .map((file) => path.basename(file));
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        files.push({ file: path.join(sessionsDir, name), configDir });
      }
    }
    files.sort((a, b) => a.file.localeCompare(b.file));

    const byFile = new Map<string, LiveClaudeSession>();
    for (const { file, configDir } of files) {
      let parsed: LiveClaudeSession | null;
      try {
        parsed = parseSessionFile(fs.readFileSync(file, 'utf8'), configDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        parsed = null;
      }
      parsed ??= this.byFile.get(file) ?? null;
      if (!parsed) continue;
      byFile.set(file, parsed);
      if (!alive(parsed.pid)) continue;
      const prev = found.get(parsed.sessionId);
      // Prefer a record that names a tmux pane. Otherwise the later path wins.
      if (!prev || Boolean(parsed.tmux) || !prev.tmux) {
        found.set(parsed.sessionId, parsed);
      }
    }

    this.byFile = byFile;
    this.sessionsById.clear();
    for (const [id, session] of found) this.sessionsById.set(id, session);
  }

  get(sessionId: string): LiveClaudeSession | undefined {
    return this.sessionsById.get(sessionId);
  }

  sessions(): LiveClaudeSession[] {
    return [...this.sessionsById.values()];
  }

  size(): number {
    return this.sessionsById.size;
  }
}

/** Transcript path for a live session, or null when the jsonl is not on disk. */
export function transcriptPathForSession(session: LiveClaudeSession): string | null {
  const projectsRoot = path.join(session.configDir, 'projects');
  const projectDir = existingProjectDir(projectsRoot, normalizeProjectPath(session.cwd));
  if (!projectDir) return null;
  const file = path.join(projectDir, `${session.sessionId}.jsonl`);
  return fs.existsSync(file) ? file : null;
}
