import type { BuildingType } from '@chien-quoc/shared';

/** Where a building type's artwork sits relative to its container origin. */
export interface BuildingArt {
  textureKey: string;
  offsetY: number;
  scale: number;
}

/**
 * Lift of the generated `building_<TYPE>` sheet above the tile centre.
 *
 * Every building sheet is 256x220 and bottom-anchored, so the lift is what puts
 * the base of the art on the footprint rather than its centre.
 */
const SHEET_OFFSET_Y: Partial<Record<BuildingType, number>> = {
  TOWN_CENTER: -130,
  BARRACKS: -96,
  HOUSE: -70,
  FARM: 0,
  TOWER: -160,
  // ECO: the three drop-off camps are drawn on the same sheet as the house.
  LUMBER_CAMP: -70,
  MILL: -70,
  MINING_CAMP: -70
};

/** Procedural textures used when a building has no generated PNG. */
const FALLBACK_ART: Partial<Record<BuildingType, { textureKey: string; offsetY: number }>> = {
  BARRACKS: { textureKey: 'b_barracks', offsetY: -70 },
  HOUSE: { textureKey: 'b_house', offsetY: -50 },
  FARM: { textureKey: 'b_farm', offsetY: 0 },
  TOWER: { textureKey: 'b_tower', offsetY: -90 }
};

const DEFAULT_ART = { textureKey: 'b_town_center', offsetY: -130 };

/**
 * Top of the health / construction bar, in the container's local space. Each
 * building's roof sits at a different height, so the bar has to follow it.
 *
 * The numbers track the top of the artwork inside each shipped sheet, not the
 * sheet rectangle: a sprite whose art does not reach the top row leaves a gap
 * that the bar has to absorb.
 */
const HP_BAR_Y: Partial<Record<BuildingType, number>> = {
  TOWN_CENTER: -357,
  TOWER: -350,
  BARRACKS: -231,
  HOUSE: -186,
  FARM: -100,
  LUMBER_CAMP: -190,
  MILL: -190,
  MINING_CAMP: -190
};

/**
 * The one place that maps a building type to its artwork. The placed sprite and
 * the placement ghost both read it, so a preview can never drift from the real
 * building.
 *
 * `hasTexture` keeps this free of Phaser: the callers pass their texture
 * manager's `exists`.
 */
export function buildingArt(
  type: BuildingType,
  hasTexture: (textureKey: string) => boolean
): BuildingArt {
  const customKey = `building_${type}`;
  if (hasTexture(customKey)) {
    return {
      textureKey: customKey,
      offsetY: SHEET_OFFSET_Y[type] ?? DEFAULT_ART.offsetY,
      scale: 1
    };
  }
  return { ...(FALLBACK_ART[type] ?? DEFAULT_ART), scale: 1 };
}

/** HP bar position for a building type; unknown types fall back to the default. */
export function buildingHpBarY(type: string): number {
  return HP_BAR_Y[type as BuildingType] ?? -120;
}
