import * as Phaser from 'phaser';
import { TILE_HEIGHT, TILE_WIDTH, UNIT_BLUEPRINTS, getIsoDepth, gridToScreen } from '@chien-quoc/shared';
import type { WorldScene } from '../scenes/WorldScene.js';

/**
 * Builds and maintains the visual object for every server entity: the container,
 * its artwork, its health/construction bar, and the state-driven animation.
 *
 * This is the only place that decides what a unit or building looks like; the
 * simulation layer only reports `actionState` / `hp` / `constructionProgress`.
 */
export class EntityRenderer {
  constructor(private readonly scene: WorldScene) {}

  /** Registers the per-type animation clips. Call once, from create(). */
  initUnitAnimations() {
    const scene = this.scene;
    const registerAnim = (
      key: string,
      texture: string,
      frames: number[],
      frameRate: number,
      repeat: number = -1
    ) => {
      if (scene.textures.exists(texture) && !scene.anims.exists(key)) {
        scene.anims.create({
          key,
          frames: scene.anims.generateFrameNumbers(texture, { frames }),
          frameRate,
          repeat
        });
      }
    };

    // Villager
    registerAnim('villager_idle', 'unit_VILLAGER_sheet', [0], 1);
    registerAnim('villager_walk', 'unit_VILLAGER_sheet', [0, 1, 2, 1], 6);
    registerAnim('villager_harvest', 'unit_VILLAGER_sheet', [3, 0], 3);

    // Spearman
    registerAnim('spearman_idle', 'unit_SPEARMAN_sheet', [0], 1);
    registerAnim('spearman_walk', 'unit_SPEARMAN_sheet', [0, 1, 2, 1], 6);
    registerAnim('spearman_attack', 'unit_SPEARMAN_sheet', [0, 3, 0], 5);

    // Archer
    registerAnim('archer_idle', 'unit_ARCHER_sheet', [0], 1);
    registerAnim('archer_walk', 'unit_ARCHER_sheet', [0, 1, 2, 1], 6);
    registerAnim('archer_attack', 'unit_ARCHER_sheet', [0, 3, 0], 4);

    // Cavalry
    registerAnim('cavalry_idle', 'unit_CAVALRY_sheet', [0], 1);
    registerAnim('cavalry_walk', 'unit_CAVALRY_sheet', [0, 1, 2, 1], 8);
    registerAnim('cavalry_attack', 'unit_CAVALRY_sheet', [0, 3, 0], 6);
  }

  createResourceNodeSprite(id: string, node: any) {
    const screenPos = gridToScreen(node.gridX, node.gridY);
    let textureKey = 'res_tree';
    let offsetY = -42;

    const customKey = `res_node_${node.type}`;
    if (this.scene.textures.exists(customKey)) {
      textureKey = customKey;
      if (node.type === 'TREE') {
        offsetY = -84;
      } else if (node.type === 'GOLD_MINE') {
        offsetY = -28;
      } else if (node.type === 'STONE_MINE') {
        offsetY = -28;
      } else if (node.type === 'BERRY_BUSH') {
        offsetY = -28;
      }
    } else {
      if (node.type === 'GOLD_MINE') {
        textureKey = 'res_gold';
        offsetY = -16;
      } else if (node.type === 'STONE_MINE') {
        textureKey = 'res_stone';
        offsetY = -16;
      } else if (node.type === 'BERRY_BUSH') {
        textureKey = 'res_berry';
        offsetY = -16;
      }
    }

    const container = this.scene.add.container(screenPos.x, screenPos.y);
    const img = this.scene.add.image(0, offsetY, textureKey);
    container.add(img);

    container.setDepth(getIsoDepth(node.gridX, node.gridY, 10));
    container.setData('entityId', id);
    container.setData('entityType', 'resource');
    container.setData('resourceType', node.type);
    container.setData('visualCenterY', offsetY);

    this.scene.resourceSprites.set(id, container);
  }

