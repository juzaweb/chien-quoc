import { MAP_GRID_HEIGHT, MAP_GRID_WIDTH } from '@chien-quoc/shared';

export interface GridPoint {
  x: number;
  y: number;
}

/**
 * 4-way movement only. Diagonal steps would let a unit squeeze between two
 * buildings that touch by a corner, which reads as walking through walls.
 */
const NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];

/**
 * Hard cap on how many cells one search may expand. A 220x220 map is 48,400
 * cells; refusing to expand more than this keeps a pathological request (a unit
 * boxed into a walled pocket) from stalling the tick. Returning `null` is the
 * "walk straight" fallback, which is the same behaviour the game had before
 * pathfinding existed.
 */
const MAX_EXPANSIONS = 20000;

/** How far the goal may be nudged off a blocked tile, in tiles. */
const GOAL_SNAP_RADIUS = 3;

/**
 * A* over the world's tile grid.
 *
 * One instance is reused for the whole room: the working arrays (cost, parent,
 * membership stamps) are allocated once per map size and reused across searches,
 * with a generation counter standing in for clearing them. Allocating a fresh
 * 48k-cell set per request would cost more than the search itself.
 *
 * The heuristic is Manhattan rather than octile because movement is 4-way;
 * octile is admissible but overestimates the cost of the remaining diagonal,
 * which costs extra expansions for no benefit.
 */
export class Pathfinder {
  readonly width: number;
  readonly height: number;

  private readonly gScore: Float32Array;
  private readonly fScore: Float32Array;
  private readonly parent: Int32Array;
  private readonly settledStamp: Int32Array;
  private readonly queuedStamp: Int32Array;
  private searchId = 0;

  /** Binary min-heap of cell indices, ordered by `fScore`. */
  private readonly heap: Int32Array;
  private heapSize = 0;

  constructor(width: number = MAP_GRID_WIDTH, height: number = MAP_GRID_HEIGHT) {
    this.width = width;
    this.height = height;

    const cells = width * height;
    this.gScore = new Float32Array(cells);
    this.fScore = new Float32Array(cells);
    this.parent = new Int32Array(cells);
    this.settledStamp = new Int32Array(cells);
    this.queuedStamp = new Int32Array(cells);
    // Duplicates are allowed (a cheaper route to a queued cell pushes it again
    // and the stale entry is skipped on pop). With a consistent heuristic each
    // cell is settled once and relaxed once per neighbour, so 4 re-pushes per
    // cell is the bound; 5 leaves headroom and costs ~1 MB on a 220x220 map.
    this.heap = new Int32Array(cells * 5);
  }

  /**
   * Finds a walkable route between two continuous grid positions.
   *
   * @param blocked One byte per cell, `1` meaning impassable, row-major.
   * @returns Tile centres from the first step to the goal, or `null` when no
   *   route exists (or the search budget ran out) — callers fall back to a
   *   straight line.
   */
  findPath(start: GridPoint, goal: GridPoint, blocked: Uint8Array): GridPoint[] | null {
    const startX = this.clampX(Math.floor(start.x));
    const startY = this.clampY(Math.floor(start.y));

    const goalGrid = this.resolveGoal(goal, blocked);
    if (!goalGrid) return null;
    const { x: goalX, y: goalY } = goalGrid;

    if (startX === goalX && startY === goalY) return [];

    const searchId = ++this.searchId;
    this.heapSize = 0;

    const startIndex = startY * this.width + startX;
    this.gScore[startIndex] = 0;
    this.fScore[startIndex] = this.heuristic(startX, startY, goalX, goalY);
    this.parent[startIndex] = -1;
    this.queuedStamp[startIndex] = searchId;
    this.heapPush(startIndex);

    let expansions = 0;

    while (this.heapSize > 0) {
      const current = this.heapPop();

      if (this.settledStamp[current] === searchId) continue;
      this.settledStamp[current] = searchId;

      const currentX = current % this.width;
      const currentY = (current - currentX) / this.width;

      if (currentX === goalX && currentY === goalY) {
        return this.reconstruct(current, startIndex);
      }

      if (++expansions > MAX_EXPANSIONS) return null;

      for (const [dx, dy] of NEIGHBOUR_OFFSETS) {
        const nextX = currentX + dx;
        const nextY = currentY + dy;
        if (nextX < 0 || nextY < 0 || nextX >= this.width || nextY >= this.height) continue;

        const nextIndex = nextY * this.width + nextX;
        if (blocked[nextIndex] === 1) continue;
        if (this.settledStamp[nextIndex] === searchId) continue;

        const tentativeG = this.gScore[current] + 1;
        const known = this.queuedStamp[nextIndex] === searchId;
        if (known && tentativeG >= this.gScore[nextIndex]) continue;

        this.gScore[nextIndex] = tentativeG;
        this.fScore[nextIndex] = tentativeG + this.heuristic(nextX, nextY, goalX, goalY);
        this.parent[nextIndex] = current;
        this.queuedStamp[nextIndex] = searchId;
        this.heapPush(nextIndex);
      }
    }

    return null;
  }

