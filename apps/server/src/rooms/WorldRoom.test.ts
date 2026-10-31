import { describe, expect, it, vi } from 'vitest';
import {
  BUILDING_BLUEPRINTS,
  MAP_GRID_WIDTH,
  MAX_SELECTION,
  NetworkMessage,
  UNIT_BLUEPRINTS
} from '@chien-quoc/shared';
import { WorldRoom } from './WorldRoom.js';
import { WorldState } from '../schema/WorldState.js';
import { PlayerState } from '../schema/PlayerState.js';
import { BuildingState } from '../schema/BuildingState.js';
import { UnitState } from '../schema/UnitState.js';
import { ResourceNodeState } from '../schema/ResourceNodeState.js';

/**
 * These tests drive `WorldRoom` without `onCreate()`: that method wires the
 * simulation interval, the 30 s autosave and SQLite restore, none of which a
 * handler or a tick assertion needs. The room's own field initialisers already
 * build every map the handlers touch, so a bare instance plus a fresh
 * `WorldState` is the whole harness and a test calls `update()` by hand.
 */
type TestClient = { sessionId: string; send: ReturnType<typeof vi.fn> };

function createRoom() {
  const room = new WorldRoom();
  room.setState(new WorldState());
  return room;
}

/**
 * The command handlers and the tick are private. The tests call them the way
 * `onMessage` and the simulation interval do, so the escape hatch stays in one
 * place instead of being scattered through the file.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = (room: WorldRoom) => room as any;

function createClient(sessionId: string): TestClient {
  return { sessionId, send: vi.fn() };
}

function addPlayer(room: WorldRoom, sessionId: string, overrides: Partial<PlayerState> = {}) {
  const player = new PlayerState();
  player.id = sessionId;
  player.name = sessionId;
  Object.assign(player, overrides);
  room.state.players.set(sessionId, player);
  return player;
}

function addUnit(
  room: WorldRoom,
  options: {
    id: string;
    ownerId: string;
    type?: string;
    x?: number;
    y?: number;
    actionState?: string;
  }
) {
  const { id, ownerId, type = 'VILLAGER', x = 10, y = 10, actionState = 'IDLE' } = options;
  const blueprint = UNIT_BLUEPRINTS[type as keyof typeof UNIT_BLUEPRINTS];

  const unit = new UnitState();
  unit.id = id;
  unit.ownerId = ownerId;
  unit.type = type;
  unit.x = x;
  unit.y = y;
  unit.targetX = x;
  unit.targetY = y;
  unit.speed = blueprint.speed;
  unit.hp = blueprint.maxHp;
  unit.maxHp = blueprint.maxHp;
  unit.actionState = actionState;
  room.state.units.set(id, unit);
  return unit;
}

function addBuilding(
  room: WorldRoom,
  options: {
    id: string;
    ownerId: string;
    type?: string;
    gridX?: number;
    gridY?: number;
    isConstructed?: boolean;
  }
) {
  const {
    id,
    ownerId,
    type = 'TOWN_CENTER',
    gridX = 40,
    gridY = 40,
    isConstructed = true
  } = options;
  const blueprint = BUILDING_BLUEPRINTS[type as keyof typeof BUILDING_BLUEPRINTS];

  const building = new BuildingState();
  building.id = id;
  building.ownerId = ownerId;
  building.type = type;
  building.gridX = gridX;
  building.gridY = gridY;
  building.sizeX = blueprint.sizeX;
  building.sizeY = blueprint.sizeY;
  building.maxHp = blueprint.maxHp;
  building.hp = isConstructed ? blueprint.maxHp : 1;
  building.isConstructed = isConstructed;
  building.constructionProgress = isConstructed ? 100 : 0;
  room.state.buildings.set(id, building);
  return building;
}

function addResource(
  room: WorldRoom,
  options: { id: string; resourceType?: string; gridX?: number; gridY?: number; remainingAmount?: number }
) {
  const { id, resourceType = 'wood', gridX = 50, gridY = 50, remainingAmount = 100 } = options;
  const node = new ResourceNodeState();
  node.id = id;
  node.type = resourceType === 'wood' ? 'TREE' : 'GOLD_MINE';
  node.resourceType = resourceType;
  node.gridX = gridX;
  node.gridY = gridY;
  node.remainingAmount = remainingAmount;
  node.maxAmount = remainingAmount;
  room.state.resourceNodes.set(id, node);
  return node;
}

describe('handleMoveUnits', () => {
  it('ignores units the client does not own', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    const foreign = addUnit(room, { id: 'u_1', ownerId: 'player-b', x: 12, y: 12 });
    const clientA = createClient('player-a');

    internals(room).commands.handleMoveUnits(clientA, { unitIds: ['u_1'], targetGridX: 60, targetGridY: 60 });

    expect(foreign.actionState).toBe('IDLE');
    expect(foreign.targetX).toBe(12);
    expect(foreign.targetY).toBe(12);
  });

  it('rejects a command that exceeds MAX_SELECTION', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    const clientA = createClient('player-a');
    const unitIds = Array.from({ length: MAX_SELECTION + 1 }, (_, i) => `u_${i}`);

    internals(room).commands.handleMoveUnits(clientA, { unitIds, targetGridX: 60, targetGridY: 60 });

    expect(clientA.send).toHaveBeenCalledWith(NetworkMessage.ERROR_NOTIFICATION, {
      message: 'Too many units in one command'
    });
  });
});

describe('handleAttackTarget', () => {
  it('rejects a friendly target', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    const own = addUnit(room, { id: 'u_1', ownerId: 'player-a' });
    const clientA = createClient('player-a');

    internals(room).commands.handleAttackTarget(clientA, {
      unitIds: ['u_1'],
      targetEntityId: 'u_1',
      targetType: 'unit'
    });

    expect(clientA.send).toHaveBeenCalledWith(NetworkMessage.ERROR_NOTIFICATION, {
      message: 'Cannot attack your own units or buildings'
    });
    expect(own.actionState).toBe('IDLE');
    expect(own.targetEntityId).toBe('');
  });

  it('starts attacking an enemy unit and drops queued waypoints', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    const attacker = addUnit(room, { id: 'u_1', ownerId: 'player-a', type: 'SPEARMAN' });
    const enemy = addUnit(room, { id: 'u_2', ownerId: 'player-b', x: 20, y: 10 });
    attacker.queueTargetX.push(99);
    attacker.queueTargetY.push(99);

    internals(room).commands.handleAttackTarget(createClient('player-a'), {
      unitIds: ['u_1'],
      targetEntityId: 'u_2',
      targetType: 'unit'
    });

    expect(attacker.actionState).toBe('ATTACKING');
    expect(attacker.targetEntityId).toBe('u_2');
    expect(attacker.queueTargetX.length).toBe(0);
  });
});

describe('handleTrainUnit', () => {
  it('deducts the blueprint cost and queues the unit', () => {
    const room = createRoom();
    const player = addPlayer(room, 'player-a', { food: 500 });
    addBuilding(room, { id: 'b_1', ownerId: 'player-a', type: 'TOWN_CENTER' });
    const woodBefore = player.wood;

    internals(room).commands.handleTrainUnit(createClient('player-a'), {
      buildingId: 'b_1',
      unitType: 'VILLAGER'
    });

    const cost = UNIT_BLUEPRINTS.VILLAGER.cost;
    expect(player.food).toBe(500 - cost.food);
    expect(player.wood).toBe(woodBefore - cost.wood);
    expect(room.state.buildings.get('b_1')!.trainingQueue.length).toBe(1);
    expect(room.state.buildings.get('b_1')!.trainingQueue[0]).toBe('VILLAGER');
  });

  it('refuses the order when resources are short and charges nothing', () => {
    const room = createRoom();
    const player = addPlayer(room, 'player-a', { food: 10 });
    addBuilding(room, { id: 'b_1', ownerId: 'player-a', type: 'TOWN_CENTER' });
    const clientA = createClient('player-a');

    internals(room).commands.handleTrainUnit(clientA, { buildingId: 'b_1', unitType: 'VILLAGER' });

    expect(clientA.send).toHaveBeenCalledWith(NetworkMessage.ERROR_NOTIFICATION, {
      message: 'Insufficient resources to train unit'
    });
    expect(player.food).toBe(10);
    expect(room.state.buildings.get('b_1')!.trainingQueue.length).toBe(0);
  });
});

describe('handlePlaceBuilding', () => {
  it('refuses to build on top of an existing building and charges nothing', () => {
    const room = createRoom();
    const player = addPlayer(room, 'player-a', { wood: 500 });
    addBuilding(room, { id: 'b_1', ownerId: 'player-a', type: 'TOWN_CENTER', gridX: 40, gridY: 40 });
    const clientA = createClient('player-a');
    const buildingsBefore = room.state.buildings.size;

    internals(room).commands.handlePlaceBuilding(clientA, { type: 'HOUSE', gridX: 41, gridY: 41 });

    expect(clientA.send).toHaveBeenCalledWith(NetworkMessage.ERROR_NOTIFICATION, {
      message: 'Placement obstructed by existing structure or resource'
    });
    expect(room.state.buildings.size).toBe(buildingsBefore);
    expect(player.wood).toBe(500);
  });

  it('refuses to build off the map', () => {
    const room = createRoom();
    const player = addPlayer(room, 'player-a', { wood: 500 });
    const clientA = createClient('player-a');

    internals(room).commands.handlePlaceBuilding(clientA, {
      type: 'HOUSE',
      gridX: MAP_GRID_WIDTH - 1,
      gridY: 10
    });

    expect(clientA.send).toHaveBeenCalledWith(NetworkMessage.ERROR_NOTIFICATION, {
      message: 'Cannot build outside map bounds'
    });
    expect(player.wood).toBe(500);
  });
});

describe('update', () => {
  it('turns a MOVING unit that reached its target IDLE', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    const unit = addUnit(room, { id: 'u_1', ownerId: 'player-a', x: 10, y: 10, actionState: 'MOVING' });
    unit.targetX = 10.1;
    unit.targetY = 10;

    internals(room).update(100);

    expect(unit.actionState).toBe('IDLE');
    expect(unit.x).toBe(10);
  });

  it('advances a MOVING unit by speed * deltaTime', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    const unit = addUnit(room, { id: 'u_1', ownerId: 'player-a', x: 10, y: 10, actionState: 'MOVING' });
    unit.targetX = 50;
    unit.targetY = 10;

    internals(room).update(1000);

    expect(unit.x).toBeCloseTo(10 + UNIT_BLUEPRINTS.VILLAGER.speed, 5);
    expect(unit.actionState).toBe('MOVING');
  });

  it('finishes a foundation after buildTimeMs of one villager working', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    const foundation = addBuilding(room, {
      id: 'b_1',
      ownerId: 'player-a',
      type: 'HOUSE',
      gridX: 40,
      gridY: 40,
      isConstructed: false
    });

    // Standing just outside the 2x2 footprint, signed up to the site.
    const builder = addUnit(room, { id: 'u_1', ownerId: 'player-a', x: 42.2, y: 41, actionState: 'BUILDING' });
    builder.targetEntityId = 'b_1';
    builder.targetEntityType = 'building';

    const buildTimeMs = BUILDING_BLUEPRINTS.HOUSE.buildTimeMs;
    const tickMs = 100;

    // The building pass runs before the unit pass, so the first tick only fills
    // the crew roster and work starts on the second one.
    internals(room).update(tickMs);
    expect(foundation.constructionProgress).toBe(0);

    for (let elapsed = tickMs; elapsed < buildTimeMs; elapsed += tickMs) {
      internals(room).update(tickMs);
      expect(foundation.isConstructed).toBe(false);
    }

    internals(room).update(tickMs);

    expect(foundation.isConstructed).toBe(true);
    expect(foundation.constructionProgress).toBe(100);
    expect(foundation.hp).toBe(foundation.maxHp);
    expect(foundation.builderUnitIds.length).toBe(0);
    expect(builder.actionState).toBe('IDLE');
  });

  it('does not advance a foundation nobody is working on', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    const foundation = addBuilding(room, {
      id: 'b_1',
      ownerId: 'player-a',
      type: 'HOUSE',
      isConstructed: false
    });

    internals(room).update(2000);

    expect(foundation.constructionProgress).toBe(0);
    expect(foundation.isConstructed).toBe(false);
  });
});

describe('gathering and drop-off (SIM-02)', () => {
  /** A villager standing on a node, already ordered to harvest it. */
  function harvestScenario(options: { nodeAmount?: number; nodeType?: string; withTownCenter?: boolean } = {}) {
    const { nodeAmount = 100, nodeType = 'wood', withTownCenter = true } = options;
    const room = createRoom();
    const player = addPlayer(room, 'player-a', { wood: 0 });
    const node = addResource(room, { id: 'res_1', resourceType: nodeType, gridX: 50, gridY: 41, remainingAmount: nodeAmount });

    if (withTownCenter) {
      addBuilding(room, { id: 'b_tc', ownerId: 'player-a', type: 'TOWN_CENTER', gridX: 40, gridY: 40 });
    } else {
      addBuilding(room, { id: 'b_barracks', ownerId: 'player-a', type: 'BARRACKS', gridX: 40, gridY: 40 });
    }

    const unit = addUnit(room, {
      id: 'u_1',
      ownerId: 'player-a',
      x: 50.5,
      y: 41.5,
      actionState: 'HARVESTING'
    });
    unit.targetEntityId = node.id;
    unit.targetEntityType = 'resource';
    unit.targetX = node.gridX;
    unit.targetY = node.gridY;

    return { room, player, node, unit };
  }

  it('carries a full load instead of crediting the player directly', () => {
    const { room, player, node, unit } = harvestScenario();

    internals(room).update(1000);

    expect(unit.carryingAmount).toBe(UNIT_BLUEPRINTS.VILLAGER.carryCapacity);
    expect(unit.carryingResourceType).toBe('wood');
    expect(node.remainingAmount).toBe(100 - UNIT_BLUEPRINTS.VILLAGER.carryCapacity);
    expect(player.wood).toBe(0);
    expect(unit.actionState).toBe('RETURNING');
    expect(unit.dropOffId).toBe('b_tc');
  });

  it('banks the load at the town center and walks back to the node', () => {
    const { room, player, unit } = harvestScenario();
    const capacity = UNIT_BLUEPRINTS.VILLAGER.carryCapacity;

    internals(room).update(1000);
    expect(unit.actionState).toBe('RETURNING');

    let delivered = false;
    for (let i = 0; i < 400 && !delivered; i++) {
      internals(room).update(100);
      delivered = player.wood === capacity;
    }

    expect(delivered).toBe(true);
    expect(unit.carryingAmount).toBe(0);
    expect(unit.carryingResourceType).toBe('');
    expect(unit.dropOffId).toBe('');
    expect(unit.actionState).toBe('HARVESTING');
    expect(unit.targetEntityId).toBe('res_1');
  });

  it('banks a partial load when the node runs dry mid-gather', () => {
    const { room, player, node, unit } = harvestScenario({ nodeAmount: 4 });

    internals(room).update(1000);

    expect(unit.carryingAmount).toBe(4);
    expect(room.state.resourceNodes.has(node.id)).toBe(false);
    expect(unit.actionState).toBe('RETURNING');
    expect(player.wood).toBe(0);
  });

  it('keeps the load when no drop-off accepts it', () => {
    const { room, player, unit } = harvestScenario({ withTownCenter: false });

    internals(room).update(1000);

    expect(unit.carryingAmount).toBe(UNIT_BLUEPRINTS.VILLAGER.carryCapacity);
    expect(unit.actionState).toBe('IDLE');
    expect(player.wood).toBe(0);
  });

  it('does not pay out when the drop-off is destroyed mid-trip', () => {
    const { room, player, unit } = harvestScenario();
    const capacity = UNIT_BLUEPRINTS.VILLAGER.carryCapacity;

    internals(room).update(1000);
    expect(unit.actionState).toBe('RETURNING');

    room.state.buildings.delete('b_tc');
    internals(room).update(100);

    expect(player.wood).toBe(0);
    expect(unit.carryingAmount).toBe(capacity);
    expect(unit.actionState).toBe('IDLE');
  });

  it('banks a load of one type before gathering another', () => {
    const { room, player, node, unit } = harvestScenario({ nodeType: 'gold' });
    const capacity = UNIT_BLUEPRINTS.VILLAGER.carryCapacity;

    // Villager already holds wood and is now standing at a gold mine.
    unit.carryingResourceType = 'wood';
    unit.carryingAmount = capacity;

    internals(room).update(1000);

    expect(unit.actionState).toBe('RETURNING');
    expect(unit.carryingResourceType).toBe('wood');
    expect(node.remainingAmount).toBe(100);
    expect(player.wood).toBe(0);
  });
});

