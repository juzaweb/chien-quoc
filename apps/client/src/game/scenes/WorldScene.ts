import * as Phaser from 'phaser';
import { Room } from '@colyseus/sdk';
import { Callbacks } from '@colyseus/schema';
import {
  BUILDING_BLUEPRINTS,
  BuildingType,
  MAP_GRID_HEIGHT,
  MAP_GRID_WIDTH,
  NetworkMessage,
  TILE_HEIGHT,
  TILE_WIDTH,
  gridToScreen,
  screenToGrid,
  getIsoDepth
} from '@chien-quoc/shared';
import { generateProceduralTextures } from '../renderers/ProceduralSprites.js';

export interface SelectedEntityData {
  id: string;
  type: 'unit' | 'building' | 'resource';
  name: string;
  subType: string;
  hp?: number;
  maxHp?: number;
  isOwner?: boolean;
  trainingQueue?: string[];
  remainingAmount?: number;
  maxAmount?: number;
}

export class WorldScene extends Phaser.Scene {
  public room: Room | null = null;
  public mySessionId: string = '';

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasdKeys!: { [key: string]: Phaser.Input.Keyboard.Key };

  // Entity visual objects
  private tilePool: Phaser.GameObjects.Image[] = [];
  private lastViewportX: number = -999999;
  private lastViewportY: number = -999999;
  private lastViewportZoom: number = -1;
  private buildingSprites: Map<string, Phaser.GameObjects.Container> = new Map();
  private unitSprites: Map<string, Phaser.GameObjects.Container> = new Map();
  private resourceSprites: Map<string, Phaser.GameObjects.Container> = new Map();

  // Unit target lerping
  private unitTargetPositions: Map<string, { x: number; y: number; hp: number; maxHp: number }> = new Map();

  // Cursor indicator
  private hoverTileHighlight!: Phaser.GameObjects.Image;
  private hoverGridCoord: { gridX: number; gridY: number } = { gridX: 0, gridY: 0 };

  // Building placement preview
  public buildingToPlace: BuildingType | null = null;
  private placementGhost!: Phaser.GameObjects.Container;
  private placementGhostImage!: Phaser.GameObjects.Image;

  // Selection
  public selectedUnitIds: Set<string> = new Set();
  public selectedBuildingId: string | null = null;
  public selectedResourceId: string | null = null;
  private hasCenteredOnSpawn: boolean = false;

  // Selection Drag Box
  private isDragSelecting: boolean = false;
  private dragStartScreen: { x: number; y: number } = { x: 0, y: 0 };
  private dragSelectionGraphics!: Phaser.GameObjects.Graphics;

  // React Callbacks
  public onSelectionChange: ((entity: SelectedEntityData | null) => void) | null = null;
  public onPlacementCancelled: (() => void) | null = null;

  constructor() {
    super('WorldScene');
  }

  preload() {
    generateProceduralTextures(this);

    // Preload generated assets with fallback support
    this.load.spritesheet('unit_VILLAGER_sheet', '/assets/units/villager_sheet.png', {
      frameWidth: 64,
      frameHeight: 64
    });
    this.load.image('unit_VILLAGER_idle', '/assets/units/villager_idle.png');

    // Preload generated building assets with cache-busting version
    const v = 'v=2';
    this.load.image('building_TOWN_CENTER', `/assets/buildings/town_center.png?${v}`);
    this.load.image('building_BARRACKS', `/assets/buildings/barracks.png?${v}`);
    this.load.image('building_HOUSE', `/assets/buildings/house.png?${v}`);
    this.load.image('building_FARM', `/assets/buildings/farm.png?${v}`);
    this.load.image('building_TOWER', `/assets/buildings/tower.png?${v}`);
  }

  create() {
    // Disable right click context menu in browser
    this.input.mouse?.disableContextMenu();

    // Register unit animations if spritesheets are loaded
    this.initUnitAnimations();

    // 1. Pre-allocate pooled terrain tile images for 60 FPS viewport rendering across 220x220 map
    const POOL_SIZE = 6000;
    this.tilePool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const tile = this.add.image(0, 0, 'tile_grass');
      tile.setDepth(-100000);
      tile.setVisible(false);
      this.tilePool.push(tile);
    }

    // 2. Cursor hover indicator
    this.hoverTileHighlight = this.add.image(0, 0, 'tile_highlight');
    this.hoverTileHighlight.setDepth(999998);
    this.hoverTileHighlight.setVisible(false);

    // 3. Building placement ghost
    this.placementGhost = this.add.container(0, 0);
    this.placementGhostImage = this.add.image(0, 0, 'b_house');
    this.placementGhostImage.setAlpha(0.65);
    this.placementGhost.add(this.placementGhostImage);
    this.placementGhost.setDepth(999999);
    this.placementGhost.setVisible(false);

