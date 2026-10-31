import { BuildingState } from '../schema/BuildingState.js';

/**
 * Distance in tiles from a point to a building's footprint rectangle, `0` when
 * the point is inside it.
 *
 * Range checks against buildings have to use the footprint rather than the
 * footprint's centre: a 4x4 Town Center's centre is 2 tiles inside its own walls,
 * so centre-based distance would put half the building outside its own range.
 */
export function distanceToFootprint(x: number, y: number, building: BuildingState): number {
  const dx = Math.max(building.gridX - x, 0, x - (building.gridX + building.sizeX));
  const dy = Math.max(building.gridY - y, 0, y - (building.gridY + building.sizeY));
  return Math.hypot(dx, dy);
}
