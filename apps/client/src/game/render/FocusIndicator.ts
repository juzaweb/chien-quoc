import * as Phaser from 'phaser';
import { TILE_HEIGHT, TILE_WIDTH } from '@chien-quoc/shared';
import type { WorldScene } from '../scenes/WorldScene.js';

/**
 * Overlay depth: above every entity, below the hover tile and the drag box.
 * The waypoint / rally overlays sit at 999990-999995, so a focus mark lands on
 * top of them without ever covering the pointer feedback.
 */
const FOCUS_DEPTH = 999997;

/**
 * CMB-03: marks the enemy that the current selection is hitting.
 *
 * Without it, a fight of twenty units against two is visually indistinguishable
 * from a fight where every unit picked a different target. The marker is drawn
 * on the target's sprite, so it stays correct while both sides move, and it is
 * recomputed every frame from the snapshot rather than cached: the set of
 * targets changes the moment a unit dies or a new order is issued.
 *
 * Purely cosmetic — it reads the selection and the unit states, never writes.
 */
export class FocusIndicator {
  private readonly graphics: Phaser.GameObjects.Graphics;
  /** Target sprite keys already marked this frame, reset on every render. */
  private readonly markedTargets = new Set<string>();

  constructor(private readonly scene: WorldScene) {
    this.graphics = scene.add.graphics();
    this.graphics.setDepth(FOCUS_DEPTH);
  }

  /** Redraws the marker set. Called once per frame from the scene's update. */
  render() {
    const graphics = this.graphics;
    graphics.clear();
    this.markedTargets.clear();

    const room = this.scene.room;
    if (!room || this.scene.selectedUnitIds.size === 0) return;

    // Slow breathing pulse so the mark reads as an order, not as terrain art.
    const pulse = 0.55 + 0.25 * Math.sin(this.scene.time.now / 180);

    this.scene.selectedUnitIds.forEach((unitId) => {
      const unit = room.state.units.get(unitId);
      if (!unit || unit.ownerId !== this.scene.mySessionId) return;
      if (unit.actionState !== 'ATTACKING' || !unit.targetEntityId) return;

      // Several attackers on one target share a single marker; drawing one per
      // attacker would just stack identical ellipses on the same pixels.
      const key = `${unit.targetEntityType}:${unit.targetEntityId}`;
      if (this.markedTargets.has(key)) return;
      this.markedTargets.add(key);

      if (unit.targetEntityType === 'unit') {
        const container = this.scene.unitSprites.get(unit.targetEntityId);
        if (container) this.drawUnitMarker(container.x, container.y, pulse);
        return;
      }

      if (unit.targetEntityType === 'building') {
        const container = this.scene.buildingSprites.get(unit.targetEntityId);
        const building = room.state.buildings.get(unit.targetEntityId);
        if (container && building) this.drawBuildingMarker(container, building, pulse);
      }
    });
  }

  /** Ring under a unit's feet, sized like the selection ring it echoes. */
  private drawUnitMarker(x: number, y: number, alpha: number) {
    const graphics = this.graphics;
    graphics.lineStyle(2, 0xef4444, alpha);
    graphics.strokeEllipse(x, y, 52, 26);

    // Four ticks pointing outwards, squashed vertically like every other iso
    // overlay, so the mark stays readable on top of a busy sprite.
    const directions: Array<[number, number]> = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0]
    ];
    directions.forEach(([dx, dy]) => {
      graphics.lineBetween(x + dx * 19, y + dy * 10, x + dx * 27, y + dy * 14);
    });
  }

  /** Diamond around a building's footprint, matching its foundation outline. */
  private drawBuildingMarker(
    container: Phaser.GameObjects.Container,
    building: { sizeX: number; sizeY: number },
    alpha: number
  ) {
    const halfW = (building.sizeX * TILE_WIDTH) / 2;
    const halfH = (building.sizeY * TILE_HEIGHT) / 2;
    const graphics = this.graphics;

    graphics.lineStyle(2, 0xef4444, alpha);
    graphics.beginPath();
    graphics.moveTo(container.x, container.y - halfH);
    graphics.lineTo(container.x + halfW, container.y);
    graphics.lineTo(container.x, container.y + halfH);
    graphics.lineTo(container.x - halfW, container.y);
    graphics.closePath();
    graphics.strokePath();
  }
}