  createBuildingSprite(id: string, building: any, cb?: any) {
    const scene = this.scene;
    const screenPos = gridToScreen(
      building.gridX + building.sizeX / 2 - 0.5,
      building.gridY + building.sizeY / 2 - 0.5
    );

    let textureKey = 'b_town_center';
    let offsetY = -130;
    const scale = 1.0;

    const customKey = `building_${building.type}`;
    if (scene.textures.exists(customKey)) {
      textureKey = customKey;
      if (building.type === 'TOWN_CENTER') {
        offsetY = -130;
      } else if (building.type === 'BARRACKS') {
        offsetY = -96;
      } else if (building.type === 'HOUSE') {
        offsetY = -70;
      } else if (building.type === 'FARM') {
        offsetY = 0;
      } else if (building.type === 'TOWER') {
        offsetY = -160;
      }
    } else {
      if (building.type === 'BARRACKS') {
        textureKey = 'b_barracks';
        offsetY = -70;
      } else if (building.type === 'HOUSE') {
        textureKey = 'b_house';
        offsetY = -50;
      } else if (building.type === 'FARM') {
        textureKey = 'b_farm';
        offsetY = 0;
      } else if (building.type === 'TOWER') {
        textureKey = 'b_tower';
        offsetY = -90;
      }
    }

    const container = scene.add.container(screenPos.x, screenPos.y);

    // Age of Empires style foundation highlight on ground (2x tile dimensions)
    const foundation = scene.add.graphics();
    const halfW = (building.sizeX * TILE_WIDTH) / 2;
    const halfH = (building.sizeY * TILE_HEIGHT) / 2;
    foundation.lineStyle(2, 0x38bdf8, 0.9);
    foundation.beginPath();
    foundation.moveTo(0, -halfH);
    foundation.lineTo(halfW, 0);
    foundation.lineTo(0, halfH);
    foundation.lineTo(-halfW, 0);
    foundation.closePath();
    foundation.strokePath();
    foundation.fillStyle(0x0284c7, 0.2);
    foundation.fillPath();
    foundation.setVisible(false);
    container.add(foundation);
    container.setData('foundation', foundation);

    const img = scene.add.image(0, offsetY, textureKey);
    img.setScale(scale);
    container.add(img);

    // Health / Construction Bar
    const hpBar = scene.add.graphics();
    container.add(hpBar);
    container.setData('hpBar', hpBar);

    container.setDepth(getIsoDepth(building.gridX + building.sizeX, building.gridY + building.sizeY, 15));
    container.setData('entityId', id);
    container.setData('entityType', 'building');
    container.setData('buildingType', building.type);
    container.setData('visualCenterY', offsetY);

    this.updateBuildingBar(container, building);

    if (cb) {
      cb.onChange(building, () => {
        this.updateBuildingBar(container, building);
        if (scene.selectedBuildingId === id) {
          scene.notifySelectionChange();
        }
      });
    }

    scene.buildingSprites.set(id, container);
  }

  updateBuildingBar(container: any, building: any) {
    const hpBar = container.getData('hpBar') as any;
    if (!hpBar) return;

    hpBar.clear();
    const width = Math.max(70, building.sizeX * 36);
    const height = 6;

    let barY = -120;
    if (building.type === 'TOWN_CENTER') barY = -370;
    else if (building.type === 'TOWER') barY = -350;
    else if (building.type === 'BARRACKS') barY = -270;
    else if (building.type === 'HOUSE') barY = -190;
    else if (building.type === 'FARM') barY = -100;

    // Background
    hpBar.fillStyle(0x0f172a, 0.85);
    hpBar.fillRect(-width / 2, barY, width, height);

    if (!building.isConstructed) {
      // Construction progress (Yellow)
      const prog = Phaser.Math.Clamp(building.constructionProgress / 100, 0, 1);
      hpBar.fillStyle(0xf59e0b, 1);
      hpBar.fillRect(-width / 2, barY, width * prog, height);
    } else {
      // HP Bar (Green to Red)
      const pct = Phaser.Math.Clamp(building.hp / building.maxHp, 0, 1);
      const color = pct > 0.5 ? 0x22c55e : pct > 0.25 ? 0xf59e0b : 0xef4444;
      hpBar.fillStyle(color, 1);
      hpBar.fillRect(-width / 2, barY, width * pct, height);
    }

    hpBar.lineStyle(1, 0x334155, 1);
    hpBar.strokeRect(-width / 2, barY, width, height);
  }

