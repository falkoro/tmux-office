import assert from 'node:assert/strict';

import { test } from 'vitest';

import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

buildDynamicCatalog({
  catalog: [
    {
      id: 'TEST_CHAIR',
      label: 'Chair',
      category: 'chairs',
      width: 16,
      height: 16,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
    },
  ],
  sprites: { TEST_CHAIR: [['#ffffffff']] },
});

const layout: OfficeLayout = {
  version: 1,
  cols: 3,
  rows: 3,
  tiles: Array(9).fill(TileType.FLOOR_1),
  furniture: [{ uid: 'chair', type: 'TEST_CHAIR', col: 1, row: 1 }],
};

test('a layout rebuild leaves the seat of a despawning agent free for the next one', () => {
  const os = new OfficeState(layout);
  os.addAgent(1, undefined, undefined, undefined, true);
  assert.equal(os.characters.get(1)!.seatId, 'chair');

  os.removeAgent(1);
  os.rebuildFromLayout(layout);
  os.addAgent(2, undefined, undefined, undefined, true);

  assert.equal(os.characters.get(2)!.seatId, 'chair');
});
