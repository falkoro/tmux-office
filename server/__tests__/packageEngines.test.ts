import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const { satisfies } = createRequire(import.meta.url)('semver') as {
  satisfies(version: string, range: string): boolean;
};

describe('package engines', () => {
  it('admits exactly the Node versions the README asks for (20.19+ or 22.12+)', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'),
    ) as { engines: { node: string } };
    const range = pkg.engines.node;
    for (const version of ['20.19.0', '20.20.1', '22.12.0', '24.3.0']) {
      expect(satisfies(version, range), version).toBe(true);
    }
    for (const version of ['18.20.0', '20.18.3', '21.7.0', '22.11.0']) {
      expect(satisfies(version, range), version).toBe(false);
    }
  });
});
