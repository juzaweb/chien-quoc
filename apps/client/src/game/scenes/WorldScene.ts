import * as Phaser from 'phaser';
import { Room } from '@colyseus/sdk';
import { Callbacks } from '@colyseus/schema';
import {
  BUILDING_BLUEPRINTS,
  BuildingType,
  MAP_GRID_HEIGHT,
  MAP_GRID_WIDTH,
  gridToScreen,
  getIsoDepth,
  screenToGrid
} from '@chien-quoc/shared';
import { generateProceduralTextures } from '../renderers/ProceduralSprites.js';
import { CommandController } from '../input/CommandController.js';
import { CursorController } from '../input/CursorController.js';
import { PlacementController } from '../input/PlacementController.js';
import { SelectionController } from '../input/SelectionController.js';
import type { BoxSelectFilter } from '../input/SelectionController.js';
import { applyEdgeScroll } from '../input/cameraInput.js';
import { CameraController } from '../input/CameraController.js';
import { installHudPointerGuard } from '../input/hudPointerGuard.js';
import { EntityRenderer } from '../render/EntityRenderer.js';
import { FocusIndicator } from '../render/FocusIndicator.js';
import { TerrainLayer } from '../render/TerrainLayer.js';
import { DEFAULT_DIRECTION_INDEX, DIRECTIONAL_WALK_UNITS, directionIndex } from '../render/unitDirections.js';

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
 * ECO-02: how often the idle-villager count is recomputed, in milliseconds.
 *
 * The HUD only needs to look live, and scanning every owned unit at 60 Hz to
 * publish a number React would re-render anyway is wasted work — four scans a
 * second are indistinguishable from instant and cost nothing.
 */
const IDLE_VILLAGER_SCAN_MS = 250;

/**
 * Modifiers captured on pointerdown, then used by the click / box-select release
 * (CTL-02).
 *
 * `additive` is Shift (add to the selection), `selectSameType` is Ctrl (a click
 * takes every unit of the clicked type) and `filter` is what a drag is allowed to
 * take: Ctrl-drag soldiers, Alt-drag villagers. Ctrl means "narrow to soldiers" on
 * the drag path and "same type" on the click path, which is what makes one
 * modifier cover both without a new key.
 */
interface SelectionMods {
  additive: boolean;
  selectSameType: boolean;
  filter: BoxSelectFilter;
}

/** Plain left-drag: takes every owned unit it covers. */
const NO_SELECTION_MODS: SelectionMods = { additive: false, selectSameType: false, filter: 'all' };

function selectionModsFor(event: MouseEvent | undefined): SelectionMods {
  const ctrl = !!event?.ctrlKey || !!event?.metaKey;
  return {
    additive: !!event?.shiftKey,
    selectSameType: ctrl,
    filter: event?.altKey ? 'villager' : ctrl ? 'military' : 'all'
  };
}

/**
 * UIX-03: one control group as the HUD renders it. `breakdown` is the unit mix,
 * so the panel can read "4 · Spearman 3, Villager 1" without the HUD knowing
 * anything about the scene's registries.
 */
export interface ControlGroupSummary {
  index: number;
  count: number;
  breakdown: Array<{ type: string; count: number }>;
}

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
  /**
   * SIM-02: what a villager is hauling right now. Shown in the entity panel so
   * the player can see a load without waiting for the stockpile to jump.
   */
  carryingAmount?: number;
  carryingResourceType?: string;
  /**
   * CMB-01: AGGRESSIVE | DEFENSIVE | STAND_GROUND | NO_ATTACK. Units only; shown
   * in the panel so the stance cycle is observable without opening a menu.
   */
  stance?: string;
}

/**
 * The Phaser scene: owns the world state the other modules read (entity sprite
 * registries, the selection sets, camera and entity interpolation) and wires the
 * input handlers to the controllers that implement each behaviour.
 *
 * Rendering lives in `render/`, input policy in `input/`. This class is the
 * composition root plus the per-frame loop, so the public fields below are the
 * scene's API to those modules, not internal scratch space.
 */