describe('farm gathering (ECO-01)', () => {
  /** A villager standing at a field's edge, already ordered to work it. */
  function farmScenario(options: { farmFood?: number; wood?: number } = {}) {
    const { farmFood = 250, wood = 0 } = options;
    const room = createRoom();
    const player = addPlayer(room, 'player-a', { wood, food: 0 });

    const farm = addBuilding(room, { id: 'b_farm', ownerId: 'player-a', type: 'FARM', gridX: 50, gridY: 50 });
    farm.resourceAmount = farmFood;
    farm.resourceCapacity = BUILDING_BLUEPRINTS.FARM.gatherCapacity ?? 0;
    addBuilding(room, { id: 'b_tc', ownerId: 'player-a', type: 'TOWN_CENTER', gridX: 40, gridY: 52 });

    // Just outside the 3x3 footprint, so the field is worked from its edge.
    const unit = addUnit(room, {
      id: 'u_1',
      ownerId: 'player-a',
      x: 49,
      y: 51.5,
      actionState: 'HARVESTING'
    });
    unit.targetEntityId = farm.id;
    unit.targetEntityType = 'farm';

    return { room, player, farm, unit, client: createClient('player-a') };
  }

  it('harvests food from the field instead of the ground', () => {
    const { room, player, farm, unit } = farmScenario();

    internals(room).update(1000);

    expect(unit.carryingAmount).toBe(UNIT_BLUEPRINTS.VILLAGER.carryCapacity);
    expect(unit.carryingResourceType).toBe('food');
    expect(farm.resourceAmount).toBe(250 - UNIT_BLUEPRINTS.VILLAGER.carryCapacity);
    expect(player.food).toBe(0);
    expect(unit.actionState).toBe('RETURNING');
    expect(unit.dropOffId).toBe('b_tc');
  });

  it('banks the load at the town center and returns to the field', () => {
    const { room, player, unit } = farmScenario();
    const capacity = UNIT_BLUEPRINTS.VILLAGER.carryCapacity;

    internals(room).update(1000);
    expect(unit.actionState).toBe('RETURNING');

    let delivered = false;
    for (let i = 0; i < 400 && !delivered; i++) {
      internals(room).update(100);
      delivered = player.food === capacity;
    }

    expect(delivered).toBe(true);
    expect(unit.actionState).toBe('HARVESTING');
    expect(unit.targetEntityId).toBe('b_farm');
    expect(unit.targetEntityType).toBe('farm');
  });

  it('re-sows an emptied field for the farm cost and keeps working', () => {
    const { room, player, farm, unit } = farmScenario({ farmFood: 5, wood: 60 });

    internals(room).update(1000);

    // Five units left on the field, so five are carried and the field is paid for.
    expect(unit.carryingAmount).toBe(5);
    expect(player.wood).toBe(0);
    expect(farm.resourceAmount).toBe(BUILDING_BLUEPRINTS.FARM.gatherCapacity);
    expect(farm.resourceCapacity).toBe(BUILDING_BLUEPRINTS.FARM.gatherCapacity);
  });

  it('stop working a field it cannot re-sow, but keeps the load', () => {
    const { room, player, farm, unit } = farmScenario({ farmFood: 5, wood: 0 });

    internals(room).update(1000);
    // Empty and unaffordable: the load in hand is banked, not thrown away.
    internals(room).update(1000);

    expect(farm.resourceAmount).toBe(0);
    expect(player.wood).toBe(0);
    expect(unit.carryingAmount).toBe(5);
    expect(unit.actionState).toBe('RETURNING');
  });

  it('refuses a harvest order on an empty farm', () => {
    const { room, farm, client } = farmScenario({ farmFood: 0 });

    internals(room).economy.handleHarvestOrder(client, { unitIds: ['u_1'], buildingId: farm.id });

    expect(farm.resourceAmount).toBe(0);
    expect(client.send).toHaveBeenCalledWith(NetworkMessage.ERROR_NOTIFICATION, { message: 'Farm is empty' });
  });

  it('refuses a harvest order on a farm owned by somebody else', () => {
    const { room, farm } = farmScenario();
    const stranger = createClient('player-b');

    internals(room).economy.handleHarvestOrder(stranger, { unitIds: ['u_1'], buildingId: farm.id });

    expect(stranger.send).toHaveBeenCalledWith(NetworkMessage.ERROR_NOTIFICATION, {
      message: 'That farm is not yours'
    });
  });

  it('banks the load and stops when the field is raised mid-harvest', () => {
    const { room, farm, unit } = farmScenario();
    unit.carryingAmount = 4;
    unit.carryingResourceType = 'food';
    room.state.buildings.delete(farm.id);

    internals(room).update(1000);

    // The load is banked; the target is kept so the resumed order can discover
    // the field is gone and retarget (see `startReturning`).
    expect(unit.actionState).toBe('RETURNING');
    expect(unit.carryingAmount).toBe(4);
    expect(unit.dropOffId).toBe('b_tc');
  });

  it('drops back to idle when an empty-handed field disappears', () => {
    const { room, farm, unit } = farmScenario();
    room.state.buildings.delete(farm.id);

    internals(room).update(1000);

    expect(unit.actionState).toBe('IDLE');
    expect(unit.targetEntityType).toBe('');
    expect(unit.targetEntityId).toBe('');
  });

  it('starts a finished farm full and leaves a foundation empty', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    const foundation = addBuilding(room, {
      id: 'b_1',
      ownerId: 'player-a',
      type: 'FARM',
      gridX: 40,
      gridY: 40,
      isConstructed: false
    });
    const builder = addUnit(room, { id: 'u_1', ownerId: 'player-a', x: 42.2, y: 41, actionState: 'BUILDING' });
    builder.targetEntityId = 'b_1';
    builder.targetEntityType = 'building';

    internals(room).update(100);
    expect(foundation.resourceAmount).toBe(0);

    for (let elapsed = 0; elapsed < BUILDING_BLUEPRINTS.FARM.buildTimeMs + 500; elapsed += 100) {
      internals(room).update(100);
    }

    expect(foundation.isConstructed).toBe(true);
    expect(foundation.resourceAmount).toBe(BUILDING_BLUEPRINTS.FARM.gatherCapacity);
  });
});

