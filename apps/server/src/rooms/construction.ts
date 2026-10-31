import { MAP_GRID_HEIGHT, MAP_GRID_WIDTH, UNIT_BLUEPRINTS, UnitType } from '@chien-quoc/shared';
import type { MapSchema } from '@colyseus/schema';
import { BuildingState } from '../schema/BuildingState.js';
import { UnitState } from '../schema/UnitState.js';

/**
 * CMD-05: how far from a foundation's footprint edge a villager can stand and
 * still put work into it, in tiles. Generous enough that a builder stopped by
 * the approach point or pushed aside by another unit does not silently drop out
 * of the crew.
 */
const BUILD_RANGE = 1.5;

/**
 * Distance outside the footprint that builders are sent to, in tiles.
 *
 * Must stay well below `BUILD_RANGE`: the approach point can sit on a diagonal
 * corner (`hypot(d, d)` from the footprint, not `d`), and the unit stops up to
 * 0.15 tiles short of its target. At 1.0 the worst case is 1.56 > BUILD_RANGE,
 * which makes a builder flicker in and out of the crew; 0.5 keeps it at 0.86.
 */
const BUILD_APPROACH_DISTANCE = 0.5;

/** Distance from a unit to a building's footprint, in tiles; `0` when inside. */
function distanceToFootprint(unit: UnitState, building: BuildingState): number {
  const dx = Math.max(building.gridX - unit.x, 0, unit.x - (building.gridX + building.sizeX));
  const dy = Math.max(building.gridY - unit.y, 0, unit.y - (building.gridY + building.sizeY));
  return Math.hypot(dx, dy);
}

/** Whether a unit is close enough to the footprint to count as a builder. */
export function isWithinBuildRange(unit: UnitState, building: BuildingState): boolean {
  return distanceToFootprint(unit, building) <= BUILD_RANGE;
}

/**
 * Point on the ring `BUILD_APPROACH_DISTANCE` outside the footprint that this
 * builder should stand on.
 *
 * The ray runs from the building's centre through the unit, so builders fan out
 * around the site in the order they arrive. A unit standing exactly on the
 * centre (a foundation can be placed under one) gets a spread around the
 * building instead of a zero-length direction.
 */
export function getBuildApproachPoint(
  unit: UnitState,
  building: BuildingState,
  index: number,
  count: number
): { x: number; y: number } {
  const centerX = building.gridX + building.sizeX / 2;
  const centerY = building.gridY + building.sizeY / 2;

  let dirX = unit.x - centerX;
  let dirY = unit.y - centerY;
  if (Math.hypot(dirX, dirY) < 0.01) {
    const angle = (index / Math.max(1, count)) * Math.PI * 2;
    dirX = Math.cos(angle);
    dirY = Math.sin(angle);
  }

  // Project onto the rectangle grown by the approach distance: the largest
  // scale that keeps the ray inside that rectangle's border.
  const halfX = building.sizeX / 2 + BUILD_APPROACH_DISTANCE;
  const halfY = building.sizeY / 2 + BUILD_APPROACH_DISTANCE;
  const scale = 1 / Math.max(Math.abs(dirX) / halfX, Math.abs(dirY) / halfY);

  return {
    x: Math.max(0, Math.min(MAP_GRID_WIDTH - 1, centerX + dirX * scale)),
    y: Math.max(0, Math.min(MAP_GRID_HEIGHT - 1, centerY + dirY * scale))
  };
}

/**
 * Brings a foundation's crew roster back in line with the units and returns its
 * total build power.
 *
 * The units are the source of truth: `builderUnitIds` only mirrors them, so
 * anyone who walked away, finished, died or was given another order is dropped
 * here instead of needing a removal path in every command handler. Pruning is
 * part of the contract, which is why this is not a plain sum.
 */
export function syncBuilders(building: BuildingState, units: MapSchema<UnitState>): number {
  let power = 0;

  // Backwards, because entries are removed while iterating.
  for (let i = building.builderUnitIds.length - 1; i >= 0; i--) {
    const unit = units.get(building.builderUnitIds[i]);
    const stillWorking = !!unit && unit.actionState === 'BUILDING' && unit.targetEntityId === building.id;

    if (!unit || !stillWorking || !isWithinBuildRange(unit, building)) {
      building.builderUnitIds.splice(i, 1);
      continue;
    }

    power += UNIT_BLUEPRINTS[unit.type as UnitType]?.buildPower ?? 0;
  }

  return power;
}
