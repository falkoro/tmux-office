import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  OFFICE3D_CREW_SCALE,
  OFFICE3D_DEPTH_FORESHORTEN,
  OFFICE3D_ROSTER_LINE_DEPTH,
} from '../src/constants.js';
import type { OfficePlan, RoomSpot } from '../src/office3d/layout.js';
import { fitKey, planOffice, porchRosterColumns } from '../src/office3d/layout.js';
import type { DeskModel, PodModel, RoomModel } from '../src/office3d/model.js';
import { BACKGROUND_ROOM_ID, NO_PANE_POD_ID } from '../src/office3d/model.js';

const DESKTOP = 1600 / 900;
const PHONE = 390 / 844;

let nextId = 1;
function pod(id: string, desks: number, pinned = false): PodModel {
  return {
    id,
    title: id,
    pinned,
    hasOverseer: id !== NO_PANE_POD_ID,
    desks: Array.from({ length: desks }, (): DeskModel => ({
      agentId: nextId++,
      name: 'a',
      label: 'a',
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
    'work',
    pod('work-8', 1, true),
    ...[2, 1, 1, 5, 1, 2, 1].map((n, i) => pod(`work-${i + 1}`, n)),
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
        ['work', 'ops', 'scratch', BACKGROUND_ROOM_ID],
      );
      assert.equal(plan.rooms[0].pods.length, 8);
      assert.equal(plan.rooms[0].desks.length, 14);
    }
  });

  test('the plan names whether it was laid out for a narrow stage', () => {
    // A 1200x1000 window with the terminal panel open leaves a 660x1000 stage.
    assert.equal(planOffice(demo(), 660 / 1000).narrow, true);
    assert.equal(planOffice(demo(), 1200 / 1000).narrow, false);
    assert.equal(planOffice(demo(), 4 / 5).narrow, false);
  });

  test('the pinned pod sits front and centre in its room', () => {
    for (const aspect of [DESKTOP, PHONE]) {
      const work = planOffice(demo(), aspect).rooms[0];
      const pinned = work.pods.find((p) => p.pinned);
      assert.ok(pinned);
      assert.equal(pinned.id, 'work-8');
      assert.ok(Math.abs(pinned.x - work.x) < 1e-9, 'pinned pod is centred');
      assert.equal(pinned.z, front(work), 'pinned pod is in the front row');
      for (const other of work.pods) {
        if (other !== pinned) assert.ok(other.z < pinned.z, `${other.id} is behind the pinned pod`);
      }
    }
  });

  test('pods keep their order, back to front and left to right', () => {
    const work = planOffice(demo(), DESKTOP).rooms[0];
    const unpinned = work.pods.filter((p) => !p.pinned);
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

  test('every room reserves floor in front of its pods for the lines of its name list', () => {
    // office3d.css lays the list out two names per line on a phone, porchRosterColumns on a wide stage.
    for (const [aspect, perLine] of [
      [PHONE, () => 2],
      [DESKTOP, porchRosterColumns],
      [1366 / 768, porchRosterColumns],
    ] as const) {
      for (const r of planOffice(demo(), aspect).rooms) {
        const lines = Math.ceil(r.desks.length / perLine(r.width));
        const podsFront = Math.max(...r.pods.map((p) => p.z + p.depth / 2));
        const floor = r.z + r.depth / 2 - podsFront;
        assert.ok(floor >= lines * OFFICE3D_ROSTER_LINE_DEPTH - 1e-9, `${r.id} at ${aspect}`);
      }
    }
  });

  test('a lone desk is centred in its pod and its room', () => {
    const r = planOffice([room('a', pod('a', 1))], DESKTOP).rooms[0];
    assert.equal(r.desks[0].x, r.x);
    assert.equal(r.pods[0].x, r.x);
  });

  test('a session puts its overseer alone at the back and its smaller crew in front', () => {
    for (const aspect of [DESKTOP, PHONE]) {
      const p = planOffice([room('a', pod('a', 4))], aspect).rooms[0].pods[0];
      const [lead, ...crew] = p.desks;
      assert.ok(lead.overseer && crew.every((d) => !d.overseer));
      assert.equal(lead.x, p.x);
      assert.equal(lead.scale, 1);
      assert.ok(crew.every((d) => d.scale === OFFICE3D_CREW_SCALE && d.z > lead.z));
      assert.deepEqual(
        crew.map((d) => d.z),
        [crew[0].z, crew[0].z, crew[0].z],
      );
    }
  });

  test('agents without a pane have no overseer', () => {
    const p = planOffice([room(BACKGROUND_ROOM_ID, pod(NO_PANE_POD_ID, 3))], DESKTOP).rooms[0]
      .pods[0];
    assert.ok(p.desks.every((d) => !d.overseer && d.z === p.desks[0].z));
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
      assert.ok(
        grid.every((r) => r.desks.every((d) => d.scale === (d.overseer ? 1 : OFFICE3D_CREW_SCALE))),
      );
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

  test('a porch of many pods behind one small room widens instead of stacking', () => {
    const porchPods = Array.from({ length: 6 }, (_, i) => pod(`other-${i}`, 1));
    const plan = planOffice(
      [room('work', pod('work-1', 1)), room(BACKGROUND_ROOM_ID, ...porchPods)],
      DESKTOP,
    );
    assertSound(plan, 'wide porch');
    const [work, porch] = plan.rooms;
    assert.ok(porch.width > work.width);
    assert.ok(plan.width >= plan.depth * OFFICE3D_DEPTH_FORESHORTEN, 'not a strip on a wide view');
  });

  test('the porch reserves floor for its name list at the columns its width holds', () => {
    const porchPods = Array.from({ length: 6 }, (_, i) => pod(`other-${i}`, 1));
    const plan = planOffice(
      [room('work', pod('work-1', 1)), room(BACKGROUND_ROOM_ID, ...porchPods)],
      DESKTOP,
    );
    const porch = plan.rooms[1];
    const lines = Math.ceil(porch.desks.length / porchRosterColumns(porch.width));
    const floor = porch.z + porch.depth / 2 - Math.max(...porch.desks.map((d) => d.z));
    assert.ok(floor >= lines * OFFICE3D_ROSTER_LINE_DEPTH);
  });

  test('the porch alone sits at the origin', () => {
    const plan = planOffice([room(BACKGROUND_ROOM_ID, pod(':no-pane', 3))], DESKTOP);
    assert.equal(plan.rooms[0].x, 0);
    assert.equal(plan.rooms[0].z, 0);
    assert.equal(plan.depth, plan.rooms[0].depth);
  });
});

describe('fitKey', () => {
  test('changes when a session sorts ahead of the focused pod', () => {
    const focus = { kind: 'pod', id: 's-3' } as const;
    const before = planOffice([room('s', pod('s-3', 1), pod('s-5', 1))], DESKTOP);
    const after = planOffice([room('s', pod('s-1', 1), pod('s-3', 1))], DESKTOP);
    assert.notEqual(fitKey(after, focus), fitKey(before, focus));
  });

  test('holds while the focused pod drops out of the plan for a poll', () => {
    const focus = { kind: 'pod', id: 's-3' } as const;
    const gone = planOffice([room('s', pod('s-5', 1))], DESKTOP);
    assert.equal(fitKey(gone, focus), null);
    assert.notEqual(fitKey(gone, null), null);
  });
});
