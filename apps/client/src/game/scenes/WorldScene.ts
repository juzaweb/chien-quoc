import * as Phaser from 'phaser';
import { Room } from '@colyseus/sdk';
import { Callbacks } from '@colyseus/schema';
import {
  BUILDING_BLUEPRINTS,
  BuildingType,
  MAP_GRID_HEIGHT,
  MAP_GRID_WIDTH,
  MAX_SELECTION,
  NetworkMessage,
  TILE_HEIGHT,
  TILE_WIDTH,
  UNIT_BLUEPRINTS,
  canTrainUnitsAt,
  gridToScreen,
  screenToGrid,
  getIsoDepth,
  isDirtRoadTile,
  getAllRoadSplinePoints,
  RoadSplinePoint
} from '@chien-quoc/shared';
import { generateProceduralTextures } from '../renderers/ProceduralSprites.js';

/**
 * How far the pointer may travel (in world pixels) before a left-button press
 * counts as a box-drag instead of a click.
 *
 * The tolerance has to grow with zoom: hand jitter is roughly constant on screen,
 * so a fixed world threshold would make clicking nearly impossible when zoomed in.
 * It also must not shrink below what a human can physically hold steady, otherwise
 * a plain click while zoomed way out turns into an accidental box-drag (which
 * wipes the current selection).
 */
const CLICK_DRAG_THRESHOLD_WORLD_PX = 8;
const CLICK_DRAG_MIN_SCREEN_PX = 6;

/**
 * Width of the screen-border band that pans the camera while the pointer rests
 * there, in CSS pixels. Set to 0 to disable edge scrolling.
 */
const EDGE_SCROLL_SIZE_PX = 24;

/**
 * Phaser emits `keydown-<NAME>` for every mapped keyCode, so these need no
 * `addKey`/`addCapture` registration. Top-row digits only (AoE2 convention).
 */
const CONTROL_GROUP_KEYS = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];

/** Second press within this window re-centres the camera on the group. */
const CONTROL_GROUP_RECALL_DOUBLE_MS = 300;

/**
 * CTL-02: a second click on the same unit within this window selects every
 * unit of that type currently visible, like AoE2's double-click.
 */
const DOUBLE_CLICK_SAME_TYPE_MS = 350;

/**
 * CMD-04b: minimum gap between two handled `Delete` presses, in milliseconds.
 * Phaser re-emits `keydown-<KEY>` every frame while a key is held down, so this
 * is what keeps one press to one command.
 */
const CANCEL_KEY_DEBOUNCE_MS = 250;

/**
 * CMD-01: same Phaser re-emit problem as the cancel key - one held `A` would
 * queue dozens of attack-move orders. Two hundred and fifty ms is below a
 * deliberate double tap and above the OS auto-repeat ramp.
 */
const ORDER_KEY_DEBOUNCE_MS = 250;

/**
 * CMD-03: what the pointer currently points at, in terms of the order a right
 * click would issue. There are no AoE-style `.cur` assets yet, so each mode maps
 * to a built-in CSS cursor - the browser renders them at any DPI without us
 * shipping images.
 */
type CursorMode = 'default' | 'attack' | 'harvest' | 'construction' | 'build-ok' | 'build-blocked' | 'order';

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

export interface SelectedEntityData {
  id: string;
  type: 'unit' | 'building' | 'resource';
  name: string;
  subType: string;
  hp?: number;
  maxHp?: number;
  isOwner?: boolean;
  trainingQueue?: string[];
  /** CMD-04b: foundations can be cancelled; finished buildings cannot. */
  isConstructed?: boolean;
  constructionProgress?: number;
  remainingAmount?: number;
  maxAmount?: number;
}

export class WorldScene extends Phaser.Scene {
  public room: Room | null = null;
  public mySessionId: string = '';
  public myPlayerName: string = '';
  private boundRoomId: string = '';
  private eventsBoundRoom: Room | null = null;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;

  // Entity visual objects
  private tilePool: Phaser.GameObjects.Image[] = [];
  private roadStampPool: Phaser.GameObjects.Image[] = [];
  private allRoadPoints: RoadSplinePoint[] = [];
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

  // CMD-03: last pointer position in world space, kept so the cursor can be
  // recomputed when the selection or the input mode changes without the pointer
  // moving (box-select under the cursor, hotkey-entered placement mode).
  private lastPointerWorld: { x: number; y: number } | null = null;
  private appliedCursorCss: string | null = null;

  /**
   * Whether a pointermove has ever reached the canvas. Phaser reports the pointer
   * at (0,0) until then, which sits inside the top-left edge-scroll band - the
   * camera would otherwise pan up-left on its own from the moment the scene
   * starts, even with the mouse parked outside the game.
   */
  private hasPointerMoved = false;

  /** CMD-04b: timestamp of the last handled `Delete`, for key-repeat debounce. */
  private lastCancelKeyAt = 0;

  /**
   * CMD-01: an armed attack-move or patrol waiting for its destination click,
   * plus the last arm keypress for the same re-emit debounce as the cancel key.
   */
  private pendingOrder: 'ATTACK_MOVE' | 'PATROL' | null = null;
  private lastOrderKey: { mode: 'ATTACK_MOVE' | 'PATROL' | ''; at: number } = { mode: '', at: 0 };

  // Building placement preview
  public buildingToPlace: BuildingType | null = null;
  private placementGhost!: Phaser.GameObjects.Container;
  private placementGhostImage!: Phaser.GameObjects.Image;

  // Selection
  public selectedUnitIds: Set<string> = new Set();
  public selectedBuildingId: string | null = null;
  public selectedResourceId: string | null = null;

  // Control groups (CTL-01): Ctrl+1..9 assigns the current selection, 1..9 recalls it.
  private controlGroups: Map<number, Set<string>> = new Map();
  private lastGroupRecall: { index: number; at: number } = { index: 0, at: 0 };
  private hasCenteredOnSpawn: boolean = false;
  private centerAttempts: number = 0;

  // Selection Drag Box
  private isDragSelecting: boolean = false;
  private dragStartScreen: { x: number; y: number } = { x: 0, y: 0 };
  private dragSelectionGraphics!: Phaser.GameObjects.Graphics;

  // CTL-02: modifiers are captured on pointerdown because pointerup can report
  // them differently (the browser fires `contextmenu` early for ctrl-click).
  private pendingSelectionMods: { additive: boolean; selectSameType: boolean } = {
    additive: false,
    selectSameType: false
  };
  private lastUnitClick: { unitId: string; at: number } = { unitId: '', at: 0 };

  // CTL-05: while Shift is held, draw the queued waypoint chain of every selected
  // unit plus the point currently under the pointer. Shift itself is read from a
  // Key object rather than the pointer event, so the preview also shows up before
  // the next click.
  private shiftKey: Phaser.Input.Keyboard.Key | null = null;
  private waypointGraphics!: Phaser.GameObjects.Graphics;
  private rallyGraphics!: Phaser.GameObjects.Graphics;
  /** Signature of the last drawn rally layer, so identical frames skip the redraw. */
  private rallySignature = '';

  // CTL-04: last unit each idle cycle landed on, so the next press moves on to a
  // different unit. Tracked by id rather than by list index: the candidate list is
  // recomputed every press (units go idle/busy, and the roster changes), so a raw
  // index would point at a different unit or fall out of range between presses.
  private idleCycleAnchor: { villager: string | null; military: string | null } = {
    villager: null,
    military: null
  };

  // React Callbacks
  public onSelectionChange: ((entity: SelectedEntityData | null) => void) | null = null;
  public onPlacementCancelled: (() => void) | null = null;

  constructor() {
    super('WorldScene');
  }

