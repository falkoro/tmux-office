import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizePackMetadata,
  parsePackJsonOutput,
  REQUIRED_PACKAGE_FILES,
  REQUIRED_PACKAGE_PREFIXES,
  validatePackageFiles,
} from './npm-package-contract.mjs';

function validFiles() {
  return [
    ...REQUIRED_PACKAGE_FILES,
    ...REQUIRED_PACKAGE_PREFIXES.map((prefix) => `${prefix}fixture.dat`),
  ].map((path) => ({ path }));
}

test('normalizes npm pack array and keyed-object output', () => {
  const metadata = { filename: 'pixel-agents-1.4.0.tgz', files: validFiles() };
  assert.equal(normalizePackMetadata([metadata]), metadata);
  assert.equal(normalizePackMetadata({ 'pixel-agents@1.4.0': metadata }), metadata);
});

test('extracts pack JSON after lifecycle build output', () => {
  const metadata = [{ filename: 'pixel-agents-1.4.0.tgz', files: validFiles() }];
  const output = `[generate-messages] built protocol\nHUSKY=0 skip install${JSON.stringify(metadata)}`;
  assert.deepEqual(parsePackJsonOutput(output), metadata);
});

test('rejects a known-bad tarball missing the shipped hook', () => {
  const files = validFiles().filter((file) => file.path !== 'dist/hooks/claude-hook.js');
  assert.throws(
    () => validatePackageFiles(files),
    /missing required file: dist\/hooks\/claude-hook\.js/,
  );
});

test('rejects source and preview files even when required files exist', () => {
  assert.throws(
    () => validatePackageFiles([...validFiles(), { path: 'server/src/cli.ts' }]),
    /forbidden package path: server\/src\/cli\.ts/,
  );
  assert.throws(
    () => validatePackageFiles([...validFiles(), { path: 'dist/browser/index.html' }]),
    /forbidden package path: dist\/browser\/index\.html/,
  );
});
