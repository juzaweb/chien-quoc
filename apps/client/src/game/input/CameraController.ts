import * as Phaser from 'phaser';
import type { WorldScene } from '../scenes/WorldScene.js';
import { MiddleDragPan } from './cameraInput.js';

/** Zoom range, shared by the wheel and the `+`/`-` hotkeys. */
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.2;
/** Wheel pixels to zoom units. */
const WHEEL_ZOOM_SENSITIVITY = 0.001;
/** Multiplier applied per `+`/`-` press: one press reads as a deliberate step. */
const KEY_ZOOM_STEP = 1.2;

/**
 * Everything that moves or zooms the camera: the wheel, the `+`/`-` keys, the
 * `Ctrl/F2..F4` bookmarks and middle-button drag panning.
 *
 * Extracted from `WorldScene` because the scene had crossed the ~1000-line
 * review threshold and this is the most self-contained block left in it: it
 * reads `cameras.main` and writes nothing else.
 */
export class CameraController {
  private readonly middleDrag = new MiddleDragPan();
  private readonly bookmarks = new Map<number, { x: number; y: number; zoom: number }>();

  constructor(private readonly scene: WorldScene) {}

  private get camera(): Phaser.Cameras.Scene2D.Camera {
    return this.scene.cameras.main;
  }

  // ---------------------------------------------------------------------------
  // Middle-button drag panning
  // ---------------------------------------------------------------------------

  beginMiddleDrag(pointer: Phaser.Input.Pointer) {
    this.middleDrag.begin(pointer);
  }

  /** @returns true while a drag is in progress, so hover work can be skipped. */
  updateMiddleDrag(pointer: Phaser.Input.Pointer): boolean {
    return this.middleDrag.update(this.camera, pointer);
  }

  endMiddleDrag() {
    this.middleDrag.end();
  }

  // ---------------------------------------------------------------------------
  // Zoom
  // ---------------------------------------------------------------------------

  /** Clamped zoom, shared by the wheel and the `+`/`-` hotkeys. */
  setZoom(zoom: number) {
    this.camera.setZoom(Phaser.Math.Clamp(zoom, ZOOM_MIN, ZOOM_MAX));
  }

  /**
   * One `+`/`-` press. Multiplicative so a step feels the same at every zoom,
   * and clamped to the same range the wheel uses.
   *
   * @param steps `1` zooms in, `-1` zooms out.
   */
  zoomBySteps(steps: number) {
    this.setZoom(this.camera.zoom * Math.pow(KEY_ZOOM_STEP, steps));
  }

  /** One wheel notch. `deltaY` is positive when scrolling down (zoom out). */
  handleWheel(deltaY: number) {
    this.setZoom(this.camera.zoom - deltaY * WHEEL_ZOOM_SENSITIVITY);
  }

  // ---------------------------------------------------------------------------
  // Bookmarks
  // ---------------------------------------------------------------------------

  /** Stores the current camera centre and zoom under `slot` (1-based). */
  saveBookmark(slot: number) {
    const camera = this.camera;
    this.bookmarks.set(slot, { x: camera.midPoint.x, y: camera.midPoint.y, zoom: camera.zoom });
    this.scene.commands.showFeedback(camera.midPoint.x, camera.midPoint.y, 0x22c55e);
  }

  /**
   * Jumps to a saved camera position, like AoE2's `F2..F4`.
   *
   * The zoom is restored before the centre so `centerOn` works in the final
   * projection; doing it the other way round would land the camera off-centre.
   *
   * @returns false when the slot was never saved, so the caller can leave the
   *   keystroke unclaimed.
   */
  recallBookmark(slot: number): boolean {
    const bookmark = this.bookmarks.get(slot);
    if (!bookmark) return false;

    // A minimap / `H` recentre is a 350 ms pan tween; leaving it running would
    // drag the camera off the bookmark right after `centerOn`.
    this.camera.panEffect.reset();
    this.setZoom(bookmark.zoom);
    this.camera.centerOn(bookmark.x, bookmark.y);
    this.scene.commands.showFeedback(bookmark.x, bookmark.y, 0x38bdf8);
    return true;
  }
}
