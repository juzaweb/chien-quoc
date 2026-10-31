import {
  BUILDING_BLUEPRINTS,
  BuildingType,
  MAP_GRID_HEIGHT,
  MAP_GRID_WIDTH,
  NetworkMessage,
  gridToScreen
} from '@chien-quoc/shared';
import type * as Phaser from 'phaser';
import type { WorldScene } from '../scenes/WorldScene.js';
import { buildingArt, type BuildingArt } from '../render/buildingArt.js';
import { pointerWorldGrid } from './pointer.js';

/**
 * CMD-04: building placement mode. Owns the ghost preview, the placement
 * validation that the ghost, the cursor and the click must all agree on, and the
 * PLACE_BUILDING message.
 */
export class PlacementController {
  private ghost!: Phaser.GameObjects.Container;
  private ghostImage!: Phaser.GameObjects.Image;

  constructor(private readonly scene: WorldScene) {}

  create() {
    const scene = this.scene;
    this.ghost = scene.add.container(0, 0);
    this.ghostImage = scene.add.image(0, 0, 'b_house');
    this.ghostImage.setAlpha(0.65);
    this.ghost.add(this.ghostImage);
    this.ghost.setDepth(999999);
    this.ghost.setVisible(false);
  }

  /** Whether a footprint anchored at `gx, gy` may be placed right now. */
  isValid(gx: number, gy: number, blueprint: any): boolean {
    const scene = this.scene;
    if (!scene.room) return false;
    if (
      gx < 0 ||
      gx + blueprint.sizeX > MAP_GRID_WIDTH ||
      gy < 0 ||
      gy + blueprint.sizeY > MAP_GRID_HEIGHT
    ) {
      return false;
    }

    let blocked = false;
    scene.room.state.buildings.forEach((b: any) => {
      const overlapX = gx < b.gridX + b.sizeX && gx + blueprint.sizeX > b.gridX;
      const overlapY = gy < b.gridY + b.sizeY && gy + blueprint.sizeY > b.gridY;
      if (overlapX && overlapY) blocked = true;
    });

    scene.room.state.resourceNodes.forEach((res: any) => {
      if (
        res.gridX >= gx &&
        res.gridX < gx + blueprint.sizeX &&
        res.gridY >= gy &&
        res.gridY < gy + blueprint.sizeY
      ) {
        blocked = true;
      }
    });

    return !blocked;
  }

  /** Follows the pointer every frame while placement mode is active. */
  updateGhost(gridX: number, gridY: number) {
    const scene = this.scene;

    if (!scene.buildingToPlace) {
      this.ghost.setVisible(false);
      return;
    }

    const blueprint = BUILDING_BLUEPRINTS[scene.buildingToPlace];
    const ghostPos = gridToScreen(
      gridX + blueprint.sizeX / 2 - 0.5,
      gridY + blueprint.sizeY / 2 - 0.5
    );
    this.ghost.setPosition(ghostPos.x, ghostPos.y);
    this.ghost.setVisible(true);
    this.ghostImage.setTint(this.isValid(gridX, gridY, blueprint) ? 0x86efac : 0xfca5a5);
  }

  /** Enters placement mode for `type` and dresses the ghost in its artwork. */
  enter(type: BuildingType) {
    const scene = this.scene;
    scene.selection.clear();
    scene.buildingToPlace = type;
    scene.notifySelectionChange();

    const art = this.ghostArt(type);
    this.ghostImage.setTexture(art.textureKey);
    this.ghostImage.setY(art.offsetY);
    this.ghostImage.setScale(art.scale);
  }

  cancel() {
    const scene = this.scene;
    scene.buildingToPlace = null;
    this.ghost.setVisible(false);
    // Placement owns the cursor while active, so leaving the mode has to restore
    // it even though the pointer has not moved.
    scene.cursor.refresh();
    scene.onPlacementCancelled?.();
  }

  /** Sends PLACE_BUILDING for the tile under the click, or blinks a refusal. */
  commit(pointer: Phaser.Input.Pointer) {
    const scene = this.scene;
    if (!scene.buildingToPlace || !scene.room) return;
    const type = scene.buildingToPlace;
    const blueprint = BUILDING_BLUEPRINTS[type];

    // Recompute from the pointer that actually clicked. The ghost position is
    // only refreshed on pointermove, so a click right after a camera pan (or any
    // input source that skips pointermove) would otherwise place the building at
    // a stale coordinate.
    const { gridX, gridY } = pointerWorldGrid(scene.cameras.main, pointer);

    if (this.isValid(gridX, gridY, blueprint)) {
      scene.room.send(NetworkMessage.PLACE_BUILDING, { type, gridX, gridY });
      this.cancel();
      return;
    }

    // Stay in placement mode (AoE lets you retry another tile) but tell the player
    // why nothing happened, at the spot they clicked.
    const ghostPos = gridToScreen(
      gridX + blueprint.sizeX / 2 - 0.5,
      gridY + blueprint.sizeY / 2 - 0.5
    );
    scene.commands.showFeedback(ghostPos.x, ghostPos.y, 0xef4444);
  }

  private ghostArt(type: BuildingType): BuildingArt {
    return buildingArt(type, (key) => this.scene.textures.exists(key));
  }
}