describe('pathfinding (SIM-01)', () => {
  /** Runs ticks until `done()` or the budget runs out. */
  function tickUntil(room: WorldRoom, done: () => boolean, maxTicks = 600, tickMs = 100) {
    for (let i = 0; i < maxTicks; i++) {
      internals(room).update(tickMs);
      if (done()) return true;
    }
    return false;
  }

  it('routes a unit around a wall of buildings instead of through it', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');

    // A wall of towers at x=15 from y=8 to y=12; the only way past is around it.
    for (let y = 8; y <= 12; y++) {
      addBuilding(room, { id: `b_${y}`, ownerId: 'player-a', type: 'TOWER', gridX: 15, gridY: y });
    }

    const unit = addUnit(room, { id: 'u_1', ownerId: 'player-a', x: 10.5, y: 10.5 });
    internals(room).commands.handleMoveUnits(createClient('player-a'), {
      unitIds: ['u_1'],
      targetGridX: 20,
      targetGridY: 10
    });

    internals(room).update(100);
    expect(unit.pathX.length).toBeGreaterThan(0);

    const visited: Array<{ x: number; y: number }> = [];
    const arrived = tickUntil(room, () => {
      visited.push({ x: unit.x, y: unit.y });
      return unit.actionState === 'IDLE';
    });

    expect(arrived).toBe(true);
    expect(unit.x).toBeCloseTo(20, 1);
    expect(unit.y).toBeCloseTo(10, 1);

    const walkedThrough = visited.filter((position) => {
      const gx = Math.floor(position.x);
      const gy = Math.floor(position.y);
      return gx === 15 && gy >= 8 && gy <= 12;
    });
    expect(walkedThrough).toEqual([]);
  });

  it('keeps walking straight when no route exists, instead of freezing', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');

    // Ring of towers boxing the target in: every neighbouring tile is blocked.
    const ring: Array<[number, number]> = [
      [19, 19], [20, 19], [21, 19],
      [19, 20], [21, 20],
      [19, 21], [20, 21], [21, 21]
    ];
    ring.forEach(([x, y], index) =>
      addBuilding(room, { id: `b_${index}`, ownerId: 'player-a', type: 'TOWER', gridX: x, gridY: y })
    );

    const unit = addUnit(room, { id: 'u_1', ownerId: 'player-a', x: 10.5, y: 20.5 });
    internals(room).commands.handleMoveUnits(createClient('player-a'), {
      unitIds: ['u_1'],
      targetGridX: 20,
      targetGridY: 20
    });

    internals(room).update(100);
    expect(unit.pathX.length).toBe(0);

    const startX = unit.x;
    internals(room).update(1000);
    expect(unit.x).toBeGreaterThan(startX);
  });

  it('clears a stale route when a new order arrives', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    const unit = addUnit(room, { id: 'u_1', ownerId: 'player-a', x: 10.5, y: 10.5 });
    const clientA = createClient('player-a');

    internals(room).commands.handleMoveUnits(clientA, { unitIds: ['u_1'], targetGridX: 30, targetGridY: 10 });
    internals(room).update(100);
    expect(unit.pathX.length).toBeGreaterThan(0);

    internals(room).commands.handleMoveUnits(clientA, { unitIds: ['u_1'], targetGridX: 10, targetGridY: 30 });
    expect(unit.pathX.length).toBe(0);

    internals(room).update(100);
    const last = unit.pathX.length - 1;
    expect(unit.pathX[last]).toBeCloseTo(10.5, 5);
    expect(unit.pathY[last]).toBeCloseTo(30.5, 5);
  });
});

