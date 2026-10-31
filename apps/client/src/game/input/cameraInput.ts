import type * as Phaser from 'phaser';

/**
 * Width of the screen-border band that pans the camera while the pointer rests
 * there, in CSS pixels. Set to 0 to disable edge scrolling.
 */
const EDGE_SCROLL_SIZE_PX = 24;

/**
 * Pans the camera when the pointer sits inside the screen border band.
 * Uses `activePointer` screen coordinates, which are immune to camera scroll,
 * and skips entirely when the pointer is off-canvas or over the React HUD
 * (the pointer then reports negative / out-of-range coordinates).
 *
 * @param hasPointerMoved Phaser reports the pointer at (0,0) until the first real
 *   pointermove, which sits inside the top-left band. Without this flag the
 *   camera pans up-left on its own from the moment the scene starts, even with
 *   the mouse parked outside the game.
 */
export function applyEdgeScroll(
  camera: Phaser.Cameras.Scene2D.Camera,
  pointer: Phaser.Input.Pointer,
  viewWidth: number,
  viewHeight: number,
  hasPointerMoved: boolean,
  cameraSpeed: number
) {
  if (EDGE_SCROLL_SIZE_PX <= 0) return;
  if (!hasPointerMoved) return;

  // Pointer outside the game canvas (e.g. hovering the HUD panel).
  if (pointer.x < 0 || pointer.y < 0 || pointer.x > viewWidth || pointer.y > viewHeight) return;

  if (pointer.x <= EDGE_SCROLL_SIZE_PX) camera.scrollX -= cameraSpeed;
  else if (pointer.x >= viewWidth - EDGE_SCROLL_SIZE_PX) camera.scrollX += cameraSpeed;

  if (pointer.y <= EDGE_SCROLL_SIZE_PX) camera.scrollY -= cameraSpeed;
  else if (pointer.y >= viewHeight - EDGE_SCROLL_SIZE_PX) camera.scrollY += cameraSpeed;
}

/**
 * Middle-button drag panning (AoE2 convention: hold the middle mouse button and
 * drag the map).
 *
 * The camera moves by the pointer delta converted from screen pixels to world
 * units, so the ground under the cursor keeps up with the mouse at every zoom
 * level. Panning writes `scrollX/scrollY` directly instead of calling
 * `camera.pan()`, whose tween would fight the drag.
 */
export class MiddleDragPan {
  private last: { x: number; y: number } | null = null;

  /** Starts a drag at the current pointer position. */
  begin(pointer: Phaser.Input.Pointer) {
    this.last = { x: pointer.x, y: pointer.y };
  }

  get active(): boolean {
    return this.last !== null;
  }

  /**
   * Applies one frame of the drag.
   *
   * @returns false when no drag is in progress, so the caller can skip the rest
   *   of the pointer work.
   */
  update(camera: Phaser.Cameras.Scene2D.Camera, pointer: Phaser.Input.Pointer): boolean {
    if (!this.last) return false;

    // A release that lands on a HUD panel never reaches the canvas, so no
    // `pointerup` (not even `pointerupoutside`) ends the drag. The button state on
    // the next move is the only reliable end condition: without it the camera
    // would keep following the mouse after the button was let go.
    if (!pointer.middleButtonDown()) {
      this.last = null;
      return false;
    }

    const zoom = camera.zoom || 1;
    camera.scrollX -= (pointer.x - this.last.x) / zoom;
    camera.scrollY -= (pointer.y - this.last.y) / zoom;
    this.last = { x: pointer.x, y: pointer.y };
    return true;
  }

  end() {
    this.last = null;
  }
}
