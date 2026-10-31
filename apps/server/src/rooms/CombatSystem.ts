import {
  BuildingBlueprint,
  UNIT_BLUEPRINTS,
  UnitBlueprint,
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
 * CMB-01: how far a `DEFENSIVE` unit may chase an auto-acquired target from the
 * spot where the fight started, in tiles. AoE2's defensive stance is "hold this
 * ground", so the unit walks back to its post instead of following a scout
 * across the map.
 */
const DEFENSIVE_LEASH_TILES = 4;

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
  /**
   * CMB-01: where a `DEFENSIVE` unit stood when it picked a fight on its own.
   * Only auto-acquired fights are leashed — a target the player clicked is a
   * direct order and is pursued anywhere, like AoE2.
   */
  private readonly engageAnchors: Map<string, { x: number; y: number }> = new Map();

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
    // CMB-01: only the two engaging stances pick their own fights. A stand-ground
    // or no-attack unit waits to be told.
    if (unit.stance === 'STAND_GROUND' || unit.stance === 'NO_ATTACK') return;

    const enemy = this.nearestEnemyOf(unit.ownerId, aggroRadius, (other) =>
      Math.hypot(other.x - unit.x, other.y - unit.y)
    );
    if (!enemy) return;

    unit.previousActionState = unit.actionState;
    unit.actionState = 'ATTACKING';
    unit.targetEntityId = enemy.id;
    unit.targetEntityType = 'unit';
    // The leash measures from here, not from the unit's destination: a defensive
    // unit pushed by a patrol has already left its post by the time it engages.
    if (unit.stance === 'DEFENSIVE') {
      this.engageAnchors.set(unit.id, { x: unit.x, y: unit.y });
    }
  }

  /**
   * CMB-01: whether this fight was picked by the unit itself instead of ordered.
   *
   * Every explicit order in the command layer clears `previousActionState`, and
   * only {@link acquireAggroTarget} fills it back in, so a non-empty value here
   * is exactly "auto-acquired".
   */
  private isAutoAcquired(unit: UnitState): boolean {
    return unit.previousActionState === 'ATTACK_MOVE' || unit.previousActionState === 'PATROL';
  }

  /**
   * CMB-01: whether the unit may keep moving towards its attack target this
   * tick.
   *
   * `STAND_GROUND` never steps — that is the whole stance, and it holds even for
   * an enemy the player clicked, which is why an out-of-reach order is dropped
   * instead of walked. `DEFENSIVE` steps freely on an explicit order but stops
   * once chasing a fight of its own carries it past the leash.
   */
  canChaseTarget(unit: UnitState): boolean {
    if (unit.stance === 'STAND_GROUND') return false;
    const anchor = this.engageAnchors.get(unit.id);
    if (unit.stance !== 'DEFENSIVE' || !anchor) return true;
    return Math.hypot(unit.x - anchor.x, unit.y - anchor.y) < DEFENSIVE_LEASH_TILES;
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
    // The leash only spans one engagement; a stale anchor would make the next
    // fight start already out of bounds.
    this.engageAnchors.delete(unit.id);

    if (resume === 'ATTACK_MOVE' || resume === 'PATROL') {
      unit.targetEntityId = '';
      unit.targetEntityType = '';
      unit.actionState = resume;
      return;
    }

    this.ports.resumeQueuedWaypoint(unit);
  }

  /**
   * CMB-01 stance gate for an active attack.
   *
   * `NO_ATTACK` drops a fight the unit picked itself — the stance exists to stop
   * exactly that — while an explicit attack order is still honoured, since the
   * player asked for it. `STAND_GROUND` keeps the fight only while the target is
   * already inside its weapon range. `DEFENSIVE` keeps it until the chase runs
   * past its leash. Both end the order rather than leaving the unit `ATTACKING` a
   * target it will never touch, which would otherwise park it forever.
   */
  private keepsTarget(unit: UnitState, blueprint: UnitBlueprint): boolean {
    if (unit.stance === 'NO_ATTACK' && this.isAutoAcquired(unit)) {
      this.endAttackOrder(unit);
      return false;
    }

    if (unit.stance === 'STAND_GROUND') {
      if (this.isTargetInWeaponRange(unit, blueprint)) return true;
      this.endAttackOrder(unit);
      return false;
    }

    if (unit.stance === 'DEFENSIVE' && !this.canChaseTarget(unit)) {
      this.endAttackOrder(unit);
      return false;
    }

    return true;
  }

  /**
   * Distance in tiles from the unit to its current target, or null when the
   * target is gone. A building is measured to the centre of its footprint, which
   * is how every other range check in this file measures it.
   */
  private distanceToTarget(unit: UnitState): number | null {
    if (unit.targetEntityType === 'unit') {
      const target = this.state.units.get(unit.targetEntityId);
      if (!target) return null;
      return Math.hypot(target.x - unit.x, target.y - unit.y);
    }

    if (unit.targetEntityType === 'building') {
      const target = this.state.buildings.get(unit.targetEntityId);
      if (!target) return null;
      const centerX = target.gridX + target.sizeX / 2;
      const centerY = target.gridY + target.sizeY / 2;
      return Math.hypot(centerX - unit.x, centerY - unit.y);
    }

    return null;
  }

  /**
   * Weapon range against the current target type. A unit is hit from half a tile
   * around its centre, a building from one and a half around its footprint, so
   * the reach feels the same against a 1x1 tower and a 4x4 town centre.
   */
  private attackRangeAgainstTarget(unit: UnitState, blueprint: UnitBlueprint): number {
    return blueprint.attackRange + (unit.targetEntityType === 'building' ? 1.5 : 0.5);
  }

  /** Whether the target sits inside weapon range right now. */
  private isTargetInWeaponRange(unit: UnitState, blueprint: UnitBlueprint): boolean {
    const dist = this.distanceToTarget(unit);
    return dist !== null && dist <= this.attackRangeAgainstTarget(unit, blueprint);
  }

  /** Per-tick work for a unit that is chasing or striking its target. */
  updateUnitCombat(unit: UnitState, deltaTime: number) {
    const blueprint = UNIT_BLUEPRINTS[unit.type as UnitType];
    if (!blueprint) return;

    // CMB-01 before the cooldown: a stance that has given up should not keep a
    // weapon timer parked against a target it is no longer fighting.
    if (!this.keepsTarget(unit, blueprint)) return;

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

      if (!this.isTargetInWeaponRange(unit, blueprint)) return;

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

      if (!this.isTargetInWeaponRange(unit, blueprint)) return;

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
    this.engageAnchors.delete(unitId);
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