describe('route invalidation (SIM-01 follow-up)', () => {
  it('re-routes when a building appears on the remaining path', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    const unit = addUnit(room, { id: 'u_1', ownerId: 'player-a', x: 10.5, y: 10.5 });

    internals(room).commands.handleMoveUnits(createClient('player-a'), {
      unitIds: ['u_1'],
      targetGridX: 20,
      targetGridY: 10
    });
    internals(room).update(100);
    expect(unit.pathX.length).toBeGreaterThan(0);

    // A completed tower dropped exactly on the next waypoint's tile.
    const nextX = Math.floor(unit.pathX[0]);
    const nextY = Math.floor(unit.pathY[0]);
    addBuilding(room, { id: 'b_1', ownerId: 'player-a', type: 'TOWER', gridX: nextX, gridY: nextY });

    internals(room).update(100);

    // The stale route is dropped and a fresh search is queued; the tick's own
    // path batch already ran, so the new route arrives on the next tick.
    const movement = internals(room).movement;
    expect(unit.pathX.length).toBe(0);
    expect(movement.pendingPathIds.has('u_1')).toBe(true);

    internals(room).update(100);
    expect(unit.pathX.length).toBeGreaterThan(0);
    const reroutedOntoObstacle =
      Math.floor(unit.pathX[0]) === nextX && Math.floor(unit.pathY[0]) === nextY;
    expect(reroutedOntoObstacle).toBe(false);
  });

  it('does not touch a route that is still clear', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    const unit = addUnit(room, { id: 'u_1', ownerId: 'player-a', x: 10.5, y: 10.5 });

    internals(room).commands.handleMoveUnits(createClient('player-a'), {
      unitIds: ['u_1'],
      targetGridX: 30,
      targetGridY: 10
    });
    internals(room).update(100);
    const pathLength = unit.pathX.length;
    expect(pathLength).toBeGreaterThan(0);

    internals(room).update(100);

    const movement = internals(room).movement;
    expect(movement.pendingPathIds.size).toBe(0);
    expect(movement.lastRepathAt.size).toBe(0);
    // Untouched: still the same route, not re-searched and not cleared.
    expect(unit.pathX.length).toBe(pathLength);
  });
});

