import { MAP_GRID_HEIGHT, MAP_GRID_WIDTH } from '../constants/index.js';
import { gridToScreen } from './isoMath.js';

export interface RoadSplinePoint {
  x: number;
  y: number;
  variant: number;
}

let cachedRoadSplinePoints: RoadSplinePoint[] | null = null;

/**
 * Returns pre-calculated dense spline points for rendering continuous organic AoE dirt roads.
 */
export function getAllRoadSplinePoints(): RoadSplinePoint[] {
  if (cachedRoadSplinePoints) {
    return cachedRoadSplinePoints;
  }

  const points: RoadSplinePoint[] = [];
  const addPoint = (gx: number, gy: number, seed: number) => {
    if (gx < 0 || gx >= MAP_GRID_WIDTH || gy < 0 || gy >= MAP_GRID_HEIGHT) return;
    const screen = gridToScreen(gx, gy);
    const variant = (Math.abs(Math.floor(seed)) % 3) + 1;
    points.push({
      x: Math.round(screen.x),
      y: Math.round(screen.y),
      variant
    });
  };

  const step = 0.35;

  // 1. East-West Grand Imperial Highway
  for (let gx = 0; gx < MAP_GRID_WIDTH; gx += step) {
    const gy = 110 + 22 * Math.sin(gx * 0.045) + 9 * Math.cos(gx * 0.09) + 4 * Math.sin(gx * 0.16);
    addPoint(gx, gy, gx * 7.13);
  }

  // 2. North-South Royal Silk Axis
  for (let gy = 0; gy < MAP_GRID_HEIGHT; gy += step) {
    const gx = 110 + 22 * Math.sin(gy * 0.045) + 9 * Math.cos(gy * 0.09) + 4 * Math.sin(gy * 0.16);
    addPoint(gx, gy, gy * 5.41);
  }

  // 3. Northwest - Southeast Diagonal Route
  for (let s = 5; s < MAP_GRID_WIDTH - 5; s += step) {
    const meander = 12 * Math.sin(s * 0.07);
    const gx = s + meander / 2;
    const gy = s - meander / 2;
    addPoint(gx, gy, s * 9.27);
  }

  // 4. Northeast - Southwest Diagonal Route
  for (let s = 5; s < MAP_GRID_WIDTH - 5; s += step) {
    const meander = 12 * Math.sin((s - (220 - s)) * 0.035);
    const gx = s;
    const gy = 220 - s + meander;
    addPoint(gx, gy, s * 3.82);
  }

  // 5. Central Crossroads Hub Plaza (at 110, 110)
  for (let r = 0.8; r <= 3.8; r += 1.0) {
    const count = Math.round(r * 8);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const gx = 110 + r * Math.cos(angle);
      const gy = 110 + r * Math.sin(angle);
      addPoint(gx, gy, i * 4.1);
    }
  }

  cachedRoadSplinePoints = points;
  return points;
}

/**
 * Deterministically checks whether a given (gx, gy) coordinate belongs to a dirt road.
 * Creates an organic, winding AoE-style road network connecting the continent.
 */
export function isDirtRoadTile(gx: number, gy: number): boolean {
  if (gx < 0 || gx >= MAP_GRID_WIDTH || gy < 0 || gy >= MAP_GRID_HEIGHT) {
    return false;
  }

  // 1. East-West Grand Imperial Highway
  const ewCenterY = 110 + 22 * Math.sin(gx * 0.045) + 9 * Math.cos(gx * 0.09) + 4 * Math.sin(gx * 0.16);
  if (Math.abs(gy - ewCenterY) <= 1.35) {
    return true;
  }

  // 2. North-South Royal Silk Axis
  const nsCenterX = 110 + 22 * Math.sin(gy * 0.045) + 9 * Math.cos(gy * 0.09) + 4 * Math.sin(gy * 0.16);
  if (Math.abs(gx - nsCenterX) <= 1.35) {
    return true;
  }

  // 3. Northwest - Southeast Diagonal Route
  const nwSeLine = gx - gy;
  const nwSeMeander = 12 * Math.sin((gx + gy) * 0.035);
  if (Math.abs(nwSeLine - nwSeMeander) <= 1.15) {
    return true;
  }

  // 4. Northeast - Southwest Diagonal Route
  const neSwLine = (gx + gy) - 220;
  const neSwMeander = 12 * Math.sin((gx - gy) * 0.035);
  if (Math.abs(neSwLine - neSwMeander) <= 1.15) {
    return true;
  }

  // 5. Central Grand Crossroads Hub (at 110, 110)
  const distCenter = Math.hypot(gx - 110, gy - 110);
  if (distCenter <= 4.5) {
    return true;
  }

  return false;
}