    // 4. Drag selection box graphics
    this.dragSelectionGraphics = this.add.graphics();
    this.dragSelectionGraphics.setDepth(1000000);

    // 5. Camera & Controls
    if (this.input.keyboard) {
      this.cursors = this.input.keyboard.createCursorKeys();
      this.wasdKeys = this.input.keyboard.addKeys({
        up: Phaser.Input.Keyboard.KeyCodes.W,
        left: Phaser.Input.Keyboard.KeyCodes.A,
        down: Phaser.Input.Keyboard.KeyCodes.S,
        right: Phaser.Input.Keyboard.KeyCodes.D
      }) as any;
    }

    // Initial camera position centered on map - normal 1.0 zoom
    const center = gridToScreen(MAP_GRID_WIDTH / 2, MAP_GRID_HEIGHT / 2);
    this.cameras.main.centerOn(center.x, center.y);
    this.cameras.main.setZoom(1.0);

    // Mouse wheel zoom
    this.input.on('wheel', (pointer: Phaser.Input.Pointer, gameObjects: any, deltaX: number, deltaY: number) => {
      const currentZoom = this.cameras.main.zoom;
      const newZoom = Phaser.Math.Clamp(currentZoom - deltaY * 0.001, 0.4, 2.2);
      this.cameras.main.setZoom(newZoom);
    });

