import { MAX_SELECTION, screenToGrid } from '@chien-quoc/shared';
import type * as Phaser from 'phaser';
import type { WorldScene } from '../scenes/WorldScene.js';
import { getUnitBodyBox, hitTestUnit } from './hitTest.js';
import { pointerWorldPoint } from './pointer.js';

/**
 * CTL-02: a second click on the same unit within this window selects every
 * unit of that type currently visible, like AoE2's double-click.
 */
const DOUBLE_CLICK_SAME_TYPE_MS = 350;

/**
 * Owns which entity is selected: click, shift-click, box-drag, double-click and
 * control-group recall all funnel through here, so there is exactly one place
 * that mutates the selection sets and the ring/foundation graphics that show it.
 */
export class SelectionController {
  /** Last unit clicked, for double-click detection. */
  private lastUnitClick: { unitId: string; at: number } = { unitId: '', at: 0 };

  constructor(private readonly scene: WorldScene) {}

  /**
   * Single click: unit first (topmost body ellipse wins), then building, then
   * resource. Shift-clicking anything that is not a unit keeps the current
   * selection, so a stray shift-click on terrain does not wipe the army being
   * gathered.
   */
  handleClick(pointer: Phaser.Input.Pointer, additive = false, selectSameType = false) {
    const scene = this.scene;
    const worldPoint = pointerWorldPoint(scene.cameras.main, pointer);
    const clickGrid = screenToGrid(worldPoint.x, worldPoint.y);

    // Check click on units first (shared hit-test, topmost depth wins)
    let clickedUnitId: string | null = null;
    let clickedUnitDepth = -Infinity;
    scene.unitSprites.forEach((container, unitId) => {
      if (hitTestUnit(worldPoint.x, worldPoint.y, container) && container.depth > clickedUnitDepth) {
        clickedUnitId = unitId;
        clickedUnitDepth = container.depth;
      }
    });

    if (clickedUnitId) {
      const unit = scene.room?.state.units.get(clickedUnitId);
      const isOwn = !!unit && unit.ownerId === scene.mySessionId;

      // Double-click is detected per unit so a double-click on ground or on a
      // building does not leave a stale timestamp behind.
      const now = scene.time.now;
      const isDoubleClick =
        this.lastUnitClick.unitId === clickedUnitId &&
        now - this.lastUnitClick.at <= DOUBLE_CLICK_SAME_TYPE_MS;
      this.lastUnitClick = { unitId: clickedUnitId, at: now };

      // Same-type selection only makes sense for units we own and can order.
      if (isOwn && unit && (selectSameType || isDoubleClick)) {
        this.selectOfTypeInViewport(unit.type, additive);
        return;
      }

      if (additive) {
        this.toggleUnit(clickedUnitId);
        return;
      }

      this.clear();
      this.addUnit(clickedUnitId);
      scene.notifySelectionChange();
      return;
    }

    this.lastUnitClick = { unitId: '', at: 0 };

    if (additive) return;

    this.clear();

    // Check click on buildings (first check visual sprite bounds, then grid footprint)
    let clickedBuildingId: string | null = null;
    if (scene.room) {
      scene.buildingSprites.forEach((container, bId) => {
        const b = scene.room?.state.buildings.get(bId);
        if (!b) return;
        const visualY = (container.getData('visualCenterY') as number) ?? -30;
        const width = b.sizeX * 64;
        const height = b.sizeY * 32 + 60;
        if (
          Math.abs(worldPoint.x - container.x) <= width / 2 &&
          worldPoint.y >= container.y + visualY - height / 2 &&
          worldPoint.y <= container.y + 20
        ) {
          clickedBuildingId = bId;
        }
      });

      if (!clickedBuildingId) {
        scene.room.state.buildings.forEach((b: any, bId: string) => {
          if (
            clickGrid.gridX >= b.gridX &&
            clickGrid.gridX < b.gridX + b.sizeX &&
            clickGrid.gridY >= b.gridY &&
            clickGrid.gridY < b.gridY + b.sizeY
          ) {
            clickedBuildingId = bId;
          }
        });
      }
    }

    if (clickedBuildingId) {
      scene.selectedBuildingId = clickedBuildingId;
      const bContainer = scene.buildingSprites.get(clickedBuildingId);
      const foundation = bContainer?.getData('foundation') as Phaser.GameObjects.Graphics;
      foundation?.setVisible(true);
      scene.notifySelectionChange();
      return;
    }

    // Check click on resources (first check visual sprite distance, fallback to grid)
    let clickedResId: string | null = null;
    if (scene.room) {
      scene.room.state.resourceNodes.forEach((res: any, resId: string) => {
        if (clickedResId) return;
        const resSprite = scene.resourceSprites.get(resId);
        if (resSprite) {
          const centerY = res.type === 'TREE' ? resSprite.y - 45 : resSprite.y - 18;
          if (Math.hypot(worldPoint.x - resSprite.x, worldPoint.y - centerY) < 38) {
            clickedResId = resId;
          }
        }
        if (!clickedResId && res.gridX === clickGrid.gridX && res.gridY === clickGrid.gridY) {
          clickedResId = resId;
        }
      });
    }

    if (clickedResId) {
      scene.selectedResourceId = clickedResId;
    }

    scene.notifySelectionChange();
  }

