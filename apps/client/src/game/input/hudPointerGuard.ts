import type * as Phaser from 'phaser';

/**
 * True when the event came from the game canvas (or a child of it).
 *
 * A null target counts as the canvas: a synthetic event must never cancel input
 * the player armed.
 */
export function isCanvasTarget(game: Phaser.Game, target: EventTarget | null): boolean {
  if (!target) return true;
  const canvas = game?.canvas;
  if (!canvas) return true;
  return target === canvas || canvas.contains(target as Node);
}

export interface HudPointerHandlers {
  /** A press landed on the HUD (or anywhere off canvas). */
  onPressOutside: () => void;
  /** A release landed on the HUD (or anywhere off canvas). */
  onReleaseOutside: () => void;
  /** The browser aborted the gesture (`pointercancel`), wherever it started. */
  onPointerCancelled: () => void;
}

/**
 * Listens for presses, releases and cancellations that land outside the canvas.
 *
 * The React HUD is DOM layered over the canvas, so those events never reach
 * Phaser: without this, an armed order stays armed and a box-selection keeps
 * painting after the button was released over a panel (UIX-01).
 *
 * `pointercancel` is not filtered by target: a browser that cancels a gesture
 * (touch scroll, window drag-out) sends it to the element that captured the
 * pointer, which can well be the canvas — and Phaser ignores that event, so the
 * drag state would stay stuck exactly as before the fix.
 *
 * Listeners are installed in the capture phase — the HUD's own React handlers
 * run on bubble — and removed when the scene shuts down.
 *
 * @returns a disposer, in case a caller wants to remove them early.
 */
export function installHudPointerGuard(
  game: Phaser.Game,
  sceneEvents: Phaser.Events.EventEmitter,
  handlers: HudPointerHandlers
): () => void {
  const onPointerDown = (event: PointerEvent) => {
    if (isCanvasTarget(game, event.target)) return;
    handlers.onPressOutside();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (isCanvasTarget(game, event.target)) return;
    handlers.onReleaseOutside();
  };

  const onPointerCancel = () => {
    handlers.onPointerCancelled();
  };

  const dispose = () => {
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerCancel, true);
  };

  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerCancel, true);
  sceneEvents.once('shutdown', dispose);
  return dispose;
}