  createUnitSprite(id: string, unit: any, cb?: any) {
    const scene = this.scene;
    const screenPos = gridToScreen(unit.x, unit.y);
    const container = scene.add.container(screenPos.x, screenPos.y);

    const unitType = (unit.type || 'VILLAGER') as string;
    const lowerType = unitType.toLowerCase();
    const sheetKey = `unit_${unitType}_sheet`;
    const idleKey = `unit_${unitType}_idle`;
    const hasSheet = scene.textures.exists(sheetKey);
    const blueprint = UNIT_BLUEPRINTS[unitType as keyof typeof UNIT_BLUEPRINTS];

    let unitDisplay: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image;
    const isCavalry = unitType === 'CAVALRY';
    const visualOffsetY = isCavalry ? -52 : -40;
    const visualScale = isCavalry ? 0.75 : 0.72;

    if (hasSheet) {
      const sprite = scene.add.sprite(0, visualOffsetY, sheetKey, 0);
      sprite.setScale(visualScale);
      const idleAnim = `${lowerType}_idle`;
      if (scene.anims.exists(idleAnim)) {
        sprite.play(idleAnim);
      }
      unitDisplay = sprite;
    } else if (scene.textures.exists(idleKey)) {
      unitDisplay = scene.add.image(0, visualOffsetY, idleKey);
      unitDisplay.setScale(visualScale);
    } else {
      const fallbackKey = `unit_${unitType}`;
      unitDisplay = scene.add.image(0, visualOffsetY, fallbackKey);
      unitDisplay.setScale(0.75);
    }

    container.add(unitDisplay);
    container.setData('unitDisplay', unitDisplay);
    // Body ellipse measured from the sprite sheet content box (villager/spearman
    // content spans y 13..123 at scale 0.72, cavalry y 29..155 at 0.75), expressed
    // relative to the container origin which sits at the unit's feet.
    container.setData('bodyOffsetY', isCavalry ? -43 : -37);
    container.setData('bodyRadiusX', isCavalry ? 50 : 36);
    container.setData('bodyRadiusY', isCavalry ? 46 : 40);

    // Selected indicator ring (AoE ground ellipse under feet, scaled for 128x64 tiles)
    const selectRing = scene.add.graphics();
    selectRing.lineStyle(2, 0x38bdf8, 0.9);
    const ringRadiusX = isCavalry ? 40 : 26;
    const ringRadiusY = isCavalry ? 20 : 13;
    selectRing.strokeEllipse(0, 0, ringRadiusX, ringRadiusY);
    selectRing.fillStyle(0x0284c7, 0.2);
    selectRing.fillEllipse(0, 0, ringRadiusX, ringRadiusY);
    selectRing.setVisible(false);
    container.add(selectRing);
    container.setData('selectRing', selectRing);

    // Unit Health Bar
    const hpBar = scene.add.graphics();
    container.add(hpBar);
    container.setData('hpBar', hpBar);

    container.setDepth(getIsoDepth(unit.x, unit.y, 25));
    container.setData('entityId', id);
    container.setData('entityType', 'unit');

    scene.unitSprites.set(id, container);
    scene.unitTargetPositions.set(id, { x: unit.x, y: unit.y, hp: unit.hp, maxHp: unit.maxHp });

    const updateVisualState = (actionState: string) => {
      if (!hasSheet || !(unitDisplay instanceof Phaser.GameObjects.Sprite)) return;

      const idleAnim = `${lowerType}_idle`;
      const walkAnim = `${lowerType}_walk`;
      // Only villagers have a harvest animation; only combat units have an attack one.
      const harvestAnim = blueprint?.canHarvest ? 'villager_harvest' : null;
      const attackAnim = `${lowerType}_attack`;

      let desired: string | null;
      switch (actionState) {
        case 'MOVING':
        // CMD-01: an attack-moving or patrolling unit is walking, fight or not.
        case 'ATTACK_MOVE':
        case 'PATROL':
        // SIM-02: carrying a load back to a drop-off is a walk, not a gather.
        case 'RETURNING':
          desired = walkAnim;
          break;
        case 'HARVESTING':
        // CMD-05: a builder reuses the harvest loop; there is no separate
        // villager_build sheet.
        case 'BUILDING':
          desired = harvestAnim ?? idleAnim;
          break;
        case 'ATTACKING':
          // Villagers have no attack animation — fall back to idle instead of
          // freezing on whatever clip happened to be playing before.
          desired = attackAnim;
          break;
        default:
          desired = idleAnim;
      }

      if (!desired || !scene.anims.exists(desired)) {
        desired = idleAnim;
      }
      if (scene.anims.exists(desired) && unitDisplay.anims.currentAnim?.key !== desired) {
        unitDisplay.play(desired);
      }
    };

    // Expose the state-driven animation helper so update() never has to guess
    // which animation key belongs to this unit type.
    container.setData('updateVisualState', updateVisualState);

    updateVisualState(unit.actionState);

    if (cb) {
      cb.onChange(unit, () => {
        scene.unitTargetPositions.set(id, { x: unit.x, y: unit.y, hp: unit.hp, maxHp: unit.maxHp });
        this.updateUnitBar(container, unit.hp, unit.maxHp, isCavalry);
        updateVisualState(unit.actionState);
      });
    }
  }

  updateUnitBar(container: any, hp: number, maxHp: number, isCavalry: boolean = false) {
    const hpBar = container.getData('hpBar') as any;
    if (!hpBar) return;

    hpBar.clear();
    const width = isCavalry ? 50 : 38;
    const height = 4;
    const barY = isCavalry ? -84 : -68;

    hpBar.fillStyle(0x0f172a, 0.8);
    hpBar.fillRect(-width / 2, barY, width, height);

    const pct = Phaser.Math.Clamp(hp / maxHp, 0, 1);
    const color = pct > 0.5 ? 0x22c55e : pct > 0.25 ? 0xf59e0b : 0xef4444;
    hpBar.fillStyle(color, 1);
    hpBar.fillRect(-width / 2, barY, width * pct, height);

    hpBar.lineStyle(1, 0x1e293b, 1);
    hpBar.strokeRect(-width / 2, barY, width, height);
  }
}
