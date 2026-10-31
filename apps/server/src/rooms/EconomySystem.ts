import { Client } from '@colyseus/core';
import {
  BUILDING_BLUEPRINTS,
  BuildingType,
  HarvestResourcePayload,
  MAX_SELECTION,
  ResourceType,
  UnitType,
  UNIT_BLUEPRINTS
} from '@chien-quoc/shared';
import { BuildingState } from '../schema/BuildingState.js';
import { PlayerState } from '../schema/PlayerState.js';
import { ResourceNodeState } from '../schema/ResourceNodeState.js';
import { UnitState } from '../schema/UnitState.js';
import { WorldState } from '../schema/WorldState.js';
import { approachPointOutsideFootprint } from './construction.js';
import { distanceToFootprint } from './geometry.js';

/**
 * What the economy system needs from the rest of the room. Kept as an interface
 * so this module owns gathering, carrying and drop-off logic without knowing how
 * orders move units or how errors reach the client.
 */
export interface EconomyPorts {
  /** Replaces the unit's route with one to this point (SIM-01). */
  setWalkTarget(unit: UnitState, targetX: number, targetY: number): void;
  /** Falls back to the next queued waypoint, or IDLE. */
  resumeQueuedWaypoint(unit: UnitState): void;
  /** Sends an `ERROR_NOTIFICATION` to the client. */
  rejectCommand(client: Client, message: string): void;
}

/**
 * Search radius, in tiles, for the next resource node of the same type once a
 * villager empties its current one (CMD-06). Ten tiles covers the gap between
 * neighbouring forest patches without letting a villager cross the whole map.
 */
const HARVEST_RETARGET_RADIUS = 10;

/**
 * Units a villager takes off a node per second of harvesting. One second's worth
 * fills a starting villager's carry capacity (10), so the walk to a drop-off and
 * back — not the gathering — is what limits the economy.
 */
const GATHER_AMOUNT_PER_SECOND = 10;

/** How close to a node a villager has to stand to harvest it, in tiles. */
const HARVEST_RANGE = 1.5;

/**
 * How close to a drop-off's footprint edge a villager has to be for the load to
 * be banked. Matches the build range on purpose: both mean "standing next to the
 * building", and the approach point is only 0.5 tiles outside the footprint.
 */
const DROP_OFF_RANGE = 1.5;

/** Distance outside the footprint a villager walks to in order to unload. */
const DROP_OFF_APPROACH_DISTANCE = 0.5;

/**
 * Gathering, carrying and banking (CMD-06 + SIM-02).
 *
 * The state lives in the room (`WorldState`); this class owns the rules and the
 * two per-unit maps that make them work: the gather timer and the resource type
 * a unit should retarget to when its node runs dry. Both are transient — nothing
 * here is persisted, so after a restart the type is re-seeded from the unit's
 * current node and the timer restarts at zero.
 */
export class EconomySystem {
  /** Elapsed milliseconds since each villager last took resources, by unit id. */
  private readonly gatherTimers: Map<string, number> = new Map();
  /** Resource type each villager should look for again, by unit id. */
  private readonly harvestTypeByUnit: Map<string, string> = new Map();

  constructor(
    private readonly state: WorldState,
    private readonly ports: EconomyPorts
  ) {}

  /** CMD-06: points the given villagers at a resource node. */
  handleHarvestOrder(client: Client, payload: HarvestResourcePayload) {
    if (!payload?.unitIds || payload.unitIds.length === 0) return;
    if (payload.unitIds.length > MAX_SELECTION) {
      this.ports.rejectCommand(client, 'Too many units in one command');
      return;
    }

    const resource = this.state.resourceNodes.get(payload.resourceNodeId);
    if (!resource) {
      this.ports.rejectCommand(client, 'Resource node no longer exists');
      return;
    }
    if (resource.remainingAmount <= 0) {
      this.ports.rejectCommand(client, 'Resource node is depleted');
      return;
    }

    payload.unitIds.forEach((uId) => {
      const unit = this.state.units.get(uId);
      if (!unit || unit.ownerId !== client.sessionId) return;
      if (!UNIT_BLUEPRINTS[unit.type as UnitType]?.canHarvest) return;

      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      unit.targetEntityId = payload.resourceNodeId;
      unit.targetEntityType = 'resource';
      this.ports.setWalkTarget(unit, resource.gridX, resource.gridY);
      unit.actionState = 'HARVESTING';
      unit.previousActionState = '';
      // Remember the type so a depleted node can hand the villager to the
      // nearest node of the same kind instead of leaving it idle (CMD-06).
      this.harvestTypeByUnit.set(unit.id, resource.resourceType);
    });
  }

