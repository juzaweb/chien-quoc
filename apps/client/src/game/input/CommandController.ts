import {
  BuildingType,
  MAP_GRID_HEIGHT,
  MAP_GRID_WIDTH,
  NetworkMessage,
  canTrainUnitsAt,
  gridToScreen,
  nextUnitStance
} from '@chien-quoc/shared';
import * as Phaser from 'phaser';
import type { ControlGroupSummary, WorldScene } from '../scenes/WorldScene.js';
import { findBuildingAt, findOwnFoundationAt, findOwnGatherableAt, findResourceAt, findUnitAt } from './hitTest.js';
import { guardKey } from './keyGuard.js';
import { pointerWorldGrid, pointerWorldPoint } from './pointer.js';

/**
 * Phaser emits `keydown-<NAME>` for every mapped keyCode, so these need no
 * `addKey`/`addCapture` registration. Top-row digits only (AoE2 convention).
 */
const CONTROL_GROUP_KEYS = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];

/** Second press within this window re-centres the camera on the group. */
const CONTROL_GROUP_RECALL_DOUBLE_MS = 300;

/**
 * `Q/W/E/R/T` start a placement, mirroring the HUD's build buttons in the same
 * order. The keyboard layer owns them so every hotkey lives in one place; the
 * scene forwards the choice to React, which owns the "currently placing" state.
 */
const BUILDING_HOTKEYS: Array<{ key: string; type: BuildingType }> = [
  { key: 'Q', type: 'TOWN_CENTER' },
  { key: 'W', type: 'BARRACKS' },
  { key: 'E', type: 'HOUSE' },
  { key: 'R', type: 'FARM' },
  { key: 'T', type: 'TOWER' }
];

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
 * Holding `+`/`-` is meant to keep zooming, so the guard between repeats is
 * short: about eight steps per second, which is faster than clicking but slow
 * enough to stop on a level the player wants.
 */
const ZOOM_KEY_REPEAT_MS = 120;

/**
 * Camera bookmark slots. `Ctrl+F2..F4` saves (AoE2 default) and the bare key
 * recalls. `Shift+F2..F4` saves too: `Ctrl+F4` closes the tab in Chrome, and
 * `Alt+F4` closes the whole window at the OS level, so neither is a usable
 * fallback for slot 3.
 */
const CAMERA_BOOKMARK_KEYS: Array<{ name: string; slot: number }> = [
  { name: 'F2', slot: 1 },
  { name: 'F3', slot: 2 },
  { name: 'F4', slot: 3 }
];

type OrderMode = 'ATTACK_MOVE' | 'PATROL';

/**
 * Everything that turns input into a command: right-click dispatch, the order
 * hotkeys, control groups, idle cycling, rally points and the waypoint preview.
 *
 * The server is authoritative for all of it; this class only reads the snapshot
 * and sends messages, plus draws the purely cosmetic overlays.
 */
export class CommandController {
  /** CMD-01: an armed attack-move or patrol waiting for its destination click. */
  public pendingOrder: OrderMode | null = null;

  private lastOrderKey: { mode: OrderMode | ''; at: number } = { mode: '', at: 0 };
  private lastCancelKeyAt = 0;
  private lastEscapeAt = 0;
  private controlGroups: Map<number, Set<string>> = new Map();
  private lastGroupRecall: { index: number; at: number } = { index: 0, at: 0 };

  /**
   * CTL-04: last unit each idle cycle landed on, so the next press moves on to a
   * different unit. Tracked by id rather than by list index: the candidate list is
   * recomputed every press (units go idle/busy, and the roster changes), so a raw
   * index would point at a different unit or fall out of range between presses.
   */
  private idleCycleAnchor: { villager: string | null; military: string | null } = {
    villager: null,
    military: null
  };

