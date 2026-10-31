import { Client } from '@colyseus/core';
import {
  BUILDING_BLUEPRINTS,
  BuildingType,
  AttackMovePayload,
  AttackTargetPayload,
  BuildTargetPayload,
  CancelBuildingPayload,
  CancelTrainPayload,
  HarvestResourcePayload,
  MAP_GRID_HEIGHT,
  MAP_GRID_WIDTH,
  MAX_QUEUED_WAYPOINTS,
  MAX_SELECTION,
  MoveUnitsPayload,
  PlaceBuildingPayload,
  Resources,
  SetRallyPointPayload,
  StopUnitsPayload,
  TrainUnitPayload,
  UNIT_BLUEPRINTS,
  UnitType,
  canTrainUnitsAt
} from '@chien-quoc/shared';
import { BuildingState } from '../schema/BuildingState.js';
import { PlayerState } from '../schema/PlayerState.js';
import { ResourceNodeState } from '../schema/ResourceNodeState.js';
import { UnitState } from '../schema/UnitState.js';
import { WorldState } from '../schema/WorldState.js';
import { getBuildApproachPoint } from './construction.js';

/**
 * What the command layer needs from the room and its sibling systems.
 *
 * Every entry is a mutation the command may cause; nothing here reads the tick
 * loop, so a handler cannot accidentally depend on simulation ordering.
 */
export interface CommandPorts {
  /** Sends an `ERROR_NOTIFICATION` to the client. */
  rejectCommand(client: Client, message: string): void;
  /** Replaces the unit's route with one to this point (SIM-01). */
  setWalkTarget(unit: UnitState, targetX: number, targetY: number): void;
  /** Pops the next queued waypoint into the active order (CTL-05). */
  advanceQueuedWaypoint(unit: UnitState): boolean;
  /** Drops the economy system's retarget type for a unit that got a new order. */
  clearHarvestOrder(unitId: string): void;
  /** Drops the combat cooldown of a building that no longer exists. */
  forgetBuilding(buildingId: string): void;
  /** Economy order handler; the rules themselves live in `EconomySystem`. */
  harvestOrder(client: Client, payload: HarvestResourcePayload): void;
  /** Next entity id from the room's counter. */
  allocateEntityId(): number;
  /** Recomputed whenever a unit or building is added. */
  updatePlayerPopulation(ownerId: string): void;
}

/** Distance between formation cells, in tiles. Wide enough to keep rings apart. */
const FORMATION_SPACING = 0.6;

/**
 * CMD-04b refund rule. AoE returns everything for a foundation that was only
 * just placed and less once work has gone into it. These two constants keep the
 * agreed numbers in one place instead of inline in the handler.
 */
const CANCEL_BUILDING_FULL_REFUND_BELOW = 10; // construction progress %
const CANCEL_BUILDING_PARTIAL_REFUND_RATIO = 0.5;

/**
 * Lays a squad out as a centred square block around its destination.
 *
 * A previous 3-column layout turned a 60-unit army into a 3x20 column, which
 * reads as a queue rather than a formation. The block is
 * `ceil(sqrt(count))` cells wide, so the group's centre of mass lands on the
 * clicked tile regardless of squad size.
 *
 * @param count Number of units to place. `0` yields an empty list.
 * @param spacing Cell distance in tiles.
 */
function computeFormationOffsets(count: number, spacing: number): Array<{ x: number; y: number }> {
  if (count <= 0) return [];

  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / cols);
  const offsets: Array<{ x: number; y: number }> = [];

  for (let idx = 0; idx < count; idx++) {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    offsets.push({
      x: (col - (cols - 1) / 2) * spacing,
      y: (row - (rows - 1) / 2) * spacing
    });
  }

  return offsets;
}

/**
 * The command layer: one handler per client message.
 *
 * Handlers validate against authoritative state, then mutate the unit's order
 * fields. They never run the simulation — the tick reads the fields they set —
 * so a rejected command leaves the world untouched and a malformed payload can
 * only ever fail. Everything a client sends is untrusted: unit ids, target ids
 * and grid coordinates are all resolved against `state`, never taken as truth.
 */