describe('tower combat (SIM-03)', () => {
  it('damages an enemy unit inside its range and spares its owner units', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    addBuilding(room, { id: 'b_1', ownerId: 'player-a', type: 'TOWER', gridX: 40, gridY: 40 });
    const friendly = addUnit(room, { id: 'u_1', ownerId: 'player-a', x: 42, y: 41 });
    const enemy = addUnit(room, { id: 'u_2', ownerId: 'player-b', x: 45, y: 41 });

    internals(room).update(100);

    expect(enemy.hp).toBe(UNIT_BLUEPRINTS.VILLAGER.maxHp - BUILDING_BLUEPRINTS.TOWER.attackPower);
    expect(friendly.hp).toBe(UNIT_BLUEPRINTS.VILLAGER.maxHp);
  });

  it('holds fire while the tower is still a foundation', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    addBuilding(room, {
      id: 'b_1',
      ownerId: 'player-a',
      type: 'TOWER',
      gridX: 40,
      gridY: 40,
      isConstructed: false
    });
    const enemy = addUnit(room, { id: 'u_2', ownerId: 'player-b', x: 42, y: 41 });

    internals(room).update(100);

    expect(enemy.hp).toBe(UNIT_BLUEPRINTS.VILLAGER.maxHp);
  });

  it('waits out the cooldown between shots', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    addBuilding(room, { id: 'b_1', ownerId: 'player-a', type: 'TOWER', gridX: 40, gridY: 40 });
    const enemy = addUnit(room, { id: 'u_2', ownerId: 'player-b', x: 42, y: 41 });
    const maxHp = UNIT_BLUEPRINTS.VILLAGER.maxHp;
    const cooldown = BUILDING_BLUEPRINTS.TOWER.attackCooldownMs;

    internals(room).update(100);
    expect(enemy.hp).toBe(maxHp - 10);

    internals(room).update(cooldown - 200);
    expect(enemy.hp).toBe(maxHp - 10);

    internals(room).update(200);
    expect(enemy.hp).toBe(maxHp - 20);
  });
});

