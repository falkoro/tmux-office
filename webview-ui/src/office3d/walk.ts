/**
 * First-person walking on the floor plane.
 * Yaw 0 looks down -z, into the rooms. Positive yaw turns counter-clockwise
 * from above, matching a camera's rotation.y, so aiming with lookAt and moving
 * here cannot disagree.
 */

import { OFFICE3D_WALK_RUN, OFFICE3D_WALK_SPEED, OFFICE3D_WALK_TILT } from '../constants.js';

export interface WalkPos {
  x: number;
  z: number;
}

export interface WalkKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  run: boolean;
}

/** Walkable rectangle on the floor. The caller insets it by the margin. */
export interface FloorBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const NO_WALK_KEYS: WalkKeys = {
  forward: false,
  back: false,
  left: false,
  right: false,
  run: false,
};

/** Horizontal facing. Yaw 0 is −z. */
export function walkForward(yaw: number): WalkPos {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/** Look direction. Positive pitch looks up. The floor part is walkForward. */
export function walkDirection(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const fwd = walkForward(yaw);
  const horiz = Math.cos(pitch);
  return { x: fwd.x * horiz, y: Math.sin(pitch), z: fwd.z * horiz };
}

/** Inverse of walkForward for a camera direction projected on the floor. */
export function walkYaw(x: number, z: number): number {
  return Math.atan2(-x, -z);
}

function clamp(value: number, min: number, max: number): number {
  if (min > max) return (min + max) / 2;
  return Math.min(max, Math.max(min, value));
}

/**
 * Next position after `dt` seconds. Diagonal input is normalised, so it is not
 * faster than walking straight. Movement stays on the floor and inside `bounds`.
 */
export function stepWalk(
  position: WalkPos,
  yaw: number,
  keys: WalkKeys,
  dt: number,
  bounds: FloorBounds,
): WalkPos {
  const strafe = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const ahead = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const len = Math.hypot(strafe, ahead);
  let x = position.x;
  let z = position.z;
  if (len > 0 && dt > 0) {
    const speed = OFFICE3D_WALK_SPEED * (keys.run ? OFFICE3D_WALK_RUN : 1);
    const scale = (speed * dt) / len;
    const fwd = walkForward(yaw);
    // right = forward × up = (-fwd.z, fwd.x). Yaw 0 gives (1, 0).
    x += (fwd.x * ahead + -fwd.z * strafe) * scale;
    z += (fwd.z * ahead + fwd.x * strafe) * scale;
  }
  // ponytail: clamp to the floor rectangle only; walking stops for desks once the merged furniture has a collider.
  return { x: clamp(x, bounds.minX, bounds.maxX), z: clamp(z, bounds.minZ, bounds.maxZ) };
}

/**
 * The walker pose a camera hands over, for example mid-glide. The camera may
 * still be off the floor, so the position is clamped into `bounds`.
 */
export function walkFromCamera(
  position: WalkPos,
  direction: { x: number; y: number; z: number },
  bounds: FloorBounds,
): WalkPos & { yaw: number; pitch: number } {
  const yaw = walkYaw(direction.x, direction.z);
  const tilt = OFFICE3D_WALK_TILT;
  const pitch = clamp(Math.asin(clamp(direction.y, -1, 1)), -tilt, tilt);
  return { ...stepWalk(position, yaw, NO_WALK_KEYS, 0, bounds), yaw, pitch };
}
