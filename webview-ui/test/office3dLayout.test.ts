import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import { OFFICE3D_ROSTER_LINE_DEPTH } from '../src/constants.js';
import type { OfficePlan, RoomSpot } from '../src/office3d/layout.js';
import { planOffice } from '../src/office3d/layout.js';
import type { DeskModel, PodModel, RoomModel } from '../src/office3d/model.js';
import { BACKGROUND_ROOM_ID } from '../src/office3d/model.js';

const DESKTOP = 1600 / 900;
const PHONE = 390 / 844;

let nextId = 1;
function pod(id: string, desks: number, pinned = false): PodModel {
  return {
    id,
    title: id,
    pinned,
    desks: Array.from({ length: desks }, (): DeskModel => ({
      agentId: nextId++,
      name: 'a',
      pane: null,
      status: 'idle',
      tool: null,
      contextRatio: 0,
      helpers: [],
    })),
  };
}

const room = (id: string, ...pods: PodModel[]): RoomModel => ({ id, title: id, pods });
const rooms = (count: number, desks = 2): RoomModel[] =>
  Array.from({ length: count }, (_, i) => room(`r${i}`, pod(`r${i}`, desks)));

/** The demo rig: eight sessions in one room with the last pinned, two lone rooms, one porch agent. */
const demo = (): RoomModel[] => [
  room(
    'emperor',
    pod('emperor-8', 1, true),
    ...[2, 1, 1, 5, 1, 2, 1].map((n, i) => pod(`emperor-${i + 1}`, n)),
  ),
  room('ops', pod('ops', 1)),
  room('scratch', pod('scratch', 1)),
  room(BACKGROUND_ROOM_ID, pod(':no-pane', 1)),
];

interface Box {
  x: number;
  z: number;
  width: number;
  depth: number;
}

const apart = (a: Box, b: Box): boolean =>
  Math.abs(a.x - b.x) >= (a.width + b.width) / 2 - 1e-9 ||
  Math.abs(a.z - b.z) >= (a.depth + b.depth) / 2 - 1e-9;

const inside = (inner: Box, outer: Box): boolean =>
  inner.x - inner.width / 2 >= outer.x - outer.width / 2 - 1e-9 &&
  inner.x + inner.width / 2 <= outer.x + outer.width / 2 + 1e-9 &&
  inner.z - inner.depth / 2 >= outer.z - outer.depth / 2 - 1e-9 &&
  inner.z + inner.depth / 2 <= outer.z + outer.depth / 2 + 1e-9;

/** Every invariant a plan must hold, whatever went in. */
function assertSound(plan: OfficePlan, label: string): void {
  plan.rooms.forEach((a, i) =>
    plan.rooms.forEach((b, j) => {
      if (i < j) assert.ok(apart(a, b), `${label}: rooms ${a.id} and ${b.id} overlap`);
    }),
  );
  const spots = new Set<string>();
  for (const r of plan.rooms) {
    assert.ok(
      inside(r, { x: 0, z: 0, width: plan.width, depth: plan.depth }),
      `${label}: ${r.id} outside the plan`,
    );
    r.pods.forEach((a, i) => {
      assert.ok(inside(a, r), `${label}: pod ${a.id} outside room ${r.id}`);
      r.pods.forEach((b, j) => {
        if (i < j) assert.ok(apart(a, b), `${label}: pods ${a.id} and ${b.id} overlap`);
      });
      for (const d of a.desks) {
        assert.ok(Math.abs(d.x - a.x) < a.width / 2, `${label}: desk x outside pod ${a.id}`);
        assert.ok(Math.abs(d.z - a.z) < a.depth / 2, `${label}: desk z outside pod ${a.id}`);
        const key = `${d.x.toFixed(3)},${d.z.toFixed(3)}`;
        assert.ok(!spots.has(key), `${label}: two desks share ${key}`);
        spots.add(key);
      }
    });
    assert.equal(
      r.desks.length,
      r.pods.reduce((n, p) => n + p.desks.length, 0),
    );
  }
}

