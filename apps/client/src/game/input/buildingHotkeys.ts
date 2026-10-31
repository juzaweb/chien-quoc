import type { BuildingType } from '@chien-quoc/shared';

/**
 * `Q/W/E/R/T/Y/U/I` start a building placement, in the same order as the HUD's
 * build buttons. This is the only list: `CommandController` binds these keys and
 * `BuildMenu` prints the same letters on its buttons.
 */
export const BUILDING_HOTKEYS: ReadonlyArray<{ key: string; type: BuildingType }> = [
  { key: 'Q', type: 'TOWN_CENTER' },
  { key: 'W', type: 'BARRACKS' },
  { key: 'E', type: 'HOUSE' },
  { key: 'R', type: 'FARM' },
  { key: 'T', type: 'TOWER' },
  { key: 'Y', type: 'LUMBER_CAMP' },
  { key: 'U', type: 'MILL' },
  { key: 'I', type: 'MINING_CAMP' }
];

/** Reverse lookup for the build menu, which renders one button per type. */
export const BUILDING_HOTKEY_BY_TYPE = Object.fromEntries(
  BUILDING_HOTKEYS.map(({ key, type }) => [type, key])
) as Record<BuildingType, string>;