  /**
   * Tile the goal actually sits on. A destination inside a building or a forest
   * patch (clicking a tree, or a formation cell that lands on a wall) is moved to
   * the closest walkable tile so the order still means "go as close as you can".
   */
  private resolveGoal(goal: GridPoint, blocked: Uint8Array): GridPoint | null {
    const goalX = this.clampX(Math.floor(goal.x));
    const goalY = this.clampY(Math.floor(goal.y));

    const index = goalY * this.width + goalX;
    if (blocked[index] !== 1) return { x: goalX, y: goalY };

    let best: GridPoint | null = null;
    let bestDistance = Infinity;

    for (let radius = 1; radius <= GOAL_SNAP_RADIUS; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          // Only the ring, not the filled square: nearer rings were already
          // checked and a filled square would revisit them.
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;

          const x = goalX + dx;
          const y = goalY + dy;
          if (x < 0 || y < 0 || x >= this.width || y >= this.height) continue;
          if (blocked[y * this.width + x] === 1) continue;

          const distance = Math.hypot(dx, dy);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = { x, y };
          }
        }
      }

      if (best) return best;
    }

    return null;
  }

  /** Walks the parent chain back to the start and returns tile centres. */
  private reconstruct(goalIndex: number, startIndex: number): GridPoint[] {
    const reversed: GridPoint[] = [];
    let index = goalIndex;

    while (index !== startIndex && index !== -1) {
      const x = index % this.width;
      const y = (index - x) / this.width;
      reversed.push({ x: x + 0.5, y: y + 0.5 });
      index = this.parent[index];
    }

    return reversed.reverse();
  }

  private heuristic(x: number, y: number, goalX: number, goalY: number): number {
    return Math.abs(goalX - x) + Math.abs(goalY - y);
  }

  private clampX(x: number): number {
    return Math.min(this.width - 1, Math.max(0, x));
  }

  private clampY(y: number): number {
    return Math.min(this.height - 1, Math.max(0, y));
  }

  private heapPush(index: number): void {
    let position = this.heapSize++;
    this.heap[position] = index;

    while (position > 0) {
      const parentPosition = (position - 1) >> 1;
      if (this.fScore[this.heap[parentPosition]] <= this.fScore[index]) break;
      this.heap[position] = this.heap[parentPosition];
      this.heap[parentPosition] = index;
      position = parentPosition;
    }
  }

  private heapPop(): number {
    const top = this.heap[0];
    const last = this.heap[--this.heapSize];

    if (this.heapSize > 0) {
      this.heap[0] = last;
      let position = 0;

      for (;;) {
        const left = position * 2 + 1;
        const right = left + 1;
        let smallest = position;

        if (left < this.heapSize && this.fScore[this.heap[left]] < this.fScore[this.heap[smallest]]) {
          smallest = left;
        }
        if (right < this.heapSize && this.fScore[this.heap[right]] < this.fScore[this.heap[smallest]]) {
          smallest = right;
        }
        if (smallest === position) break;

        const swap = this.heap[position];
        this.heap[position] = this.heap[smallest];
        this.heap[smallest] = swap;
        position = smallest;
      }
    }

    return top;
  }
}
