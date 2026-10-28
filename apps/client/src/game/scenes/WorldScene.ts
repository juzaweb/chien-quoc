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
  private terrainGroup!: Phaser.GameObjects.Group;
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
  }

  create() {
    // Disable right click context menu in browser
    this.input.mouse?.disableContextMenu();

    // 1. Render Isometric Terrain
    this.terrainGroup = this.add.group();
    for (let gy = 0; gy < MAP_GRID_HEIGHT; gy++) {
      for (let gx = 0; gx < MAP_GRID_WIDTH; gx++) {
        const screenPos = gridToScreen(gx, gy);
        const tile = this.add.image(screenPos.x, screenPos.y, 'tile_grass');
        tile.setDepth(-100000 + (gx + gy));
        tile.setData('gridX', gx);
        tile.setData('gridY', gy);
        this.terrainGroup.add(tile);
      }
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

    // Initial camera position centered on map
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
    let offsetY = -40;

    if (building.type === 'BARRACKS') {
      textureKey = 'b_barracks';
      offsetY = -28;
    } else if (building.type === 'HOUSE') {
      textureKey = 'b_house';
      offsetY = -18;
    } else if (building.type === 'FARM') {
      textureKey = 'b_farm';
      offsetY = 0;
    } else if (building.type === 'TOWER') {
      textureKey = 'b_tower';
      offsetY = -35;
    }

    const container = this.add.container(screenPos.x, screenPos.y);
    const img = this.add.image(0, offsetY, textureKey);
    container.add(img);

    // Health / Construction Bar
    const hpBar = this.add.graphics();
    container.add(hpBar);
    container.setData('hpBar', hpBar);

    container.setDepth(getIsoDepth(building.gridX + building.sizeX, building.gridY + building.sizeY, 15));
    container.setData('entityId', id);
    container.setData('entityType', 'building');

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
    const width = 48;
    const height = 5;
    const barY = -75;

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

  private createUnitSprite(id: string, unit: any, cb?: any) {
    const screenPos = gridToScreen(unit.x, unit.y);
    const container = this.add.container(screenPos.x, screenPos.y);

    const textureKey = `unit_${unit.type}`;
    const img = this.add.image(0, -14, textureKey);
    container.add(img);

    // Selected indicator ring
    const selectRing = this.add.graphics();
    selectRing.lineStyle(2, 0x38bdf8, 0.8);
    selectRing.strokeEllipse(0, 0, 20, 8);
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

    if (cb) {
      cb.onChange(unit, () => {
        this.unitTargetPositions.set(id, { x: unit.x, y: unit.y, hp: unit.hp, maxHp: unit.maxHp });
        this.updateUnitBar(container, unit.hp, unit.maxHp);
      });
    }
  }

  private updateUnitBar(container: Phaser.GameObjects.Container, hp: number, maxHp: number) {
    const hpBar = container.getData('hpBar') as Phaser.GameObjects.Graphics;
    if (!hpBar) return;

    hpBar.clear();
    const width = 24;
    const height = 3;
    const barY = -30;

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

    // Check click on units first
    let clickedUnitId: string | null = null;
    this.unitSprites.forEach((container, unitId) => {
      const dist = Math.hypot(container.x - worldPoint.x, container.y - worldPoint.y);
      if (dist < 25) {
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

    // Check click on buildings
    let clickedBuildingId: string | null = null;
    if (this.room) {
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

    if (clickedBuildingId) {
      this.selectedBuildingId = clickedBuildingId;
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
        if (container.x >= minX && container.x <= maxX && container.y >= minY && container.y <= maxY) {
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
    if (type === 'BARRACKS') textureKey = 'b_barracks';
    else if (type === 'HOUSE') textureKey = 'b_house';
    else if (type === 'FARM') textureKey = 'b_farm';
    else if (type === 'TOWER') textureKey = 'b_tower';

    this.placementGhostImage.setTexture(textureKey);
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

  update(time: number, delta: number) {
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
        container.x = Phaser.Math.Linear(container.x, targetScreen.x, 0.25);
        container.y = Phaser.Math.Linear(container.y, targetScreen.y, 0.25);
        container.setDepth(getIsoDepth(target.x, target.y, 25));
      }
    });
  }
}