export class WorldScene extends Phaser.Scene {
  public room: Room | null = null;
  /**
   * Ownership key the server writes on every entity (`Player.id`, the account
   * id). It is not the socket session id: that changes on every refresh and
   * reconnect, which is exactly what used to lose the empire.
   */
  public get myOwnerId(): string {
    if (this.cachedOwnerId) return this.cachedOwnerId;
    if (!this.room || !this.myPlayerName) return '';

    // Resolved from the snapshot rather than `room.sessionId`; the SDK does not
    // expose the auth payload the server keyed the entities with.
    let found = '';
    this.room.state.players.forEach((p: any) => {
      if (!found && p.name === this.myPlayerName) found = p.id;
    });
    this.cachedOwnerId = found;
    return found;
  }
  /** Display name of this account, from the auth API. Stable across reloads. */
  public myPlayerName: string = '';
  private cachedOwnerId: string = '';
  private boundRoomId: string = '';
  private eventsBoundRoom: Room | null = null;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;

  // Entity visual objects, keyed by server entity id.
  public buildingSprites: Map<string, Phaser.GameObjects.Container> = new Map();
  public unitSprites: Map<string, Phaser.GameObjects.Container> = new Map();
  public resourceSprites: Map<string, Phaser.GameObjects.Container> = new Map();

  // Unit target lerping
  public unitTargetPositions: Map<string, { x: number; y: number; hp: number; maxHp: number }> =
    new Map();

  // Cursor indicator
  private hoverTileHighlight!: Phaser.GameObjects.Image;

  // CMD-03: last pointer position in world space, kept so the cursor can be
  // recomputed when the selection or the input mode changes without the pointer
  // moving (box-select under the cursor, hotkey-entered placement mode).
  public lastPointerWorld: { x: number; y: number } | null = null;

  /**
   * Whether a pointermove has ever reached the canvas. Phaser reports the pointer
   * at (0,0) until then, which sits inside the top-left edge-scroll band - the
   * camera would otherwise pan up-left on its own from the moment the scene
   * starts, even with the mouse parked outside the game.
   */
  public hasPointerMoved = false;

  // Building placement preview
  public buildingToPlace: BuildingType | null = null;

  // Selection
  public selectedUnitIds: Set<string> = new Set();
  public selectedBuildingId: string | null = null;
  public selectedResourceId: string | null = null;

  private hasCenteredOnSpawn: boolean = false;
  private centerAttempts: number = 0;

  // Selection Drag Box
  public isDragSelecting: boolean = false;
  private dragStartScreen: { x: number; y: number } = { x: 0, y: 0 };
  private dragSelectionGraphics!: Phaser.GameObjects.Graphics;

  /** Middle-button drag panning, edge scroll, zoom and camera bookmarks. */
  public cameraControl!: CameraController;

  // CTL-02: modifiers are captured on pointerdown because pointerup can report
  // them differently (the browser fires `contextmenu` early for ctrl-click).
  private pendingSelectionMods: SelectionMods = NO_SELECTION_MODS;

  // React Callbacks
  public onSelectionChange: ((entity: SelectedEntityData | null) => void) | null = null;
  public onPlacementCancelled: (() => void) | null = null;
  /**
   * Set by `PhaserGame`. A build hotkey (`Q/W/E/R/T`) is owned by the keyboard
   * layer but has to open React state, because the HUD highlights the selected
   * building type and the placement panel reads it.
   */
  public onBuildingHotkey: ((type: BuildingType) => void) | null = null;
  /**
   * ECO-02: published whenever the number of this player's idle villagers
   * changes, so the HUD can show the AoE idle-counter without scanning state.
   */
  public onIdleVillagersChange: ((count: number) => void) | null = null;
  /**
   * UIX-03: published whenever the `Ctrl+1..9` rosters change (assign, recall,
   * a member dying), so the right-hand group panel mirrors the real groups.
   */
  public onControlGroupsChange: ((groups: ControlGroupSummary[]) => void) | null = null;
  /** Last `hp|carrying|actionState` string published to the entity panel. */
  private lastUnitDetailSignature = '';
  /** ECO-02: last count published, and when the next scan is allowed. */
  private lastIdleVillagerCount = -1;
  private nextIdleVillagerScanAt = 0;

