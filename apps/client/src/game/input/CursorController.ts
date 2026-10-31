import { BUILDING_BLUEPRINTS, screenToGrid } from '@chien-quoc/shared';
import type { WorldScene } from '../scenes/WorldScene.js';
import { findBuildingAt, findOwnFoundationAt, findOwnGatherableAt, findResourceAt, findUnitAt } from './hitTest.js';
import type { WorldPoint } from './pointer.js';

/**
 * CMD-03: what the pointer currently points at, in terms of the order a right
 * click would issue. There are no AoE-style `.cur` assets yet, so each mode maps
 * to a built-in CSS cursor - the browser renders them at any DPI without us
 * shipping images.
 */
export type CursorMode =
  | 'default'
  | 'attack'
  | 'harvest'
  | 'construction'
  | 'build-ok'
  | 'build-blocked'
  | 'order';

const CURSOR_CSS: Record<CursorMode, string> = {
  default: 'default',
  // No sword asset: `crosshair` is the closest built-in that reads as "pick a
  // target" instead of "click to move".
  attack: 'crosshair',
  // `copy` is the only built-in that reads as "carry this back", which is the
  // harvest affordance without custom art.
  harvest: 'copy',
  // CMD-05: right-clicking your own foundation with villagers armed reads the
  // same as harvest — "send them to work on that".
  construction: 'copy',
  'build-ok': 'copy',
  'build-blocked': 'not-allowed',
  // An armed attack-move / patrol is asking for a destination: same affordance.
  order: 'crosshair'
};

/**
 * Owns the canvas cursor. Everything here is derived state: it reads the
 * selection, the placement mode and the hit tests, and writes only CSS.
 */
export class CursorController {
  private appliedCss: string | null = null;

  constructor(private readonly scene: WorldScene) {}

  /**
   * CMD-03: what a right click at `worldPoint` would do right now. Mirrors the
   * unit-order branches of `handleRightClickCommand` (placement, attack on an
   * enemy, build on own foundation, harvest, move) using the same hit-tests, so
   * the cursor can never promise an order that the click will not issue. The
   * rally-point branch is not represented: it only applies with a building
   * selected and no units, which resolves to `default`.
   */
  resolve(worldPoint: WorldPoint): CursorMode {
    const grid = screenToGrid(worldPoint.x, worldPoint.y);

    if (this.scene.buildingToPlace) {
      const blueprint = BUILDING_BLUEPRINTS[this.scene.buildingToPlace];
      return this.scene.placement.isValid(grid.gridX, grid.gridY, blueprint) ? 'build-ok' : 'build-blocked';
    }

    // CMD-01: an armed attack-move / patrol is waiting for a destination click,
    // so the pointer is picking a point rather than targeting what is under it.
    if (this.scene.commands.pendingOrder) return 'order';

    if (!this.scene.room || this.scene.selectedUnitIds.size === 0) return 'default';

    if (findUnitAt(this.scene, worldPoint, 'enemy') || findBuildingAt(this.scene, grid, 'enemy')) {
      return 'attack';
    }

    // CMD-05: an own, unfinished building under the pointer is a build site.
    if (this.scene.selection.isAllVillagers() && findOwnFoundationAt(this.scene, grid)) {
      return 'construction';
    }

    if (this.scene.selection.isAllVillagers() && findResourceAt(this.scene, worldPoint, grid)) {
      return 'harvest';
    }

    // ECO-01: an own finished farm is worked in place, so the same affordance
    // applies without a resource node under the pointer.
    if (this.scene.selection.isAllVillagers() && findOwnGatherableAt(this.scene, grid)) {
      return 'harvest';
    }

    return 'default';
  }

  /**
   * Applies `mode` to the canvas. Phaser writes the CSS cursor, so re-asserting
   * the same value every pointermove would touch the DOM ~60 times a second -
   * the applied value is cached and only actual changes are written.
   */
  set(mode: CursorMode) {
    const css = CURSOR_CSS[mode];
    if (css === this.appliedCss) return;
    this.appliedCss = css;
    this.scene.input.setDefaultCursor(css);
  }

  /**
   * Recomputes the cursor from the most recent pointer position. Safe to call
   * before the pointer has ever moved (nothing to resolve against) and while
   * box-selecting (the drag rectangle is the feedback there, and switching the
   * cursor mid-drag would flicker as units pass under it).
   */
  refresh() {
    if (!this.scene.lastPointerWorld) return;
    if (this.scene.isDragSelecting) return;
    this.set(this.resolve(this.scene.lastPointerWorld));
  }
}
