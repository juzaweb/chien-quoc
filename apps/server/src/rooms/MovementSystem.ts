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