  /** Per-tick work for a unit that is harvesting or carrying a load home. */
  updateUnit(unit: UnitState, deltaTime: number) {
    if (unit.actionState === 'HARVESTING') this.processGathering(unit, deltaTime);
    else if (unit.actionState === 'RETURNING') this.processReturning(unit);
  }

  /**
   * Drops everything this system remembers about a unit.
   *
   * Called when a unit dies or leaves, so neither map grows with dead ids and a
   * recycled id cannot inherit a stale target type.
   */
  forgetUnit(unitId: string) {
    this.gatherTimers.delete(unitId);
    this.harvestTypeByUnit.delete(unitId);
  }

  /**
   * Drops the retarget type for a unit that was given a different order.
   *
   * Without this, a villager sent from a woodline to a build site would walk
   * back to the forest the next time a node ran dry.
   */
  clearHarvestOrder(unitId: string) {
    this.gatherTimers.delete(unitId);
    this.harvestTypeByUnit.delete(unitId);
  }

  private processGathering(unit: UnitState, deltaTime: number) {
    const carryCapacity = UNIT_BLUEPRINTS[unit.type as UnitType]?.carryCapacity ?? 0;
    if (carryCapacity <= 0) return;

    // SIM-02: a villager holding a full load banks it instead of harvesting over
    // it. This is also the exit for anyone restored mid-order after a restart.
    if (unit.carryingAmount >= carryCapacity) {
      this.startReturning(unit);
      return;
    }

    const resource = this.state.resourceNodes.get(unit.targetEntityId);
    if (!resource) {
      // Another villager may have emptied this node while this one was walking
      // to it. Bank whatever is already carried before looking for a new node.
      if (unit.carryingAmount > 0) {
        this.startReturning(unit);
        return;
      }
      this.giveUpOrRetarget(unit);
      return;
    }

    // Re-seed after a restart, where the order was restored but the transient
    // map was not, so the unit can still retarget instead of stopping.
    if (!this.harvestTypeByUnit.has(unit.id)) {
      this.harvestTypeByUnit.set(unit.id, resource.resourceType);
    }

    // The carry slot remembers one type only, so a villager ordered from a wood
    // line to a gold mine banks the wood first instead of turning it into gold.
    if (unit.carryingAmount > 0 && unit.carryingResourceType !== resource.resourceType) {
      this.startReturning(unit);
      return;
    }

    const dist = Math.hypot(resource.gridX - unit.x, resource.gridY - unit.y);
    if (dist > HARVEST_RANGE) return;

    const gatherTimer = (this.gatherTimers.get(unit.id) ?? 0) + deltaTime;
    if (gatherTimer < 1000) {
      this.gatherTimers.set(unit.id, gatherTimer);
      return;
    }
    this.gatherTimers.set(unit.id, 0);

    const taken = Math.min(
      GATHER_AMOUNT_PER_SECOND,
      resource.remainingAmount,
      carryCapacity - unit.carryingAmount
    );

    if (taken > 0) {
      resource.remainingAmount -= taken;
      unit.carryingAmount += taken;
      unit.carryingResourceType = resource.resourceType;
    }

    if (resource.remainingAmount <= 0) {
      this.state.resourceNodes.delete(resource.id);
      // AoE behaviour: bank what is in hand, then walk to the next node of the
      // same type instead of standing idle next to an empty stump.
      if (unit.carryingAmount > 0) this.startReturning(unit);
      else this.giveUpOrRetarget(unit);
      return;
    }

    if (unit.carryingAmount >= carryCapacity) this.startReturning(unit);
  }

  /**
   * SIM-02: sends a loaded villager to the closest building that accepts what it
   * carries.
   *
   * `targetEntityId` keeps pointing at the resource node so the unit knows where
   * to go back to; `dropOffId` is what the return trip targets. With nowhere to
   * unload, the villager stops holding its load instead of the resources
   * evaporating into nothing.
   */
  private startReturning(unit: UnitState) {
    const dropOff = this.findNearestDropOff(unit, unit.carryingResourceType);

    if (!dropOff) {
      unit.dropOffId = '';
      unit.actionState = 'IDLE';
      unit.targetX = unit.x;
      unit.targetY = unit.y;
      unit.pathX.clear();
      unit.pathY.clear();
      return;
    }

    unit.dropOffId = dropOff.id;
    unit.actionState = 'RETURNING';
    const approach = approachPointOutsideFootprint(unit, dropOff, 0, 1, DROP_OFF_APPROACH_DISTANCE);
    this.ports.setWalkTarget(unit, approach.x, approach.y);
  }