  // Behaviour modules. Constructed in create() so they can allocate Phaser
  // objects; every one of them reads this scene's state rather than keeping a copy.
  public selection!: SelectionController;
  public cursor!: CursorController;
  public placement!: PlacementController;
  public commands!: CommandController;
  public entityRenderer!: EntityRenderer;
  public terrain!: TerrainLayer;
  /** CMB-03: red marker on the enemy the selection is hitting. */
  public focus!: FocusIndicator;

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

    // Directional walk sheets (8 rows x 4 frames). Units without one keep the
    // single-facing sheet above and are mirrored instead of rotated.
    const walkFrameSize: Record<string, number> = {
      VILLAGER: 128,
      SPEARMAN: 128,
      ARCHER: 128,
      CAVALRY: 160
    };
    for (const unitType of DIRECTIONAL_WALK_UNITS) {
      const frame = walkFrameSize[unitType] ?? 128;
      this.load.spritesheet(`unit_${unitType}_walk`, `/assets/units/${unitType.toLowerCase()}_walk.png?${uv}`, {
        frameWidth: frame,
        frameHeight: frame
      });
    }

    // Preload generated building assets with cache-busting version (2x resolution)
    const v = 'v=3';
    this.load.image('building_TOWN_CENTER', `/assets/buildings/town_center.png?${v}`);
    this.load.image('building_BARRACKS', `/assets/buildings/barracks.png?${v}`);
    this.load.image('building_HOUSE', `/assets/buildings/house.png?${v}`);
    this.load.image('building_FARM', `/assets/buildings/farm.png?${v}`);
    this.load.image('building_TOWER', `/assets/buildings/tower.png?${v}`);
    this.load.image('building_LUMBER_CAMP', `/assets/buildings/lumber_camp.png?${v}`);
    this.load.image('building_MILL', `/assets/buildings/mill.png?${v}`);
    this.load.image('building_MINING_CAMP', `/assets/buildings/mining_camp.png?${v}`);

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
    this.entityRenderer = new EntityRenderer(this);
    this.entityRenderer.initUnitAnimations();

    // 1. Terrain: pre-allocated tile and road-stamp pools, rendered per viewport
    // across a 220x220 map.
    this.terrain = new TerrainLayer(this);
    this.terrain.create();

    // 2. Cursor hover indicator
    this.hoverTileHighlight = this.add.image(0, 0, 'tile_highlight');
    this.hoverTileHighlight.setDepth(999998);
    this.hoverTileHighlight.setVisible(false);

    // 3. Building placement ghost
    this.placement = new PlacementController(this);
    this.placement.create();

    // 4. Drag selection box graphics
    this.dragSelectionGraphics = this.add.graphics();
    this.dragSelectionGraphics.setDepth(1000000);

    // 4b. Waypoint + rally overlays (CTL-05 / CTL-06), under the selection box
    this.commands = new CommandController(this);
    this.commands.createOverlays();

    // 4b-2. Camera: wheel zoom, +/- steps, bookmarks and middle-drag panning.
    // Built after `commands` because a saved bookmark flashes feedback through it.
    this.cameraControl = new CameraController(this);

    // 4c. Focus-fire marker (CMB-03), under the drag box like every other overlay
    this.focus = new FocusIndicator(this);

    // 5. Selection and cursor policy. Built after placement because the cursor
    // reads the placement validator.
    this.selection = new SelectionController(this);
    this.cursor = new CursorController(this);

