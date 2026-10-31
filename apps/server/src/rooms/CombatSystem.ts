import {
  BuildingBlueprint,
  UNIT_BLUEPRINTS,
  UnitType
} from '@chien-quoc/shared';
import { BuildingState } from '../schema/BuildingState.js';
import { UnitState } from '../schema/UnitState.js';
import { WorldState } from '../schema/WorldState.js';
import { distanceToFootprint } from './geometry.js';

/**
 * What the combat system needs from the rest of the room. Kept as an interface
 * so this module owns damage, cooldowns and target resolution without knowing
 * how orders move units or how economy state is tracked.
 */
export interface CombatPorts {
  /** Falls back to the next queued waypoint, or IDLE. */
  resumeQueuedWaypoint(unit: UnitState): void;
  /** Drops transient per-unit state owned by another system (economy). */
  forgetEconomyState(unitId: string): void;
  /** Drops transient per-unit state owned by the movement system. */
  forgetMovementState(unitId: string): void;
  /** Recomputed when a unit is removed from the world. */
  updatePlayerPopulation(ownerId: string): void;
}

/**
 * Melee combat for units and ranged fire for defensive buildings (CMD-01,
 * SIM-03).
 *
 * The state lives in the room (`WorldState`); this class owns the rules and the
 * two cooldown maps that make them work: one keyed by unit id, one by building
 * id. Both are transient — nothing here is persisted, so after a restart every
 * attack is ready immediately, which costs at most one shot.
 */
export class CombatSystem {
  /**
   * Remaining cooldown before each unit may strike again, by unit id.
   *
   * A unit that dies is removed from this map by {@link forgetUnit}, so a dead
   * id cannot sit here forever and a recycled id cannot inherit a cooldown.
   */
  private readonly attackTimers: Map<string, number> = new Map();
  /**
   * Remaining cooldown per defensive building, keyed by building id. Separate
   * from `attackTimers` because that map is keyed by unit id and only touched
   * by {@link updateUnitCombat}.
   */
  private readonly towerTimers: Map<string, number> = new Map();

  constructor(
    private readonly state: WorldState,
    private readonly ports: CombatPorts
  ) {}

  /**
   * CMD-01: before taking a step, an attack-moving or patrolling unit checks for
   * the closest enemy inside its aggro radius. Switching to ATTACKING parks the
   * current order in `previousActionState` so the unit picks it up again once
   * the fight is over.
   */
  acquireAggroTarget(unit: UnitState, aggroRadius: number) {
    if (unit.actionState !== 'ATTACK_MOVE' && unit.actionState !== 'PATROL') return;
    if (aggroRadius <= 0) return;

    const enemy = this.nearestEnemyOf(unit.ownerId, aggroRadius, (other) =>
      Math.hypot(other.x - unit.x, other.y - unit.y)
    );
    if (!enemy) return;

    unit.previousActionState = unit.actionState;
    unit.actionState = 'ATTACKING';
    unit.targetEntityId = enemy.id;
    unit.targetEntityType = 'unit';
  }

  /**
   * Whether the unit's attack target still exists in the snapshot. A unit with no
   * target at all counts as gone, so an `ATTACKING` state can never survive
   * without something to hit.
   */
  isTargetAlive(unit: UnitState): boolean {
    if (!unit.targetEntityId) return false;
    if (unit.targetEntityType === 'unit') return this.state.units.has(unit.targetEntityId);
    if (unit.targetEntityType === 'building') return this.state.buildings.has(unit.targetEntityId);
    return false;
  }

  /**
   * Ends a fight (CMD-01).
   *
   * The unit remembers what it was doing before it engaged in
   * `previousActionState`: an attack-move keeps walking to its destination, a
   * patrol keeps walking its route. Anything else falls back to the queued
   * waypoints, exactly like a finished plain attack.
   */
  endAttackOrder(unit: UnitState) {
    const resume = unit.previousActionState;
    unit.previousActionState = '';

    if (resume === 'ATTACK_MOVE' || resume === 'PATROL') {
      unit.targetEntityId = '';
      unit.targetEntityType = '';
      unit.actionState = resume;
      return;
    }

    this.ports.resumeQueuedWaypoint(unit);
  }

