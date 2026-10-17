// fastify + @fastify/{cors,static,websocket} are root runtime `dependencies` even though
// no root source file imports them: esbuild marks them `external` when bundling
// dist/cli.js (see esbuild.js), so the published `pixel-agents` bin resolves them from
// node_modules at runtime. server/ ships its own copy for local dev but is excluded from
// the tarball (FORBIDDEN_PACKAGE_PREFIXES below), so dropping the root declarations would
// publish a CLI that crashes on require(). knip.json ignores them for this reason.

export const REQUIRED_PACKAGE_FILES = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'dist/cli.js',
  'dist/extension.js',
  'dist/hooks/claude-hook.js',
  'dist/webview/index.html',
  'icon.png',
  'package.json',
];

export const REQUIRED_PACKAGE_PREFIXES = [
  'dist/assets/characters/',
  'dist/assets/furniture/',
  'dist/webview/assets/',
];

export const FORBIDDEN_PACKAGE_PREFIXES = [
  '.github/',
  '.husky/',
  'adapters/',
  'core/',
  'dist/browser/',
  'dist/webview-preview/',
  'docs/',
  'e2e/',
  'reports/',
  'scripts/',
  'server/',
  'test-results/',
  'webview-ui/',
];

export function parsePackJsonOutput(output) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const candidates = [];
    for (let index = 0; index < trimmed.length; index++) {
      if (trimmed[index] === '[' || trimmed[index] === '{') candidates.push(index);
    }
    for (let index = candidates.length - 1; index >= 0; index--) {
      try {
        return JSON.parse(trimmed.slice(candidates[index]));
      } catch {
        // Build/lifecycle output can contain JSON-looking fragments; keep scanning.
      }
    }
  }
  throw new Error(`Unable to locate npm pack JSON metadata in output:\n${output}`);
}

export function normalizePackMetadata(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new Error(`Expected one packed package, received ${value.length.toString()}`);
    }
    return value[0];
  }
  if (value && typeof value === 'object') {
    if (typeof value.filename === 'string') return value;
    const entries = Object.values(value);
    if (entries.length === 1 && entries[0] && typeof entries[0] === 'object') {
      return entries[0];
    }
  }
  throw new Error('npm pack did not return one package metadata object');
}

export function validatePackageFiles(files) {
  if (!Array.isArray(files)) throw new Error('npm pack metadata is missing its files array');
  const paths = files.map((file) => file?.path).filter((file) => typeof file === 'string');
  const pathSet = new Set(paths);
  const problems = [];

  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!pathSet.has(required)) problems.push(`missing required file: ${required}`);
  }
  for (const prefix of REQUIRED_PACKAGE_PREFIXES) {
    if (!paths.some((file) => file.startsWith(prefix))) {
      problems.push(`missing required file prefix: ${prefix}`);
    }
  }
  for (const file of paths) {
    const forbiddenPrefix = FORBIDDEN_PACKAGE_PREFIXES.find((prefix) => file.startsWith(prefix));
    if (forbiddenPrefix) problems.push(`forbidden package path: ${file}`);
    if (file.endsWith('.map')) problems.push(`source map must not ship: ${file}`);
    if (file.endsWith('.tgz')) problems.push(`nested tarball must not ship: ${file}`);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid npm package contents:\n- ${problems.join('\n- ')}`);
  }
  return paths;
}
