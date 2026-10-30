export type ResourceType = 'wood' | 'food' | 'gold' | 'stone';

export interface Resources {
  wood: number;
  food: number;
  gold: number;
  stone: number;
}

export type BuildingType = 'TOWN_CENTER' | 'BARRACKS' | 'HOUSE' | 'FARM' | 'TOWER';

export type UnitType = 'VILLAGER' | 'SPEARMAN' | 'ARCHER' | 'CAVALRY';

export type ResourceNodeType = 'TREE' | 'GOLD_MINE' | 'STONE_MINE' | 'BERRY_BUSH';

export type UnitActionState = 'IDLE' | 'MOVING' | 'ATTACKING' | 'HARVESTING';

export interface BuildingBlueprint {
  type: BuildingType;
  name: string;
  sizeX: number;
  sizeY: number;
  cost: Resources;
  buildTimeMs: number;
  maxHp: number;
  populationProvided: number;
  trainableUnits: UnitType[];
  description: string;
}

export interface UnitBlueprint {
  type: UnitType;
  name: string;
  cost: Resources;
  trainTimeMs: number;
  maxHp: number;
  speed: number;
  attackPower: number;
  attackRange: number;
  attackCooldownMs: number;
  canHarvest: boolean;
  description: string;
}

export interface PlaceBuildingPayload {
  type: BuildingType;
  gridX: number;
  gridY: number;
}

export interface MoveUnitsPayload {
  unitIds: string[];
  targetGridX: number;
  targetGridY: number;
  /**
   * When true the waypoint is appended to the unit's queue instead of replacing
   * its current order, so it walks through every point in order (Shift+right
   * click). A non-queued move always clears whatever was queued.
   */
  queue?: boolean;
}

export interface TrainUnitPayload {
  buildingId: string;
  unitType: UnitType;
}

export interface AttackTargetPayload {
  unitIds: string[];
  targetEntityId: string;
  targetType: 'unit' | 'building';
}

export interface HarvestResourcePayload {
  unitIds: string[];
  resourceNodeId: string;
}

/**
 * Cancels whatever a unit is doing and leaves it standing where it is.
 * Unlike MOVE_UNITS this never makes the unit walk anywhere, so it is the only
 * way to halt mid-map (e.g. a villager halfway through a forest).
 */
export interface StopUnitsPayload {
  unitIds: string[];
}

/**
 * Sets the rally point of a building: freshly trained units walk there instead
 * of standing at the door. Grid coordinates are validated server-side against
 * the map bounds.
 */
export interface SetRallyPointPayload {
  buildingId: string;
  gridX: number;
  gridY: number;
}

/**
 * CMD-04a: drops the unit at the head of a building's training queue and
 * refunds its full cost. Only the building id is needed — the server reads the
 * cancelled unit from the queue itself, so the client cannot choose what to
 * refund.
 */
export interface CancelTrainPayload {
  buildingId: string;
}

/**
 * CMD-04b: tears down a foundation that was placed but not finished, refunding
 * part of its cost. Completed buildings are rejected by the server.
 */
export interface CancelBuildingPayload {
  buildingId: string;
}

export enum NetworkMessage {
  PLACE_BUILDING = 'PLACE_BUILDING',
  MOVE_UNITS = 'MOVE_UNITS',
  TRAIN_UNIT = 'TRAIN_UNIT',
  CANCEL_TRAIN = 'CANCEL_TRAIN',
  CANCEL_BUILDING = 'CANCEL_BUILDING',
  ATTACK_TARGET = 'ATTACK_TARGET',
  HARVEST_RESOURCE = 'HARVEST_RESOURCE',
  STOP_UNITS = 'STOP_UNITS',
  SET_RALLY_POINT = 'SET_RALLY_POINT',
  ERROR_NOTIFICATION = 'ERROR_NOTIFICATION',
  SYSTEM_ANNOUNCEMENT = 'SYSTEM_ANNOUNCEMENT'
}