const front = (r: RoomSpot) => Math.max(...r.pods.map((p) => p.z));

describe('planOffice', () => {
  test('one room sits at the origin', () => {
    const plan = planOffice(rooms(1), DESKTOP);
    assert.equal(plan.columns, 1);
    assert.equal(plan.rooms[0].x, 0);
    assert.equal(plan.rooms[0].z, 0);
  });

  test('the demo rig plans soundly on a desktop and a phone', () => {
    for (const aspect of [DESKTOP, PHONE]) {
      const plan = planOffice(demo(), aspect);
      assertSound(plan, `demo at ${aspect.toFixed(2)}`);
      assert.deepEqual(
        plan.rooms.map((r) => r.id),
        ['emperor', 'ops', 'scratch', BACKGROUND_ROOM_ID],
      );
      assert.equal(plan.rooms[0].pods.length, 8);
      assert.equal(plan.rooms[0].desks.length, 14);
    }
  });

  test('the pinned pod sits front and centre in its room', () => {
    for (const aspect of [DESKTOP, PHONE]) {
      const emperor = planOffice(demo(), aspect).rooms[0];
      const pinned = emperor.pods.find((p) => p.pinned);
      assert.ok(pinned);
      assert.equal(pinned.id, 'emperor-8');
      assert.ok(Math.abs(pinned.x - emperor.x) < 1e-9, 'pinned pod is centred');
      assert.equal(pinned.z, front(emperor), 'pinned pod is in the front row');
      for (const other of emperor.pods) {
        if (other !== pinned) assert.ok(other.z < pinned.z, `${other.id} is behind the pinned pod`);
      }
    }
  });

  test('pods keep their order, back to front and left to right', () => {
    const emperor = planOffice(demo(), DESKTOP).rooms[0];
    const unpinned = emperor.pods.filter((p) => !p.pinned);
    for (let i = 1; i < unpinned.length; i++) {
      const [a, b] = [unpinned[i - 1], unpinned[i]];
      const [fa, fb] = [a.z + a.depth / 2, b.z + b.depth / 2];
      assert.ok(fb > fa + 1e-9 || (Math.abs(fb - fa) < 1e-9 && b.x > a.x), `${a.id} → ${b.id}`);
    }
  });

  test('a room shapes itself to the viewport', () => {
    const one = [room('r', ...Array.from({ length: 8 }, (_, i) => pod(`p${i}`, 2)))];
    const wide = planOffice(one, DESKTOP).rooms[0];
    const tall = planOffice(one, PHONE).rooms[0];
    assert.ok(wide.width / wide.depth > tall.width / tall.depth);
  });

  test('1 to 8 pods and 1 to 12 rooms plan soundly at both aspects', () => {
    for (let pods = 1; pods <= 8; pods++) {
      for (const count of [1, 2, 5, 12]) {
        for (const aspect of [DESKTOP, PHONE, 1]) {
          const office = Array.from({ length: count }, (_, r) =>
            room(
              `r${r}`,
              ...Array.from({ length: pods }, (_, p) =>
                pod(`r${r}p${p}`, 1 + ((p + r) % 4), p === 3),
              ),
            ),
          );
          const plan = planOffice(office, aspect);
          assert.equal(plan.rooms.length, count);
          assert.ok(plan.rooms.every((r) => r.pods.length === pods));
          assertSound(plan, `${count} rooms of ${pods} pods at ${aspect.toFixed(2)}`);
        }
      }
    }
  });

  test('a room of twenty desks fits one pod and many', () => {
    for (const aspect of [DESKTOP, PHONE]) {
      const big = planOffice([room('big', pod('big', 20))], aspect);
      assertSound(big, 'one pod of twenty');
      assert.equal(big.rooms[0].desks.length, 20);
      const many = planOffice(
        [room('many', ...[6, 5, 4, 3, 2].map((n, i) => pod(`p${i}`, n, i === 2)))],
        aspect,
      );
      assertSound(many, 'twenty over five pods');
      assert.equal(many.rooms[0].desks.length, 20);
    }
  });

  test('a wide viewport gets more columns than a phone', () => {
    const wide = planOffice(rooms(8), DESKTOP);
    const phone = planOffice(rooms(8), PHONE);
    assert.ok(wide.columns > phone.columns, `${wide.columns} vs ${phone.columns}`);
  });

  test('a short last row of rooms is centred under the full rows', () => {
    const plan = planOffice(rooms(5), DESKTOP);
    const rows = new Map<number, RoomSpot[]>();
    for (const r of plan.rooms) {
      const top = Number((r.z - r.depth / 2).toFixed(6));
      rows.set(top, [...(rows.get(top) ?? []), r]);
    }
    const last = [...rows.values()].at(-1) ?? [];
    const left = Math.min(...last.map((r) => r.x - r.width / 2));
    const right = Math.max(...last.map((r) => r.x + r.width / 2));
    assert.ok(Math.abs(left + right) < 1e-9);
  });

  test('a narrow viewport adds front floor for each room name list', () => {
    const wide = planOffice(rooms(4, 2), DESKTOP).rooms[0];
    const phone = planOffice(rooms(4, 2), PHONE).rooms[0];
    const frontFloor = (r: RoomSpot) => r.z + r.depth / 2 - (front(r) + r.pods[0].depth / 2);
    assert.ok(frontFloor(phone) - frontFloor(wide) >= OFFICE3D_ROSTER_LINE_DEPTH - 1e-9);
  });

  test('a lone desk is centred in its pod and its room', () => {
    const r = planOffice([room('a', pod('a', 1))], DESKTOP).rooms[0];
    assert.equal(r.desks[0].x, r.x);
    assert.equal(r.pods[0].x, r.x);
  });

  test('an empty office and an empty room still plan', () => {
    assert.deepEqual(planOffice([], 1).rooms, []);
    const plan = planOffice([room('empty'), ...rooms(2)], DESKTOP);
    assertSound(plan, 'empty room');
    assert.ok(plan.rooms[0].width > 0 && plan.rooms[0].depth > 0);
  });

  test('the background is a porch of smaller desks behind the rooms', () => {
    for (const aspect of [PHONE, DESKTOP]) {
      const plan = planOffice([...rooms(8), room(BACKGROUND_ROOM_ID, pod(':no-pane', 11))], aspect);
      assertSound(plan, `porch at ${aspect.toFixed(2)}`);
      const porch = plan.rooms[plan.rooms.length - 1];
      const grid = plan.rooms.slice(0, -1);
      assert.equal(porch.id, BACKGROUND_ROOM_ID);
      assert.ok(porch.background);
      assert.ok(grid.every((r) => r.z - r.depth / 2 > porch.z + porch.depth / 2));
      assert.equal(porch.width, plan.width);
      assert.ok(porch.desks.every((d) => d.scale < 1));
      assert.ok(grid.every((r) => r.desks.every((d) => d.scale === 1)));
    }
  });

  test('the porch deepens for its wrapped name list', () => {
    const frontFloor = (count: number) => {
      const plan = planOffice(
        [...rooms(4), room(BACKGROUND_ROOM_ID, pod(':no-pane', count))],
        16 / 9,
      );
      const porch = plan.rooms[plan.rooms.length - 1];
      return porch.z + porch.depth / 2 - Math.max(...porch.desks.map((d) => d.z));
    };
    assert.ok(frontFloor(11) - frontFloor(1) > OFFICE3D_ROSTER_LINE_DEPTH / 2);
  });

  test('the porch alone sits at the origin', () => {
    const plan = planOffice([room(BACKGROUND_ROOM_ID, pod(':no-pane', 3))], DESKTOP);
    assert.equal(plan.rooms[0].x, 0);
    assert.equal(plan.rooms[0].z, 0);
    assert.equal(plan.depth, plan.rooms[0].depth);
  });
});
