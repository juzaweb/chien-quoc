import type { Room } from '@colyseus/sdk';
import { BUILDING_BLUEPRINTS, BuildingType } from '@chien-quoc/shared';
import type * as Phaser from 'phaser';
import type { GridPoint, WorldPoint } from './pointer.js';

/**
 * The parts of WorldScene every hit test reads. Keeping it structural instead of
 * importing the scene class avoids a runtime import cycle between the scene and
 * its input modules.
 */
export interface HitTestScene {
  room: Room | null;
  mySessionId: string;
  unitSprites: Map<string, Phaser.GameObjects.Container>;
  buildingSprites: Map<string, Phaser.GameObjects.Container>;
  resourceSprites: Map<string, Phaser.GameObjects.Container>;
}

/**
 * `findUnitAt`/`findBuildingAt` take an owner filter that is either a session
 * id or the literal `'enemy'`. Resolving that here keeps both call sites from
 * re-implementing the comparison.
 */
export function ownerMatches(scene: HitTestScene, ownerId: string, filter: string): boolean {
  return filter === 'enemy' ? ownerId !== scene.mySessionId : ownerId === filter;
}

/**
 * Unit body ellipse in world coordinates, derived from the sprite sheet content
 * box and stored on the container at creation time. Every pointer interaction
 * (left-click, right-click, box-select) reads it from here, so they can never
 * disagree about where the unit actually is.
 */
export function getUnitBodyBox(container: Phaser.GameObjects.Container) {
  const centerY = container.y + ((container.getData('bodyOffsetY') as number) ?? -37);
  const radiusX = (container.getData('bodyRadiusX') as number) ?? 36;
  const radiusY = (container.getData('bodyRadiusY') as number) ?? 40;
  return { centerX: container.x, centerY, radiusX, radiusY };
}

export function hitTestUnit(
  worldX: number,
  worldY: number,
  container: Phaser.GameObjects.Container
): boolean {
  const { centerX, centerY, radiusX, radiusY } = getUnitBodyBox(container);
  const nx = (worldX - centerX) / radiusX;
  const ny = (worldY - centerY) / radiusY;
  return nx * nx + ny * ny <= 1;
}

/**
 * Topmost unit of `ownerFilter` under the pointer. Shared by right-click
 * targeting and the CMD-03 cursor so the two can never disagree about what the
 * pointer is over.
 */
export function findUnitAt(
  scene: HitTestScene,
  worldPoint: WorldPoint,
  ownerFilter?: string
): string | null {
  if (!scene.room) return null;
  let foundId: string | null = null;
  let foundDepth = -Infinity;
  scene.room.state.units.forEach((unit: any, uId: string) => {
    if (ownerFilter !== undefined && !ownerMatches(scene, unit.ownerId, ownerFilter)) return;
    const container = scene.unitSprites.get(uId);
    if (container && hitTestUnit(worldPoint.x, worldPoint.y, container) && container.depth > foundDepth) {
      foundId = uId;
      foundDepth = container.depth;
    }
  });
  return foundId;
}

/**
 * Building whose footprint contains `grid`. Ownership is the caller's filter:
 * right-click attacks foreign buildings, the cursor only cares that one is there.
 */
export function findBuildingAt(
  scene: HitTestScene,
  grid: GridPoint,
  ownerFilter?: string
): string | null {
  if (!scene.room) return null;
  let foundId: string | null = null;
  scene.room.state.buildings.forEach((b: any, bId: string) => {
    if (ownerFilter !== undefined && !ownerMatches(scene, b.ownerId, ownerFilter)) return;
    if (
      grid.gridX >= b.gridX &&
      grid.gridX < b.gridX + b.sizeX &&
      grid.gridY >= b.gridY &&
      grid.gridY < b.gridY + b.sizeY
    ) {
      foundId = bId;
    }
  });
  return foundId;
}

/**
 * CMD-05: id of one of the player's own unfinished buildings whose footprint
 * contains `grid`, or null. Builds on `findBuildingAt` so the pointer, the
 * cursor and the right-click order all agree on which building a click lands on.
 */
export function findOwnFoundationAt(scene: HitTestScene, grid: GridPoint): string | null {
  const buildingId = findBuildingAt(scene, grid, scene.mySessionId);
  if (!buildingId) return null;
  const building = scene.room?.state.buildings.get(buildingId);
  return building && !building.isConstructed ? buildingId : null;
}

/**
 * ECO-01: id of one of the player's own finished buildings that can be gathered
 * from (a farm), or null. Shares `findBuildingAt` so the right-click, the cursor
 * and the panel all agree on which building a click lands on.
 */
export function findOwnGatherableAt(scene: HitTestScene, grid: GridPoint): string | null {
  const buildingId = findBuildingAt(scene, grid, scene.mySessionId);
  if (!buildingId) return null;
  const building = scene.room?.state.buildings.get(buildingId);
  if (!building || !building.isConstructed) return null;
  const blueprint = BUILDING_BLUEPRINTS[building.type as BuildingType];
  return blueprint?.gatheredResource ? buildingId : null;
}

/** Resource node under the pointer: sprite distance first, then exact grid cell. */
export function findResourceAt(
  scene: HitTestScene,
  worldPoint: WorldPoint,
  grid: GridPoint
): string | null {
  if (!scene.room) return null;
  let foundId: string | null = null;
  scene.room.state.resourceNodes.forEach((res: any, resId: string) => {
    if (foundId) return;
    const resSprite = scene.resourceSprites.get(resId);
    if (resSprite) {
      const centerY = res.type === 'TREE' ? resSprite.y - 45 : resSprite.y - 18;
      if (Math.hypot(worldPoint.x - resSprite.x, worldPoint.y - centerY) < 38) {
        foundId = resId;
      }
    }
    if (!foundId && res.gridX === grid.gridX && res.gridY === grid.gridY) {
      foundId = resId;
    }
  });
  return foundId;
}