export class CommandSystem {
  constructor(
    private readonly state: WorldState,
    private readonly ports: CommandPorts
  ) {}

  handlePlaceBuilding(client: Client, payload: PlaceBuildingPayload) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const blueprint = BUILDING_BLUEPRINTS[payload.type];
    if (!blueprint) {
      this.ports.rejectCommand(client, 'Invalid building type');
      return;
    }

    // Check resource sufficiency
    if (
      player.wood < blueprint.cost.wood ||
      player.food < blueprint.cost.food ||
      player.gold < blueprint.cost.gold ||
      player.stone < blueprint.cost.stone
    ) {
      this.ports.rejectCommand(client, 'Insufficient resources to construct building');
      return;
    }

    // Check bounds
    const endX = payload.gridX + blueprint.sizeX;
    const endY = payload.gridY + blueprint.sizeY;
    if (payload.gridX < 0 || endX > MAP_GRID_WIDTH || payload.gridY < 0 || endY > MAP_GRID_HEIGHT) {
      this.ports.rejectCommand(client, 'Cannot build outside map bounds');
      return;
    }

    // Check tile occupancy collisions with other buildings and resource nodes
    let isColliding = false;
    this.state.buildings.forEach((b: BuildingState) => {
      const bEndX = b.gridX + b.sizeX;
      const bEndY = b.gridY + b.sizeY;
      const overlapX = payload.gridX < bEndX && endX > b.gridX;
      const overlapY = payload.gridY < bEndY && endY > b.gridY;
      if (overlapX && overlapY) {
        isColliding = true;
      }
    });

    this.state.resourceNodes.forEach((res: ResourceNodeState) => {
      if (res.gridX >= payload.gridX && res.gridX < endX && res.gridY >= payload.gridY && res.gridY < endY) {
        isColliding = true;
      }
    });

    if (isColliding) {
      this.ports.rejectCommand(client, 'Placement obstructed by existing structure or resource');
      return;
    }

    // Deduct resources
    player.wood -= blueprint.cost.wood;
    player.food -= blueprint.cost.food;
    player.gold -= blueprint.cost.gold;
    player.stone -= blueprint.cost.stone;

    // Create building
    const buildingId = `b_${this.ports.allocateEntityId()}`;
    const building = new BuildingState();
    building.id = buildingId;
    building.ownerId = client.sessionId;
    building.type = payload.type;
    building.gridX = payload.gridX;
    building.gridY = payload.gridY;
    building.sizeX = blueprint.sizeX;
    building.sizeY = blueprint.sizeY;
    building.hp = 1; // CMD-05: a foundation is nearly defenceless until it is finished
    building.maxHp = blueprint.maxHp;
    building.isConstructed = false;
    building.constructionProgress = 0;

