import { BUILDING_BLUEPRINTS, BuildingType, ResourceType } from '@chien-quoc/shared';
import { BuildingState } from '../schema/BuildingState.js';

/**
 * ECO-01: the resource a building yields when a villager works it, or `''` when
 * it yields none.
 *
 * One definition shared by the gather tick, the retarget scan and the code that
 * fills a finished building, so "which buildings hold a harvestable resource" is
 * answered the same way everywhere.
 */
export function gatheredType(building: BuildingState): ResourceType | '' {
  return BUILDING_BLUEPRINTS[building.type as BuildingType]?.gatheredResource ?? '';
}

/**
 * ECO-01: fills a gatherable building to its capacity.
 *
 * Called when a building finishes and when the world is restored: neither a
 * foundation nor a row read back from SQLite carries an amount, and a field that
 * came back empty would be permanently barren. Half-used fields refilling on
 * restart is the accepted cost of not migrating the table (see `99-backlog.md`).
 */
export function seedGatheredBuilding(building: BuildingState): void {
  const capacity = BUILDING_BLUEPRINTS[building.type as BuildingType]?.gatherCapacity;
  if (!gatheredType(building) || !capacity) return;

  building.resourceAmount = capacity;
  building.resourceCapacity = capacity;
}