describe('combat cooldown bookkeeping', () => {
  it('resumes the stored order on the tick its target dies', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    const attacker = addUnit(room, {
      id: 'u_1', ownerId: 'player-a', type: 'SPEARMAN', x: 10, y: 10, actionState: 'ATTACKING'
    });
    attacker.previousActionState = 'ATTACK_MOVE';
    const victim = addUnit(room, { id: 'u_2', ownerId: 'player-b', type: 'VILLAGER', x: 11, y: 10 });
    victim.hp = 1;
    attacker.targetEntityId = victim.id;
    attacker.targetEntityType = 'unit';

    internals(room).update(100);

    expect(room.state.units.has(victim.id)).toBe(false);
    expect(attacker.actionState).toBe('ATTACK_MOVE');
    expect(attacker.targetEntityId).toBe('');
  });

  it('drops a unit cooldown when that unit is killed', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    const enemy = addUnit(room, {
      id: 'u_1', ownerId: 'player-a', type: 'SPEARMAN', x: 10, y: 10
    });
    const victim = addUnit(room, {
      id: 'u_2', ownerId: 'player-b', type: 'VILLAGER', x: 11, y: 10, actionState: 'ATTACKING'
    });
    victim.targetEntityId = enemy.id;
    victim.targetEntityType = 'unit';

    // Tick 1: the villager lands its own hit, which is what puts it in the
    // cooldown map. Killing it in the same tick would not, because the tick
    // deletes it before its turn comes around.
    internals(room).update(100);
    const combat = internals(room).combat;
    expect(enemy.hp).toBe(UNIT_BLUEPRINTS.SPEARMAN.maxHp - UNIT_BLUEPRINTS.VILLAGER.attackPower);
    expect(combat.attackTimers.has(victim.id)).toBe(true);

    // Tick 2: a tower finishes it off mid-cooldown.
    addBuilding(room, { id: 'b_1', ownerId: 'player-a', type: 'TOWER', gridX: 11, gridY: 9 });
    victim.hp = 1;
    internals(room).update(100);

    expect(room.state.units.has(victim.id)).toBe(false);
    expect(combat.attackTimers.has(victim.id)).toBe(false);
    // The villager was the only unit with a cooldown, so the map must be empty.
    expect(combat.attackTimers.size).toBe(0);
  });

  it('drops a tower cooldown when the tower is destroyed', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    const tower = addBuilding(room, { id: 'b_1', ownerId: 'player-a', type: 'TOWER', gridX: 40, gridY: 40 });
    tower.hp = 1;
    // Standing on the tower's own tile (distance 0) so it is unambiguously the
    // target of the shot this tick.
    const bystander = addUnit(room, { id: 'u_2', ownerId: 'player-b', x: 40.5, y: 40.5 });
    const attacker = addUnit(room, {
      id: 'u_1', ownerId: 'player-b', type: 'SPEARMAN', x: 41, y: 42, actionState: 'ATTACKING'
    });
    attacker.targetEntityId = tower.id;
    attacker.targetEntityType = 'building';

    internals(room).update(100);

    const combat = internals(room).combat;
    // The tower fired first this tick, which is what puts it in the map.
    expect(bystander.hp).toBe(UNIT_BLUEPRINTS.VILLAGER.maxHp - BUILDING_BLUEPRINTS.TOWER.attackPower);
    expect(room.state.buildings.has(tower.id)).toBe(false);
    expect(combat.towerTimers.has(tower.id)).toBe(false);
  });
});