    this.state.buildings.set(buildingId, building);
    this.ports.updatePlayerPopulation(client.sessionId);
  }

  handleMoveUnits(client: Client, payload: MoveUnitsPayload) {
    if (!payload.unitIds || payload.unitIds.length === 0) return;
    if (payload.unitIds.length > MAX_SELECTION) {
      this.ports.rejectCommand(client, 'Too many units in one command');
      return;
    }
    if (!Number.isFinite(payload.targetGridX) || !Number.isFinite(payload.targetGridY)) {
      this.ports.rejectCommand(client, 'Invalid move target');
      return;
    }

    // Shift+right click appends; a plain move replaces the whole order. Anything
    // that is not literally `true` is treated as a direct move, so a malformed
    // payload can never sneak extra state into a unit.
    const queueWaypoint = payload.queue === true;

    // Validate first, then spread the surviving units over one formation. Doing
    // it in a single pass would size the block off the payload length, so ids
    // that are foreign or stale would leave holes in the shape.
    const ownedUnits = this.collectOwnedUnits(client, payload.unitIds);
    const targets = this.assignFormationTargets(ownedUnits, payload.targetGridX, payload.targetGridY);

    ownedUnits.forEach((unit, idx) => {
      const { x: targetX, y: targetY } = targets[idx];

      if (queueWaypoint) {
        if (unit.queueTargetX.length >= MAX_QUEUED_WAYPOINTS) return;
        unit.queueTargetX.push(targetX);
        unit.queueTargetY.push(targetY);
        // A unit with no order in flight has nothing to finish, so the point
        // it just asked for becomes the active order immediately.
        if (unit.actionState === 'IDLE') {
          this.ports.advanceQueuedWaypoint(unit);
        }
        return;
      }

      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      this.ports.setWalkTarget(unit, targetX, targetY);
      unit.actionState = 'MOVING';
      unit.targetEntityId = '';
      unit.targetEntityType = '';
      unit.previousActionState = '';
    });
  }

  handleTrainUnit(client: Client, payload: TrainUnitPayload) {
    const player = this.state.players.get(client.sessionId);
    const building = this.state.buildings.get(payload.buildingId);
    if (!player || !building || building.ownerId !== client.sessionId) return;

    const blueprint = BUILDING_BLUEPRINTS[building.type as BuildingType];
    if (!blueprint || !blueprint.trainableUnits.includes(payload.unitType)) {
      this.ports.rejectCommand(client, 'Unit cannot be trained at this structure');
      return;
    }

    const unitBlueprint = UNIT_BLUEPRINTS[payload.unitType];
    if (!unitBlueprint) return;

    // Population limit check
    if (player.population >= player.populationCap) {
      this.ports.rejectCommand(client, 'Population limit reached. Build more Houses!');
      return;
    }

    // Resource check
    if (
      player.wood < unitBlueprint.cost.wood ||
      player.food < unitBlueprint.cost.food ||
      player.gold < unitBlueprint.cost.gold ||
      player.stone < unitBlueprint.cost.stone
    ) {
      this.ports.rejectCommand(client, 'Insufficient resources to train unit');
      return;
    }

    // Deduct resources
    player.wood -= unitBlueprint.cost.wood;
    player.food -= unitBlueprint.cost.food;
    player.gold -= unitBlueprint.cost.gold;
    player.stone -= unitBlueprint.cost.stone;

    // Add to training queue
    building.trainingQueue.push(payload.unitType);
  }

  /**
   * CMD-04a: drops the unit at the head of a building's training queue.
   *
   * The queue is the source of truth for what was being trained, so the refund
   * amount never comes from the client: only the head is cancelled and only its
   * own blueprint price is returned. Cancelling refunds in full — nothing has
   * been produced yet, the player only loses the elapsed time.
   */
  handleCancelTrain(client: Client, payload: CancelTrainPayload) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const building = this.requireOwnedBuilding(client, payload.buildingId);
    if (!building) return;

    if (building.trainingQueue.length === 0) {
      this.ports.rejectCommand(client, 'Nothing is being trained here');
      return;
    }

    // Resolve the price before touching the queue: an unreadable entry must not
    // disappear without a refund, which is what a shift-then-lookup would do.
    const unitType = building.trainingQueue[0] as UnitType;
    const blueprint = UNIT_BLUEPRINTS[unitType];
    if (!blueprint) {
      this.ports.rejectCommand(client, 'Unknown unit in training queue');
      return;
    }

    building.trainingQueue.shift();
    // The elapsed time belonged to the cancelled unit. Keeping it would let the
    // player cancel and re-queue to finish the next unit for free.
    building.trainingProgressMs = 0;
    this.refundResources(player, blueprint.cost, 1);
  }

  /**
   * CMD-04b: removes a foundation that was placed but never finished.
   *
   * Completed buildings are rejected: this is a "cancel the build", not a
   * demolish command, and silently deleting a finished Town Center on a
   * misclicked hotkey would be unrecoverable.
   */
  handleCancelBuilding(client: Client, payload: CancelBuildingPayload) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    const building = this.requireOwnedBuilding(client, payload.buildingId);
    if (!building) return;

    if (building.isConstructed) {
      this.ports.rejectCommand(client, 'Cannot cancel a completed building');
      return;
    }

    const blueprint = BUILDING_BLUEPRINTS[building.type as BuildingType];
    if (blueprint) {
      // A foundation that has barely been worked on returns everything; once
      // real progress went in, the player eats half the cost.
      const ratio =
        building.constructionProgress < CANCEL_BUILDING_FULL_REFUND_BELOW
          ? 1
          : CANCEL_BUILDING_PARTIAL_REFUND_RATIO;
      this.refundResources(player, blueprint.cost, ratio);
    }

    // Units walking to or attacking the foundation resolve the missing target
    // on their next tick, so nothing has to be repointed here.
    this.state.buildings.delete(building.id);
    this.ports.forgetBuilding(building.id);
  }

  handleAttackTarget(client: Client, payload: AttackTargetPayload) {
    if (!payload.unitIds || payload.unitIds.length === 0) return;
    if (payload.unitIds.length > MAX_SELECTION) {
      this.ports.rejectCommand(client, 'Too many units in one command');
      return;
    }

    // The client chooses targetEntityId/targetType freely, so resolve the target
    // from authoritative state and reject anything that is missing or friendly.
    // Without this a client can order units to attack an ally or itself.
    const target =
      payload.targetType === 'unit'
        ? this.state.units.get(payload.targetEntityId)
        : payload.targetType === 'building'
          ? this.state.buildings.get(payload.targetEntityId)
          : undefined;

    if (!target) {
      this.ports.rejectCommand(client, 'Target no longer exists');
      return;
    }
    if (target.ownerId === client.sessionId) {
      this.ports.rejectCommand(client, 'Cannot attack your own units or buildings');
      return;
    }

    payload.unitIds.forEach((uId) => {
      const unit = this.state.units.get(uId);
      if (unit && unit.ownerId === client.sessionId) {
        // A new order replaces any queued path; leaving waypoints behind would
        // make the unit resume an old route after the attack finishes.
        unit.queueTargetX.clear();
        unit.queueTargetY.clear();
        // The chase is straight-line, so a route to the old destination would
        // only pull the unit off the target if the fight ends.
        unit.pathX.clear();
        unit.pathY.clear();
        // A plain attack has nothing to return to (CMD-01).
        unit.previousActionState = '';
        unit.targetEntityId = payload.targetEntityId;
        unit.targetEntityType = payload.targetType;
        unit.actionState = 'ATTACKING';
      }
    });
  }

  /**
   * CMD-01: issues ATTACK_MOVE or PATROL to a grid point.
   *
   * Both orders reuse the formation layout of a plain move, so a squad keeps its
   * shape while walking. PATROL also keeps each unit's current position as the
   * other end of the route; the endpoints swap on every arrival (see `update`).
   *
   * The unit types are mixed freely: villagers may attack-move too, they just
   * never auto-engage (`aggroRadius = 0`), which keeps a wood-cutting crew from
   * charging a passing scout.
   */
  handleAttackMove(client: Client, payload: AttackMovePayload, mode: 'ATTACK_MOVE' | 'PATROL') {
    if (!payload?.unitIds || payload.unitIds.length === 0) return;
    if (payload.unitIds.length > MAX_SELECTION) {
      this.ports.rejectCommand(client, 'Too many units in one command');
      return;
    }
    if (!Number.isFinite(payload.targetGridX) || !Number.isFinite(payload.targetGridY)) {
      this.ports.rejectCommand(client, 'Invalid move target');
      return;
    }

    // Same validate-then-spread order as `handleMoveUnits`: a foreign or repeated
    // id must not leave a hole in the block.
    const ownedUnits = this.collectOwnedUnits(client, payload.unitIds);
    const targets = this.assignFormationTargets(ownedUnits, payload.targetGridX, payload.targetGridY);

    ownedUnits.forEach((unit, idx) => {
      const { x: targetX, y: targetY } = targets[idx];

      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      unit.targetEntityId = '';
      unit.targetEntityType = '';
      unit.previousActionState = '';
      this.ports.setWalkTarget(unit, targetX, targetY);

      if (mode === 'PATROL') {
        // The route starts where the unit stands, so it walks back here once it
        // reaches the clicked point.
        unit.patrolX = unit.x;
        unit.patrolY = unit.y;
      }

      unit.actionState = mode;
    });
  }

  /**
   * CMD-05: sends villagers to work on one of the player's own foundations.
   *
   * The client only says "these units, that building"; the server resolves both
   * against authoritative state, so a foreign foundation is rejected instead of
   * being built for its owner, and non-builders are dropped from the crew rather
   * than being dragged to the site.
   *
   * Each builder is sent to its own point on the ring just outside the footprint
   * (see `getBuildApproachPoint`), which is what stops a three-villager crew from
   * stacking on one tile.
   */
  handleBuildTarget(client: Client, payload: BuildTargetPayload) {
    if (!payload?.unitIds || payload.unitIds.length === 0) return;
    if (payload.unitIds.length > MAX_SELECTION) {
      this.ports.rejectCommand(client, 'Too many units in one command');
      return;
    }

    const building = this.requireOwnedBuilding(client, payload.buildingId);
    if (!building) return;
    if (building.isConstructed) {
      this.ports.rejectCommand(client, 'Building is already finished');
      return;
    }
    if (!BUILDING_BLUEPRINTS[building.type as BuildingType]) {
      this.ports.rejectCommand(client, 'Unknown building type');
      return;
    }

    const builders = this.collectOwnedUnits(client, payload.unitIds).filter(
      (unit) => (UNIT_BLUEPRINTS[unit.type as UnitType]?.buildPower ?? 0) > 0
    );
    if (builders.length === 0) {
      this.ports.rejectCommand(client, 'Only villagers can build');
      return;
    }

    builders.forEach((unit, idx) => {
      const approach = getBuildApproachPoint(unit, building, idx, builders.length);

      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      unit.targetEntityId = building.id;
      unit.targetEntityType = 'building';
      unit.previousActionState = '';
      this.ports.setWalkTarget(unit, approach.x, approach.y);
      unit.actionState = 'BUILDING';
      // Leaving a woodline for a build site must not leave a stale retarget type
      // behind, or a later depleted node would pull the villager back to it.
      this.ports.clearHarvestOrder(unit.id);
    });
  }

  handleHarvestResource(client: Client, payload: HarvestResourcePayload) {
    this.ports.harvestOrder(client, payload);
  }

  /**
   * Halts the given units where they stand.
   *
   * Stop cancels the unit's order (move / attack / harvest) and leaves it at its
   * exact position. `targetX/targetY` are reset to the current position so the
   * movement branch in `update()` has nothing left to walk towards.
   *
   * Per-unit timers are deliberately NOT cleared: they hold unit state, not
   * order state. Dropping the attack cooldown would reset the weapon timer,
   * letting a client spam stop + attack to land a hit every tick instead of
   * every cooldown. Leaving the gather timer alone keeps partial progress.
   *
   * Queued waypoints ARE cleared: they are the remaining part of the cancelled
   * order, so resuming them later would undo the stop.
   */
  handleStopUnits(client: Client, payload: StopUnitsPayload) {
    if (!payload?.unitIds || payload.unitIds.length === 0) return;
    if (payload.unitIds.length > MAX_SELECTION) {
      this.ports.rejectCommand(client, 'Too many units in one command');
      return;
    }

    payload.unitIds.forEach((uId) => {
      const unit = this.state.units.get(uId);
      if (!unit || unit.ownerId !== client.sessionId) return;

      unit.actionState = 'IDLE';
      unit.targetEntityId = '';
      unit.targetEntityType = '';
      unit.previousActionState = '';
      unit.targetX = unit.x;
      unit.targetY = unit.y;
      unit.pathX.clear();
      unit.pathY.clear();
      // SIM-02: the load stays in hand (it was already taken from the world),
      // but the trip to a drop-off is cancelled with everything else.
      unit.dropOffId = '';
      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      this.ports.clearHarvestOrder(unit.id);
    });
  }

  /**
   * Sets where this building's newly trained units should walk to.
   *
   * Only the owner may set it: a foreign building id is refused outright rather
   * than silently ignored, so a client bug surfaces as an error toast instead of
   * a rally point that appears to work. Coordinates are validated against the
   * map bounds because the client sends grid positions straight from the pointer
   * and a stray click outside the terrain would otherwise create an unreachable
   * target that traps every future unit in MOVING forever. Buildings that train
   * nothing are refused too: a rally flag on a House is a promise the simulation
   * can never keep.
   */
  handleSetRallyPoint(client: Client, payload: SetRallyPointPayload) {
    const building = this.requireOwnedBuilding(client, payload?.buildingId);
    if (!building) return;

    if (!canTrainUnitsAt(building.type as BuildingType)) {
      this.ports.rejectCommand(client, 'This building cannot train units');
      return;
    }

    const gridX = Number(payload.gridX);
    const gridY = Number(payload.gridY);
    if (
      !Number.isFinite(gridX) ||
      !Number.isFinite(gridY) ||
      gridX < 0 ||
      gridY < 0 ||
      gridX >= MAP_GRID_WIDTH ||
      gridY >= MAP_GRID_HEIGHT
    ) {
      this.ports.rejectCommand(client, 'Invalid rally point');
      return;
    }

    building.rallyX = gridX;
    building.rallyY = gridY;
  }

  /**
   * Keeps only the units this client actually owns, at most one entry per id.
   *
   * A repeated id would otherwise receive two orders and two formation cells,
   * so the same unit would be counted twice in the block.
   */
  private collectOwnedUnits(client: Client, unitIds: string[]): UnitState[] {
    const owned: UnitState[] = [];
    const seen = new Set<string>();

    unitIds.forEach((uId) => {
      if (seen.has(uId)) return;
      seen.add(uId);

      const unit = this.state.units.get(uId);
      if (unit && unit.ownerId === client.sessionId) owned.push(unit);
    });

    return owned;
  }

  /**
   * Lays `units` out as a centred block around one grid destination (CMD-02) and
   * clamps every cell to the map. Shared by every group order so a squad keeps
   * its shape whether it walks or attack-moves.
   *
   * @returns One destination per input unit, in the same order.
   */
  private assignFormationTargets(
    units: UnitState[],
    destX: number,
    destY: number
  ): Array<{ x: number; y: number }> {
    const offsets = computeFormationOffsets(units.length, FORMATION_SPACING);
    return units.map((_, idx) => ({
      x: Math.max(0, Math.min(MAP_GRID_WIDTH - 1, destX + offsets[idx].x)),
      y: Math.max(0, Math.min(MAP_GRID_HEIGHT - 1, destY + offsets[idx].y))
    }));
  }

  /**
   * Credits a fraction of a blueprint cost back to a player.
   *
   * Each resource is floored separately so a partial refund can never round up
   * into free material. `ratio` is clamped at 1: a refund must never mint
   * resources, whatever a future caller passes.
   */
  private refundResources(player: PlayerState, cost: Resources, ratio: number) {
    if (!(ratio > 0)) return;

    const share = Math.min(1, ratio);
    player.wood += Math.floor(cost.wood * share);
    player.food += Math.floor(cost.food * share);
    player.gold += Math.floor(cost.gold * share);
    player.stone += Math.floor(cost.stone * share);
  }

  /**
   * Resolves a building the client is allowed to command, or rejects the command.
   *
   * Cancelling training, cancelling a foundation and setting a rally point all
   * open with the same existence + ownership checks. Keeping them in one place
   * means a new command cannot forget one and quietly accept a foreign id.
   */
  private requireOwnedBuilding(client: Client, buildingId: string): BuildingState | null {
    if (!buildingId) return null;

    const building = this.state.buildings.get(buildingId);
    if (!building) {
      this.ports.rejectCommand(client, 'Building no longer exists');
      return null;
    }
    if (building.ownerId !== client.sessionId) {
      this.ports.rejectCommand(client, 'Not your building');
      return null;
    }
    return building;
  }
}
