import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, test } from 'vitest';

import { Effects } from '../src/office3d/effects.js';
import { radialTexture } from '../src/office3d/furniture.js';

// A rug's highest slab is centred 0.015 above the floor and 0.02 thick (furniture.ts rug()).
const RUG_TOP = 0.025;

describe('desk effects on a scaled-down desk', () => {
  test('the status pool, permission ring and selection ring of a porch crew desk clear the rug', () => {
    const fx = new Effects(radialTexture());
    const porchCrew = new Matrix4().compose(
      new Vector3(2, 0, -1),
      new Quaternion(),
      new Vector3(0.39, 0.39, 0.39),
    );
    fx.sync([{ matrix: porchCrew, status: 'needs-permission' }], porchCrew);
    fx.step(0, true);

    const internals = fx as unknown as {
      pools: { mesh: { getMatrixAt(i: number, m: Matrix4): void } };
      rings: { mesh: { getMatrixAt(i: number, m: Matrix4): void } };
      selection: { matrix: Matrix4 };
    };
    const y = (m: Matrix4) => new Vector3().setFromMatrixPosition(m).y;
    const pool = new Matrix4();
    const ring = new Matrix4();
    internals.pools.mesh.getMatrixAt(0, pool);
    internals.rings.mesh.getMatrixAt(0, ring);
    expect(y(pool)).toBeGreaterThan(RUG_TOP);
    expect(y(ring)).toBeGreaterThan(RUG_TOP);
    expect(y(internals.selection.matrix)).toBeGreaterThan(RUG_TOP);
  });
});
