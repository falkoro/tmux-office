import assert from 'node:assert/strict';

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, test } from 'vitest';

import {
  OFFICE3D_DESK_HEIGHT,
  OFFICE3D_FLOOR_Y,
  OFFICE3D_WALK_EYE_Y,
  OFFICE3D_WALK_RUN,
  OFFICE3D_WALK_SPEED,
  OFFICE3D_WALL_HEIGHT,
} from '../src/constants.js';
import {
  CHARACTER_HEAD_HALF,
  CHARACTER_HEAD_Y,
  CHARACTER_HIP_Y,
  CHARACTER_SEAT_HEIGHT,
} from '../src/office3d/characters.js';
import type { WalkKeys } from '../src/office3d/walk.js';
import { stepWalk, walkDirection, walkFromCamera } from '../src/office3d/walk.js';

const bounds = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
const idle: WalkKeys = { forward: false, back: false, left: false, right: false, run: false };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

describe('stepWalk', () => {
  test('forward motion follows the yaw', () => {
    const dt = 0.5;
    const speed = OFFICE3D_WALK_SPEED * dt;
    const ahead: WalkKeys = { ...idle, forward: true };
    // A camera looks down -z; a positive yaw turns it left (counterclockwise seen from above).
    const expected: Array<[number, number, number]> = [
      [0, 0, -1],
      [Math.PI / 2, -1, 0],
      [-Math.PI / 2, 1, 0],
      [Math.PI, 0, 1],
      [Math.PI / 4, -Math.SQRT1_2, -Math.SQRT1_2],
    ];
    for (const [yaw, x, z] of expected) {
      const next = stepWalk({ x: 2, z: -3 }, yaw, ahead, dt, bounds);
      const step = Math.hypot(next.x - 2, next.z + 3);
      near((next.x - 2) / step, x);
      near((next.z + 3) / step, z);
    }
    const right = stepWalk({ x: 0, z: 0 }, 0, { ...idle, right: true }, dt, bounds);
    near(right.x, speed);
    near(right.z, 0);
  });

  test('diagonal speed is not faster than straight speed', () => {
    const dt = 0.4;
    const straight = stepWalk({ x: 0, z: 0 }, 0, { ...idle, forward: true }, dt, bounds);
    const diagonal = stepWalk(
      { x: 0, z: 0 },
      0,
      { ...idle, forward: true, right: true },
      dt,
      bounds,
    );
    near(Math.hypot(straight.x, straight.z), Math.hypot(diagonal.x, diagonal.z));
  });

  test('shift runs faster', () => {
    const dt = 0.4;
    const walk = stepWalk({ x: 0, z: 0 }, 0, { ...idle, forward: true }, dt, bounds);
    const run = stepWalk({ x: 0, z: 0 }, 0, { ...idle, forward: true, run: true }, dt, bounds);
    near(Math.hypot(run.x, run.z) / Math.hypot(walk.x, walk.z), OFFICE3D_WALK_RUN);
  });

  test('motion scales with elapsed seconds', () => {
    const yaw = 0.4;
    const keys: WalkKeys = { ...idle, forward: true };
    const once = stepWalk({ x: 0, z: 0 }, yaw, keys, 0.5, bounds);
    const half = stepWalk({ x: 0, z: 0 }, yaw, keys, 0.25, bounds);
    const twice = stepWalk(half, yaw, keys, 0.25, bounds);
    near(once.x, twice.x);
    near(once.z, twice.z);
  });

  test('the clamp holds', () => {
    const box = { minX: -1, maxX: 1, minZ: -2, maxZ: 2 };
    const pushed = stepWalk({ x: 0, z: 0 }, 0, { ...idle, forward: true, right: true }, 100, box);
    assert.equal(pushed.x, 1);
    assert.equal(pushed.z, -2);
    const outside = stepWalk({ x: 8, z: -8 }, 0, idle, 1, box);
    assert.equal(outside.x, 1);
    assert.equal(outside.z, -2);
  });
});

describe('walkFromCamera', () => {
  test('a camera taken over mid-glide behind the porch lands on the floor', () => {
    // An overview camera 25 m behind a floor that ends at z = 10, looking down into the rooms.
    const pose = walkFromCamera({ x: 3, z: 25 }, { x: 0, y: -0.6, z: -0.8 }, bounds);
    near(pose.x, 3);
    near(pose.z, bounds.maxZ);
    near(pose.yaw, 0);
    near(pose.pitch, Math.asin(-0.6));
  });

  test('a camera already on the floor keeps its spot', () => {
    const pose = walkFromCamera({ x: -4, z: 2 }, { x: -1, y: 0, z: 0 }, bounds);
    near(pose.x, -4);
    near(pose.z, 2);
    near(pose.yaw, Math.PI / 2);
    near(pose.pitch, 0);
  });
});

describe('walk aim', () => {
  test('lookAt of the walk direction matches the camera', () => {
    const camera = new PerspectiveCamera();
    const look = 4;
    const got = new Vector3();
    for (const yaw of [0, Math.PI / 2, -0.7]) {
      for (const pitch of [0, 0.4, -0.6]) {
        const dir = walkDirection(yaw, pitch);
        const eye = new Vector3(1, 2, 3);
        camera.position.copy(eye);
        camera.up.set(0, 1, 0);
        camera.lookAt(eye.x + dir.x * look, eye.y + dir.y * look, eye.z + dir.z * look);
        camera.updateMatrixWorld(true);
        camera.getWorldDirection(got);
        near(got.x, dir.x);
        near(got.y, dir.y);
        near(got.z, dir.z);
      }
    }
  });

  test('eye height sits a little above a seated overseer and over the desk', () => {
    const crown =
      OFFICE3D_FLOOR_Y +
      CHARACTER_SEAT_HEIGHT +
      (CHARACTER_HEAD_Y - CHARACTER_HIP_Y) +
      CHARACTER_HEAD_HALF;
    assert.equal(OFFICE3D_WALK_EYE_Y, crown + 0.15);
    assert.ok(OFFICE3D_WALK_EYE_Y > OFFICE3D_FLOOR_Y + OFFICE3D_DESK_HEIGHT);
    assert.ok(OFFICE3D_WALK_EYE_Y < OFFICE3D_FLOOR_Y + OFFICE3D_WALL_HEIGHT);
  });
});
