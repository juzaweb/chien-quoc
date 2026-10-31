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

    internals(room).handleMoveUnits(clientA, { unitIds: ['u_1'], targetGridX: 60, targetGridY: 60 });

    expect(foreign.actionState).toBe('IDLE');
    expect(foreign.targetX).toBe(12);
    expect(foreign.targetY).toBe(12);
  });

  it('rejects a command that exceeds MAX_SELECTION', () => {
    const room = createRoom();
    addPlayer(room, 'player-a');
    const clientA = createClient('player-a');
    const unitIds = Array.from({ length: MAX_SELECTION + 1 }, (_, i) => `u_${i}`);

    internals(room).handleMoveUnits(clientA, { unitIds, targetGridX: 60, targetGridY: 60 });

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

    internals(room).handleAttackTarget(clientA, {
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

    internals(room).handleAttackTarget(createClient('player-a'), {
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

    internals(room).handleTrainUnit(createClient('player-a'), {
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

    internals(room).handleTrainUnit(clientA, { buildingId: 'b_1', unitType: 'VILLAGER' });

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

    internals(room).handlePlaceBuilding(clientA, { type: 'HOUSE', gridX: 41, gridY: 41 });

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

    internals(room).handlePlaceBuilding(clientA, {
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
    internals(room).handleMoveUnits(createClient('player-a'), {
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
    internals(room).handleMoveUnits(createClient('player-a'), {
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

    internals(room).handleMoveUnits(clientA, { unitIds: ['u_1'], targetGridX: 30, targetGridY: 10 });
    internals(room).update(100);
    expect(unit.pathX.length).toBeGreaterThan(0);

    internals(room).handleMoveUnits(clientA, { unitIds: ['u_1'], targetGridX: 10, targetGridY: 30 });
    expect(unit.pathX.length).toBe(0);

    internals(room).update(100);
    const last = unit.pathX.length - 1;
    expect(unit.pathX[last]).toBeCloseTo(10.5, 5);
    expect(unit.pathY[last]).toBeCloseTo(30.5, 5);
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