  /** Per-tick work for a unit that is chasing or striking its target. */
  updateUnitCombat(unit: UnitState, deltaTime: number) {
    const blueprint = UNIT_BLUEPRINTS[unit.type as UnitType];
    if (!blueprint) return;

    const remainingCooldown = (this.attackTimers.get(unit.id) ?? 0) - deltaTime;

    if (remainingCooldown > 0) {
      this.attackTimers.set(unit.id, remainingCooldown);
      return;
    }

    if (unit.targetEntityType === 'unit') {
      const targetUnit = this.state.units.get(unit.targetEntityId);
      if (!targetUnit || targetUnit.ownerId === unit.ownerId) {
        // Target died or changed hands: the order is over.
        this.endAttackOrder(unit);
        return;
      }

      const dist = Math.hypot(targetUnit.x - unit.x, targetUnit.y - unit.y);
      if (dist > blueprint.attackRange + 0.5) return;

      targetUnit.hp -= blueprint.attackPower;
      this.attackTimers.set(unit.id, blueprint.attackCooldownMs);

      if (targetUnit.hp <= 0) {
        this.killUnit(targetUnit);
        // The attacker resumes its stored order on this same tick, like before
        // the split: waiting for the next tick's liveness check would leave it
        // ATTACKING a target that no longer exists for one tick (50 ms).
        this.endAttackOrder(unit);
      }
      return;
    }

    if (unit.targetEntityType === 'building') {
      const targetBuilding = this.state.buildings.get(unit.targetEntityId);
      if (!targetBuilding || targetBuilding.ownerId === unit.ownerId) {
        // Building destroyed or captured by its owner: order over.
        this.endAttackOrder(unit);
        return;
      }

      const centerX = targetBuilding.gridX + targetBuilding.sizeX / 2;
      const centerY = targetBuilding.gridY + targetBuilding.sizeY / 2;
      const dist = Math.hypot(centerX - unit.x, centerY - unit.y);
      if (dist > blueprint.attackRange + 1.5) return;

      targetBuilding.hp -= blueprint.attackPower;
      this.attackTimers.set(unit.id, blueprint.attackCooldownMs);

      if (targetBuilding.hp <= 0) {
        this.destroyBuilding(targetBuilding);
        this.endAttackOrder(unit);
      }
    }
  }

  /**
   * SIM-03: fires a defensive building's shot at the closest enemy unit in range.
   *
   * The cooldown counts down every tick and is only reset when a shot actually
   * lands, so a tower that had nothing to shoot fires the moment a target walks
   * in instead of waiting out a timer it never used.
   */
  updateTowerCombat(building: BuildingState, deltaTime: number, blueprint: BuildingBlueprint) {
    const remainingCooldown = (this.towerTimers.get(building.id) ?? 0) - deltaTime;

    if (remainingCooldown > 0) {
      this.towerTimers.set(building.id, remainingCooldown);
      return;
    }

    const target = this.nearestEnemyOf(building.ownerId, blueprint.attackRange, (other) =>
      distanceToFootprint(other.x, other.y, building)
    );
    if (!target) {
      // Ready, but nothing in range: stay at zero so the next arrival is shot
      // immediately rather than after a fresh cooldown.
      this.towerTimers.set(building.id, 0);
      return;
    }

    target.hp -= blueprint.attackPower;
    this.towerTimers.set(building.id, blueprint.attackCooldownMs);

    if (target.hp <= 0) this.killUnit(target);
  }

  /**
   * Drops everything this system remembers about a unit.
   *
   * Called whenever a unit leaves the world, so the cooldown map cannot grow
   * with dead ids and a recycled id cannot inherit a stale cooldown.
   */
  forgetUnit(unitId: string) {
    this.attackTimers.delete(unitId);
  }

  /** Drops the cooldown of a building that was destroyed or cancelled. */
  forgetBuilding(buildingId: string) {
    this.towerTimers.delete(buildingId);
  }

  /** Removes a dead unit and everything keyed to it. */
  private killUnit(victim: UnitState) {
    const ownerId = victim.ownerId;
    this.state.units.delete(victim.id);
    this.forgetUnit(victim.id);
    this.ports.forgetEconomyState(victim.id);
    this.ports.forgetMovementState(victim.id);
    this.ports.updatePlayerPopulation(ownerId);
  }

  private destroyBuilding(building: BuildingState) {
    const ownerId = building.ownerId;
    this.state.buildings.delete(building.id);
    this.forgetBuilding(building.id);
    this.ports.updatePlayerPopulation(ownerId);
  }

  /**
   * Closest enemy unit the caller's distance function puts inside `radius`, or
   * null.
   *
   * The two callers measure distance differently on purpose: a unit measures
   * from its own centre (soldiers engage at body distance), a building from its
   * footprint edge (so `attackRange` means the same thing for a 1x1 tower and a
   * 4x4 town centre). Only the unit scan is shared; the metric is a parameter.
   *
   * Ties go to the last such unit, which is what `<=` here always did.
   */
  private nearestEnemyOf(
    ownerId: string,
    radius: number,
    distanceOf: (enemy: UnitState) => number
  ): UnitState | null {
    let nearest: UnitState | null = null;
    let nearestDist = radius;

    this.state.units.forEach((other: UnitState) => {
      if (other.ownerId === ownerId) return;
      const dist = distanceOf(other);
      if (dist <= nearestDist) {
        nearest = other;
        nearestDist = dist;
      }
    });

    return nearest;
  }
}
