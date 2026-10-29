import { MAP_GRID_HEIGHT, MAP_GRID_WIDTH } from '../constants/index.js';

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

