import { BuildingBlueprint, BuildingType, Resources, UnitBlueprint, UnitType } from '../types/index.js';

export const TILE_WIDTH = 64;
export const TILE_HEIGHT = 32;

export const MAP_GRID_WIDTH = 220;
export const MAP_GRID_HEIGHT = 220;

export const SERVER_TICK_RATE = 20; // 20 ticks per second (50ms per tick)

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
    description: 'Fast and powerful mounted warrior suited for hit-and-run tactics.'
  }
};

