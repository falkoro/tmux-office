import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../../../../core/src/normalizeProjectPath.js';

/** Default name glob for Claude config directories inside a home directory. */
export const DEFAULT_CLAUDE_CONFIG_DIR_GLOB = '.claude*';

const BAK_DIR = /\.bak-/;

/**
 * Turn a glob that only uses `*` into an anchored regex.
 * `.claude*` matches `.claude` and `.claude-work`.
 */
export function configDirGlobToRegExp(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}$`);
}

function isDirectory(parent: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(parent, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every Claude config directory under `homeDir`.
 *
 * Directories only, so a file such as `~/.claude.json` is ignored. Names
 * matching `*.bak-*` (for example `~/.claude.bak-2026-01-01`) are backups,
 * not live config dirs.
 */
export function listClaudeConfigDirs(
  homeDir: string,
  configDirGlob: string = DEFAULT_CLAUDE_CONFIG_DIR_GLOB,
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(homeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const match = configDirGlobToRegExp(configDirGlob);
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!match.test(entry.name) || BAK_DIR.test(entry.name)) continue;
    if (!isDirectory(homeDir, entry)) continue;
    dirs.push(path.join(homeDir, entry.name));
  }
  dirs.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  // The default config dir is where a launch without CLAUDE_CONFIG_DIR writes.
  // Keep it first so callers that use dirs[0] as the launch anchor stay there.
  const primary = path.join(homeDir, '.claude');
  const primaryIndex = dirs.indexOf(primary);
  if (primaryIndex > 0) {
    dirs.splice(primaryIndex, 1);
    dirs.unshift(primary);
  }
  return dirs;
}

/** `projects/` root under every config dir. Includes `~/.claude/projects`
 *  even when that directory does not exist yet, matching the historical
 *  single-root scanner. */
export function allSessionRoots(
  homeDir: string,
  configDirGlob: string = DEFAULT_CLAUDE_CONFIG_DIR_GLOB,
): string[] {
  const configs = listClaudeConfigDirs(homeDir, configDirGlob);
  const primary = path.join(homeDir, '.claude');
  const roots = configs.map((configDir) => path.join(configDir, 'projects'));
  if (!configs.includes(primary)) {
    roots.unshift(path.join(primary, 'projects'));
  }
  return roots;
}

export function existingProjectDir(projectsRoot: string, dirName: string): string | null {
  const exact = path.join(projectsRoot, dirName);
  if (fs.existsSync(exact)) return exact;
  try {
    if (!fs.existsSync(projectsRoot)) return null;
    const lower = dirName.toLowerCase();
    const match = fs.readdirSync(projectsRoot).find((entry) => entry.toLowerCase() === lower);
    return match ? path.join(projectsRoot, match) : null;
  } catch {
    return null;
  }
}

/**
 * Project transcript directories for one workspace, across every config dir.
 * The canonical `~/.claude` path is first. When nothing exists yet, that
 * expected path is still returned so a launch has somewhere to watch.
 */
export function sessionDirsForWorkspace(
  homeDir: string,
  workspacePath: string,
  configDirGlob: string = DEFAULT_CLAUDE_CONFIG_DIR_GLOB,
): string[] {
  const dirName = normalizeProjectPath(workspacePath);
  const primary = path.join(homeDir, '.claude');
  const configs = listClaudeConfigDirs(homeDir, configDirGlob);
  const search = configs.includes(primary) ? configs : [primary, ...configs];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const configDir of search) {
    const match = existingProjectDir(path.join(configDir, 'projects'), dirName);
    if (!match || seen.has(match)) continue;
    seen.add(match);
    found.push(match);
  }
  // dirs[0] is the launch anchor. Keep the canonical ~/.claude path there even
  // when this workspace has no transcripts in it yet.
  const expected = path.join(primary, 'projects', dirName);
  const hasCanonical = found.some((dir) => dir.toLowerCase() === expected.toLowerCase());
  if (!hasCanonical) found.unshift(expected);
  return found;
}
