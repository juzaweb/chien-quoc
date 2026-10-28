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

export enum NetworkMessage {
  PLACE_BUILDING = 'PLACE_BUILDING',
  MOVE_UNITS = 'MOVE_UNITS',
  TRAIN_UNIT = 'TRAIN_UNIT',
  ATTACK_TARGET = 'ATTACK_TARGET',
  HARVEST_RESOURCE = 'HARVEST_RESOURCE',
  ERROR_NOTIFICATION = 'ERROR_NOTIFICATION',
  SYSTEM_ANNOUNCEMENT = 'SYSTEM_ANNOUNCEMENT'
}

