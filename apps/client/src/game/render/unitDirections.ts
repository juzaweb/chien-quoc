/**
 * Shared conventions for the directional unit art.
 *
 * A directional walk sheet stores one row per compass direction and one column
 * per walk frame, so a Phaser spritesheet frame index is
 * `directionIndex * FRAMES_PER_DIRECTION + frame`. Row order is compass-from-east
 * (E, SE, S, SW, W, NW, N, NE) so the index falls straight out of
 * `atan2(screenDy, screenDx)`.
 */
export const DIRECTION_NAMES = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] as const;

export type DirectionName = (typeof DIRECTION_NAMES)[number];

export const FRAMES_PER_DIRECTION = 4;

/** Facing used before a unit has moved: toward the viewer. */
export const DEFAULT_DIRECTION_INDEX = 2;

/**
 * Units that ship a `<unit>_walk.png` directional sheet. Units absent from this
 * list keep the legacy single-facing sheet and are flipped horizontally instead.
 */
export const DIRECTIONAL_WALK_UNITS = ['VILLAGER'] as const;

/**
 * Screen-space heading as a compass index. Phaser's y axis points down, so
 * positive dy is "south", which is why the sheet's row order starts at east and
 * turns clockwise.
 */
export function directionIndex(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return DEFAULT_DIRECTION_INDEX;
  const step = Math.PI / 4;
  const index = Math.round(Math.atan2(dy, dx) / step);
  return ((index % 8) + 8) % 8;
}

export function directionalWalkKey(unitType: string, direction: number): string {
  return `${unitType.toLowerCase()}_walk_${DIRECTION_NAMES[direction]}`;
}

export function directionalIdleKey(unitType: string, direction: number): string {
  return `${unitType.toLowerCase()}_idle_${DIRECTION_NAMES[direction]}`;
}