    // Pointer events for selection and actions
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      this.handlePointerMove(pointer);
    });

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.handlePointerDown(pointer);
    });

    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      this.handlePointerUp(pointer);
    });

    // Bind room events if room already passed
    if (this.room) {
      this.bindRoomEvents(this.room);
    }

    // Initial viewport terrain render
    this.updateViewportTerrain();
  }

  public setRoom(room: Room) {
    this.room = room;
    this.mySessionId = room.sessionId;
    if (this.scene.isActive()) {
      this.bindRoomEvents(room);
    }
  }

  public bindRoomEvents(room: Room) {
    const cb = Callbacks.get(room);

    // 1. Synchronize Resource Nodes
    cb.onAdd('resourceNodes', (node: any, key: any) => {
      this.createResourceNodeSprite(key, node);
    });

    cb.onRemove('resourceNodes', (node: any, key: any) => {
      const sprite = this.resourceSprites.get(key);
      if (sprite) {
        sprite.destroy();
        this.resourceSprites.delete(key);
      }
    });

    // 2. Synchronize Buildings
    cb.onAdd('buildings', (building: any, key: any) => {
      this.createBuildingSprite(key, building, cb);
      if (building.ownerId === this.mySessionId && building.type === 'TOWN_CENTER' && !this.hasCenteredOnSpawn) {
        this.hasCenteredOnSpawn = true;
        const screenPos = gridToScreen(building.gridX + 1.5, building.gridY + 1.5);
        this.cameras.main.centerOn(screenPos.x, screenPos.y);
      }
    });

    cb.onRemove('buildings', (building: any, key: any) => {
      const sprite = this.buildingSprites.get(key);
      if (sprite) {
        sprite.destroy();
        this.buildingSprites.delete(key);
      }
      if (this.selectedBuildingId === key) {
        this.selectedBuildingId = null;
        this.notifySelectionChange();
      }
    });

    // 3. Synchronize Units
    cb.onAdd('units', (unit: any, key: any) => {
      this.createUnitSprite(key, unit, cb);
    });

    cb.onRemove('units', (unit: any, key: any) => {
      const sprite = this.unitSprites.get(key);
      if (sprite) {
        sprite.destroy();
        this.unitSprites.delete(key);
      }
      this.unitTargetPositions.delete(key);
      if (this.selectedUnitIds.has(key)) {
        this.selectedUnitIds.delete(key);
        this.notifySelectionChange();
      }
    });
  }

  private createResourceNodeSprite(id: string, node: any) {
    const screenPos = gridToScreen(node.gridX, node.gridY);
    let textureKey = 'res_tree';
    let offsetY = -20;

    if (node.type === 'GOLD_MINE') {
      textureKey = 'res_gold';
      offsetY = -8;
    } else if (node.type === 'STONE_MINE') {
      textureKey = 'res_stone';
      offsetY = -8;
    } else if (node.type === 'BERRY_BUSH') {
      textureKey = 'res_berry';
      offsetY = -8;
    }

    const container = this.add.container(screenPos.x, screenPos.y);
    const img = this.add.image(0, offsetY, textureKey);
    container.add(img);

    container.setDepth(getIsoDepth(node.gridX, node.gridY, 10));
    container.setData('entityId', id);
    container.setData('entityType', 'resource');

    this.resourceSprites.set(id, container);
  }

  private createBuildingSprite(id: string, building: any, cb?: any) {
    const screenPos = gridToScreen(
      building.gridX + building.sizeX / 2 - 0.5,
      building.gridY + building.sizeY / 2 - 0.5
    );

    let textureKey = 'b_town_center';
    let offsetY = -65;
    let scale = 1.0;

    const customKey = `building_${building.type}`;
    if (this.textures.exists(customKey)) {
      textureKey = customKey;
      if (building.type === 'TOWN_CENTER') {
        offsetY = -65;
      } else if (building.type === 'BARRACKS') {
        offsetY = -48;
      } else if (building.type === 'HOUSE') {
        offsetY = -35;
      } else if (building.type === 'FARM') {
        offsetY = 0;
      } else if (building.type === 'TOWER') {
        offsetY = -80;
      }
    } else {
      if (building.type === 'BARRACKS') {
        textureKey = 'b_barracks';
        offsetY = -35;
      } else if (building.type === 'HOUSE') {
        textureKey = 'b_house';
        offsetY = -25;
      } else if (building.type === 'FARM') {
        textureKey = 'b_farm';
        offsetY = 0;
      } else if (building.type === 'TOWER') {
        textureKey = 'b_tower';
        offsetY = -45;
      }
    }

    const container = this.add.container(screenPos.x, screenPos.y);

    // Age of Empires style foundation highlight on ground
    const foundation = this.add.graphics();
    const halfW = (building.sizeX * 64) / 2;
    const halfH = (building.sizeY * 32) / 2;
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

    const img = this.add.image(0, offsetY, textureKey);
    img.setScale(scale);
    container.add(img);

    // Health / Construction Bar
    const hpBar = this.add.graphics();
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
        if (this.selectedBuildingId === id) {
          this.notifySelectionChange();
        }
      });
    }

    this.buildingSprites.set(id, container);
  }

  private updateBuildingBar(container: Phaser.GameObjects.Container, building: any) {
    const hpBar = container.getData('hpBar') as Phaser.GameObjects.Graphics;
    if (!hpBar) return;

    hpBar.clear();
    const width = Math.max(52, building.sizeX * 24);
    const height = 5;

    let barY = -75;
    if (building.type === 'TOWN_CENTER') barY = -185;
    else if (building.type === 'TOWER') barY = -175;
    else if (building.type === 'BARRACKS') barY = -135;
    else if (building.type === 'HOUSE') barY = -95;
    else if (building.type === 'FARM') barY = -52;

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

  private initUnitAnimations() {
    if (this.textures.exists('unit_VILLAGER_sheet')) {
      if (!this.anims.exists('villager_idle')) {
        this.anims.create({
          key: 'villager_idle',
          frames: this.anims.generateFrameNumbers('unit_VILLAGER_sheet', { start: 0, end: 0 }),
          frameRate: 1,
          repeat: -1
        });
      }
      if (!this.anims.exists('villager_walk')) {
        this.anims.create({
          key: 'villager_walk',
          frames: this.anims.generateFrameNumbers('unit_VILLAGER_sheet', { start: 1, end: 4 }),
          frameRate: 8,
          repeat: -1
        });
      }
      if (!this.anims.exists('villager_harvest')) {
        this.anims.create({
          key: 'villager_harvest',
          frames: this.anims.generateFrameNumbers('unit_VILLAGER_sheet', { start: 5, end: 6 }),
          frameRate: 4,
          repeat: -1
        });
      }
    }
  }

  private createUnitSprite(id: string, unit: any, cb?: any) {
    const screenPos = gridToScreen(unit.x, unit.y);
    const container = this.add.container(screenPos.x, screenPos.y);

    const hasVillagerSheet = unit.type === 'VILLAGER' && this.textures.exists('unit_VILLAGER_sheet');
    let unitDisplay: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image;

    if (hasVillagerSheet) {
      // 64x64 frame anchored bottom, scaled to 0.72x for AoE realistic human-to-building proportions
      const sprite = this.add.sprite(0, -20, 'unit_VILLAGER_sheet', 0);
      sprite.setScale(0.72);
      if (this.anims.exists('villager_idle')) {
        sprite.play('villager_idle');
      }
      unitDisplay = sprite;
    } else {
      const textureKey = `unit_${unit.type}`;
      unitDisplay = this.add.image(0, -14, textureKey);
      unitDisplay.setScale(0.75);
    }

    container.add(unitDisplay);
    container.setData('unitDisplay', unitDisplay);

    // Selected indicator ring (AoE ground ellipse under feet)
    const selectRing = this.add.graphics();
    selectRing.lineStyle(1.5, 0x38bdf8, 0.9);
    selectRing.strokeEllipse(0, 0, 16, 8);
    selectRing.fillStyle(0x0284c7, 0.2);
    selectRing.fillEllipse(0, 0, 16, 8);
    selectRing.setVisible(false);
    container.add(selectRing);
    container.setData('selectRing', selectRing);

    // Unit Health Bar
    const hpBar = this.add.graphics();
    container.add(hpBar);
    container.setData('hpBar', hpBar);

    container.setDepth(getIsoDepth(unit.x, unit.y, 25));
    container.setData('entityId', id);
    container.setData('entityType', 'unit');

    this.unitSprites.set(id, container);
    this.unitTargetPositions.set(id, { x: unit.x, y: unit.y, hp: unit.hp, maxHp: unit.maxHp });

    const updateVisualState = (actionState: string) => {
      if (hasVillagerSheet && unitDisplay instanceof Phaser.GameObjects.Sprite) {
        if (actionState === 'MOVING') {
          if (unitDisplay.anims.currentAnim?.key !== 'villager_walk') {
            unitDisplay.play('villager_walk');
          }
        } else if (actionState === 'HARVESTING') {
          if (unitDisplay.anims.currentAnim?.key !== 'villager_harvest') {
            unitDisplay.play('villager_harvest');
          }
        } else {
          if (unitDisplay.anims.currentAnim?.key !== 'villager_idle') {
            unitDisplay.play('villager_idle');
          }
        }
      }
    };

    updateVisualState(unit.actionState);

    if (cb) {
      cb.onChange(unit, () => {
        this.unitTargetPositions.set(id, { x: unit.x, y: unit.y, hp: unit.hp, maxHp: unit.maxHp });
        this.updateUnitBar(container, unit.hp, unit.maxHp);
        updateVisualState(unit.actionState);
      });
    }
  }

  private updateUnitBar(container: Phaser.GameObjects.Container, hp: number, maxHp: number) {
    const hpBar = container.getData('hpBar') as Phaser.GameObjects.Graphics;
    if (!hpBar) return;

    hpBar.clear();
    const width = 24;
    const height = 3;
    const barY = -34;

    hpBar.fillStyle(0x0f172a, 0.8);
    hpBar.fillRect(-width / 2, barY, width, height);

    const pct = Phaser.Math.Clamp(hp / maxHp, 0, 1);
    const color = pct > 0.5 ? 0x22c55e : pct > 0.25 ? 0xf59e0b : 0xef4444;
    hpBar.fillStyle(color, 1);
    hpBar.fillRect(-width / 2, barY, width * pct, height);

    hpBar.lineStyle(1, 0x1e293b, 1);
    hpBar.strokeRect(-width / 2, barY, width, height);
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer) {
    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    this.hoverGridCoord = screenToGrid(worldPoint.x, worldPoint.y);

    // Snap highlight to grid tile
    const snappedScreen = gridToScreen(this.hoverGridCoord.gridX, this.hoverGridCoord.gridY);
    this.hoverTileHighlight.setPosition(snappedScreen.x, snappedScreen.y);
    this.hoverTileHighlight.setVisible(
      this.hoverGridCoord.gridX >= 0 &&
      this.hoverGridCoord.gridX < MAP_GRID_WIDTH &&
      this.hoverGridCoord.gridY >= 0 &&
      this.hoverGridCoord.gridY < MAP_GRID_HEIGHT
    );

    // Update Placement Ghost if in building mode
    if (this.buildingToPlace) {
      const blueprint = BUILDING_BLUEPRINTS[this.buildingToPlace];
      const ghostPos = gridToScreen(
        this.hoverGridCoord.gridX + blueprint.sizeX / 2 - 0.5,
        this.hoverGridCoord.gridY + blueprint.sizeY / 2 - 0.5
      );
      this.placementGhost.setPosition(ghostPos.x, ghostPos.y);
      this.placementGhost.setVisible(true);

      // Check placement validity
      const isValid = this.isPlacementValid(this.hoverGridCoord.gridX, this.hoverGridCoord.gridY, blueprint);
      this.placementGhostImage.setTint(isValid ? 0x86efac : 0xfca5a5);
    } else {
      this.placementGhost.setVisible(false);
    }

    // Drag selection rendering
    if (this.isDragSelecting) {
      this.dragSelectionGraphics.clear();
      this.dragSelectionGraphics.lineStyle(1.5, 0x38bdf8, 1);
      this.dragSelectionGraphics.fillStyle(0x0284c7, 0.2);

      const start = this.dragStartScreen;
      const current = { x: pointer.x, y: pointer.y };

      const minX = Math.min(start.x, current.x);
      const minY = Math.min(start.y, current.y);
      const width = Math.abs(current.x - start.x);
      const height = Math.abs(current.y - start.y);

      // Draw in camera-fixed screen space
      this.dragSelectionGraphics.fillRect(
        this.cameras.main.worldView.x + minX / this.cameras.main.zoom,
        this.cameras.main.worldView.y + minY / this.cameras.main.zoom,
        width / this.cameras.main.zoom,
        height / this.cameras.main.zoom
      );
      this.dragSelectionGraphics.strokeRect(
        this.cameras.main.worldView.x + minX / this.cameras.main.zoom,
        this.cameras.main.worldView.y + minY / this.cameras.main.zoom,
        width / this.cameras.main.zoom,
        height / this.cameras.main.zoom
      );
    }
  }

  private isPlacementValid(gx: number, gy: number, blueprint: any): boolean {
    if (!this.room) return false;
    if (gx < 0 || gx + blueprint.sizeX > MAP_GRID_WIDTH || gy < 0 || gy + blueprint.sizeY > MAP_GRID_HEIGHT) {
      return false;
    }

    let blocked = false;
    this.room.state.buildings.forEach((b: any) => {
      const overlapX = gx < b.gridX + b.sizeX && gx + blueprint.sizeX > b.gridX;
      const overlapY = gy < b.gridY + b.sizeY && gy + blueprint.sizeY > b.gridY;
      if (overlapX && overlapY) blocked = true;
    });

    this.room.state.resourceNodes.forEach((res: any) => {
      if (res.gridX >= gx && res.gridX < gx + blueprint.sizeX && res.gridY >= gy && res.gridY < gy + blueprint.sizeY) {
        blocked = true;
      }
    });

    return !blocked;
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer) {
    if (pointer.rightButtonDown()) {
      // Right Click
      if (this.buildingToPlace) {
        this.cancelBuildingPlacement();
      } else {
        this.handleRightClickCommand(pointer);
      }
      return;
    }

    if (pointer.leftButtonDown()) {
      if (this.buildingToPlace) {
        this.commitBuildingPlacement();
      } else {
        // Start Drag selection box
        this.isDragSelecting = true;
        this.dragStartScreen = { x: pointer.x, y: pointer.y };
      }
    }
  }

  private handlePointerUp(pointer: Phaser.Input.Pointer) {
    if (this.isDragSelecting) {
      this.isDragSelecting = false;
      this.dragSelectionGraphics.clear();

      const dragDistance = Math.hypot(pointer.x - this.dragStartScreen.x, pointer.y - this.dragStartScreen.y);

      if (dragDistance > 8) {
        // Box Selection
        this.performBoxSelection(this.dragStartScreen, { x: pointer.x, y: pointer.y });
      } else {
        // Single Click Selection
        this.performSingleClickSelection(pointer);
      }
    }
  }

  private performSingleClickSelection(pointer: Phaser.Input.Pointer) {
    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const clickGrid = screenToGrid(worldPoint.x, worldPoint.y);

    this.clearSelection();

    // Check click on units first (check distance to unit visual center)
    let clickedUnitId: string | null = null;
    this.unitSprites.forEach((container, unitId) => {
      // Unit visual center is offset vertically around y - 18
      const dist = Math.hypot(container.x - worldPoint.x, (container.y - 18) - worldPoint.y);
      if (dist < 32) {
        clickedUnitId = unitId;
      }
    });

    if (clickedUnitId) {
      this.selectedUnitIds.add(clickedUnitId);
      const container = this.unitSprites.get(clickedUnitId);
      if (container) {
        const ring = container.getData('selectRing') as Phaser.GameObjects.Graphics;
        ring?.setVisible(true);
      }
      this.notifySelectionChange();
      return;
    }

    // Check click on buildings (first check visual sprite bounds, then grid footprint)
    let clickedBuildingId: string | null = null;
    if (this.room) {
      this.buildingSprites.forEach((container, bId) => {
        const b = this.room?.state.buildings.get(bId);
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
        this.room.state.buildings.forEach((b: any, bId: string) => {
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
      this.selectedBuildingId = clickedBuildingId;
      const bContainer = this.buildingSprites.get(clickedBuildingId);
      const foundation = bContainer?.getData('foundation') as Phaser.GameObjects.Graphics;
      foundation?.setVisible(true);
      this.notifySelectionChange();
      return;
    }

    // Check click on resources
    let clickedResId: string | null = null;
    if (this.room) {
      this.room.state.resourceNodes.forEach((res: any, resId: string) => {
        if (res.gridX === clickGrid.gridX && res.gridY === clickGrid.gridY) {
          clickedResId = resId;
        }
      });
    }

    if (clickedResId) {
      this.selectedResourceId = clickedResId;
    }

    this.notifySelectionChange();
  }

  private performBoxSelection(p1Screen: { x: number; y: number }, p2Screen: { x: number; y: number }) {
    const p1World = this.cameras.main.getWorldPoint(p1Screen.x, p1Screen.y);
    const p2World = this.cameras.main.getWorldPoint(p2Screen.x, p2Screen.y);

    const minX = Math.min(p1World.x, p2World.x);
    const maxX = Math.max(p1World.x, p2World.x);
    const minY = Math.min(p1World.y, p2World.y);
    const maxY = Math.max(p1World.y, p2World.y);

    this.clearSelection();

    this.unitSprites.forEach((container, unitId) => {
      const unit = this.room?.state.units.get(unitId);
      if (unit && unit.ownerId === this.mySessionId) {
        // Check overlap against unit's visual bounding box
        const unitLeft = container.x - 24;
        const unitRight = container.x + 24;
        const unitTop = container.y - 50;
        const unitBottom = container.y + 10;

        const overlaps = unitRight >= minX && unitLeft <= maxX && unitBottom >= minY && unitTop <= maxY;
        if (overlaps) {
          this.selectedUnitIds.add(unitId);
          const ring = container.getData('selectRing') as Phaser.GameObjects.Graphics;
          ring?.setVisible(true);
        }
      }
    });

    this.notifySelectionChange();
  }

  public clearSelection() {
    this.selectedUnitIds.forEach((uId) => {
      const container = this.unitSprites.get(uId);
      const ring = container?.getData('selectRing') as Phaser.GameObjects.Graphics;
      ring?.setVisible(false);
    });
    this.selectedUnitIds.clear();

    if (this.selectedBuildingId) {
      const bContainer = this.buildingSprites.get(this.selectedBuildingId);
      const foundation = bContainer?.getData('foundation') as Phaser.GameObjects.Graphics;
      foundation?.setVisible(false);
    }

    this.selectedBuildingId = null;
    this.selectedResourceId = null;
  }

  private handleRightClickCommand(pointer: Phaser.Input.Pointer) {
    if (!this.room || this.selectedUnitIds.size === 0) return;

    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const targetGrid = screenToGrid(worldPoint.x, worldPoint.y);

    // 1. Check if right-clicked on an enemy unit
    let targetEnemyUnitId: string | null = null;
    this.room.state.units.forEach((unit: any, uId: string) => {
      if (unit.ownerId !== this.mySessionId) {
        const container = this.unitSprites.get(uId);
        if (container && Math.hypot(container.x - worldPoint.x, container.y - worldPoint.y) < 25) {
          targetEnemyUnitId = uId;
        }
      }
    });

    if (targetEnemyUnitId) {
      this.room.send(NetworkMessage.ATTACK_TARGET, {
        unitIds: Array.from(this.selectedUnitIds),
        targetEntityId: targetEnemyUnitId,
        targetType: 'unit'
      });
      this.showCommandFeedback(worldPoint.x, worldPoint.y, 0xef4444);
      return;
    }

    // 2. Check if right-clicked on an enemy building
    let targetEnemyBuildingId: string | null = null;
    this.room.state.buildings.forEach((b: any, bId: string) => {
      if (b.ownerId !== this.mySessionId) {
        if (
          targetGrid.gridX >= b.gridX &&
          targetGrid.gridX < b.gridX + b.sizeX &&
          targetGrid.gridY >= b.gridY &&
          targetGrid.gridY < b.gridY + b.sizeY
        ) {
          targetEnemyBuildingId = bId;
        }
      }
    });

    if (targetEnemyBuildingId) {
      this.room.send(NetworkMessage.ATTACK_TARGET, {
        unitIds: Array.from(this.selectedUnitIds),
        targetEntityId: targetEnemyBuildingId,
        targetType: 'building'
      });
      this.showCommandFeedback(worldPoint.x, worldPoint.y, 0xef4444);
      return;
    }

    // 3. Check if right-clicked on a resource node (harvest command)
    let targetResourceNodeId: string | null = null;
    this.room.state.resourceNodes.forEach((res: any, resId: string) => {
      if (res.gridX === targetGrid.gridX && res.gridY === targetGrid.gridY) {
        targetResourceNodeId = resId;
      }
    });

    if (targetResourceNodeId) {
      this.room.send(NetworkMessage.HARVEST_RESOURCE, {
        unitIds: Array.from(this.selectedUnitIds),
        resourceNodeId: targetResourceNodeId
      });
      this.showCommandFeedback(worldPoint.x, worldPoint.y, 0xf59e0b);
      return;
    }

    // 4. Default: Move command to target ground
    this.room.send(NetworkMessage.MOVE_UNITS, {
      unitIds: Array.from(this.selectedUnitIds),
      targetGridX: targetGrid.gridX,
      targetGridY: targetGrid.gridY
    });
    this.showCommandFeedback(worldPoint.x, worldPoint.y, 0x22c55e);
  }

  private showCommandFeedback(x: number, y: number, color: number) {
    const feedback = this.add.graphics();
    feedback.lineStyle(2, color, 1);
    feedback.strokeEllipse(x, y, 24, 10);
    feedback.setDepth(999990);

    this.tweens.add({
      targets: feedback,
      scaleX: 1.5,
      scaleY: 1.5,
      alpha: 0,
      duration: 400,
      onComplete: () => feedback.destroy()
    });
  }

  public setBuildingMode(type: BuildingType) {
    this.clearSelection();
    this.buildingToPlace = type;
    this.notifySelectionChange();

    let textureKey = 'b_town_center';
    let offsetY = -65;
    let scale = 1.0;

    const customKey = `building_${type}`;
    if (this.textures.exists(customKey)) {
      textureKey = customKey;
      if (type === 'TOWN_CENTER') {
        offsetY = -65;
      } else if (type === 'BARRACKS') {
        offsetY = -48;
      } else if (type === 'HOUSE') {
        offsetY = -35;
      } else if (type === 'FARM') {
        offsetY = 0;
      } else if (type === 'TOWER') {
        offsetY = -80;
      }
    } else {
      if (type === 'BARRACKS') {
        textureKey = 'b_barracks';
        offsetY = -35;
      } else if (type === 'HOUSE') {
        textureKey = 'b_house';
        offsetY = -25;
      } else if (type === 'FARM') {
        textureKey = 'b_farm';
        offsetY = 0;
      } else if (type === 'TOWER') {
        textureKey = 'b_tower';
        offsetY = -45;
      }
    }

    this.placementGhostImage.setTexture(textureKey);
    this.placementGhostImage.setY(offsetY);
    this.placementGhostImage.setScale(scale);
  }

  public cancelBuildingPlacement() {
    this.buildingToPlace = null;
    this.placementGhost.setVisible(false);
    if (this.onPlacementCancelled) {
      this.onPlacementCancelled();
    }
  }

  private commitBuildingPlacement() {
    if (!this.buildingToPlace || !this.room) return;
    const blueprint = BUILDING_BLUEPRINTS[this.buildingToPlace];

    if (this.isPlacementValid(this.hoverGridCoord.gridX, this.hoverGridCoord.gridY, blueprint)) {
      this.room.send(NetworkMessage.PLACE_BUILDING, {
        type: this.buildingToPlace,
        gridX: this.hoverGridCoord.gridX,
        gridY: this.hoverGridCoord.gridY
      });
      this.cancelBuildingPlacement();
    }
  }

  public panTo(gridX: number, gridY: number) {
    const screenPos = gridToScreen(gridX, gridY);
    this.cameras.main.pan(screenPos.x, screenPos.y, 350, 'Power2');
  }

  private notifySelectionChange() {
    if (!this.onSelectionChange) return;

    if (this.selectedUnitIds.size > 0) {
      const firstId = Array.from(this.selectedUnitIds)[0];
      const unit = this.room?.state.units.get(firstId);
      if (unit) {
        this.onSelectionChange({
          id: firstId,
          type: 'unit',
          name: `${unit.type} (${this.selectedUnitIds.size})`,
          subType: unit.type,
          hp: unit.hp,
          maxHp: unit.maxHp,
          isOwner: unit.ownerId === this.mySessionId
        });
        return;
      }
    }

    if (this.selectedBuildingId) {
      const b = this.room?.state.buildings.get(this.selectedBuildingId);
      if (b) {
        const bp = BUILDING_BLUEPRINTS[b.type as BuildingType];
        this.onSelectionChange({
          id: this.selectedBuildingId,
          type: 'building',
          name: bp ? bp.name : b.type,
          subType: b.type,
          hp: b.hp,
          maxHp: b.maxHp,
          isOwner: b.ownerId === this.mySessionId,
          trainingQueue: Array.from(b.trainingQueue)
        });
        return;
      }
    }

    if (this.selectedResourceId) {
      const res = this.room?.state.resourceNodes.get(this.selectedResourceId);
      if (res) {
        this.onSelectionChange({
          id: this.selectedResourceId,
          type: 'resource',
          name: `${res.resourceType.toUpperCase()} Node`,
          subType: res.type,
          remainingAmount: res.remainingAmount,
          maxAmount: res.maxAmount
        });
        return;
      }
    }

    this.onSelectionChange(null);
  }

  private updateViewportTerrain() {
    const cam = this.cameras.main;
    const view = cam.worldView;

    // Only recalculate when camera has moved more than 16px or zoom changed
    if (
      Math.abs(view.x - this.lastViewportX) < 16 &&
      Math.abs(view.y - this.lastViewportY) < 16 &&
      Math.abs(cam.zoom - this.lastViewportZoom) < 0.01
    ) {
      return;
    }

    this.lastViewportX = view.x;
    this.lastViewportY = view.y;
    this.lastViewportZoom = cam.zoom;

    // Expand margin to prevent edge pop-in during fast scrolling
    const margin = 160;
    const left = view.left - margin;
    const right = view.right + margin;
    const top = view.top - margin;
    const bottom = view.bottom + margin;

    const cTopLeft = screenToGrid(left, top);
    const cTopRight = screenToGrid(right, top);
    const cBottomLeft = screenToGrid(left, bottom);
    const cBottomRight = screenToGrid(right, bottom);

    const minGx = Math.max(0, Math.min(cTopLeft.gridX, cTopRight.gridX, cBottomLeft.gridX, cBottomRight.gridX) - 3);
    const maxGx = Math.min(MAP_GRID_WIDTH - 1, Math.max(cTopLeft.gridX, cTopRight.gridX, cBottomLeft.gridX, cBottomRight.gridX) + 3);
    const minGy = Math.max(0, Math.min(cTopLeft.gridY, cTopRight.gridY, cBottomLeft.gridY, cBottomRight.gridY) - 3);
    const maxGy = Math.min(MAP_GRID_HEIGHT - 1, Math.max(cTopLeft.gridY, cTopRight.gridY, cBottomLeft.gridY, cBottomRight.gridY) + 3);

    let poolIdx = 0;

    for (let gy = minGy; gy <= maxGy; gy++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        const screenPos = gridToScreen(gx, gy);

        if (
          screenPos.x >= left &&
          screenPos.x <= right &&
          screenPos.y >= top &&
          screenPos.y <= bottom
        ) {
          // Dynamically allocate from pool, expanding on demand if screen is large or zoomed out
          let tile = this.tilePool[poolIdx];
          if (!tile) {
            tile = this.add.image(0, 0, 'tile_grass');
            tile.setDepth(-100000);
            this.tilePool.push(tile);
          }
          poolIdx++;

          tile.setPosition(screenPos.x, screenPos.y);
          tile.setVisible(true);

          // Subtle organic terrain shading
          const shade = (gx * 17 + gy * 31) % 5;
          if (shade === 0) tile.setTint(0xedf8eb);
          else if (shade === 1) tile.setTint(0xf7fdf5);
          else if (shade === 2) tile.setTint(0xe2f0df);
          else if (shade === 3) tile.setTint(0xd9ecd6);
          else tile.clearTint();
        }
      }
    }

    // Hide remaining unused tiles
    const totalPooled = this.tilePool.length;
    while (poolIdx < totalPooled) {
      this.tilePool[poolIdx++].setVisible(false);
    }
  }

  update(time: number, delta: number) {
    this.updateViewportTerrain();

    const dtSeconds = delta / 1000;
    const cameraSpeed = (600 / this.cameras.main.zoom) * dtSeconds;

    // Pan camera via WASD / Arrow keys
    if (this.cursors.left.isDown || this.wasdKeys.left.isDown) {
      this.cameras.main.scrollX -= cameraSpeed;
    }
    if (this.cursors.right.isDown || this.wasdKeys.right.isDown) {
      this.cameras.main.scrollX += cameraSpeed;
    }
    if (this.cursors.up.isDown || this.wasdKeys.up.isDown) {
      this.cameras.main.scrollY -= cameraSpeed;
    }
    if (this.cursors.down.isDown || this.wasdKeys.down.isDown) {
      this.cameras.main.scrollY += cameraSpeed;
    }

    // Smooth unit position interpolation (Lerp)
    this.unitTargetPositions.forEach((target, unitId) => {
      const container = this.unitSprites.get(unitId);
      if (container) {
        const targetScreen = gridToScreen(target.x, target.y);
        const prevX = container.x;
        const prevY = container.y;
        container.x = Phaser.Math.Linear(container.x, targetScreen.x, 0.25);
        container.y = Phaser.Math.Linear(container.y, targetScreen.y, 0.25);
        container.setDepth(getIsoDepth(target.x, target.y, 25));

        // Flip facing direction based on movement
        const dx = targetScreen.x - prevX;
        const moveDist = Math.hypot(container.x - prevX, container.y - prevY);
        const unitDisplay = container.getData('unitDisplay') as Phaser.GameObjects.Sprite | Phaser.GameObjects.Image;
        if (unitDisplay) {
          if (Math.abs(dx) > 0.05) {
            unitDisplay.setFlipX(dx < 0);
          }

          // Trigger walk animation in real-time whenever unit is moving
          if (unitDisplay instanceof Phaser.GameObjects.Sprite && this.anims.exists('villager_walk')) {
            const unit = this.room?.state.units.get(unitId);
            const isHarvesting = unit?.actionState === 'HARVESTING';

            if (moveDist > 0.15) {
              if (unitDisplay.anims.currentAnim?.key !== 'villager_walk') {
                unitDisplay.play('villager_walk');
              }
            } else if (isHarvesting) {
              if (unitDisplay.anims.currentAnim?.key !== 'villager_harvest') {
                unitDisplay.play('villager_harvest');
              }
            } else {
              if (unitDisplay.anims.currentAnim?.key !== 'villager_idle') {
                unitDisplay.play('villager_idle');
              }
            }
          }
        }
      }
    });
  }
}

