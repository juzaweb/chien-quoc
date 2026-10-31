/**
 * One guarded key handler for `keyboard.on('keydown-<NAME>', …)`.
 *
 * Phaser re-emits `keydown-<NAME>` every frame while a key stays down, and
 * `KeyboardEvent.repeat` does not catch those re-emits (they are not DOM repeat
 * events), so a held camera or bookmark key would fire dozens of times per
 * second. Each binding therefore needs the same two guards: drop `repeat`, then
 * drop a second press inside `minGapMs`.
 *
 * The timestamp is only recorded when the wrapped handler reports it actually
 * did something, so a key that was ignored (no bookmark in that slot, nothing
 * selected) does not swallow the next, valid press.
 */
export type KeyHandler = (event: KeyboardEvent) => boolean;

export type GuardedKeyHandler = (event: KeyboardEvent) => void;

export function guardKey(handler: KeyHandler, minGapMs = 250): GuardedKeyHandler {
  let lastHandledAt = Number.NEGATIVE_INFINITY;

  return (event: KeyboardEvent) => {
    if (event.repeat) return;

    const now = performance.now();
    if (now - lastHandledAt < minGapMs) return;

    if (!handler(event)) return;
    lastHandledAt = now;
  };
}
