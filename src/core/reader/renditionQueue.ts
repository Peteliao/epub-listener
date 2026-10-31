interface RenditionQueueLike {
  tick?: (callback: () => void) => number
}

/**
 * epub.js runs every rendition task — chapter display included — through a
 * queue clocked by requestAnimationFrame. iOS stops animation frames once the
 * screen locks, so the next chapter would never render there: the display
 * times out and playback pauses. Background timers keep running, so switch the
 * queue clock to one while the page is hidden.
 */
export function makeQueueBackgroundSafe(rendition: unknown): void {
  const queue = (rendition as { q?: RenditionQueueLike } | null)?.q
  if (!queue) return
  queue.tick = (callback) =>
    document.visibilityState === 'hidden'
      ? window.setTimeout(callback, 0)
      : window.requestAnimationFrame(callback)
}