describe('unit stance (CMB-01)', () => {
  it('sets the stance on owned units and leaves a foreign unit alone', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    const mine = addUnit(room, { id: 'u_1', ownerId: 'player-a' });
    const theirs = addUnit(room, { id: 'u_2', ownerId: 'player-b' });
    const client = createClient('player-a');

    internals(room).commands.handleSetStance(client, {
      unitIds: [mine.id, theirs.id],
      stance: 'STAND_GROUND'
    });

    expect(mine.stance).toBe('STAND_GROUND');
    expect(theirs.stance).toBe('AGGRESSIVE');
  });

  it('rejects an unknown stance without writing it', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    const unit = addUnit(room, { id: 'u_1', ownerId: 'player-a' });
    const client = createClient('player-a');

    internals(room).commands.handleSetStance(client, {
      unitIds: [unit.id],
      stance: 'BERSERK'
    });

    expect(unit.stance).toBe('AGGRESSIVE');
    expect(client.send).toHaveBeenCalledWith(NetworkMessage.ERROR_NOTIFICATION, expect.anything());
  });

  it('NO_ATTACK never picks its own fight', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    const unit = addUnit(room, {
      id: 'u_1',
      ownerId: 'player-a',
      type: 'SPEARMAN',
      x: 10,
      y: 10,
      actionState: 'ATTACK_MOVE'
    });
    unit.stance = 'NO_ATTACK';
    // Walk somewhere, so the unit cannot arrive this tick and drop to IDLE.
    unit.targetX = 30;
    unit.targetY = 10;
    addUnit(room, { id: 'u_2', ownerId: 'player-b', type: 'VILLAGER', x: 12, y: 10 });

    internals(room).update(50);

    expect(unit.actionState).toBe('ATTACK_MOVE');
    expect(unit.targetEntityId).toBe('');
  });

  it('STAND_GROUND drops a target out of reach and does not take a step', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    const unit = addUnit(room, {
      id: 'u_1',
      ownerId: 'player-a',
      type: 'SPEARMAN',
      x: 10,
      y: 10,
      actionState: 'ATTACKING'
    });
    unit.stance = 'STAND_GROUND';
    const enemy = addUnit(room, { id: 'u_2', ownerId: 'player-b', type: 'VILLAGER', x: 20, y: 10 });
    unit.targetEntityId = enemy.id;
    unit.targetEntityType = 'unit';

    internals(room).update(100);

    expect(unit.actionState).toBe('IDLE');
    expect(unit.x).toBe(10);
    expect(enemy.hp).toBe(UNIT_BLUEPRINTS.VILLAGER.maxHp);
  });

  it('STAND_GROUND still strikes a target already inside its range', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    const unit = addUnit(room, {
      id: 'u_1',
      ownerId: 'player-a',
      type: 'SPEARMAN',
      x: 10,
      y: 10,
      actionState: 'ATTACKING'
    });
    unit.stance = 'STAND_GROUND';
    const enemy = addUnit(room, { id: 'u_2', ownerId: 'player-b', type: 'VILLAGER', x: 11, y: 10 });
    unit.targetEntityId = enemy.id;
    unit.targetEntityType = 'unit';

    internals(room).update(100);

    expect(enemy.hp).toBe(UNIT_BLUEPRINTS.VILLAGER.maxHp - UNIT_BLUEPRINTS.SPEARMAN.attackPower);
    // It hit without walking: the stance holds the ground it stands on.
    expect(unit.x).toBe(10);
    expect(unit.actionState).toBe('ATTACKING');
  });

  it('NO_ATTACK gives up a fight it picked itself', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    // Auto-acquired: `previousActionState` still holds the attack-move that was
    // interrupted, which is the only marker that distinguishes it from a click.
    const unit = addUnit(room, {
      id: 'u_1',
      ownerId: 'player-a',
      type: 'SPEARMAN',
      x: 10,
      y: 10,
      actionState: 'ATTACKING'
    });
    unit.previousActionState = 'ATTACK_MOVE';
    unit.targetX = 40;
    unit.targetY = 10;
    unit.stance = 'NO_ATTACK';
    const enemy = addUnit(room, { id: 'u_2', ownerId: 'player-b', type: 'VILLAGER', x: 11, y: 10 });
    unit.targetEntityId = enemy.id;
    unit.targetEntityType = 'unit';

    internals(room).update(100);

    expect(unit.actionState).toBe('ATTACK_MOVE');
    expect(unit.targetEntityId).toBe('');
    expect(enemy.hp).toBe(UNIT_BLUEPRINTS.VILLAGER.maxHp);
  });

  it('NO_ATTACK still fights a target the player clicked', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    // An explicit attack order clears `previousActionState`, so the stance must
    // not touch it — the player asked for this fight by hand.
    const unit = addUnit(room, {
      id: 'u_1',
      ownerId: 'player-a',
      type: 'SPEARMAN',
      x: 10,
      y: 10,
      actionState: 'ATTACKING'
    });
    unit.stance = 'NO_ATTACK';
    const enemy = addUnit(room, { id: 'u_2', ownerId: 'player-b', type: 'VILLAGER', x: 11, y: 10 });
    unit.targetEntityId = enemy.id;
    unit.targetEntityType = 'unit';

    internals(room).update(100);

    expect(enemy.hp).toBe(UNIT_BLUEPRINTS.VILLAGER.maxHp - UNIT_BLUEPRINTS.SPEARMAN.attackPower);
    expect(unit.actionState).toBe('ATTACKING');
  });

  it('DEFENSIVE gives up once the chase passes its leash', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    addPlayer(room, 'player-b');
    const unit = addUnit(room, {
      id: 'u_1',
      ownerId: 'player-a',
      type: 'SPEARMAN',
      x: 10,
      y: 10,
      actionState: 'ATTACK_MOVE'
    });
    unit.stance = 'DEFENSIVE';
    unit.targetX = 40;
    unit.targetY = 10;
    const enemy = addUnit(room, { id: 'u_2', ownerId: 'player-b', type: 'VILLAGER', x: 15, y: 10 });

    // Tick 1: it picks the fight itself, which is what records the leash anchor.
    internals(room).update(100);
    expect(unit.actionState).toBe('ATTACKING');

    // The target runs: a defensive unit follows only four tiles from its post.
    enemy.x = 60;
    for (let i = 0; i < 200 && unit.actionState === 'ATTACKING'; i++) {
      internals(room).update(100);
    }

    expect(unit.actionState).toBe('ATTACK_MOVE');
    expect(Math.hypot(unit.x - 10, unit.y - 10)).toBeLessThan(5);
  });
});

