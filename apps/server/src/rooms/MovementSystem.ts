import { MAP_GRID_HEIGHT, MAP_GRID_WIDTH } from '@chien-quoc/shared';
import { BuildingState } from '../schema/BuildingState.js';
import { ResourceNodeState } from '../schema/ResourceNodeState.js';
import { UnitState } from '../schema/UnitState.js';
import { WorldState } from '../schema/WorldState.js';
import { Pathfinder } from '../services/Pathfinder.js';

/**
 * SIM-01: how many path requests one tick may compute. A 220x220 corner-to-
 * corner search measures ~0.9 ms, so a 120-unit order would be a ~100 ms stall
 * if it were answered in one tick; spreading it over ticks keeps the simulation
 * at its 20 Hz cadence and every unit walks the straight line until its route
 * is ready.
 */
const MAX_PATHS_PER_TICK = 12;

/** Wall-clock budget for pathfinding inside one tick, in ms. */
const PATH_BUDGET_MS = 3;

/**
 * The blocked grid is rebuilt when the number of buildings or resource nodes
 * changes, and at least this often — a cheap safety net for anything that
 * changes a footprint without changing those counts.
 */
const BLOCKED_GRID_MAX_AGE_MS = 1000;

/**
 * Minimum gap between two obstacle-triggered re-routes for one unit, in
 * milliseconds. A route whose every alternative is walled off would otherwise be
 * re-searched on every tick: the search returns straight-line, the next tile is
 * still blocked, and the unit burns its share of the per-tick path budget
 * forever. Five hundred ms is invisible to the player and caps a stuck unit at
 * two searches per second.
 */
const REPATH_COOLDOWN_MS = 500;

/**
 * Routing, waypoint queues and the movement half of every order (SIM-01,
 * CTL-05).
 *
 * The state lives in the room (`WorldState`); this class owns the route cache
 * and the queue of units waiting for one. Nothing here is persisted: after a
 * restart a unit that was mid-route keeps its `targetX/targetY` and walks the
 * straight line until its next order, which is the documented backlog gap.
 *
 * It needs no ports: every mutation is on the unit it was handed, so nothing
 * calls back into the room.
 */
export class MovementSystem {
  /** SIM-01: reused across searches; see `Pathfinder`. */
  private readonly pathfinder = new Pathfinder();
  private blockedGrid: Uint8Array | null = null;
  private blockedGridBuildingCount = -1;
  private blockedGridResourceCount = -1;
  private blockedGridBuiltAt = 0;
  /** Unit ids waiting for a route, oldest first. `pendingPathIds` dedupes. */
  private pendingPaths: string[] = [];
  private pendingPathIds: Set<string> = new Set();
  /** Last obstacle-triggered re-route per unit, for `REPATH_COOLDOWN_MS`. */
  private readonly lastRepathAt: Map<string, number> = new Map();

  constructor(private readonly state: WorldState) {}

  /**
   * Gives a unit a new walking destination and queues a fresh route to it.
   *
   * Every order that moves a unit goes through here, so a stale route cannot
   * survive a new order: the old waypoints are dropped immediately and the new
   * one is computed on an upcoming tick. Nothing is queued for a destination the
   * unit is already standing on.
   */
  setWalkTarget(unit: UnitState, targetX: number, targetY: number) {
    unit.targetX = targetX;
    unit.targetY = targetY;
    unit.pathX.clear();
    unit.pathY.clear();

    if (Math.hypot(targetX - unit.x, targetY - unit.y) < 0.01) return;

    if (this.pendingPathIds.has(unit.id)) return;
    this.pendingPathIds.add(unit.id);
    this.pendingPaths.push(unit.id);
  }

  /**
   * Pops the next queued waypoint into the unit's active movement order.
   *
   * The two arrays are always written together, so a length mismatch can only
   * come from a corrupted snapshot; when it happens the queue is dropped rather
   * than half-applied.
   *
   * @returns true when a waypoint was consumed and the unit is now MOVING.
   */
  advanceQueuedWaypoint(unit: UnitState): boolean {
    if (unit.queueTargetX.length !== unit.queueTargetY.length) {
      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      return false;
    }
    if (unit.queueTargetX.length === 0) return false;

    const nextX = unit.queueTargetX.shift();
    const nextY = unit.queueTargetY.shift();
    if (typeof nextX !== 'number' || typeof nextY !== 'number') {
      unit.queueTargetX.clear();
      unit.queueTargetY.clear();
      return false;
    }

    this.setWalkTarget(unit, nextX, nextY);
    unit.targetEntityId = '';
    unit.targetEntityType = '';
    unit.actionState = 'MOVING';
    return true;
  }

  /**
   * Ends the unit's current order and starts the next queued waypoint, if any.
   *
   * Called wherever an order finishes or becomes invalid (arrival, target gone,
   * resource depleted). Without it a Shift-queued path would be stranded: the
   * waypoints would sit in the snapshot and never run, because nothing else ever
   * consumes them.
   */
  resumeQueuedWaypoint(unit: UnitState) {
    unit.targetEntityId = '';
    unit.targetEntityType = '';
    unit.previousActionState = '';
    if (!this.advanceQueuedWaypoint(unit)) {
      unit.actionState = 'IDLE';
    }
  }