    // 6. Camera & Controls
    if (this.input.keyboard) {
      this.cursors = this.input.keyboard.createCursorKeys();
      // WASD is intentionally NOT bound: it collides with the Q/W/E/R/T build
      // hotkeys in App.tsx. Panning is arrows + edge scroll (see update()).
      this.commands.bindKeys(this.input.keyboard);
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
      this.cameraControl.handleWheel(deltaY);
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

    // A release outside the canvas emits `pointerupoutside` *instead of*
    // `pointerup`, and both middle-drag panning and box selection end on that
    // event. Without this the camera would keep panning with the mouse until the
    // next release inside the canvas.
    this.input.on('pointerupoutside', (pointer: Phaser.Input.Pointer) => {
      this.handlePointerUp(pointer);
    });

    // Presses and releases that land on a React HUD panel never reach the canvas,
    // so neither Phaser handler above fires. UIX-01: treat an off-canvas press as
    // "clicked the world chrome" — the armed order or the placement ghost must
    // drop, and an in-flight box selection must finish instead of leaving its
    // rectangle painted on screen.
    installHudPointerGuard(this.game, this.events, {
      onPressOutside: () => {
        if (this.buildingToPlace) {
          this.placement.cancel();
        } else if (this.commands.pendingOrder) {
          this.commands.cancelPendingOrder();
        }
      },
      onReleaseOutside: () => {
        // A middle-button pan can also end over a panel; stop it unconditionally.
        this.cameraControl.endMiddleDrag();
        // `outside` so a sub-threshold drag is not read as a click: the pointer
        // then sits over a panel, and `handleClick` would hit-test (or clear the
        // selection through) whatever is painted underneath it.
        if (this.isDragSelecting) this.handlePointerUp(this.input.activePointer, true);
      },
      onPointerCancelled: () => {
        // The browser aborted the gesture (touch interruption, window drag-out).
        // A drawn box still completes — the player did drag it — but the
        // sub-threshold click is skipped for the same reason as above, and the
        // pan must stop because no `pointerup` is coming.
        this.cameraControl.endMiddleDrag();
        if (this.isDragSelecting) this.handlePointerUp(this.input.activePointer, true);
      }
    });

    // Bind room events if room already passed
    if (this.room) {
      this.bindRoomEvents(this.room);
    }

    // Initial viewport terrain render
    this.terrain.render();
  }

  public setRoom(room: Room) {
    // Same instance = nothing to wire up. React StrictMode and Phaser's 'ready'
    // event can both call this with the same object.
    if (room === this.room) return;

    // Same roomId but a different Room instance means a reconnect: the snapshot
    // is the same world, but the cached owner id may not be resolvable yet, so
    // it is dropped and re-resolved from the new snapshot.
    const isNewWorld = room.roomId !== this.boundRoomId;

    this.room = room;
    this.cachedOwnerId = '';
    this.boundRoomId = room.roomId;

    if (isNewWorld) {
      // Fresh world snapshot: allow re-centering on the base.
      this.hasCenteredOnSpawn = false;
      this.centerAttempts = 0;
      // UIX-03: group members belong to the old world; their ids are meaningless
      // in the new snapshot.
      this.commands?.resetControlGroups();
    }

    // Callbacks belong to a Room instance, so a new instance always needs binding.
    if (this.scene.isActive()) {
      this.bindRoomEvents(room);
      this.centerOnOwnBaseIfNeeded();
    }
  }

  /**
   * Player name is stable across reconnects, so the camera and the owner id can
   * always be resolved even after the socket changed.
   */
  public setPlayerName(playerName: string) {
    this.myPlayerName = playerName;
    this.cachedOwnerId = '';
    this.centerOnOwnBaseIfNeeded();
  }

  public isOwnBuilding(ownerId: string): boolean {
    if (!ownerId) return false;
    return ownerId === this.myOwnerId;
  }