  preload() {
    generateProceduralTextures(this);

    // Preload generated unit assets with spritesheet & idle frame support (2x resolution)
    const uv = 'v=3';
    this.load.spritesheet('unit_VILLAGER_sheet', `/assets/units/villager_sheet.png?${uv}`, {
      frameWidth: 128,
      frameHeight: 128
    });
    this.load.image('unit_VILLAGER_idle', `/assets/units/villager_idle.png?${uv}`);

    this.load.spritesheet('unit_SPEARMAN_sheet', `/assets/units/spearman_sheet.png?${uv}`, {
      frameWidth: 128,
      frameHeight: 128
    });
    this.load.image('unit_SPEARMAN_idle', `/assets/units/spearman_idle.png?${uv}`);

    this.load.spritesheet('unit_ARCHER_sheet', `/assets/units/archer_sheet.png?${uv}`, {
      frameWidth: 128,
      frameHeight: 128
    });
    this.load.image('unit_ARCHER_idle', `/assets/units/archer_idle.png?${uv}`);

    this.load.spritesheet('unit_CAVALRY_sheet', `/assets/units/cavalry_sheet.png?${uv}`, {
      frameWidth: 160,
      frameHeight: 160
    });
    this.load.image('unit_CAVALRY_idle', `/assets/units/cavalry_idle.png?${uv}`);

    // Preload generated building assets with cache-busting version (2x resolution)
    const v = 'v=3';
    this.load.image('building_TOWN_CENTER', `/assets/buildings/town_center.png?${v}`);
    this.load.image('building_BARRACKS', `/assets/buildings/barracks.png?${v}`);
    this.load.image('building_HOUSE', `/assets/buildings/house.png?${v}`);
    this.load.image('building_FARM', `/assets/buildings/farm.png?${v}`);
    this.load.image('building_TOWER', `/assets/buildings/tower.png?${v}`);

    // Preload generated resource node assets with cache-busting version
    this.load.image('res_node_TREE', `/assets/resources/tree.png?${v}`);
    this.load.image('res_node_GOLD_MINE', `/assets/resources/gold.png?${v}`);
    this.load.image('res_node_STONE_MINE', `/assets/resources/stone.png?${v}`);
    this.load.image('res_node_BERRY_BUSH', `/assets/resources/berry.png?${v}`);

    // Preload Age of Empires 2 Grass Terrain textures
    const tv = 'v=7';
    this.load.image('tile_grass_1', `/assets/terrain/grass_1.png?${tv}`);
    this.load.image('tile_grass_2', `/assets/terrain/grass_2.png?${tv}`);
    this.load.image('tile_grass_3', `/assets/terrain/grass_3.png?${tv}`);
    this.load.image('tile_grass', `/assets/terrain/grass.png?${tv}`);

    // Preload Age of Empires 2 Dirt Road Terrain textures & organic road stamps
    this.load.image('tile_dirt_1', `/assets/terrain/dirt_1.png?${tv}`);
    this.load.image('tile_dirt_2', `/assets/terrain/dirt_2.png?${tv}`);
    this.load.image('tile_dirt_3', `/assets/terrain/dirt_3.png?${tv}`);
    this.load.image('tile_dirt', `/assets/terrain/dirt.png?${tv}`);
    this.load.image('road_stamp', `/assets/terrain/road_stamp.png?${tv}`);
    this.load.image('road_stamp_1', `/assets/terrain/road_stamp_1.png?${tv}`);
    this.load.image('road_stamp_2', `/assets/terrain/road_stamp_2.png?${tv}`);
    this.load.image('road_stamp_3', `/assets/terrain/road_stamp_3.png?${tv}`);
  }