  /**
   * Drops everything this system remembers about a unit.
   *
   * Only the re-route cooldown is per-unit state here; the route itself lives on
   * the unit, so a dead id must not keep a timestamp alive for the lifetime of
   * the room.
   */
  forgetUnit(unitId: string) {
    this.lastRepathAt.delete(unitId);
  }

  /**
   * Invalidates a route whose next tile has become an obstacle.
   *
   * Paths are computed when an order arrives, so a building placed across a
   * unit's remaining route is not seen by anyone: the unit keeps following the
   * stale waypoints and walks through the new wall. Called once per tick per
   * moving unit, before the movement step, so the tile the unit is about to enter
   * is checked against the same blocked grid the search uses. A hit drops the
   * route and queues a fresh search; the unit walks straight for the tick or two
   * the search needs, exactly like a failed search.
   *
   * @returns true when a new route was requested.
   */
  refreshRouteIfBlocked(unit: UnitState): boolean {
    if (unit.pathX.length === 0 || unit.pathY.length === 0) return false;

    const nextX = Math.floor(unit.pathX[0]);
    const nextY = Math.floor(unit.pathY[0]);
    if (!this.isBlockedTile(nextX, nextY)) return false;

    const now = performance.now();
    const lastRepath = this.lastRepathAt.get(unit.id);
    // Only a *previous* re-route throttles: an untracked unit must be re-routed
    // immediately, and `performance.now()` can legitimately be below the cooldown
    // in a fresh process (tests) or after a page reload.
    if (lastRepath !== undefined && now - lastRepath < REPATH_COOLDOWN_MS) return false;
    this.lastRepathAt.set(unit.id, now);

    this.setWalkTarget(unit, unit.targetX, unit.targetY);
    return true;
  }

  /** Whether one tile of the cached blocked grid is an obstacle. */
  private isBlockedTile(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= MAP_GRID_WIDTH || y >= MAP_GRID_HEIGHT) return false;
    return this.getBlockedGrid()[y * MAP_GRID_WIDTH + x] === 1;
  }

  /**
   * Answers a bounded number of queued path requests per tick.
   *
   * The goal is read from the unit's own target rather than from the request, so
   * a unit re-ordered while it waits for a route is routed to its current
   * destination instead of the one it asked for earlier.
   */
  processPendingPaths() {
    if (this.pendingPaths.length === 0) return;

    const blocked = this.getBlockedGrid();
    const deadline = performance.now() + PATH_BUDGET_MS;
    let computed = 0;

    while (this.pendingPaths.length > 0 && computed < MAX_PATHS_PER_TICK) {
      const unitId = this.pendingPaths.shift() as string;
      this.pendingPathIds.delete(unitId);

      const unit = this.state.units.get(unitId);
      if (!unit) continue;
      computed++;

      const route = this.pathfinder.findPath(
        { x: unit.x, y: unit.y },
        { x: unit.targetX, y: unit.targetY },
        blocked
      );

      unit.pathX.clear();
      unit.pathY.clear();
      // No route (walled in, or the search hit its budget): the unit walks the
      // straight line, which is the pre-SIM-01 behaviour.
      if (!route) continue;

      for (const point of route) {
        unit.pathX.push(point.x);
        unit.pathY.push(point.y);
      }

      if (performance.now() >= deadline) break;
    }
  }

  /**
   * Current blocked-tile snapshot, rebuilt only when the world changed shape.
   *
   * Paths are only computed when an order arrives and in bounded batches, so the
   * rebuild is off the per-tick path entirely; the age check is a safety net for
   * a footprint that changes without the building count changing.
   */
  private getBlockedGrid(): Uint8Array {
    const buildingCount = this.state.buildings.size;
    const resourceCount = this.state.resourceNodes.size;
    const stale =
      this.blockedGrid === null ||
      this.blockedGridBuildingCount !== buildingCount ||
      this.blockedGridResourceCount !== resourceCount ||
      performance.now() - this.blockedGridBuiltAt > BLOCKED_GRID_MAX_AGE_MS;

    if (!stale) return this.blockedGrid as Uint8Array;

    const grid = this.blockedGrid ?? new Uint8Array(MAP_GRID_WIDTH * MAP_GRID_HEIGHT);
    grid.fill(0);

    this.state.buildings.forEach((building: BuildingState) => {
      const endX = Math.min(MAP_GRID_WIDTH, building.gridX + building.sizeX);
      const endY = Math.min(MAP_GRID_HEIGHT, building.gridY + building.sizeY);
      for (let y = Math.max(0, building.gridY); y < endY; y++) {
        for (let x = Math.max(0, building.gridX); x < endX; x++) {
          grid[y * MAP_GRID_WIDTH + x] = 1;
        }
      }
    });

    this.state.resourceNodes.forEach((node: ResourceNodeState) => {
      if (node.remainingAmount <= 0) return;
      if (node.gridX < 0 || node.gridY < 0) return;
      if (node.gridX >= MAP_GRID_WIDTH || node.gridY >= MAP_GRID_HEIGHT) return;
      grid[node.gridY * MAP_GRID_WIDTH + node.gridX] = 1;
    });

    this.blockedGrid = grid;
    this.blockedGridBuildingCount = buildingCount;
    this.blockedGridResourceCount = resourceCount;
    this.blockedGridBuiltAt = performance.now();

    return grid;
  }
}