  /**
   * Own Town Center, or null when the snapshot does not contain it yet.
   */
  public findOwnTownCenter(): any | null {
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

    // Player name may not be known yet; retry on the next tick instead.
    if (!this.myPlayerName) return;

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
      this.entityRenderer.createResourceNodeSprite(key, node);
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
      this.entityRenderer.createBuildingSprite(key, building, cb);
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
      this.entityRenderer.createUnitSprite(key, unit, cb);
    });

    cb.onRemove('units', (unit: any, key: any) => {
      const sprite = this.unitSprites.get(key);
      if (sprite) {
        sprite.destroy();
        this.unitSprites.delete(key);
      }
      this.unitTargetPositions.delete(key);
      this.commands.forgetUnit(key);
      if (this.selectedUnitIds.has(key)) {
        this.selectedUnitIds.delete(key);
        this.notifySelectionChange();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Pointer handling
  // ---------------------------------------------------------------------------

  private handlePointerMove(pointer: Phaser.Input.Pointer) {
    // Middle-drag pan moves the camera under a still pointer, so the world point
    // below the cursor is recomputed first: the cursor and the waypoint preview
    // both read it, and a stale one would pin them to the tile left behind.
    const panning = this.cameraControl.updateMiddleDrag(pointer);

    const worldPoint = pointer.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
    const hoverGridCoord = screenToGrid(worldPoint.x, worldPoint.y);
    this.lastPointerWorld = { x: worldPoint.x, y: worldPoint.y };

    // A pan owns the pointer: no hover highlight, no placement ghost and no box
    // selection while the map is being dragged.
    if (panning) {
      this.hoverTileHighlight.setVisible(false);
      this.cursor.refresh();
      return;
    }

    this.hasPointerMoved = true;

    // Snap highlight to grid tile
    const snappedScreen = gridToScreen(hoverGridCoord.gridX, hoverGridCoord.gridY);
    this.hoverTileHighlight.setPosition(snappedScreen.x, snappedScreen.y);
    this.hoverTileHighlight.setVisible(
      hoverGridCoord.gridX >= 0 &&
      hoverGridCoord.gridX < MAP_GRID_WIDTH &&
      hoverGridCoord.gridY >= 0 &&
      hoverGridCoord.gridY < MAP_GRID_HEIGHT
    );

    // Placement ghost follows the pointer while the mode is active
    this.placement.updateGhost(hoverGridCoord.gridX, hoverGridCoord.gridY);

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

    this.cursor.refresh();
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer) {
    const native = pointer.event as MouseEvent | undefined;
    // macOS: Phaser rewrites Ctrl+left-click into a right-click to match the OS
    // convention (see Pointer#down). Ctrl+click is our same-type-selection
    // modifier and the canvas context menu is disabled, so read the native
    // button instead of trusting `rightButtonDown()`.
    const ctrlLeftClick = !!native && native.button === 0 && native.ctrlKey;

    // Middle-button drag pans the map (AoE2). The default is suppressed so the
    // browser does not start its own autoscroll on the canvas.
    if (pointer.middleButtonDown()) {
      native?.preventDefault();
      if (!this.buildingToPlace) {
        this.cameraControl.beginMiddleDrag(pointer);
        return;
      }
    }

    // CMD-01: an armed attack-move / patrol consumes the next left click as its
    // destination, before anything can start a drag selection box. Placement mode
    // keeps its click: the cursor is already promising a building there.
    if (
      this.commands.pendingOrder &&
      !this.buildingToPlace &&
      (pointer.leftButtonDown() || ctrlLeftClick)
    ) {
      this.commands.commitPendingOrder(pointer);
      return;
    }

    if (pointer.rightButtonDown() && !ctrlLeftClick) {
      // Right Click
      if (this.buildingToPlace) {
        this.placement.cancel();
      } else if (this.commands.pendingOrder) {
        // Right click used to fire a normal order; with an order armed it only
        // backs out, like cancelling a placement.
        this.commands.cancelPendingOrder();
      } else if (native?.ctrlKey && native.button === 2) {
        // CMD-01: Ctrl + right click is AoE2's attack-move.
        this.commands.issueAttackMove(pointer, 'ATTACK_MOVE');
      } else {
        this.commands.handleRightClick(pointer, !!native?.shiftKey);
      }
      return;
    }

    if (pointer.leftButtonDown() || ctrlLeftClick) {
      if (this.buildingToPlace) {
        this.placement.commit(pointer);
      } else {
        // Start Drag selection box. Modifiers are resolved here, from the native
        // event, because the release can report them differently.
        this.pendingSelectionMods = selectionModsFor(native);
        this.isDragSelecting = true;
        this.dragStartScreen = { x: pointer.x, y: pointer.y };
      }
    }
  }

  /**
   * @param outside true when the button came up off-canvas (over a HUD panel, or
   *   after a cancelled gesture). A box selection still finishes at the last
   *   on-canvas position, but a sub-threshold drag must not become a click-select:
   *   the pointer coordinates then point at the panel, not at the world.
   */
  private handlePointerUp(pointer: Phaser.Input.Pointer, outside = false) {
    // The middle button can be released outside the drag state (e.g. pressed
    // while placing a building), so this is unconditional.
    this.cameraControl.endMiddleDrag();

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
      this.pendingSelectionMods = NO_SELECTION_MODS;

      if (dragDistanceWorld > threshold) {
        // Box Selection
        this.selection.handleBoxSelect(
          this.dragStartScreen,
          { x: pointer.x, y: pointer.y },
          mods.additive,
          mods.filter
        );
      } else if (!outside) {
        // Single Click Selection
        this.selection.handleClick(pointer, mods.additive, mods.selectSameType);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (React HUD, minimap)
  // ---------------------------------------------------------------------------

  public clearSelection() {
    this.selection.clear();
  }

  public stopSelectedUnits() {
    this.commands.stopSelectedUnits();
  }

  public cancelSelectedFoundation(): boolean {
    return this.commands.cancelSelectedFoundation();
  }

  public setBuildingMode(type: BuildingType) {
    this.placement.enter(type);
  }

  public cancelBuildingPlacement() {
    this.placement.cancel();
  }

  public commandMoveTo(gridX: number, gridY: number) {
    this.commands.commandMoveTo(gridX, gridY);
  }

  public cycleToIdleUnit(category: 'villager' | 'military') {
    this.commands.cycleToIdleUnit(category);
  }

  /**
   * UIX-03: recalling a group from the HUD panel is the same action as pressing
   * its digit, including the second-press camera jump.
   */
  public selectControlGroup(index: number) {
    this.commands.recallControlGroup(index);
  }

  public panTo(gridX: number, gridY: number) {
    const screenPos = gridToScreen(gridX, gridY);
    this.cameras.main.pan(screenPos.x, screenPos.y, 350, 'Power2');
  }

  // The old camera wrappers (`zoomTo`, `zoomBySteps`, `saveCameraBookmark`,
  // `recallCameraBookmark`) were pass-throughs to `cameraControl`; removed so
  // there is one handle, not two layers claiming ownership of the zoom range.

  /**
   * Publishes the current selection to React and lets the cursor follow it.
   *
   * An armed order belongs to the units selected when it was given. Once they
   * are all gone (killed, or replaced by a building) the next click would be
   * swallowed with nothing to command, so the order is dropped first.
   */
  public notifySelectionChange() {
    if (this.selectedUnitIds.size === 0) this.commands.cancelPendingOrder();

    // Selection fingerprints the cursor (harvest needs an all-villager selection,
    // attack needs units), so recompute even when no React callback is wired.
    this.cursor.refresh();

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
          isOwner: unit.ownerId === this.myOwnerId,
          carryingAmount: unit.carryingAmount,
          carryingResourceType: unit.carryingResourceType,
          stance: unit.stance
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
          isOwner: b.ownerId === this.myOwnerId,
          trainingQueue: Array.from(b.trainingQueue),
          isConstructed: b.isConstructed,
          constructionProgress: b.constructionProgress,
          // ECO-01: what is left to gather from a farm, shown with the same
          // "remaining / max" block a resource node uses.
          remainingAmount: b.resourceCapacity > 0 ? b.resourceAmount : undefined,
          maxAmount: b.resourceCapacity > 0 ? b.resourceCapacity : undefined
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

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------

  update(time: number, delta: number) {
    this.terrain.render();

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

    applyEdgeScroll(
      this.cameras.main,
      this.input.activePointer,
      this.scale.width,
      this.scale.height,
      this.hasPointerMoved,
      cameraSpeed
    );

    this.commands.updateWaypointPreview();
    this.commands.updateRallyMarkers();

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

        // Face the direction of travel. Units with a directional sheet pick the
        // matching row; the rest are mirrored from their single-facing art.
        const dx = targetScreen.x - prevX;
        const dy = targetScreen.y - prevY;
        const moveDist = Math.hypot(container.x - prevX, container.y - prevY);
        const unitDisplay = container.getData('unitDisplay') as Phaser.GameObjects.Sprite | Phaser.GameObjects.Image;
        if (unitDisplay) {
          const hasDirectionalSheet = container.getData('hasDirectionalSheet') === true;
          if (hasDirectionalSheet) {
            // Only re-face once the sprite actually travelled a pixel; below that
            // the delta is lerp jitter and would flip the row every frame.
            if (Math.hypot(dx, dy) > 0.3) {
              container.setData('facingDirection', directionIndex(dx, dy));
            }
            unitDisplay.setFlipX(false);
          } else if (Math.abs(dx) > 0.05) {
            unitDisplay.setFlipX(dx < 0);
          }

          // Drive animation from the unit's own type/action state. Never hardcode
          // a key here: `updateVisualState` knows `${type}_walk|idle|attack|harvest`.
          const updateVisualState = container.getData('updateVisualState') as
            | ((actionState: string, direction?: number) => void)
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
            const facing =
              (container.getData('facingDirection') as number | undefined) ?? DEFAULT_DIRECTION_INDEX;
            updateVisualState(effectiveState, facing);
          }
        }
      }
    });

    // CMB-03 after the lerp: the marker is drawn on the sprite's current screen
    // position, so reading it before interpolation would leave the ring one
    // frame behind a moving target.
    this.focus.render();

    this.syncSelectedUnitDetails();
    this.publishIdleVillagerCount(time);
  }

  /**
   * ECO-02: publishes this player's idle-villager count when it changes.
   *
   * Only a bare `IDLE` villager counts: one walking home, harvesting or building
   * is working, and flagging it would make the number impossible to clear. The
   * scan is throttled (see `IDLE_VILLAGER_SCAN_MS`) and the callback only fires
   * on an actual change, so React does not re-render four times a second on a
   * steady number.
   */
  private publishIdleVillagerCount(time: number) {
    if (!this.onIdleVillagersChange || !this.room) return;
    if (time < this.nextIdleVillagerScanAt) return;
    this.nextIdleVillagerScanAt = time + IDLE_VILLAGER_SCAN_MS;

    let count = 0;
    this.room.state.units.forEach((unit: any) => {
      if (unit.type !== 'VILLAGER') return;
      if (unit.actionState !== 'IDLE') return;
      if (!this.isOwnBuilding(unit.ownerId)) return;
      count++;
    });

    if (count === this.lastIdleVillagerCount) return;
    this.lastIdleVillagerCount = count;
    this.onIdleVillagersChange(count);
  }

  /**
   * Re-publishes the entity panel while a single unit is selected and something
   * the panel shows has changed (hp, the load it is hauling, its action).
   *
   * The panel used to be published on selection changes only, so a villager's
   * `carryingAmount` and a unit's hp went stale the moment they moved. The
   * signature keeps the React update to actual value changes instead of one
   * render per frame.
   */
  private syncSelectedUnitDetails() {
    if (this.selectedUnitIds.size !== 1) return;

    const unitId = Array.from(this.selectedUnitIds)[0];
    const unit = this.room?.state.units.get(unitId);
    if (!unit) return;

    const signature = `${unit.hp}|${unit.carryingAmount}|${unit.carryingResourceType}|${unit.actionState}|${unit.stance}`;
    if (signature === this.lastUnitDetailSignature) return;

    this.lastUnitDetailSignature = signature;
    this.notifySelectionChange();
  }
}