describe('drop-off buildings (ECO)', () => {
  /**
   * A villager standing on a node, with one drop-off building placed next to it
   * and a town center pinned at the far end of the map, so "nearest drop-off"
   * is a real choice rather than the only option.
   */
  function campScenario(options: { campType: string; nodeType: string }) {
    const { campType, nodeType } = options;
    const room = createRoom();
    const player = addPlayer(room, 'player-a', { wood: 0, food: 0, gold: 0, stone: 0 });

    const node = addResource(room, {
      id: 'res_1',
      resourceType: nodeType,
      gridX: 50,
      gridY: 41,
      remainingAmount: 100
    });
    const camp = addBuilding(room, {
      id: 'b_camp',
      ownerId: 'player-a',
      type: campType,
      gridX: 50,
      gridY: 44
    });
    addBuilding(room, { id: 'b_tc', ownerId: 'player-a', type: 'TOWN_CENTER', gridX: 5, gridY: 5 });

    const unit = addUnit(room, {
      id: 'u_1',
      ownerId: 'player-a',
      x: 50.5,
      y: 41.5,
      actionState: 'HARVESTING'
    });
    unit.targetEntityId = node.id;
    unit.targetEntityType = 'resource';
    unit.targetX = node.gridX;
    unit.targetY = node.gridY;

    return { room, player, node, camp, unit };
  }

  /** Ticks until the load is banked or the villager gives up. */
  function bank(room: WorldRoom, done: () => boolean) {
    for (let i = 0; i < 400 && !done(); i++) {
      internals(room).update(100);
    }
  }

  it('lumber camp banks wood instead of the distant town center', () => {
    const { room, player, unit } = campScenario({ campType: 'LUMBER_CAMP', nodeType: 'wood' });

    internals(room).update(1000);
    expect(unit.actionState).toBe('RETURNING');
    expect(unit.dropOffId).toBe('b_camp');

    bank(room, () => player.wood > 0);
    expect(player.wood).toBe(UNIT_BLUEPRINTS.VILLAGER.carryCapacity);
  });

  it('mill banks food', () => {
    const { room, player, unit } = campScenario({ campType: 'MILL', nodeType: 'food' });

    internals(room).update(1000);
    expect(unit.dropOffId).toBe('b_camp');

    bank(room, () => player.food > 0);
    expect(player.food).toBe(UNIT_BLUEPRINTS.VILLAGER.carryCapacity);
  });

  it('mining camp banks both gold and stone', () => {
    for (const resource of ['gold', 'stone'] as const) {
      const { room, player, unit } = campScenario({ campType: 'MINING_CAMP', nodeType: resource });

      internals(room).update(1000);
      expect(unit.dropOffId, resource).toBe('b_camp');

      bank(room, () => player[resource] > 0);
      expect(player[resource], resource).toBe(UNIT_BLUEPRINTS.VILLAGER.carryCapacity);
    }
  });

  it('a lumber camp refuses a load it does not handle', () => {
    // Only a lumber camp is nearby, so a gold load has nowhere to go: the
    // villager must keep it rather than walk to the wrong camp, and must not
    // walk across the map to the town center either.
    const room = createRoom();
    const player = addPlayer(room, 'player-a', { wood: 0, gold: 0 });
    const node = addResource(room, {
      id: 'res_1',
      resourceType: 'gold',
      gridX: 50,
      gridY: 41,
      remainingAmount: 100
    });
    addBuilding(room, {
      id: 'b_camp',
      ownerId: 'player-a',
      type: 'LUMBER_CAMP',
      gridX: 50,
      gridY: 44
    });

    const unit = addUnit(room, {
      id: 'u_1',
      ownerId: 'player-a',
      x: 50.5,
      y: 41.5,
      actionState: 'HARVESTING'
    });
    unit.targetEntityId = node.id;
    unit.targetEntityType = 'resource';

    internals(room).update(1000);

    expect(unit.carryingAmount).toBe(UNIT_BLUEPRINTS.VILLAGER.carryCapacity);
    expect(unit.carryingResourceType).toBe('gold');
    expect(unit.actionState).toBe('IDLE');
    expect(unit.dropOffId).toBe('');
    expect(player.gold).toBe(0);
  });
});
