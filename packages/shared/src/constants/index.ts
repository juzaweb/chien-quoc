import {
  BuildingBlueprint,
  BuildingType,
  Resources,
  UnitBlueprint,
  UnitStance,
  UnitType
} from '../types/index.js';

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

/**
 * CMB-01: cycle order for the stance hotkey, from most to least aggressive.
 *
 * Shared so the client's cycling and the server's validation agree on what a
 * legal stance is: a stance not in this list is rejected instead of being
 * silently stored and then ignored by the combat system.
 */
export const UNIT_STANCES: readonly UnitStance[] = [
  'AGGRESSIVE',
  'DEFENSIVE',
  'STAND_GROUND',
  'NO_ATTACK'
];

/**
 * Next stance in the cycle. An unknown current value (a snapshot from an older
 * server, an empty field) restarts the cycle at `AGGRESSIVE` rather than
 * returning `undefined`.
 */
export function nextUnitStance(current: string): UnitStance {
  const index = UNIT_STANCES.indexOf(current as UnitStance);
  if (index === -1) return UNIT_STANCES[0];
  return UNIT_STANCES[(index + 1) % UNIT_STANCES.length];
}

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
    // ECO-03: the house is the one building whose capacity is a shared constant,
    // so the number the HUD promises and the number the blueprint grants cannot
    // drift apart.
    populationProvided: POPULATION_PER_HOUSE,
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
    // ECO-01: a farm is a source, not a drop-off. Villagers harvest it in place,
    // and a villager who empties it re-plants it for the farm's own cost.
    gatheredResource: 'food',
    gatherCapacity: 250,
    description: 'Renewable source of food. Villagers harvest it in place and re-sow it when it runs dry.'
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
  },
  // ECO: the three drop-off buildings. All three cost the same 100 wood and take
  // the same 6s / 600 HP, so the choice between them is purely positional — where
  // the villager walks, not which building is "better". Only `dropOffs` differs,
  // and it is what tells the economy system which loads each one accepts.
  LUMBER_CAMP: {
    type: 'LUMBER_CAMP',
    name: 'Lumber Camp',
    sizeX: 2,
    sizeY: 2,
    cost: { wood: 100, food: 0, gold: 0, stone: 0 },
    buildTimeMs: 6000,
    maxHp: 600,
    populationProvided: 0,
    trainableUnits: [],
    attackPower: 0,
    attackRange: 0,
    attackCooldownMs: 0,
    dropOffs: ['wood'],
    description: 'Wood drop-off. Villagers haul logs here instead of walking back to the Town Center.'
  },
  MILL: {
    type: 'MILL',
    name: 'Mill',
    sizeX: 2,
    sizeY: 2,
    cost: { wood: 100, food: 0, gold: 0, stone: 0 },
    buildTimeMs: 6000,
    maxHp: 600,
    populationProvided: 0,
    trainableUnits: [],
    attackPower: 0,
    attackRange: 0,
    attackCooldownMs: 0,
    dropOffs: ['food'],
    description: 'Food drop-off. Berries and farm harvests are delivered here.'
  },
  MINING_CAMP: {
    type: 'MINING_CAMP',
    name: 'Mining Camp',
    sizeX: 2,
    sizeY: 2,
    cost: { wood: 100, food: 0, gold: 0, stone: 0 },
    buildTimeMs: 6000,
    maxHp: 600,
    populationProvided: 0,
    trainableUnits: [],
    attackPower: 0,
    attackRange: 0,
    attackCooldownMs: 0,
    // One camp serves both mine types: a gold mine and a stone mine close
    // enough to share a drop-off is a common map layout, and charging twice for
    // it would just make the player pick the worse of the two spots.
    dropOffs: ['gold', 'stone'],
    description: 'Gold and stone drop-off. Serves both mine types from one spot.'
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