  /** Box-drag: every own unit whose body ellipse overlaps the rectangle. */
  handleBoxSelect(
    p1Screen: { x: number; y: number },
    p2Screen: { x: number; y: number },
    additive = false
  ) {
    const scene = this.scene;
    const p1World = scene.cameras.main.getWorldPoint(p1Screen.x, p1Screen.y);
    const p2World = scene.cameras.main.getWorldPoint(p2Screen.x, p2Screen.y);

    const minX = Math.min(p1World.x, p2World.x);
    const maxX = Math.max(p1World.x, p2World.x);
    const minY = Math.min(p1World.y, p2World.y);
    const maxY = Math.max(p1World.y, p2World.y);

    // Shift-drag adds to the current selection instead of replacing it.
    if (!additive) this.clear();

    let selectedCount = scene.selectedUnitIds.size;
    let added = 0;

    scene.unitSprites.forEach((container, unitId) => {
      if (selectedCount >= MAX_SELECTION) return;
      const unit = scene.room?.state.units.get(unitId);
      if (unit && unit.ownerId === scene.mySessionId && !scene.selectedUnitIds.has(unitId)) {
        // Same body box as hitTestUnit, as an AABB so partial overlap still counts.
        const { centerY, radiusX, radiusY } = getUnitBodyBox(container);
        const unitLeft = container.x - radiusX;
        const unitRight = container.x + radiusX;
        const unitTop = centerY - radiusY;
        const unitBottom = centerY + radiusY;

        const overlaps = unitRight >= minX && unitLeft <= maxX && unitBottom >= minY && unitTop <= maxY;
        if (overlaps) {
          scene.selectedUnitIds.add(unitId);
          const ring = container.getData('selectRing') as Phaser.GameObjects.Graphics;
          ring?.setVisible(true);
          selectedCount++;
          added++;
        }
      }
    });

    // A mixed selection (building + units) has no meaning for commands, so
    // collecting units cancels the single-entity selection.
    if (added > 0) this.clearEntity();

    scene.notifySelectionChange();
  }

  /** Rings one unit on. Max-selection overflow is the caller's problem. */
  addUnit(unitId: string) {
    const container = this.scene.unitSprites.get(unitId);
    this.scene.selectedUnitIds.add(unitId);
    const ring = container?.getData('selectRing') as Phaser.GameObjects.Graphics | undefined;
    ring?.setVisible(true);
  }

  /** Shift-click a unit: first click adds, second click removes it again. */
  toggleUnit(unitId: string) {
    const scene = this.scene;
    const container = scene.unitSprites.get(unitId);

    if (scene.selectedUnitIds.has(unitId)) {
      scene.selectedUnitIds.delete(unitId);
      const ring = container?.getData('selectRing') as Phaser.GameObjects.Graphics;
      ring?.setVisible(false);
      scene.notifySelectionChange();
      return;
    }

    if (scene.selectedUnitIds.size >= MAX_SELECTION) return;

    this.addUnit(unitId);
    this.clearEntity();
    scene.notifySelectionChange();
  }

  /**
   * Ctrl-click / double-click: select every own unit of `type` that is visible
   * in the current viewport (AoE2 only takes what is on screen).
   */
  selectOfTypeInViewport(type: string, additive = false) {
    const scene = this.scene;
    const view = scene.cameras.main.worldView;

    if (!additive) this.clear();

    let selectedCount = scene.selectedUnitIds.size;
    let added = 0;

    scene.unitSprites.forEach((container, unitId) => {
      if (selectedCount >= MAX_SELECTION) return;
      const unit = scene.room?.state.units.get(unitId);
      if (!unit || unit.ownerId !== scene.mySessionId || unit.type !== type) return;
      if (scene.selectedUnitIds.has(unitId)) return;

      const { centerY, radiusX, radiusY } = getUnitBodyBox(container);
      const visible =
        container.x + radiusX >= view.x &&
        container.x - radiusX <= view.right &&
        centerY + radiusY >= view.y &&
        centerY - radiusY <= view.bottom;
      if (!visible) return;

      this.addUnit(unitId);
      selectedCount++;
      added++;
    });

    if (added > 0) this.clearEntity();
    scene.notifySelectionChange();
  }

  /** Drops every selected unit, building and resource. */
  clear() {
    const scene = this.scene;
    // Escape routes through here (App.tsx), so an armed order is dropped too.
    scene.commands.cancelPendingOrder();

    scene.selectedUnitIds.forEach((uId) => {
      const container = scene.unitSprites.get(uId);
      const ring = container?.getData('selectRing') as Phaser.GameObjects.Graphics;
      ring?.setVisible(false);
    });
    scene.selectedUnitIds.clear();

    this.clearEntity();
  }

  /** Units and buildings never mix in a selection, so this is also called alone. */
  clearEntity() {
    const scene = this.scene;
    if (scene.selectedBuildingId) {
      const bContainer = scene.buildingSprites.get(scene.selectedBuildingId);
      const foundation = bContainer?.getData('foundation') as Phaser.GameObjects.Graphics;
      foundation?.setVisible(false);
    }

    scene.selectedBuildingId = null;
    scene.selectedResourceId = null;
  }

  /**
   * Harvest and build are villager-only on the server, so the cursor must not
   * advertise them for a mixed or military selection. Unknown ids (despawned
   * units) count as "not a villager" to stay conservative.
   */
  isAllVillagers(): boolean {
    const scene = this.scene;
    if (!scene.room || scene.selectedUnitIds.size === 0) return false;
    for (const unitId of scene.selectedUnitIds) {
      const unit = scene.room.state.units.get(unitId);
      if (!unit || unit.type !== 'VILLAGER') return false;
    }
    return true;
  }
}
