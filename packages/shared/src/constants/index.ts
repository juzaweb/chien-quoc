import { BuildingBlueprint, BuildingType, Resources, UnitBlueprint, UnitType } from '../types/index.js';

export const TILE_WIDTH = 128;
export const TILE_HEIGHT = 64;

export const MAP_GRID_WIDTH = 220;
export const MAP_GRID_HEIGHT = 220;

export const SERVER_TICK_RATE = 20; // 20 ticks per second (50ms per tick)

/**
 * Upper bound on how many unit ids a single client command may reference.
 * Guards the authoritative handlers against a client sending thousands of ids
 * in one message to force unbounded per-tick work.
 */
export const MAX_SELECTION = 120;

/**
 * Upper bound on how many future waypoints one unit may hold. Shift+right click
 * appends without bound otherwise, and every waypoint is replicated state that
 * is persisted for the unit's lifetime.
 */
export const MAX_QUEUED_WAYPOINTS = 12;

/**
 * True when the building type produces units, i.e. when a rally point has any
 * meaning. Shared so the client (skip the order) and the authoritative room
 * (reject it) agree on which buildings accept `SET_RALLY_POINT` instead of each
 * carrying its own copy of the rule.
 */
export function canTrainUnitsAt(type: BuildingType): boolean {
  return (BUILDING_BLUEPRINTS[type]?.trainableUnits.length ?? 0) > 0;
}

export const INITIAL_PLAYER_RESOURCES: Resources = {
  wood: 300,
  food: 300,
  gold: 150,
  stone: 100
};

export const INITIAL_POPULATION_CAP = 10;
export const POPULATION_PER_HOUSE = 5;
export const MAX_POPULATION_LIMIT = 200;

export const BUILDING_BLUEPRINTS: Record<BuildingType, BuildingBlueprint> = {
  TOWN_CENTER: {
    type: 'TOWN_CENTER',
    name: 'Town Center',
    sizeX: 4,
    sizeY: 4,
    cost: { wood: 275, food: 0, gold: 0, stone: 100 },
    buildTimeMs: 15000,
    maxHp: 2400,
    populationProvided: 15,
    trainableUnits: ['VILLAGER'],
    attackPower: 0,
    attackRange: 0,
    attackCooldownMs: 0,
    dropOffs: ['wood', 'food', 'gold', 'stone'],
    description: 'The heart of your settlement. Trains villagers and provides core population.'
  },
  BARRACKS: {
    type: 'BARRACKS',
    name: 'Barracks',
    sizeX: 3,
    sizeY: 3,
    cost: { wood: 175, food: 0, gold: 0, stone: 0 },
    buildTimeMs: 10000,
    maxHp: 1200,
    populationProvided: 0,
    trainableUnits: ['SPEARMAN', 'ARCHER', 'CAVALRY'],
    attackPower: 0,
    attackRange: 0,
    attackCooldownMs: 0,
    dropOffs: [],
    description: 'Military facility used to recruit spearmen, archers, and cavalry.'
  },
  HOUSE: {
    type: 'HOUSE',
    name: 'House',
    sizeX: 2,
    sizeY: 2,
    cost: { wood: 50, food: 0, gold: 0, stone: 0 },
    buildTimeMs: 5000,
    maxHp: 450,
    populationProvided: 5,
    trainableUnits: [],
    attackPower: 0,
    attackRange: 0,
    attackCooldownMs: 0,
    dropOffs: [],
    description: 'Provides housing to support up to 5 additional population.'
  },
  FARM: {
    type: 'FARM',
    name: 'Farm',
    sizeX: 3,
    sizeY: 3,
    cost: { wood: 60, food: 0, gold: 0, stone: 0 },
    buildTimeMs: 6000,
    maxHp: 400,
    populationProvided: 0,
    trainableUnits: [],
    attackPower: 0,
    attackRange: 0,
    attackCooldownMs: 0,
    dropOffs: [],
    description: 'Renewable source of food for your population and military.'
  },
  TOWER: {
    type: 'TOWER',
    name: 'Watch Tower',
    sizeX: 1,
    sizeY: 1,
    cost: { wood: 50, food: 0, gold: 0, stone: 125 },
    buildTimeMs: 12000,
    maxHp: 1020,
    populationProvided: 0,
    trainableUnits: [],
    // SIM-03: 10 damage per 2s shot. Ten seconds to drop an unarmoured
    // villager, which is enough to matter without making a lone tower a wall.
    attackPower: 10,
    attackRange: 8,
    attackCooldownMs: 2000,
    dropOffs: [],
    description: 'Defensive structure that fires arrows at approaching enemy forces.'
  }
};

export const UNIT_BLUEPRINTS: Record<UnitType, UnitBlueprint> = {
  VILLAGER: {
    type: 'VILLAGER',
    name: 'Villager',
    cost: { wood: 0, food: 50, gold: 0, stone: 0 },
    trainTimeMs: 5000,
    maxHp: 50,
    speed: 2.2, // tiles per second
    attackPower: 3,
    attackRange: 1.2,
    attackCooldownMs: 1500,
    canHarvest: true,
    aggroRadius: 0,
    buildPower: 1,
    carryCapacity: 10,
    description: 'Gathers resources and constructs buildings for your empire.'
  },
  SPEARMAN: {
    type: 'SPEARMAN',
    name: 'Spearman',
    cost: { wood: 25, food: 50, gold: 0, stone: 0 },
    trainTimeMs: 7000,
    maxHp: 90,
    speed: 2.5,
    attackPower: 8,
    attackRange: 1.5,
    attackCooldownMs: 1200,
    canHarvest: false,
    aggroRadius: 6,
    buildPower: 0,
    carryCapacity: 0,
    description: 'Infantry unit equipped with spears, excellent against cavalry.'
  },
  ARCHER: {
    type: 'ARCHER',
    name: 'Archer',
    cost: { wood: 45, food: 0, gold: 40, stone: 0 },
    trainTimeMs: 8000,
    maxHp: 65,
    speed: 2.3,
    attackPower: 7,
    attackRange: 5.0,
    attackCooldownMs: 1400,
    canHarvest: false,
    aggroRadius: 6,
    buildPower: 0,
    carryCapacity: 0,
    description: 'Ranged unit capable of firing arrows from distance.'
  },
  CAVALRY: {
    type: 'CAVALRY',
    name: 'Cavalry',
    cost: { wood: 0, food: 80, gold: 70, stone: 0 },
    trainTimeMs: 10000,
    maxHp: 140,
    speed: 4.0,
    attackPower: 14,
    attackRange: 1.5,
    attackCooldownMs: 1000,
    canHarvest: false,
    aggroRadius: 6,
    buildPower: 0,
    carryCapacity: 0,
    description: 'Fast and powerful mounted warrior suited for hit-and-run tactics.'
  }
};