  /** CTL-05: while Shift is held, draw the queued waypoint chain of every unit. */
  private shiftKey: Phaser.Input.Keyboard.Key | null = null;
  private waypointGraphics!: Phaser.GameObjects.Graphics;
  private rallyGraphics!: Phaser.GameObjects.Graphics;
  /** Signature of the last drawn rally layer, so identical frames skip the redraw. */
  private rallySignature = '';

  constructor(private readonly scene: WorldScene) {}

  /** Overlay layers. Above terrain and entities, below the drag-selection box. */
  createOverlays() {
    this.waypointGraphics = this.scene.add.graphics();
    this.waypointGraphics.setDepth(999995);

    this.rallyGraphics = this.scene.add.graphics();
    this.rallyGraphics.setDepth(999990);
  }

  bindKeys(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    this.bindControlGroupKeys(keyboard);
    this.bindStopKey(keyboard);
    this.bindIdleCycleKeys(keyboard);
    this.bindHomeKey(keyboard);
    this.bindCancelKey(keyboard);
    this.bindOrderKeys(keyboard);
    this.bindStanceKey(keyboard);
    this.bindBuildingKeys(keyboard);
    this.bindZoomKeys(keyboard);
    this.bindCameraBookmarkKeys(keyboard);
    this.bindEscapeKey(keyboard);
    // Held-modifier state for the waypoint preview; not a hotkey.
    this.shiftKey = keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);
  }

  // ---------------------------------------------------------------------------
  // Key bindings
  // ---------------------------------------------------------------------------

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
      if (this.scene.buildingToPlace) return;
      if (this.scene.selectedUnitIds.size === 0) return;

      event.preventDefault();
      this.stopSelectedUnits();
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
      if (this.scene.buildingToPlace) return;
      if (this.scene.selectedUnitIds.size > 0) return;

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
   * CMD-01: `A` arms attack-move, `P` arms patrol; the next left click picks the
   * destination, which is exactly how AoE2's two-step order works.
   *
   * The keys are ignored with any modifier (Ctrl+A selects everything in the
   * browser, Cmd+P prints), during placement, and with nothing selected - arming
   * an order that can never be issued would just leave the cursor crosshaired.
   */
  private bindOrderKeys(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    const arm = (mode: OrderMode) => (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (this.scene.buildingToPlace) return;
      if (this.scene.selectedUnitIds.size === 0) return;

      // Phaser re-emits keydown while the key is held down (see bindCancelKey).
      const now = performance.now();
      if (this.lastOrderKey.mode === mode && now - this.lastOrderKey.at < ORDER_KEY_DEBOUNCE_MS) return;
      this.lastOrderKey = { mode, at: now };

      event.preventDefault();
      this.pendingOrder = mode;
      this.scene.cursor.refresh();
    };

    keyboard.on('keydown-A', arm('ATTACK_MOVE'));
    keyboard.on('keydown-P', arm('PATROL'));
  }

  /**
   * `Q/W/E/R/T` open a build placement, the same five the HUD offers.
   *
   * This used to live in a `window` keydown listener inside `App.tsx`, which had
   * no modifier guard: `Ctrl+W` closed the tab and still started a Barracks.
   * Routing it through Phaser gives every hotkey one owner, and any modifier now
   * disqualifies the press (Ctrl/Cmd/Shift/Alt belong to the browser, the OS or a
   * future hotkey layer).
   */
  private bindBuildingKeys(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    BUILDING_HOTKEYS.forEach(({ key, type }) => {
      keyboard.on(`keydown-${key}`, (event: KeyboardEvent) => {
        if (event.repeat) return;
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        // Already placing this one: Phaser re-emits while the key is held, and
        // re-entering the same mode would only reset the ghost.
        if (this.scene.buildingToPlace === type) return;

        event.preventDefault();
        this.scene.onBuildingHotkey?.(type);
      });
    });
  }

  /**
   * `Escape` gives up placement first, then the selection — the order the React
   * listener used before it moved here.
   *
   * The re-emit guard is the same one the cancel key needs: a held Escape fires
   * every frame, and each extra press would cancel something further down the
   * stack.
   */
  private bindEscapeKey(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    keyboard.on('keydown-ESC', (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;

      const now = performance.now();
      if (now - this.lastEscapeAt < CANCEL_KEY_DEBOUNCE_MS) return;

      if (this.scene.buildingToPlace) {
        this.lastEscapeAt = now;
        event.preventDefault();
        this.scene.cancelBuildingPlacement();
        return;
      }

      const hasSelection =
        this.scene.selectedUnitIds.size > 0 ||
        this.scene.selectedBuildingId !== null ||
        this.scene.selectedResourceId !== null;
      if (!hasSelection) return;

      this.lastEscapeAt = now;
      event.preventDefault();
      // `clear()` drops an armed order as well; React learns about the empty
      // selection through the same callback the pointer uses.
      this.scene.clearSelection();
      this.scene.notifySelectionChange();
    });
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
      if (this.scene.buildingToPlace) return;

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

      const townCenter = this.scene.findOwnTownCenter();
      if (!townCenter) return;

      event.preventDefault();
      this.scene.panTo(townCenter.gridX + townCenter.sizeX / 2, townCenter.gridY + townCenter.sizeY / 2);
    });
  }

  /**
   * `+` / `-` (and the numpad pair) step the camera zoom.
   *
   * Both keys of each pair map to the same guarded handler, so a held key emits
   * one step per `ZOOM_KEY_REPEAT_MS` instead of one per frame. Ctrl/Alt/Cmd are
   * refused: `Ctrl` and the numpad are also browser zoom shortcuts in some
   * configurations, and this zoom must not fight the browser's.
   */
  private bindZoomKeys(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    const step = (direction: 1 | -1) =>
      guardKey((event: KeyboardEvent) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return false;
        event.preventDefault();
        this.scene.cameraControl.zoomBySteps(direction);
        return true;
      }, ZOOM_KEY_REPEAT_MS);

    const zoomIn = step(1);
    const zoomOut = step(-1);

    // 'PLUS' is the `=` key (keyCode 187) without Shift, which is the key '+'
    // sits on for most layouts - binding the shifted form only would make the
    // advertised hotkey need two keys on a US keyboard.
    keyboard.on('keydown-PLUS', zoomIn);
    keyboard.on('keydown-NUMPAD_ADD', zoomIn);
    keyboard.on('keydown-MINUS', zoomOut);
    keyboard.on('keydown-NUMPAD_SUBTRACT', zoomOut);
  }

  /**
   * `Ctrl+F2..F4` saves a camera bookmark, `F2..F4` jumps back to it (AoE2).
   * `Shift+F2..F4` also saves, for the slot the browser owns (`Ctrl+F4` closes
   * the tab in Chrome). Alt is refused outright: `Alt+F4` closes the window
   * before the page sees it, so capturing Alt here would only mislead.
   *
   * Recalling an empty slot reports `false`, so the guard does not swallow the
   * next press once the slot has been saved.
   */
  private bindCameraBookmarkKeys(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    CAMERA_BOOKMARK_KEYS.forEach(({ name, slot }) => {
      const recall = guardKey((event: KeyboardEvent) => {
        event.preventDefault();
        return this.scene.cameraControl.recallBookmark(slot);
      });

      const save = guardKey((event: KeyboardEvent) => {
        event.preventDefault();
        this.scene.cameraControl.saveBookmark(slot);
        return true;
      });

      keyboard.on(`keydown-${name}`, (event: KeyboardEvent) => {
        if (event.altKey) return;
        // The bare key and the modifier form share one listener, so a save must
        // never fall through and also jump on the same press.
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          save(event);
          return;
        }
        recall(event);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Unit commands
  // ---------------------------------------------------------------------------

  /**
   * CMB-01: `D` cycles the stance of the whole selection.
   *
   * The cycle is derived from the first selected unit, so pressing the key twice
   * on a mixed group pulls everyone forward one step together instead of each
   * unit advancing from its own current stance. Modifiers, placement mode and an
   * empty selection are ignored: there is nothing to command in any of them.
   */
  private bindStanceKey(keyboard: Phaser.Input.Keyboard.KeyboardPlugin) {
    keyboard.on(
      'keydown-D',
      guardKey((event: KeyboardEvent) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
        if (this.scene.buildingToPlace) return false;
        if (this.scene.selectedUnitIds.size === 0) return false;

        event.preventDefault();
        this.cycleSelectedStance();
        return true;
      })
    );
  }

  /**
   * Sends the next stance in the cycle for the current selection.
   *
   * The stance is read from the snapshot, not from local state: the server is
   * authoritative, and a client that tracked its own copy would drift whenever a
   * command was refused.
   */
  cycleSelectedStance() {
    const scene = this.scene;
    if (!scene.room || scene.selectedUnitIds.size === 0) return;

    const firstId = scene.selectedUnitIds.values().next().value;
    const current = firstId ? scene.room.state.units.get(firstId)?.stance : '';
    const stance = nextUnitStance(current ?? '');
    scene.room.send(NetworkMessage.SET_STANCE, {
      unitIds: Array.from(scene.selectedUnitIds),
      stance
    });
  }

  /**
   * Halts the selection in place. The server is authoritative; this only sends
   * the craft. Local prediction would fight the server snapshot for liveness.
   */
  stopSelectedUnits() {
    const scene = this.scene;
    if (!scene.room || scene.selectedUnitIds.size === 0) return;

    const unitIds = Array.from(scene.selectedUnitIds);
    scene.room.send(NetworkMessage.STOP_UNITS, { unitIds });

    // Ring on the ground at each stopped unit, so the command has visible
    // effect even when the unit was already standing still (IDLE -> IDLE).
    unitIds.forEach((uId) => {
      const container = scene.unitSprites.get(uId);
      if (container) this.showFeedback(container.x, container.y, 0xfacc15);
    });
  }

  /**
   * Sends CANCEL_BUILDING for the selected building.
   *
   * @returns true when a command was actually sent, so the caller can swallow
   * the key event only when it did something.
   */
  cancelSelectedFoundation(): boolean {
    const scene = this.scene;
    if (!scene.room || !scene.selectedBuildingId) return false;

    const building = scene.room.state.buildings.get(scene.selectedBuildingId);
    if (!building) return false;
    if (building.ownerId !== scene.mySessionId) return false;
    if (building.isConstructed) return false;

    scene.room.send(NetworkMessage.CANCEL_BUILDING, { buildingId: scene.selectedBuildingId });
    return true;
  }

  /** Drops an armed order (right click, Escape) and restores the pointer. */
  cancelPendingOrder() {
    if (!this.pendingOrder) return;
    this.pendingOrder = null;
    this.scene.cursor.refresh();
  }

  /**
   * Turns the armed order into a message. The destination is read from the same
   * pointer position the click used, so the order lands on the highlighted tile.
   */
  commitPendingOrder(pointer: Phaser.Input.Pointer) {
    const mode = this.pendingOrder;
    this.pendingOrder = null;
    this.scene.cursor.refresh();
    if (mode) this.issueAttackMove(pointer, mode);
  }

  /**
   * Sends ATTACK_MOVE or PATROL for the current selection.
   *
   * Out-of-map points are dropped here as well as on the server: a click on the
   * terrain edge would otherwise cost a round-trip to be refused.
   */
  issueAttackMove(pointer: Phaser.Input.Pointer, mode: OrderMode) {
    const scene = this.scene;
    if (!scene.room || scene.selectedUnitIds.size === 0) return;
    if (scene.buildingToPlace) return;

    const worldPoint = pointerWorldPoint(scene.cameras.main, pointer);
    const grid = pointerWorldGrid(scene.cameras.main, pointer);
    if (grid.gridX < 0 || grid.gridY < 0 || grid.gridX >= MAP_GRID_WIDTH || grid.gridY >= MAP_GRID_HEIGHT) {
      return;
    }

    scene.room.send(mode === 'PATROL' ? NetworkMessage.PATROL : NetworkMessage.ATTACK_MOVE, {
      unitIds: Array.from(scene.selectedUnitIds),
      targetGridX: grid.gridX,
      targetGridY: grid.gridY
    });
    this.showFeedback(worldPoint.x, worldPoint.y, 0xef4444);
  }

  /**
   * Resolves a right-click into one order for the current selection.
   *
   * @param queue Shift is held: ground clicks append a waypoint to the unit's
   *   path instead of replacing the order (CTL-05). Entity targets still issue
   *   their normal order — attack/harvest have no queue model on the server, and
   *   a half-queued attack would be worse than a plain one.
   */
  handleRightClick(pointer: Phaser.Input.Pointer, queue = false) {
    const scene = this.scene;
    if (!scene.room) return;

    // CTL-06: with no unit selected, a right-click on the map sets the rally
    // point of the selected own building instead of doing nothing.
    if (scene.selectedUnitIds.size === 0) {
      this.handleSetRallyPoint(pointer);
      return;
    }

    const worldPoint = pointerWorldPoint(scene.cameras.main, pointer);
    const targetGrid = pointerWorldGrid(scene.cameras.main, pointer);

    // 1. Check if right-clicked on an enemy unit (shared hit-test with left-click)
    const targetEnemyUnitId = findUnitAt(scene, worldPoint, 'enemy');
    if (targetEnemyUnitId) {
      scene.room.send(NetworkMessage.ATTACK_TARGET, {
        unitIds: Array.from(scene.selectedUnitIds),
        targetEntityId: targetEnemyUnitId,
        targetType: 'unit'
      });
      this.showFeedback(worldPoint.x, worldPoint.y, 0xef4444);
      return;
    }

    // 2. Check if right-clicked on an enemy building
    const targetEnemyBuildingId = findBuildingAt(scene, targetGrid, 'enemy');
    if (targetEnemyBuildingId) {
      scene.room.send(NetworkMessage.ATTACK_TARGET, {
        unitIds: Array.from(scene.selectedUnitIds),
        targetEntityId: targetEnemyBuildingId,
        targetType: 'building'
      });
      this.showFeedback(worldPoint.x, worldPoint.y, 0xef4444);
      return;
    }

    // 3. CMD-05: right-clicking your own foundation with villagers selected puts
    // them to work on it instead of walking them onto the footprint.
    const ownFoundationId = findOwnFoundationAt(scene, targetGrid);
    if (ownFoundationId && scene.selection.isAllVillagers()) {
      scene.room.send(NetworkMessage.BUILD_TARGET, {
        unitIds: Array.from(scene.selectedUnitIds),
        buildingId: ownFoundationId
      });
      this.showFeedback(worldPoint.x, worldPoint.y, 0xf97316);
      return;
    }

    // 4. Check if right-clicked on a resource node (harvest command)
    const targetResourceNodeId = findResourceAt(scene, worldPoint, targetGrid);
    if (targetResourceNodeId) {
      scene.room.send(NetworkMessage.HARVEST_RESOURCE, {
        unitIds: Array.from(scene.selectedUnitIds),
        resourceNodeId: targetResourceNodeId
      });
      this.showFeedback(worldPoint.x, worldPoint.y, 0xf59e0b);
      return;
    }

    // 4b. ECO-01: right-clicking an own finished farm puts the villagers to work
    // on the field itself. Same rule as the build site above — a worker order on
    // your own building — so the cursor and the click agree on what a harvest
    // click means, and a mixed or military selection keeps falling through to a
    // move order.
    const ownFarmId = findOwnGatherableAt(scene, targetGrid);
    if (ownFarmId && scene.selection.isAllVillagers()) {
      scene.room.send(NetworkMessage.HARVEST_RESOURCE, {
        unitIds: Array.from(scene.selectedUnitIds),
        buildingId: ownFarmId
      });
      this.showFeedback(worldPoint.x, worldPoint.y, 0xf59e0b);
      return;
    }

    // 5. Default: Move command to target ground
    scene.room.send(NetworkMessage.MOVE_UNITS, {
      unitIds: Array.from(scene.selectedUnitIds),
      targetGridX: targetGrid.gridX,
      targetGridY: targetGrid.gridY,
      ...(queue ? { queue: true } : {})
    });
    this.showFeedback(worldPoint.x, worldPoint.y, 0x22c55e);
  }

  /**
   * CTL-07: issues a plain move order to `gridX, gridY` for the current
   * selection. Used by the minimap, which has no pointer over the world, so it
   * cannot reuse `handleRightClick`.
   *
   * Mirrors the ground branch of `handleRightClick` — same message, same
   * payload, no queue flag — because the minimap has no Shift modifier to read.
   * Does nothing while placing a building (placement owns the input) and with no
   * unit selected (a building-only selection must not be turned into a move).
   * Coordinates are clamped here as well as on the server: a click on the very
   * edge of the minimap can land exactly on the map size.
   */
  commandMoveTo(gridX: number, gridY: number) {
    const scene = this.scene;
    if (!scene.room) return;
    if (scene.buildingToPlace) return;
    if (scene.selectedUnitIds.size === 0) return;

    const targetGridX = Math.max(0, Math.min(MAP_GRID_WIDTH - 1, Math.round(gridX)));
    const targetGridY = Math.max(0, Math.min(MAP_GRID_HEIGHT - 1, Math.round(gridY)));

    scene.room.send(NetworkMessage.MOVE_UNITS, {
      unitIds: Array.from(scene.selectedUnitIds),
      targetGridX,
      targetGridY
    });

    const screenPos = gridToScreen(targetGridX, targetGridY);
    this.showFeedback(screenPos.x, screenPos.y, 0x22c55e);
  }

  // ---------------------------------------------------------------------------
  // Rally points
  // ---------------------------------------------------------------------------

  /**
   * CTL-06: turns a right-click into a rally order for the selected building.
   *
   * Silently does nothing when the selection is not exactly one own building that
   * can train — right-clicking empty terrain with nothing selected must not spam
   * the server, and a House cannot hold a rally point. Out-of-map clicks are
   * dropped client-side too, so the common misclick never costs a round-trip.
   */
  private handleSetRallyPoint(pointer: Phaser.Input.Pointer) {
    const scene = this.scene;
    if (!scene.room || !scene.selectedBuildingId) return;

    const building = scene.room.state.buildings.get(scene.selectedBuildingId);
    if (!building || !scene.isOwnBuilding(building.ownerId)) return;
    if (!canTrainUnitsAt(building.type as BuildingType)) return;

    const worldPoint = pointerWorldPoint(scene.cameras.main, pointer);
    const grid = pointerWorldGrid(scene.cameras.main, pointer);
    if (grid.gridX < 0 || grid.gridY < 0 || grid.gridX >= MAP_GRID_WIDTH || grid.gridY >= MAP_GRID_HEIGHT) {
      return;
    }

    scene.room.send(NetworkMessage.SET_RALLY_POINT, {
      buildingId: scene.selectedBuildingId,
      gridX: grid.gridX,
      gridY: grid.gridY
    });
    this.showFeedback(worldPoint.x, worldPoint.y, 0x38bdf8);
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
  updateRallyMarkers() {
    const scene = this.scene;
    const markers: { id: string; rallyX: number; rallyY: number }[] = [];

    if (scene.room) {
      scene.room.state.buildings.forEach((b: any) => {
        if (!scene.isOwnBuilding(b.ownerId)) return;
        if (!(b.rallyX >= 0 && b.rallyY >= 0)) return;
        if (!scene.buildingSprites.get(b.id)) return;
        markers.push({ id: b.id, rallyX: b.rallyX, rallyY: b.rallyY });
      });
    }

    const signature = markers.map((m) => `${m.id}:${m.rallyX},${m.rallyY}`).join('|');
    if (signature === this.rallySignature) return;
    this.rallySignature = signature;

    this.rallyGraphics.clear();

    markers.forEach((m) => {
      const container = scene.buildingSprites.get(m.id);
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

  // ---------------------------------------------------------------------------
  // Overlays and feedback
  // ---------------------------------------------------------------------------

  /**
   * CTL-05: while Shift is held, draws the pending path of every selected unit —
   * current position, the order it is executing, then each queued waypoint, and
   * finally the point under the pointer. Purely cosmetic: it reads the snapshot
   * and never mutates an order.
   */
  updateWaypointPreview() {
    const scene = this.scene;
    this.waypointGraphics.clear();
    if (!scene.room || !this.shiftKey?.isDown) return;
    if (scene.buildingToPlace || scene.selectedUnitIds.size === 0) return;

    const worldPoint = pointerWorldPoint(scene.cameras.main, scene.input.activePointer);
    const line = this.waypointGraphics;
    line.lineStyle(2, 0xfde68a, 0.55);

    scene.selectedUnitIds.forEach((unitId) => {
      const unit = scene.room?.state.units.get(unitId);
      const container = scene.unitSprites.get(unitId);
      if (!unit || !container || unit.ownerId !== scene.mySessionId) return;

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

  /** Short-lived ring at the click point, so every order has visible effect. */
  showFeedback(x: number, y: number, color: number) {
    const feedback = this.scene.add.graphics();
    feedback.lineStyle(2, color, 1);
    feedback.strokeEllipse(x, y, 24, 10);
    feedback.setDepth(999990);

    this.scene.tweens.add({
      targets: feedback,
      scaleX: 1.5,
      scaleY: 1.5,
      alpha: 0,
      duration: 400,
      onComplete: () => feedback.destroy()
    });
  }

  // ---------------------------------------------------------------------------
  // Selection helpers driven by hotkeys
  // ---------------------------------------------------------------------------

  /**
   * Selects the next idle unit of `category`, wrapping around at the end.
   *
   * Only IDLE counts: a unit walking home or harvesting is busy, and jumping to it
   * would make the hotkey feel random. Nothing is selected when no unit qualifies -
   * the current selection stays as it was instead of being cleared for no reason.
   */
  cycleToIdleUnit(category: 'villager' | 'military') {
    const scene = this.scene;
    if (!scene.room) return;

    const idleIds: string[] = [];
    scene.room.state.units.forEach((unit: any, unitId: string) => {
      if (unit.ownerId !== scene.mySessionId) return;
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
    const scene = this.scene;
    scene.selection.clear();
    scene.selection.addUnit(unitId);
    scene.notifySelectionChange();

    const container = scene.unitSprites.get(unitId);
    const unit = scene.room?.state.units.get(unitId);
    // Sprite position lerps toward the server position, so it is the visually
    // correct target; fall back to the snapshot when the sprite is not built yet.
    const pos = container
      ? { x: container.x, y: container.y }
      : unit
        ? gridToScreen(unit.x, unit.y)
        : null;
    if (!pos) return;

    scene.cameras.main.pan(pos.x, pos.y, 350, 'Power2');
    this.showFeedback(pos.x, pos.y, 0x22d3ee);
  }

  /** Drops a dead/despawned unit from every control group. */
  forgetUnit(unitId: string) {
    // Only republish when a roster actually lost a member: `onRemove` fires once
    // per dead unit, and each publish hands React a brand-new array.
    let changed = false;
    this.controlGroups.forEach((ids) => {
      if (ids.delete(unitId)) changed = true;
    });
    if (changed) this.publishControlGroups();
  }

  /**
   * UIX-03: drops every stored roster. Called when the scene binds a new world
   * snapshot, where the old entity ids cannot resolve to anything.
   */
  resetControlGroups() {
    this.controlGroups.clear();
    // Published directly rather than through `publishControlGroups`: an empty
    // roster needs no snapshot lookup, and the snapshot may not be bound yet.
    this.scene.onControlGroupsChange?.([]);
  }

  /**
   * UIX-03: mirrors the rosters into React.
   *
   * Dead ids are pruned first: a group keeps its id set across deaths, and a
   * panel showing "4 units" for a group of two survivors would be a lie. The
   * publish is push-based (called on every mutation) rather than polled, so the
   * HUD never scans the snapshot.
   */
  private publishControlGroups() {
    const units = this.scene.room?.state.units;
    // No snapshot means the rosters cannot be verified; keep the last published
    // list instead of telling the HUD every group died.
    if (!units) return;

    const groups: ControlGroupSummary[] = [];

    this.controlGroups.forEach((ids, index) => {
      const breakdown = new Map<string, number>();
      const dead: string[] = [];
      ids.forEach((unitId) => {
        const unit = units.get(unitId);
        if (!unit) {
          dead.push(unitId);
          return;
        }
        breakdown.set(unit.type, (breakdown.get(unit.type) ?? 0) + 1);
      });
      // Deleted after the scan, not during it: mutating a Set mid-`forEach` is
      // legal but reads as a bug to everyone who looks at this next.
      dead.forEach((unitId) => ids.delete(unitId));
      if (ids.size === 0) return;

      groups.push({
        index,
        count: ids.size,
        breakdown: Array.from(breakdown, ([type, count]) => ({ type, count })).sort(
          (a, b) => b.count - a.count
        )
      });
    });

    groups.sort((a, b) => a.index - b.index);
    this.scene.onControlGroupsChange?.(groups);
  }

  private groupControlGroup(index: number) {
    const scene = this.scene;
    const ids = new Set<string>();
    scene.selectedUnitIds.forEach((unitId) => {
      const unit = scene.room?.state.units.get(unitId);
      // Left-click selection ignores ownership, so filter here - otherwise a
      // misclicked enemy unit would follow us into the group and take orders.
      if (unit && unit.ownerId === scene.mySessionId) ids.add(unitId);
    });
    // Assigning with nothing selected empties the group, like AoE2.
    this.controlGroups.set(index, ids);
    this.publishControlGroups();
  }

  /**
   * UIX-03: `Ctrl+1..9` recall. Public so the HUD group panel runs the exact same
   * path as the digit key, including the second-press camera jump.
   */
  recallControlGroup(index: number) {
    const scene = this.scene;
    const ids = this.controlGroups.get(index);
    if (!ids || ids.size === 0) return;

    const now = scene.time.now;
    const centerCamera =
      this.lastGroupRecall.index === index &&
      now - this.lastGroupRecall.at <= CONTROL_GROUP_RECALL_DOUBLE_MS;
    this.lastGroupRecall = { index, at: now };

    scene.selection.clear();
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    ids.forEach((unitId) => {
      const container = scene.unitSprites.get(unitId);
      if (!container) return;
      scene.selectedUnitIds.add(unitId);
      const ring = container.getData('selectRing') as Phaser.GameObjects.Graphics;
      ring?.setVisible(true);
      // container.x/y are already world coordinates; panTo() expects grid ones.
      sumX += container.x;
      sumY += container.y;
      count++;
    });
    scene.notifySelectionChange();

    if (centerCamera && count > 0) {
      scene.cameras.main.pan(sumX / count, sumY / count, 250, 'Power2');
    }

    // Recall is also when a group sheds members that died since the last look.
    this.publishControlGroups();
  }
}
