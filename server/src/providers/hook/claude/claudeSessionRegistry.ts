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
  /** Start time of the process, field 22 of `/proc/<pid>/stat`. */
  procStart?: string;
  /** `linux:<machine-id>:pid:[<inode>]`, the pid namespace the pid belongs to. */
  pidDomain?: string;
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
    procStart: optionalString(record.procStart) ?? undefined,
    pidDomain: optionalString(record.pidDomain) ?? undefined,
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

/** The /proc reads that tell a live Claude from a reused pid. Null when unreadable. */
export interface ProcReader {
  stat(pid: number): string | null;
  pidNamespace(): string | null;
}

export const realProc: ProcReader = {
  stat(pid) {
    try {
      return fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return null;
    }
  },
  pidNamespace() {
    try {
      return fs.readlinkSync('/proc/self/ns/pid');
    } catch {
      return null;
    }
  },
};

/** Field 22 (starttime) of a `/proc/<pid>/stat` line. The comm field may hold spaces or parens. */
export function procStartTime(stat: string): string | null {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  return stat.slice(end + 2).split(' ')[19] ?? null;
}

/** Field 4 (ppid) of a `/proc/<pid>/stat` line. */
export function procParentPid(stat: string): number | null {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const ppid = Number(stat.slice(end + 2).split(' ')[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

const MAX_PROCESS_DEPTH = 64;

/**
 * Whether `pid` is `panePid` or descends from it. Null when /proc cannot read
 * `pid` at all (a host without /proc, such as macOS), so the caller cannot tell.
 */
export function runsInPane(
  pid: number,
  panePid: number,
  proc: ProcReader = realProc,
): boolean | null {
  if (proc.stat(pid) === null) return null;
  for (let at = pid, depth = 0; at > 1 && depth < MAX_PROCESS_DEPTH; depth++) {
    if (at === panePid) return true;
    const stat = proc.stat(at);
    const parent = stat ? procParentPid(stat) : null;
    if (parent === null) return false;
    at = parent;
  }
  return false;
}

/**
 * The pid is alive and, where the session file and /proc can tell, it is the
 * same process in the same pid namespace that wrote the file.
 */
export function isSessionProcess(
  session: LiveClaudeSession,
  alive: (pid: number) => boolean,
  proc: ProcReader,
): boolean {
  if (!alive(session.pid)) return false;
  if (session.pidDomain) {
    const ns = proc.pidNamespace();
    if (ns && !session.pidDomain.endsWith(`:${ns}`)) return false;
  }
  if (session.procStart) {
    const stat = proc.stat(session.pid);
    const start = stat ? procStartTime(stat) : null;
    if (start && start !== session.procStart) return false;
  }
  return true;
}

export interface ClaudeSessionRegistryOptions {
  homeDir?: string;
  configDirGlob?: string;
  isPidAlive?: (pid: number) => boolean;
  proc?: ProcReader;
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
    const proc = this.options.proc ?? realProc;
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
      if (!isSessionProcess(parsed, alive, proc)) continue;
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