  create() {
    // Disable right click context menu in browser
    this.input.mouse?.disableContextMenu();

    // Natural AoE grass background clear color (eliminates any sub-pixel black seam line)
    this.cameras.main.setBackgroundColor('#58752d');

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

    // Pre-calculate organic road spline points
    this.allRoadPoints = getAllRoadSplinePoints();

    // Pre-allocate pooled road stamp images (depth -99990, above grass, below entities)
    const ROAD_POOL_SIZE = 700;
    this.roadStampPool = [];
    for (let i = 0; i < ROAD_POOL_SIZE; i++) {
      const stamp = this.add.image(0, 0, 'road_stamp_1');
      stamp.setDepth(-99990);
      stamp.setVisible(false);
      this.roadStampPool.push(stamp);
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

    // 4b. Queued waypoint preview (CTL-05), under the selection ring layer
    this.waypointGraphics = this.add.graphics();
    this.waypointGraphics.setDepth(999995);

    // 4c. Rally point flags (CTL-06), below every command overlay
    this.rallyGraphics = this.add.graphics();
    this.rallyGraphics.setDepth(999990);

    // 5. Camera & Controls
    if (this.input.keyboard) {
      this.cursors = this.input.keyboard.createCursorKeys();
      // WASD is intentionally NOT bound: it collides with the Q/W/E/R/T build
      // hotkeys in App.tsx. Panning is arrows + edge scroll (see update()).
      this.bindControlGroupKeys(this.input.keyboard);
      this.bindStopKey(this.input.keyboard);
      this.bindIdleCycleKeys(this.input.keyboard);
      this.bindHomeKey(this.input.keyboard);
      this.bindCancelKey(this.input.keyboard);
      this.bindOrderKeys(this.input.keyboard);
      // Held-modifier state for the waypoint preview; not a hotkey.
      this.shiftKey = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
    }

    // Ctrl+left-click is the same-type selection shortcut (CTL-02). On macOS the
    // OS turns that gesture into a context menu unless we suppress it here.
    this.input.mouse?.disableContextMenu();

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
    // Same instance = nothing to wire up. React StrictMode and Phaser's 'ready'
    // event can both call this with the same object.
    if (room === this.room) return;

    // Same roomId but a different Room instance means a reconnect: ownership and
    // sessionId must be refreshed, but the world snapshot itself is unchanged.
    const isNewWorld = room.roomId !== this.boundRoomId;

    this.room = room;
    this.mySessionId = room.sessionId;
    this.boundRoomId = room.roomId;

    if (isNewWorld) {
      // Fresh world snapshot: allow re-centering on the base.
      this.hasCenteredOnSpawn = false;
      this.centerAttempts = 0;
    }

    // Callbacks belong to a Room instance, so a new instance always needs binding.
    if (this.scene.isActive()) {
      this.bindRoomEvents(room);
      this.centerOnOwnBaseIfNeeded();
    }
  }

  /**
   * Player name is stable across reconnects (sessionId is not), so the camera can
   * always locate this player's Town Center even after ownership is re-assigned.
   */
  public setPlayerName(playerName: string) {
    this.myPlayerName = playerName;
    this.centerOnOwnBaseIfNeeded();
  }

  private isOwnBuilding(ownerId: string): boolean {
    if (!ownerId) return false;
    return ownerId === this.mySessionId || (!!this.myPlayerName && ownerId === this.myPlayerName);
  }

  /**
   * Own Town Center, or null when the snapshot does not contain it yet. Ownership
   * matches on sessionId first, then on player name (survives a reconnect).
   */
  private findOwnTownCenter(): any | null {
    if (!this.room) return null;

    let target: any = null;
    this.room.state.buildings.forEach((b: any) => {
      if (!target && b.type === 'TOWN_CENTER' && this.isOwnBuilding(b.ownerId)) {
        target = b;
      }
    });
    return target;
  }

  private centerOnOwnBaseIfNeeded() {
    if (this.hasCenteredOnSpawn || !this.room) return;

    // Player name / sessionId may not be known yet; retry on the next tick instead.
    if (!this.mySessionId && !this.myPlayerName) return;

    const target = this.findOwnTownCenter();
    if (!target) return;

    this.hasCenteredOnSpawn = true;
    const screenPos = gridToScreen(target.gridX + target.sizeX / 2, target.gridY + target.sizeY / 2);
    this.cameras.main.centerOn(screenPos.x, screenPos.y);
  }

  /**
   * Called from update() as a bounded fallback (max ~5s at 60fps) in case the
   * Town Center arrives in a snapshot after the initial onAdd burst.
   */
  private retryCenterOnBase() {
    // Don't burn the retry budget while still in the lobby (no room yet) — the
    // player can sit there for minutes before joining.
    if (this.hasCenteredOnSpawn || !this.room) return;

    if (this.centerAttempts++ > 300) {
      this.hasCenteredOnSpawn = true; // give up, keep the default camera position
      return;
    }
    this.centerOnOwnBaseIfNeeded();
  }

  public bindRoomEvents(room: Room) {
    // Called from create(), setRoom() and PhaserGame effects; binding the same
    // Room twice would register duplicate schema callbacks (duplicate sprites).
    if (this.eventsBoundRoom === room) return;
    this.eventsBoundRoom = room;

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
      this.centerOnOwnBaseIfNeeded();
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
      this.controlGroups.forEach((ids) => ids.delete(key));
      if (this.selectedUnitIds.has(key)) {
        this.selectedUnitIds.delete(key);
        this.notifySelectionChange();
      }
    });
  }

  private createResourceNodeSprite(id: string, node: any) {
    const screenPos = gridToScreen(node.gridX, node.gridY);
    let textureKey = 'res_tree';
    let offsetY = -42;

    const customKey = `res_node_${node.type}`;
    if (this.textures.exists(customKey)) {
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

    const container = this.add.container(screenPos.x, screenPos.y);
    const img = this.add.image(0, offsetY, textureKey);
    container.add(img);

    container.setDepth(getIsoDepth(node.gridX, node.gridY, 10));
    container.setData('entityId', id);
    container.setData('entityType', 'resource');
    container.setData('resourceType', node.type);
    container.setData('visualCenterY', offsetY);

    this.resourceSprites.set(id, container);
  }

  private createBuildingSprite(id: string, building: any, cb?: any) {
    const screenPos = gridToScreen(
      building.gridX + building.sizeX / 2 - 0.5,
      building.gridY + building.sizeY / 2 - 0.5
    );

    let textureKey = 'b_town_center';
    let offsetY = -130;
    let scale = 1.0;

    const customKey = `building_${building.type}`;
    if (this.textures.exists(customKey)) {
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

    const container = this.add.container(screenPos.x, screenPos.y);

    // Age of Empires style foundation highlight on ground (2x tile dimensions)
    const foundation = this.add.graphics();
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

  private initUnitAnimations() {
    const registerAnim = (key: string, texture: string, frames: number[], frameRate: number, repeat: number = -1) => {
      if (this.textures.exists(texture) && !this.anims.exists(key)) {
        this.anims.create({
          key,
          frames: this.anims.generateFrameNumbers(texture, { frames }),
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

  private createUnitSprite(id: string, unit: any, cb?: any) {
    const screenPos = gridToScreen(unit.x, unit.y);
    const container = this.add.container(screenPos.x, screenPos.y);

    const unitType = (unit.type || 'VILLAGER') as string;
    const lowerType = unitType.toLowerCase();
    const sheetKey = `unit_${unitType}_sheet`;
    const idleKey = `unit_${unitType}_idle`;
    const hasSheet = this.textures.exists(sheetKey);
    const blueprint = UNIT_BLUEPRINTS[unitType as keyof typeof UNIT_BLUEPRINTS];

    let unitDisplay: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image;
    const isCavalry = unitType === 'CAVALRY';
    const visualOffsetY = isCavalry ? -52 : -40;
    const visualScale = isCavalry ? 0.75 : 0.72;

    if (hasSheet) {
      const sprite = this.add.sprite(0, visualOffsetY, sheetKey, 0);
      sprite.setScale(visualScale);
      const idleAnim = `${lowerType}_idle`;
      if (this.anims.exists(idleAnim)) {
        sprite.play(idleAnim);
      }
      unitDisplay = sprite;
    } else if (this.textures.exists(idleKey)) {
      unitDisplay = this.add.image(0, visualOffsetY, idleKey);
      unitDisplay.setScale(visualScale);
    } else {
      const fallbackKey = `unit_${unitType}`;
      unitDisplay = this.add.image(0, visualOffsetY, fallbackKey);
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
    const selectRing = this.add.graphics();
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
    const hpBar = this.add.graphics();
    container.add(hpBar);
    container.setData('hpBar', hpBar);

    container.setDepth(getIsoDepth(unit.x, unit.y, 25));
    container.setData('entityId', id);
    container.setData('entityType', 'unit');

    this.unitSprites.set(id, container);
    this.unitTargetPositions.set(id, { x: unit.x, y: unit.y, hp: unit.hp, maxHp: unit.maxHp });

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

      if (!desired || !this.anims.exists(desired)) {
        desired = idleAnim;
      }
      if (this.anims.exists(desired) && unitDisplay.anims.currentAnim?.key !== desired) {
        unitDisplay.play(desired);
      }
    };

    // Expose the state-driven animation helper so update() never has to guess
    // which animation key belongs to this unit type.
    container.setData('updateVisualState', updateVisualState);

    updateVisualState(unit.actionState);

    if (cb) {
      cb.onChange(unit, () => {
        this.unitTargetPositions.set(id, { x: unit.x, y: unit.y, hp: unit.hp, maxHp: unit.maxHp });
        this.updateUnitBar(container, unit.hp, unit.maxHp, isCavalry);
        updateVisualState(unit.actionState);
      });
    }
  }

  private updateUnitBar(container: Phaser.GameObjects.Container, hp: number, maxHp: number, isCavalry: boolean = false) {
    const hpBar = container.getData('hpBar') as Phaser.GameObjects.Graphics;
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

  private handlePointerMove(pointer: Phaser.Input.Pointer) {
    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    this.hoverGridCoord = screenToGrid(worldPoint.x, worldPoint.y);
    this.lastPointerWorld = { x: worldPoint.x, y: worldPoint.y };
    this.hasPointerMoved = true;

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

    this.refreshCursor();
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
    const native = pointer.event as MouseEvent | undefined;
    // macOS: Phaser rewrites Ctrl+left-click into a right-click to match the OS
    // convention (see Pointer#down). Ctrl+click is our same-type-selection
    // modifier and the canvas context menu is disabled, so read the native
    // button instead of trusting `rightButtonDown()`.
    const ctrlLeftClick = !!native && native.button === 0 && native.ctrlKey;

    // CMD-01: an armed attack-move / patrol consumes the next left click as its
    // destination, before anything can start a drag selection box. Placement mode
    // keeps its click: the cursor is already promising a building there.
    if (this.pendingOrder && !this.buildingToPlace && (pointer.leftButtonDown() || ctrlLeftClick)) {
      this.commitPendingOrder(pointer);
      return;
    }

    if (pointer.rightButtonDown() && !ctrlLeftClick) {
      // Right Click
      if (this.buildingToPlace) {
        this.cancelBuildingPlacement();
      } else if (this.pendingOrder) {
        // Right click used to fire a normal order; with an order armed it only
        // backs out, like cancelling a placement.
        this.cancelPendingOrder();
      } else if (native?.ctrlKey && native.button === 2) {
        // CMD-01: Ctrl + right click is AoE2's attack-move.
        this.issueAttackMoveOrder(pointer, 'ATTACK_MOVE');
      } else {
        this.handleRightClickCommand(pointer, !!native?.shiftKey);
      }
      return;
    }

    if (pointer.leftButtonDown() || ctrlLeftClick) {
      if (this.buildingToPlace) {
        this.commitBuildingPlacement(pointer);
      } else {
        // Start Drag selection box
        this.pendingSelectionMods = {
          additive: !!native?.shiftKey,
          selectSameType: !!native?.ctrlKey || !!native?.metaKey
        };
        this.isDragSelecting = true;
        this.dragStartScreen = { x: pointer.x, y: pointer.y };
      }
    }
  }

  private handlePointerUp(pointer: Phaser.Input.Pointer) {
    if (this.isDragSelecting) {
      this.isDragSelecting = false;
      this.dragSelectionGraphics.clear();

      // Compare in world pixels so the tolerance tracks zoom. Clamped so that
      // zooming all the way out cannot shrink click tolerance to a couple of
      // screen pixels (which would turn steady clicks into accidental box-drags).
      const zoom = this.cameras.main.zoom;
      const screenDistance = Math.hypot(pointer.x - this.dragStartScreen.x, pointer.y - this.dragStartScreen.y);
      const dragDistanceWorld = screenDistance / zoom;
      const threshold = Math.max(CLICK_DRAG_THRESHOLD_WORLD_PX, CLICK_DRAG_MIN_SCREEN_PX / zoom);
      const mods = this.pendingSelectionMods;
      this.pendingSelectionMods = { additive: false, selectSameType: false };

      if (dragDistanceWorld > threshold) {
        // Box Selection
        this.performBoxSelection(this.dragStartScreen, { x: pointer.x, y: pointer.y }, mods.additive);
      } else {
        // Single Click Selection
        this.performSingleClickSelection(pointer, mods.additive, mods.selectSameType);
      }
    }
  }

  /**
   * Unit body ellipse in world coordinates, derived from the sprite sheet content
   * box and stored on the container at creation time. Every pointer interaction
   * (left-click, right-click, box-select) reads it from here, so they can never
   * disagree about where the unit actually is.
   */
  private getUnitBodyBox(container: Phaser.GameObjects.Container) {
    const centerY = container.y + ((container.getData('bodyOffsetY') as number) ?? -37);
    const radiusX = (container.getData('bodyRadiusX') as number) ?? 36;
    const radiusY = (container.getData('bodyRadiusY') as number) ?? 40;
    return { centerX: container.x, centerY, radiusX, radiusY };
  }

  private hitTestUnit(worldX: number, worldY: number, container: Phaser.GameObjects.Container): boolean {
    const { centerX, centerY, radiusX, radiusY } = this.getUnitBodyBox(container);
    const nx = (worldX - centerX) / radiusX;
    const ny = (worldY - centerY) / radiusY;
    return nx * nx + ny * ny <= 1;
  }

  /**
   * Topmost unit of `ownerFilter` under the pointer. Shared by right-click
   * targeting and the CMD-03 cursor so the two can never disagree about what the
   * pointer is over.
   */
  private findUnitAt(worldPoint: { x: number; y: number }, ownerFilter?: string): string | null {
    if (!this.room) return null;
    let foundId: string | null = null;
    let foundDepth = -Infinity;
    this.room.state.units.forEach((unit: any, uId: string) => {
      if (ownerFilter !== undefined && !this.ownerMatches(unit.ownerId, ownerFilter)) return;
      const container = this.unitSprites.get(uId);
      if (container && this.hitTestUnit(worldPoint.x, worldPoint.y, container) && container.depth > foundDepth) {
        foundId = uId;
        foundDepth = container.depth;
      }
    });
    return foundId;
  }

  /**
   * Building whose footprint contains `grid`. Ownership is the caller's filter:
   * right-click attacks foreign buildings, the cursor only cares that one is there.
   */
  private findBuildingAt(grid: { gridX: number; gridY: number }, ownerFilter?: string): string | null {
    if (!this.room) return null;
    let foundId: string | null = null;
    this.room.state.buildings.forEach((b: any, bId: string) => {
      if (ownerFilter !== undefined && !this.ownerMatches(b.ownerId, ownerFilter)) return;
      if (
        grid.gridX >= b.gridX &&
        grid.gridX < b.gridX + b.sizeX &&
        grid.gridY >= b.gridY &&
        grid.gridY < b.gridY + b.sizeY
      ) {
        foundId = bId;
      }
    });
    return foundId;
  }

  /**
   * CMD-05: id of one of the player's own unfinished buildings whose footprint
   * contains `grid`, or null. Builds on `findBuildingAt` so the pointer, the
   * cursor and the right-click order all agree on which building a click lands on.
   */
  private findOwnFoundationAt(grid: { gridX: number; gridY: number }): string | null {
    const buildingId = this.findBuildingAt(grid, this.mySessionId);
    if (!buildingId) return null;
    const building = this.room?.state.buildings.get(buildingId);
    return building && !building.isConstructed ? buildingId : null;
  }

  /** Resource node under the pointer: sprite distance first, then exact grid cell. */
  private findResourceAt(worldPoint: { x: number; y: number }, grid: { gridX: number; gridY: number }): string | null {
    if (!this.room) return null;
    let foundId: string | null = null;
    this.room.state.resourceNodes.forEach((res: any, resId: string) => {
      if (foundId) return;
      const resSprite = this.resourceSprites.get(resId);
      if (resSprite) {
        const centerY = res.type === 'TREE' ? resSprite.y - 45 : resSprite.y - 18;
        if (Math.hypot(worldPoint.x - resSprite.x, worldPoint.y - centerY) < 38) {
          foundId = resId;
        }
      }
      if (!foundId && res.gridX === grid.gridX && res.gridY === grid.gridY) {
        foundId = resId;
      }
    });
    return foundId;
  }

  /**
   * CMD-03: what a right click at `worldPoint` would do right now. Mirrors the
   * unit-order branches of `handleRightClickCommand` (placement, attack on an
   * enemy, build on own foundation, harvest, move) using the same hit-tests, so
   * the cursor can never promise an order that the click will not issue. The
   * rally-point branch is not represented: it only applies with a building
   * selected and no units, which resolves to `default`.
   */
  private resolveCursorMode(worldPoint: { x: number; y: number }): CursorMode {
    const grid = screenToGrid(worldPoint.x, worldPoint.y);

    if (this.buildingToPlace) {
      const blueprint = BUILDING_BLUEPRINTS[this.buildingToPlace];
      return this.isPlacementValid(grid.gridX, grid.gridY, blueprint) ? 'build-ok' : 'build-blocked';
    }

    // CMD-01: an armed attack-move / patrol is waiting for a destination click,
    // so the pointer is picking a point rather than targeting what is under it.
    if (this.pendingOrder) return 'order';

    if (!this.room || this.selectedUnitIds.size === 0) return 'default';

    if (this.findUnitAt(worldPoint, 'enemy') || this.findBuildingAt(grid, 'enemy')) return 'attack';

    // CMD-05: an own, unfinished building under the pointer is a build site.
    if (this.selectionIsAllVillagers() && this.findOwnFoundationAt(grid)) return 'construction';

    if (this.selectionIsAllVillagers() && this.findResourceAt(worldPoint, grid)) return 'harvest';

    return 'default';
  }

  /**
   * Harvest is villager-only on the server, so the cursor must not advertise it
   * for a mixed or military selection. Unknown ids (despawned units) count as
   * "not a villager" to stay conservative.
   */
  private selectionIsAllVillagers(): boolean {
    if (!this.room || this.selectedUnitIds.size === 0) return false;
    for (const unitId of this.selectedUnitIds) {
      const unit = this.room.state.units.get(unitId);
      if (!unit || unit.type !== 'VILLAGER') return false;
    }
    return true;
  }

  /**
   * Applies `mode` to the canvas. Phaser writes the CSS cursor, so re-asserting
   * the same value every pointermove would touch the DOM ~60 times a second -
   * the applied value is cached and only actual changes are written.
   */
  private setCursorMode(mode: CursorMode) {
    const css = CURSOR_CSS[mode];
    if (css === this.appliedCursorCss) return;
    this.appliedCursorCss = css;
    this.input.setDefaultCursor(css);
  }

  /**
   * Recomputes the cursor from the most recent pointer position. Safe to call
   * before the pointer has ever moved (nothing to resolve against) and while
   * box-selecting (the drag rectangle is the feedback there, and switching the
   * cursor mid-drag would flicker as units pass under it).
   */
  private refreshCursor() {
    if (!this.lastPointerWorld) return;
    if (this.isDragSelecting) return;
    this.setCursorMode(this.resolveCursorMode(this.lastPointerWorld));
  }

  /**
   * `findUnitAt`/`findBuildingAt` take an owner filter that is either a session
   * id or the literal `'enemy'`. Resolving that here keeps both call sites from
   * re-implementing the comparison.
   */
  private ownerMatches(ownerId: string, filter: string): boolean {
    return filter === 'enemy' ? ownerId !== this.mySessionId : ownerId === filter;
  }

  private performSingleClickSelection(pointer: Phaser.Input.Pointer, additive = false, selectSameType = false) {
    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const clickGrid = screenToGrid(worldPoint.x, worldPoint.y);

    // Check click on units first (shared hit-test, topmost depth wins)
    let clickedUnitId: string | null = null;
    let clickedUnitDepth = -Infinity;
    this.unitSprites.forEach((container, unitId) => {
      if (this.hitTestUnit(worldPoint.x, worldPoint.y, container) && container.depth > clickedUnitDepth) {
        clickedUnitId = unitId;
        clickedUnitDepth = container.depth;
      }
    });

    if (clickedUnitId) {
      const unit = this.room?.state.units.get(clickedUnitId);
      const isOwn = !!unit && unit.ownerId === this.mySessionId;

      // Double-click is detected per unit so a double-click on ground or on a
      // building does not leave a stale timestamp behind.
      const now = this.time.now;
      const isDoubleClick =
        this.lastUnitClick.unitId === clickedUnitId && now - this.lastUnitClick.at <= DOUBLE_CLICK_SAME_TYPE_MS;
      this.lastUnitClick = { unitId: clickedUnitId, at: now };

      // Same-type selection only makes sense for units we own and can order.
      if (isOwn && unit && (selectSameType || isDoubleClick)) {
        this.selectUnitsOfTypeInViewport(unit.type, additive);
        return;
      }

      if (additive) {
        this.toggleUnitSelection(clickedUnitId);
        return;
      }

      this.clearSelection();
      this.addUnitToSelection(clickedUnitId);
      this.notifySelectionChange();
      return;
    }

    this.lastUnitClick = { unitId: '', at: 0 };

    // Shift-clicking anything that is not a unit keeps the current selection,
    // so a stray shift-click on terrain does not wipe the army being gathered.
    if (additive) return;

    this.clearSelection();

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

    // Check click on resources (first check visual sprite distance, fallback to grid)
    let clickedResId: string | null = null;
    if (this.room) {
      this.room.state.resourceNodes.forEach((res: any, resId: string) => {
        if (clickedResId) return;
        const resSprite = this.resourceSprites.get(resId);
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
      this.selectedResourceId = clickedResId;
    }

    this.notifySelectionChange();
  }

  private performBoxSelection(
    p1Screen: { x: number; y: number },
    p2Screen: { x: number; y: number },
    additive = false
  ) {
    const p1World = this.cameras.main.getWorldPoint(p1Screen.x, p1Screen.y);
    const p2World = this.cameras.main.getWorldPoint(p2Screen.x, p2Screen.y);

    const minX = Math.min(p1World.x, p2World.x);
    const maxX = Math.max(p1World.x, p2World.x);
    const minY = Math.min(p1World.y, p2World.y);
    const maxY = Math.max(p1World.y, p2World.y);

    // Shift-drag adds to the current selection instead of replacing it.
    if (!additive) this.clearSelection();

    let selectedCount = this.selectedUnitIds.size;
    let added = 0;

    this.unitSprites.forEach((container, unitId) => {
      if (selectedCount >= MAX_SELECTION) return;
      const unit = this.room?.state.units.get(unitId);
      if (unit && unit.ownerId === this.mySessionId && !this.selectedUnitIds.has(unitId)) {
        // Same body box as hitTestUnit, as an AABB so partial overlap still counts.
        const { centerY, radiusX, radiusY } = this.getUnitBodyBox(container);
        const unitLeft = container.x - radiusX;
        const unitRight = container.x + radiusX;
        const unitTop = centerY - radiusY;
        const unitBottom = centerY + radiusY;

        const overlaps = unitRight >= minX && unitLeft <= maxX && unitBottom >= minY && unitTop <= maxY;
        if (overlaps) {
          this.selectedUnitIds.add(unitId);
          const ring = container.getData('selectRing') as Phaser.GameObjects.Graphics;
          ring?.setVisible(true);
          selectedCount++;
          added++;
        }
      }
    });

    // A mixed selection (building + units) has no meaning for commands, so
    // collecting units cancels the single-entity selection.
    if (added > 0) this.clearBuildingAndResourceSelection();

    this.notifySelectionChange();
  }

  /** Rings one unit on. Max-selection overflow is the caller's problem. */
  private addUnitToSelection(unitId: string) {
    const container = this.unitSprites.get(unitId);
    this.selectedUnitIds.add(unitId);
    const ring = container?.getData('selectRing') as Phaser.GameObjects.Graphics | undefined;
    ring?.setVisible(true);
  }

  /** Shift-click a unit: first click adds, second click removes it again. */
  private toggleUnitSelection(unitId: string) {
    const container = this.unitSprites.get(unitId);

    if (this.selectedUnitIds.has(unitId)) {
      this.selectedUnitIds.delete(unitId);
      const ring = container?.getData('selectRing') as Phaser.GameObjects.Graphics;
      ring?.setVisible(false);
      this.notifySelectionChange();
      return;
    }

    if (this.selectedUnitIds.size >= MAX_SELECTION) return;

    this.addUnitToSelection(unitId);
    this.clearBuildingAndResourceSelection();
    this.notifySelectionChange();
  }

  /**
   * Ctrl-click / double-click: select every own unit of `type` that is visible
   * in the current viewport (AoE2 only takes what is on screen).
   */
  private selectUnitsOfTypeInViewport(type: string, additive = false) {
    const view = this.cameras.main.worldView;

    if (!additive) this.clearSelection();

    let selectedCount = this.selectedUnitIds.size;
    let added = 0;

    this.unitSprites.forEach((container, unitId) => {
      if (selectedCount >= MAX_SELECTION) return;
      const unit = this.room?.state.units.get(unitId);
      if (!unit || unit.ownerId !== this.mySessionId || unit.type !== type) return;
      if (this.selectedUnitIds.has(unitId)) return;

      const { centerY, radiusX, radiusY } = this.getUnitBodyBox(container);
      const visible =
        container.x + radiusX >= view.x &&
        container.x - radiusX <= view.right &&
        centerY + radiusY >= view.y &&
        centerY - radiusY <= view.bottom;
      if (!visible) return;

      this.addUnitToSelection(unitId);
      selectedCount++;
      added++;
    });

    if (added > 0) this.clearBuildingAndResourceSelection();
    this.notifySelectionChange();
  }

  public clearSelection() {
    // Escape routes through here (App.tsx), so an armed order is dropped too.
    this.cancelPendingOrder();

    this.selectedUnitIds.forEach((uId) => {
      const container = this.unitSprites.get(uId);
      const ring = container?.getData('selectRing') as Phaser.GameObjects.Graphics;
      ring?.setVisible(false);
    });
    this.selectedUnitIds.clear();

    this.clearBuildingAndResourceSelection();
  }

  /** Units and buildings never mix in a selection, so this is also called alone. */
  private clearBuildingAndResourceSelection() {
    if (this.selectedBuildingId) {
      const bContainer = this.buildingSprites.get(this.selectedBuildingId);
      const foundation = bContainer?.getData('foundation') as Phaser.GameObjects.Graphics;
      foundation?.setVisible(false);
    }

    this.selectedBuildingId = null;
    this.selectedResourceId = null;
  }

  private bindControlGroupKeys(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    CONTROL_GROUP_KEYS.forEach((name, i) => {
      const index = i + 1;
      keyboard.on(`keydown-${name}`, (event: KeyboardEvent) => {
        if (event.ctrlKey || event.metaKey) {
          // Ctrl/Cmd + digit is a browser tab shortcut, and Phaser deliberately
          // skips its own preventDefault for keys pressed with a modifier - so
          // the tab would switch instead of the group being assigned.
          event.preventDefault();
          this.groupControlGroup(index);
        } else {
          this.recallControlGroup(index);
        }
      });
    });
  }

  /**
   * CTL-03: `S` cancels the current order of every selected unit and leaves it
   * standing where it is.
   *
   * Modifier combos are ignored on purpose: Ctrl/Cmd+S is the browser's Save
   * dialog, and Shift/Alt+S belong to future hotkey layers.
   */
  private bindStopKey(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    keyboard.on('keydown-S', (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      // A pending building placement owns the keyboard; stopping units there
      // would fire an invisible command while the player is placing a farm.
      if (this.buildingToPlace) return;
      if (this.selectedUnitIds.size === 0) return;

      event.preventDefault();
      this.stopSelectedUnits();
    });
  }

  /**
   * Halts the selection in place. The server is authoritative; this only sends
   * the craft. Local prediction would fight the server snapshot for liveness.
   */
  public stopSelectedUnits() {
    if (!this.room || this.selectedUnitIds.size === 0) return;

    const unitIds = Array.from(this.selectedUnitIds);
    this.room.send(NetworkMessage.STOP_UNITS, { unitIds });

    // Ring on the ground at each stopped unit, so the command has visible
    // effect even when the unit was already standing still (IDLE -> IDLE).
    unitIds.forEach((uId) => {
      const container = this.unitSprites.get(uId);
      if (container) this.showCommandFeedback(container.x, container.y, 0xfacc15);
    });
  }

  /**
   * CMD-04b: `Delete` cancels the selected foundation.
   *
   * The unit selection owns `S` and `.`, so this only fires with no units
   * selected. Ownership and completion are checked here before sending, because
   * the server refuses both — claiming the keystroke for a command that cannot
   * be executed would just look like the key is broken.
   *
   * Both key codes are bound because the key labelled "delete" on a Mac keyboard
   * is BACKSPACE; binding only DELETE would make the advertised shortcut do
   * nothing on macOS.
   */
  private bindCancelKey(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    const handleKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (this.buildingToPlace) return;
      if (this.selectedUnitIds.size > 0) return;

      // Phaser re-emits `keydown-<KEY>` for a key that stays down, so a held
      // Delete would fire CANCEL_BUILDING dozens of times per second and the
      // server would answer every extra one with an error. `event.repeat` does
      // not catch that (the re-emitted event is not a DOM repeat), so the
      // keystroke is debounced by time. 250 ms is below a deliberate double tap
      // and well above the OS auto-repeat ramp.
      const now = performance.now();
      if (now - this.lastCancelKeyAt < CANCEL_KEY_DEBOUNCE_MS) return;

      if (!this.cancelSelectedFoundation()) return;
      this.lastCancelKeyAt = now;
      event.preventDefault();
    };

    keyboard.on('keydown-DELETE', handleKey);
    keyboard.on('keydown-BACKSPACE', handleKey);
  }

  /**
   * Sends CANCEL_BUILDING for the selected building.
   *
   * @returns true when a command was actually sent, so the caller can swallow
   * the key event only when it did something.
   */
  public cancelSelectedFoundation(): boolean {
    if (!this.room || !this.selectedBuildingId) return false;

    const building = this.room.state.buildings.get(this.selectedBuildingId);
    if (!building) return false;
    if (building.ownerId !== this.mySessionId) return false;
    if (building.isConstructed) return false;

    this.room.send(NetworkMessage.CANCEL_BUILDING, { buildingId: this.selectedBuildingId });
    return true;
  }

  /**
   * CMD-01: `A` arms attack-move, `P` arms patrol; the next left click picks the
   * destination, which is exactly how AoE2's two-step order works.
   *
   * The keys are ignored with any modifier (Ctrl+A selects everything in the
   * browser, Cmd+P prints), during placement, and with nothing selected - arming
   * an order that can never be issued would just leave the cursor crosshaired.
   */
  private bindOrderKeys(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    const arm = (mode: 'ATTACK_MOVE' | 'PATROL') => (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (this.buildingToPlace) return;
      if (this.selectedUnitIds.size === 0) return;

      // Phaser re-emits keydown while the key is held down (see bindCancelKey).
      const now = performance.now();
      if (this.lastOrderKey.mode === mode && now - this.lastOrderKey.at < ORDER_KEY_DEBOUNCE_MS) return;
      this.lastOrderKey = { mode, at: now };

      event.preventDefault();
      this.pendingOrder = mode;
      this.refreshCursor();
    };

    keyboard.on('keydown-A', arm('ATTACK_MOVE'));
    keyboard.on('keydown-P', arm('PATROL'));
  }

  /** Drops an armed order (right click, Escape) and restores the pointer. */
  private cancelPendingOrder() {
    if (!this.pendingOrder) return;
    this.pendingOrder = null;
    this.refreshCursor();
  }

  /**
   * Turns the armed order into a message. The destination is read from the same
   * pointer position the click used, so the order lands on the highlighted tile.
   */
  private commitPendingOrder(pointer: Phaser.Input.Pointer) {
    const mode = this.pendingOrder;
    this.pendingOrder = null;
    this.refreshCursor();
    if (mode) this.issueAttackMoveOrder(pointer, mode);
  }

  /**
   * Sends ATTACK_MOVE or PATROL for the current selection.
   *
   * Out-of-map points are dropped here as well as on the server: a click on the
   * terrain edge would otherwise cost a round-trip to be refused.
   */
  private issueAttackMoveOrder(pointer: Phaser.Input.Pointer, mode: 'ATTACK_MOVE' | 'PATROL') {
    if (!this.room || this.selectedUnitIds.size === 0) return;
    if (this.buildingToPlace) return;

    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const grid = screenToGrid(worldPoint.x, worldPoint.y);
    if (grid.gridX < 0 || grid.gridY < 0 || grid.gridX >= MAP_GRID_WIDTH || grid.gridY >= MAP_GRID_HEIGHT) {
      return;
    }

    this.room.send(mode === 'PATROL' ? NetworkMessage.PATROL : NetworkMessage.ATTACK_MOVE, {
      unitIds: Array.from(this.selectedUnitIds),
      targetGridX: grid.gridX,
      targetGridY: grid.gridY
    });
    this.showCommandFeedback(worldPoint.x, worldPoint.y, 0xef4444);
  }

  /**
   * CTL-04: `.` jumps to the next idle villager, `Ctrl + .` to the next idle
   * military unit. Selection follows the camera, so the jumped-to unit is ready
   * for an order without a second click.
   *
   * Modifiers other than Ctrl are ignored: Shift+. is `>` (reserved for future
   * layers) and Alt/Cmd combinations belong to the OS or the browser.
   */
  private bindIdleCycleKeys(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    keyboard.on('keydown-PERIOD', (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.metaKey || event.shiftKey || event.altKey) return;
      // Placement mode owns the keyboard; stealing the selection mid-placement
      // would drop the building cursor without telling the player why.
      if (this.buildingToPlace) return;

      event.preventDefault();
      this.cycleToIdleUnit(event.ctrlKey ? 'military' : 'villager');
    });
  }

  /**
   * CTL-04: `H` re-centres the camera on this player's Town Center.
   * Ctrl/Cmd+H are browser shortcuts (history, hide), so those are left alone.
   */
  private bindHomeKey(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    keyboard.on('keydown-H', (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const townCenter = this.findOwnTownCenter();
      if (!townCenter) return;

      event.preventDefault();
      this.panTo(townCenter.gridX + townCenter.sizeX / 2, townCenter.gridY + townCenter.sizeY / 2);
    });
  }

  /**
   * Selects the next idle unit of `category`, wrapping around at the end.
   *
   * Only IDLE counts: a unit walking home or harvesting is busy, and jumping to it
   * would make the hotkey feel random. Nothing is selected when no unit qualifies -
   * the current selection stays as it was instead of being cleared for no reason.
   */
  public cycleToIdleUnit(category: 'villager' | 'military') {
    if (!this.room) return;

    const idleIds: string[] = [];
    this.room.state.units.forEach((unit: any, unitId: string) => {
      if (unit.ownerId !== this.mySessionId) return;
      if (unit.actionState !== 'IDLE') return;
      const isVillager = unit.type === 'VILLAGER';
      if (category === 'villager' ? !isVillager : isVillager) return;
      idleIds.push(unitId);
    });
    if (idleIds.length === 0) return;

    // Colyseus preserves insertion order, which is stable across snapshots, but an
    // explicit sort keeps the cycle predictable regardless of snapshot timing.
    idleIds.sort();

    const anchor = this.idleCycleAnchor[category];
    const anchorIndex = anchor ? idleIds.indexOf(anchor) : -1;
    const nextId = idleIds[(anchorIndex + 1) % idleIds.length];
    this.idleCycleAnchor[category] = nextId;

    this.focusUnit(nextId);
  }

  /** Selects exactly one unit and pans the camera onto it. */
  private focusUnit(unitId: string) {
    this.clearSelection();
    this.addUnitToSelection(unitId);
    this.notifySelectionChange();

    const container = this.unitSprites.get(unitId);
    const unit = this.room?.state.units.get(unitId);
    // Sprite position lerps toward the server position, so it is the visually
    // correct target; fall back to the snapshot when the sprite is not built yet.
    const pos = container
      ? { x: container.x, y: container.y }
      : unit
        ? gridToScreen(unit.x, unit.y)
        : null;
    if (!pos) return;

    this.cameras.main.pan(pos.x, pos.y, 350, 'Power2');
    this.showCommandFeedback(pos.x, pos.y, 0x22d3ee);
  }

  private groupControlGroup(index: number) {
    const ids = new Set<string>();
    this.selectedUnitIds.forEach((unitId) => {
      const unit = this.room?.state.units.get(unitId);
      // Left-click selection ignores ownership, so filter here - otherwise a
      // misclicked enemy unit would follow us into the group and take orders.
      if (unit && unit.ownerId === this.mySessionId) ids.add(unitId);
    });
    // Assigning with nothing selected empties the group, like AoE2.
    this.controlGroups.set(index, ids);
  }

  private recallControlGroup(index: number) {
    const ids = this.controlGroups.get(index);
    if (!ids || ids.size === 0) return;

    const now = this.time.now;
    const centerCamera =
      this.lastGroupRecall.index === index &&
      now - this.lastGroupRecall.at <= CONTROL_GROUP_RECALL_DOUBLE_MS;
    this.lastGroupRecall = { index, at: now };

    this.clearSelection();
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    ids.forEach((unitId) => {
      const container = this.unitSprites.get(unitId);
      if (!container) return;
      this.selectedUnitIds.add(unitId);
      const ring = container.getData('selectRing') as Phaser.GameObjects.Graphics;
      ring?.setVisible(true);
      // container.x/y are already world coordinates; panTo() expects grid ones.
      sumX += container.x;
      sumY += container.y;
      count++;
    });
    this.notifySelectionChange();

    if (centerCamera && count > 0) {
      this.cameras.main.pan(sumX / count, sumY / count, 250, 'Power2');
    }
  }

  /**
   * Resolves a right-click into one order for the current selection.
   *
   * @param queue Shift is held: ground clicks append a waypoint to the unit's
   *   path instead of replacing the order (CTL-05). Entity targets still issue
   *   their normal order — attack/harvest have no queue model on the server, and
   *   a half-queued attack would be worse than a plain one.
   */
  private handleRightClickCommand(pointer: Phaser.Input.Pointer, queue = false) {
    if (!this.room) return;

    // CTL-06: with no unit selected, a right-click on the map sets the rally
    // point of the selected own building instead of doing nothing.
    if (this.selectedUnitIds.size === 0) {
      this.handleSetRallyPointCommand(pointer);
      return;
    }

    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const targetGrid = screenToGrid(worldPoint.x, worldPoint.y);

    // 1. Check if right-clicked on an enemy unit (shared hit-test with left-click)
    const targetEnemyUnitId = this.findUnitAt(worldPoint, 'enemy');
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
    const targetEnemyBuildingId = this.findBuildingAt(targetGrid, 'enemy');
    if (targetEnemyBuildingId) {
      this.room.send(NetworkMessage.ATTACK_TARGET, {
        unitIds: Array.from(this.selectedUnitIds),
        targetEntityId: targetEnemyBuildingId,
        targetType: 'building'
      });
      this.showCommandFeedback(worldPoint.x, worldPoint.y, 0xef4444);
      return;
    }

    // 3. CMD-05: right-clicking your own foundation with villagers selected puts
    // them to work on it instead of walking them onto the footprint.
    const ownFoundationId = this.findOwnFoundationAt(targetGrid);
    if (ownFoundationId && this.selectionIsAllVillagers()) {
      this.room.send(NetworkMessage.BUILD_TARGET, {
        unitIds: Array.from(this.selectedUnitIds),
        buildingId: ownFoundationId
      });
      this.showCommandFeedback(worldPoint.x, worldPoint.y, 0xf97316);
      return;
    }

    // 4. Check if right-clicked on a resource node (harvest command)
    const targetResourceNodeId = this.findResourceAt(worldPoint, targetGrid);
    if (targetResourceNodeId) {
      this.room.send(NetworkMessage.HARVEST_RESOURCE, {
        unitIds: Array.from(this.selectedUnitIds),
        resourceNodeId: targetResourceNodeId
      });
      this.showCommandFeedback(worldPoint.x, worldPoint.y, 0xf59e0b);
      return;
    }

    // 5. Default: Move command to target ground
    this.room.send(NetworkMessage.MOVE_UNITS, {
      unitIds: Array.from(this.selectedUnitIds),
      targetGridX: targetGrid.gridX,
      targetGridY: targetGrid.gridY,
      ...(queue ? { queue: true } : {})
    });
    this.showCommandFeedback(worldPoint.x, worldPoint.y, 0x22c55e);
  }

  /**
   * CTL-07: issues a plain move order to `gridX, gridY` for the current
   * selection. Used by the minimap, which has no pointer over the world, so it
   * cannot reuse `handleRightClickCommand`.
   *
   * Mirrors the ground branch of `handleRightClickCommand` — same message, same
   * payload, no queue flag — because the minimap has no Shift modifier to read.
   * Does nothing while placing a building (placement owns the input) and with no
   * unit selected (a building-only selection must not be turned into a move).
   * Coordinates are clamped here as well as on the server: a click on the very
   * edge of the minimap can land exactly on the map size.
   */
  public commandMoveTo(gridX: number, gridY: number) {
    if (!this.room) return;
    if (this.buildingToPlace) return;
    if (this.selectedUnitIds.size === 0) return;

    const targetGridX = Math.max(0, Math.min(MAP_GRID_WIDTH - 1, Math.round(gridX)));
    const targetGridY = Math.max(0, Math.min(MAP_GRID_HEIGHT - 1, Math.round(gridY)));

    this.room.send(NetworkMessage.MOVE_UNITS, {
      unitIds: Array.from(this.selectedUnitIds),
      targetGridX,
      targetGridY
    });

    const screenPos = gridToScreen(targetGridX, targetGridY);
    this.showCommandFeedback(screenPos.x, screenPos.y, 0x22c55e);
  }

  /**
   * CTL-06: turns a right-click into a rally order for the selected building.
   *
   * Silently does nothing when the selection is not exactly one own building that
   * can train — right-clicking empty terrain with nothing selected must not spam
   * the server, and a House cannot hold a rally point. Out-of-map clicks are
   * dropped client-side too, so the common misclick never costs a round-trip.
   */
  private handleSetRallyPointCommand(pointer: Phaser.Input.Pointer) {
    if (!this.room || !this.selectedBuildingId) return;

    const building = this.room.state.buildings.get(this.selectedBuildingId);
    if (!building || !this.isOwnBuilding(building.ownerId)) return;
    if (!canTrainUnitsAt(building.type as BuildingType)) return;

    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const grid = screenToGrid(worldPoint.x, worldPoint.y);
    if (grid.gridX < 0 || grid.gridY < 0 || grid.gridX >= MAP_GRID_WIDTH || grid.gridY >= MAP_GRID_HEIGHT) {
      return;
    }

    this.room.send(NetworkMessage.SET_RALLY_POINT, {
      buildingId: this.selectedBuildingId,
      gridX: grid.gridX,
      gridY: grid.gridY
    });
    this.showCommandFeedback(worldPoint.x, worldPoint.y, 0x38bdf8);
  }

  /**
   * CTL-06: draws a flag on every own building's rally point plus a faint line
   * back to the building it belongs to.
   *
   * Runs from update(), so the frame-to-frame cost is what matters: the flags are
   * collected first and only redrawn when the collected signature actually
   * changed (a rally point moved, a building appeared or was destroyed). Rally
   * changes arrive as state patches from other clients too, so a signature beats
   * tracking individual patches.
   */
  private updateRallyMarkers() {
    const markers: { id: string; rallyX: number; rallyY: number }[] = [];

    if (this.room) {
      this.room.state.buildings.forEach((b: any) => {
        if (!this.isOwnBuilding(b.ownerId)) return;
        if (!(b.rallyX >= 0 && b.rallyY >= 0)) return;
        if (!this.buildingSprites.get(b.id)) return;
        markers.push({ id: b.id, rallyX: b.rallyX, rallyY: b.rallyY });
      });
    }

    const signature = markers.map((m) => `${m.id}:${m.rallyX},${m.rallyY}`).join('|');
    if (signature === this.rallySignature) return;
    this.rallySignature = signature;

    this.rallyGraphics.clear();

    markers.forEach((m) => {
      const container = this.buildingSprites.get(m.id);
      if (!container) return;

      const flag = gridToScreen(m.rallyX, m.rallyY);
      const marker = this.rallyGraphics;

      marker.lineStyle(1, 0x38bdf8, 0.3);
      marker.lineBetween(container.x, container.y, flag.x, flag.y);

      marker.fillStyle(0x0f172a, 0.55);
      marker.fillEllipse(flag.x, flag.y, 22, 11);

      // Pole and a triangle pennant pointing left.
      marker.lineStyle(2, 0xe2e8f0, 0.9);
      marker.lineBetween(flag.x, flag.y, flag.x, flag.y - 34);
      marker.fillStyle(0x38bdf8, 0.95);
      marker.fillTriangle(flag.x, flag.y - 34, flag.x, flag.y - 20, flag.x - 16, flag.y - 27);
    });
  }

  /**
   * Pans the camera when the pointer sits inside the screen border band.
   * Uses `activePointer` screen coordinates, which are immune to camera scroll,
   * and skips entirely when the pointer is off-canvas or over the React HUD
   * (the pointer then reports negative / out-of-range coordinates).
   */
  private applyEdgeScroll(cameraSpeed: number) {
    if (EDGE_SCROLL_SIZE_PX <= 0) return;
    // Before the first real pointermove the pointer sits at (0,0), which is
    // inside the edge band - scrolling on phantom input would drag the camera
    // away from the base while the player is still looking at the page.
    if (!this.hasPointerMoved) return;

    const pointer = this.input.activePointer;
    const width = this.scale.width;
    const height = this.scale.height;

    // Pointer outside the game canvas (e.g. hovering the HUD panel).
    if (pointer.x < 0 || pointer.y < 0 || pointer.x > width || pointer.y > height) return;

    const cam = this.cameras.main;
    if (pointer.x <= EDGE_SCROLL_SIZE_PX) cam.scrollX -= cameraSpeed;
    else if (pointer.x >= width - EDGE_SCROLL_SIZE_PX) cam.scrollX += cameraSpeed;

    if (pointer.y <= EDGE_SCROLL_SIZE_PX) cam.scrollY -= cameraSpeed;
    else if (pointer.y >= height - EDGE_SCROLL_SIZE_PX) cam.scrollY += cameraSpeed;
  }

  /**
   * CTL-05: while Shift is held, draws the pending path of every selected unit —
   * current position, the order it is executing, then each queued waypoint, and
   * finally the point under the pointer. Purely cosmetic: it reads the snapshot
   * and never mutates an order.
   */
  private updateWaypointPreview() {
    this.waypointGraphics.clear();
    if (!this.room || !this.shiftKey?.isDown) return;
    if (this.buildingToPlace || this.selectedUnitIds.size === 0) return;

    const worldPoint = this.input.activePointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const line = this.waypointGraphics;
    line.lineStyle(2, 0xfde68a, 0.55);

    this.selectedUnitIds.forEach((unitId) => {
      const unit = this.room?.state.units.get(unitId);
      const container = this.unitSprites.get(unitId);
      if (!unit || !container || unit.ownerId !== this.mySessionId) return;

      const points: { x: number; y: number }[] = [{ x: container.x, y: container.y }];
      if (unit.actionState === 'MOVING') {
        points.push(gridToScreen(unit.targetX, unit.targetY));
      }

      const queueX = unit.queueTargetX as ArrayLike<number> | undefined;
      const queueY = unit.queueTargetY as ArrayLike<number> | undefined;
      if (queueX && queueY) {
        const count = Math.min(queueX.length, queueY.length);
        for (let i = 0; i < count; i++) {
          points.push(gridToScreen(queueX[i], queueY[i]));
        }
      }

      points.push({ x: worldPoint.x, y: worldPoint.y });

      line.beginPath();
      line.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        line.lineTo(points[i].x, points[i].y);
      }
      line.strokePath();

      // Ring every committed waypoint; the pointer end stays unmarked.
      for (let i = 1; i < points.length - 1; i++) {
        line.strokeCircle(points[i].x, points[i].y, 5);
      }
    });
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
    let offsetY = -130;
    let scale = 1.0;

    const customKey = `building_${type}`;
    if (this.textures.exists(customKey)) {
      textureKey = customKey;
      if (type === 'TOWN_CENTER') {
        offsetY = -130;
      } else if (type === 'BARRACKS') {
        offsetY = -96;
      } else if (type === 'HOUSE') {
        offsetY = -70;
      } else if (type === 'FARM') {
        offsetY = 0;
      } else if (type === 'TOWER') {
        offsetY = -160;
      }
    } else {
      if (type === 'BARRACKS') {
        textureKey = 'b_barracks';
        offsetY = -70;
      } else if (type === 'HOUSE') {
        textureKey = 'b_house';
        offsetY = -50;
      } else if (type === 'FARM') {
        textureKey = 'b_farm';
        offsetY = 0;
      } else if (type === 'TOWER') {
        textureKey = 'b_tower';
        offsetY = -90;
      }
    }

    this.placementGhostImage.setTexture(textureKey);
    this.placementGhostImage.setY(offsetY);
    this.placementGhostImage.setScale(scale);
  }

  public cancelBuildingPlacement() {
    this.buildingToPlace = null;
    this.placementGhost.setVisible(false);
    // Placement owns the cursor while active, so leaving the mode has to restore
    // it even though the pointer has not moved.
    this.refreshCursor();
    if (this.onPlacementCancelled) {
      this.onPlacementCancelled();
    }
  }

  private commitBuildingPlacement(pointer: Phaser.Input.Pointer) {
    if (!this.buildingToPlace || !this.room) return;
    const blueprint = BUILDING_BLUEPRINTS[this.buildingToPlace];

    // Recompute from the pointer that actually clicked. `hoverGridCoord` is only
    // refreshed on pointermove, so a click right after a camera pan (or any input
    // source that skips pointermove) would otherwise place the building at a stale
    // coordinate.
    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const { gridX, gridY } = screenToGrid(worldPoint.x, worldPoint.y);
    this.hoverGridCoord = { gridX, gridY };

    if (this.isPlacementValid(gridX, gridY, blueprint)) {
      this.room.send(NetworkMessage.PLACE_BUILDING, { type: this.buildingToPlace, gridX, gridY });
      this.cancelBuildingPlacement();
      return;
    }

    // Stay in placement mode (AoE lets you retry another tile) but tell the player
    // why nothing happened, at the spot they clicked.
    const ghostPos = gridToScreen(gridX + blueprint.sizeX / 2 - 0.5, gridY + blueprint.sizeY / 2 - 0.5);
    this.showCommandFeedback(ghostPos.x, ghostPos.y, 0xef4444);
  }

  public panTo(gridX: number, gridY: number) {    const screenPos = gridToScreen(gridX, gridY);
    this.cameras.main.pan(screenPos.x, screenPos.y, 350, 'Power2');
  }

  private notifySelectionChange() {
    // An armed order belongs to the units selected when it was given. Once they
    // are all gone (killed, or replaced by a building) the next click would be
    // swallowed with nothing to command, so the order is dropped first.
    if (this.selectedUnitIds.size === 0) this.cancelPendingOrder();

    // Selection fingerprints the cursor (harvest needs an all-villager selection,
    // attack needs units), so recompute even when no React callback is wired.
    this.refreshCursor();

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
          trainingQueue: Array.from(b.trainingQueue),
          isConstructed: b.isConstructed,
          constructionProgress: b.constructionProgress
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

          // Natural AoE 2 meadow grass - 100% continuous, zero diamond stair-steps
          const variant = ((gx * 7 + gy * 13) % 3) + 1;
          const texKey = this.textures.exists(`tile_grass_${variant}`) ? `tile_grass_${variant}` : 'tile_grass';
          if (tile.texture.key !== texKey) {
            tile.setTexture(texKey);
          }

          tile.setPosition(screenPos.x, screenPos.y);
          tile.setVisible(true);
          tile.clearTint();
        }
      }
    }

    // Hide remaining unused tiles
    const totalPooled = this.tilePool.length;
    while (poolIdx < totalPooled) {
      this.tilePool[poolIdx++].setVisible(false);
    }

    // Render continuous organic AoE dirt roads over seamless grass (zero diamond stair-steps)
    let roadPoolIdx = 0;
    const roadMargin = 140;
    const rLeft = left - roadMargin;
    const rRight = right + roadMargin;
    const rTop = top - roadMargin;
    const rBottom = bottom + roadMargin;

    const roadPointsLen = this.allRoadPoints.length;
    for (let i = 0; i < roadPointsLen; i++) {
      const rp = this.allRoadPoints[i];
      if (rp.x >= rLeft && rp.x <= rRight && rp.y >= rTop && rp.y <= rBottom) {
        let stamp = this.roadStampPool[roadPoolIdx];
        if (!stamp) {
          stamp = this.add.image(0, 0, 'road_stamp');
          stamp.setDepth(-99990);
          this.roadStampPool.push(stamp);
        }
        roadPoolIdx++;

        const stampKey = `road_stamp_${rp.variant}`;
        if (stamp.texture.key !== stampKey && this.textures.exists(stampKey)) {
          stamp.setTexture(stampKey);
        }
        stamp.setPosition(rp.x, rp.y);
        stamp.setVisible(true);
      }
    }

    // Hide remaining unused road stamps
    const totalRoadPooled = this.roadStampPool.length;
    while (roadPoolIdx < totalRoadPooled) {
      this.roadStampPool[roadPoolIdx++].setVisible(false);
    }
  }

  update(time: number, delta: number) {
    this.updateViewportTerrain();

    // Fallback: keep trying to focus this player's Town Center until the snapshot
    // (or a delayed ownership sync) exposes it. Bounded so it stops after ~5s.
    if (!this.hasCenteredOnSpawn) {
      this.retryCenterOnBase();
    }

    const dtSeconds = delta / 1000;
    const cameraSpeed = (600 / this.cameras.main.zoom) * dtSeconds;

    // Pan camera via arrow keys and screen edges. WASD is deliberately unused
    // because W/A/S/D double as build hotkeys in App.tsx.
    if (this.cursors.left.isDown) this.cameras.main.scrollX -= cameraSpeed;
    if (this.cursors.right.isDown) this.cameras.main.scrollX += cameraSpeed;
    if (this.cursors.up.isDown) this.cameras.main.scrollY -= cameraSpeed;
    if (this.cursors.down.isDown) this.cameras.main.scrollY += cameraSpeed;

    this.applyEdgeScroll(cameraSpeed);

    this.updateWaypointPreview();
    this.updateRallyMarkers();

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

          // Drive animation from the unit's own type/action state. Never hardcode
          // a key here: `updateVisualState` knows `${type}_walk|idle|attack|harvest`.
          const updateVisualState = container.getData('updateVisualState') as
            | ((actionState: string) => void)
            | undefined;
          if (updateVisualState) {
            const serverState = this.room?.state.units.get(unitId)?.actionState ?? 'IDLE';
            // Position lerp is authoritative for "is it actually walking right now".
            let effectiveState = serverState;
            if (moveDist > 0.15) {
              effectiveState = 'MOVING';
            } else if (serverState === 'MOVING') {
              // Server still reports MOVING but the sprite has settled (arrived).
              effectiveState = 'IDLE';
            }
            updateVisualState(effectiveState);
          }
        }
      }
    });
  }
}

