import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  allSessionRoots,
  listClaudeConfigDirs,
  sessionDirsForWorkspace,
} from '../src/providers/hook/claude/claudeConfigDirs.js';

describe('claude config dirs', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function home(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-claude-home-'));
    dirs.push(dir);
    return dir;
  }

  it('lists config directories, skips files and bak dirs, and keeps .claude first', () => {
    const root = home();
    fs.mkdirSync(path.join(root, '.claude-work'));
    fs.mkdirSync(path.join(root, '.claude'));
    fs.mkdirSync(path.join(root, '.claude-client'));
    fs.writeFileSync(path.join(root, '.claude.json'), '{}');
    fs.mkdirSync(path.join(root, '.claude.bak-old'));
    fs.mkdirSync(path.join(root, '.claude-client.bak-1'));
    fs.mkdirSync(path.join(root, 'notes'));

    expect(listClaudeConfigDirs(root).map((dir) => path.basename(dir))).toEqual([
      '.claude',
      '.claude-client',
      '.claude-work',
    ]);
  });

  it('follows a symlink to a config directory', () => {
    const root = home();
    const real = path.join(root, 'real-claude');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(root, '.claude-link'), 'dir');
    expect(listClaudeConfigDirs(root).map((dir) => path.basename(dir))).toEqual(['.claude-link']);
  });

  it('returns an empty list when the home directory is missing', () => {
    expect(listClaudeConfigDirs(path.join(os.tmpdir(), 'pxl-missing-home-nope'))).toEqual([]);
  });

  it('includes the canonical projects root even when .claude does not exist', () => {
    const root = home();
    fs.mkdirSync(path.join(root, '.claude-work'));
    expect(allSessionRoots(root)).toEqual([
      path.join(root, '.claude', 'projects'),
      path.join(root, '.claude-work', 'projects'),
    ]);
  });

  it('finds a workspace transcript dir in every config dir and falls back to .claude', () => {
    const root = home();
    const workspace = '/tmp/Example Project';
    const hashed = normalizeProjectPath(workspace);
    const work = path.join(root, '.claude-work', 'projects', hashed);
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(path.join(root, '.claude'));

    expect(sessionDirsForWorkspace(root, workspace)).toEqual([
      path.join(root, '.claude', 'projects', hashed),
      work,
    ]);

    const empty = home();
    expect(sessionDirsForWorkspace(empty, workspace)).toEqual([
      path.join(empty, '.claude', 'projects', hashed),
    ]);
  });
});
