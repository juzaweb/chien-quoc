import { TILE_HEIGHT, TILE_WIDTH } from '../constants/index.js';

export interface Point2D {
  x: number;
  y: number;
}

export interface GridCoord {
  gridX: number;
  gridY: number;
}

/**
 * Converts tile grid coordinates to screen pixel coordinates (isometric center of tile).
 */
export function gridToScreen(
  gridX: number,
  gridY: number,
  tileWidth: number = TILE_WIDTH,
  tileHeight: number = TILE_HEIGHT
): Point2D {
  const halfW = tileWidth / 2;
  const halfH = tileHeight / 2;
  return {
    x: (gridX - gridY) * halfW,
    y: (gridX + gridY) * halfH
  };
}

/**
 * Converts screen pixel coordinates to tile grid coordinates.
 */
export function screenToGrid(
  screenX: number,
  screenY: number,
  tileWidth: number = TILE_WIDTH,
  tileHeight: number = TILE_HEIGHT
): GridCoord {
  const halfW = tileWidth / 2;
  const halfH = tileHeight / 2;

  const a = screenX / halfW;
  const b = screenY / halfH;

  const gridX = Math.floor((a + b) / 2);
  const gridY = Math.floor((b - a) / 2);

  return { gridX, gridY };
}

/**
 * Returns rendering depth sorting key based on isometric Y position.
 */
export function getIsoDepth(gridX: number, gridY: number, heightOffset: number = 0): number {
  return (gridX + gridY) * 1000 + heightOffset;
}

/**
 * Calculates Euclidean distance between two grid points.
 */
export function gridDistance(p1: GridCoord, p2: GridCoord): number {
  return Math.hypot(p2.gridX - p1.gridX, p2.gridY - p1.gridY);
}

/**
 * Clamps coordinates within map bounds.
 */
export function clampGrid(gridX: number, gridY: number, mapWidth: number, mapHeight: number): GridCoord {
  return {
    gridX: Math.max(0, Math.min(mapWidth - 1, gridX)),
    gridY: Math.max(0, Math.min(mapHeight - 1, gridY))
  };
}

