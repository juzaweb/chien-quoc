import type * as Phaser from 'phaser';
import { screenToGrid } from '@chien-quoc/shared';

/** World-space point. Phaser camera coordinates, not screen pixels. */
export interface WorldPoint {
  x: number;
  y: number;
}

/** Grid-space tile coordinate. */
export interface GridPoint {
  gridX: number;
  gridY: number;
}

/**
 * Pointer position in world space. Every order, hit test and cursor decision
 * reads the pointer through this helper so they all agree on the point.
 */
export function pointerWorldPoint(
  camera: Phaser.Cameras.Scene2D.Camera,
  pointer: Phaser.Input.Pointer
): WorldPoint {
  const p = pointer.positionToCamera(camera) as Phaser.Math.Vector2;
  return { x: p.x, y: p.y };
}

/** Pointer position rounded down to the tile it is over. */
export function pointerWorldGrid(
  camera: Phaser.Cameras.Scene2D.Camera,
  pointer: Phaser.Input.Pointer
): GridPoint {
  const world = pointerWorldPoint(camera, pointer);
  return screenToGrid(world.x, world.y);
}
