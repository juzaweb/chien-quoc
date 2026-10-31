import { describe, expect, it } from 'vitest';
import { MAP_GRID_HEIGHT, MAP_GRID_WIDTH } from '@chien-quoc/shared';
import { Pathfinder, type GridPoint } from './Pathfinder.js';

function createGrid(): Uint8Array {
  return new Uint8Array(MAP_GRID_WIDTH * MAP_GRID_HEIGHT);
}

function block(grid: Uint8Array, x: number, y: number): void {
  grid[y * MAP_GRID_WIDTH + x] = 1;
}

/** Asserts the path is a chain of 4-way adjacent tiles ending on `goal`. */
function expectWalkable(path: GridPoint[] | null, from: GridPoint, goal: GridPoint): GridPoint[] {
  expect(path).not.toBeNull();
  const route = path as GridPoint[];
  expect(route.length).toBeGreaterThan(0);

  let previousX = Math.floor(from.x) + 0.5;
  let previousY = Math.floor(from.y) + 0.5;

  for (const step of route) {
    const distance = Math.abs(step.x - previousX) + Math.abs(step.y - previousY);
    expect(distance).toBeCloseTo(1, 5);
    previousX = step.x;
    previousY = step.y;
  }

  expect(previousX).toBeCloseTo(Math.floor(goal.x) + 0.5, 5);
  expect(previousY).toBeCloseTo(Math.floor(goal.y) + 0.5, 5);

  return route;
}

describe('Pathfinder', () => {
  it('walks a straight line across open ground', () => {
    const pathfinder = new Pathfinder();
    const grid = createGrid();

    const route = expectWalkable(
      pathfinder.findPath({ x: 10, y: 10 }, { x: 15, y: 10 }, grid),
      { x: 10, y: 10 },
      { x: 15, y: 10 }
    );

    expect(route.length).toBe(5);
  });

  it('routes around a wall instead of through it', () => {
    const pathfinder = new Pathfinder();
    const grid = createGrid();

    // Wall at x=12 from y=0..14, with a gap at y=15.
    for (let y = 0; y <= 14; y++) block(grid, 12, y);

    const route = expectWalkable(
      pathfinder.findPath({ x: 10, y: 10 }, { x: 14, y: 10 }, grid),
      { x: 10, y: 10 },
      { x: 14, y: 10 }
    );

    const straightLine = 4;
    expect(route.length).toBeGreaterThan(straightLine);
    // The only gap is at y=15, so the detour has to reach it.
    expect(route.some((step) => step.y >= 15.5)).toBe(true);
    // ...and it never steps onto a blocked tile.
    for (const step of route) {
      expect(grid[Math.floor(step.y) * MAP_GRID_WIDTH + Math.floor(step.x)]).toBe(0);
    }
  });

  it('detours around a building footprint', () => {
    const pathfinder = new Pathfinder();
    const grid = createGrid();

    // 2x2 house in the way.
    for (let x = 12; x <= 13; x++) {
      for (let y = 12; y <= 13; y++) block(grid, x, y);
    }

    const route = expectWalkable(
      pathfinder.findPath({ x: 10, y: 12 }, { x: 15, y: 13 }, grid),
      { x: 10, y: 12 },
      { x: 15, y: 13 }
    );

    for (const step of route) {
      const gx = Math.floor(step.x);
      const gy = Math.floor(step.y);
      const insideHouse = gx >= 12 && gx <= 13 && gy >= 12 && gy <= 13;
      expect(insideHouse).toBe(false);
    }
  });

  it('moves a blocked destination to the closest walkable tile', () => {
    const pathfinder = new Pathfinder();
    const grid = createGrid();
    block(grid, 20, 20);

    const route = pathfinder.findPath({ x: 18, y: 20 }, { x: 20, y: 20 }, grid);
    expect(route).not.toBeNull();

    const last = (route as GridPoint[])[route!.length - 1];
    const endX = Math.floor(last.x);
    const endY = Math.floor(last.y);

    // Any of the four tiles beside the blocked goal is a valid answer; what
    // matters is that the route refuses to end inside it.
    expect(endX === 20 && endY === 20).toBe(false);
    expect(Math.abs(endX - 20) + Math.abs(endY - 20)).toBe(1);
    expect(grid[endY * MAP_GRID_WIDTH + endX]).toBe(0);
  });

  it('returns null when the goal is walled in', () => {
    const pathfinder = new Pathfinder();
    const grid = createGrid();

    // Solid 7x7 block with a single cell in the middle: the goal sits in a
    // 1-tile pocket that no route can reach.
    for (let x = 16; x <= 22; x++) {
      for (let y = 16; y <= 22; y++) block(grid, x, y);
    }
    grid[19 * MAP_GRID_WIDTH + 19] = 0;

    expect(pathfinder.findPath({ x: 10, y: 10 }, { x: 19, y: 19 }, grid)).toBeNull();
  });

  it('returns an empty route when the unit is already there', () => {
    const pathfinder = new Pathfinder();
    const grid = createGrid();

    expect(pathfinder.findPath({ x: 10.4, y: 10.6 }, { x: 10.1, y: 10.2 }, grid)).toEqual([]);
  });

  it('stays inside the map when the goal is off the edge', () => {
    const pathfinder = new Pathfinder();
    const grid = createGrid();

    const route = expectWalkable(
      pathfinder.findPath({ x: 5, y: 5 }, { x: -10, y: -10 }, grid),
      { x: 5, y: 5 },
      { x: 0, y: 0 }
    );

    for (const step of route) {
      expect(step.x).toBeGreaterThanOrEqual(0.5);
      expect(step.y).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('searches a full empty 220x220 map quickly enough for a tick budget', () => {
    const pathfinder = new Pathfinder();
    const grid = createGrid();
    const start = { x: 0, y: 0 };
    const goal = { x: MAP_GRID_WIDTH - 1, y: MAP_GRID_HEIGHT - 1 };

    // Warm-up so the measured run is not paying for JIT compilation.
    pathfinder.findPath(start, goal, grid);

    const runs = 5;
    const began = performance.now();
    for (let i = 0; i < runs; i++) {
      expect(pathfinder.findPath(start, goal, grid)).not.toBeNull();
    }
    const perPathMs = (performance.now() - began) / runs;

    console.log(`A* corner-to-corner on ${MAP_GRID_WIDTH}x${MAP_GRID_HEIGHT}: ${perPathMs.toFixed(2)} ms/path`);
    expect(perPathMs).toBeLessThan(25);
  });
});