  /** Closest finished building of the unit's owner that accepts `resourceType`. */
  private findNearestDropOff(unit: UnitState, resourceType: string): BuildingState | null {
    if (!resourceType) return null;

    let nearest: BuildingState | null = null;
    let nearestDist = Infinity;

    this.state.buildings.forEach((building: BuildingState) => {
      if (building.ownerId !== unit.ownerId || !building.isConstructed) return;

      const blueprint = BUILDING_BLUEPRINTS[building.type as BuildingType];
      if (!blueprint || !blueprint.dropOffs.includes(resourceType as ResourceType)) return;

      const dist = distanceToFootprint(unit.x, unit.y, building);
      if (dist < nearestDist) {
        nearest = building;
        nearestDist = dist;
      }
    });

    return nearest;
  }

  /**
   * SIM-02: banks the load once the villager reaches its drop-off, then sends it
   * back to the node it came from.
   *
   * The drop-off is re-read from state every tick, so a building destroyed while
   * the villager is walking there never pays out: the trip is re-planned against
   * another drop-off, or the villager stops holding the load when none is left.
   */
  private processReturning(unit: UnitState) {
    const dropOff = this.state.buildings.get(unit.dropOffId);
    const accepts =
      !!dropOff &&
      dropOff.isConstructed &&
      dropOff.ownerId === unit.ownerId &&
      (BUILDING_BLUEPRINTS[dropOff.type as BuildingType]?.dropOffs.includes(
        unit.carryingResourceType as ResourceType
      ) ?? false);

    if (!accepts) {
      this.startReturning(unit);
      return;
    }

    if (distanceToFootprint(unit.x, unit.y, dropOff) > DROP_OFF_RANGE) return;

    const player = this.state.players.get(unit.ownerId);
    if (!player) return;

    if (unit.carryingAmount > 0) {
      this.creditResource(player, unit.carryingResourceType, unit.carryingAmount);
      unit.carryingAmount = 0;
      unit.carryingResourceType = '';
    }
    unit.dropOffId = '';

    const node = this.state.resourceNodes.get(unit.targetEntityId);
    if (node) {
      unit.actionState = 'HARVESTING';
      this.ports.setWalkTarget(unit, node.gridX, node.gridY);
    } else {
      this.giveUpOrRetarget(unit);
    }
  }

  /** Adds `amount` of `resourceType` to a player's stockpile. */
  private creditResource(player: PlayerState, resourceType: string, amount: number) {
    if (amount <= 0) return;

    if (resourceType === 'wood') player.wood += amount;
    else if (resourceType === 'food') player.food += amount;
    else if (resourceType === 'gold') player.gold += amount;
    else if (resourceType === 'stone') player.stone += amount;
  }

  /** Moves the villager to the next node of the same type, or ends the order. */
  private giveUpOrRetarget(unit: UnitState) {
    if (this.retargetHarvest(unit)) return;
    this.harvestTypeByUnit.delete(unit.id);
    this.ports.resumeQueuedWaypoint(unit);
  }

  /**
   * Hands the villager to the closest node of the type it was working.
   *
   * @returns false when there is nothing to retarget to (or a queued waypoint
   *   means the player already decided where the unit goes next).
   */
  private retargetHarvest(unit: UnitState): boolean {
    if (unit.queueTargetX.length > 0) return false;

    const resourceType = this.harvestTypeByUnit.get(unit.id);
    if (!resourceType) return false;

    const node = this.findNearestResource(unit, resourceType, HARVEST_RETARGET_RADIUS);
    if (!node) return false;

    unit.targetEntityId = node.id;
    unit.targetEntityType = 'resource';
    this.ports.setWalkTarget(unit, node.gridX, node.gridY);
    unit.actionState = 'HARVESTING';
    return true;
  }

  private findNearestResource(unit: UnitState, resourceType: string, radius: number): ResourceNodeState | null {
    let nearest: ResourceNodeState | null = null;
    let nearestDist = radius;

    this.state.resourceNodes.forEach((node: ResourceNodeState) => {
      if (node.resourceType !== resourceType || node.remainingAmount <= 0) return;
      const dist = Math.hypot(node.gridX - unit.x, node.gridY - unit.y);
      if (dist <= nearestDist) {
        nearest = node;
        nearestDist = dist;
      }
    });

    return nearest;
  }
}
