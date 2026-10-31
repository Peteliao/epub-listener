const MAX_DISTANCE = 12
const MAX_DURATION = 600
const CLICK_DEDUPE = 600
const CLICK_QUIET = 120

export type StageTapHandler = (clientX: number, clientY: number) => void

/**
 * Reads taps on the stage that hosts the book iframe. iOS does not reliably
 * dispatch touch events into an iframe document, so phones make the iframe
 * pointer-transparent and the tap is mapped back into it with elementFromPoint.
 */
export function bindStageTaps(
  element: HTMLElement,
  onTap: StageTapHandler,
  signal: AbortSignal,
): void {
  let start: { x: number; y: number; time: number } | null = null
  let lastTouchEndAt = 0
  let lastScrollAt = 0

  const reset = (): void => {
    start = null
  }

  const recentlyScrolled = (): boolean => Date.now() - lastScrollAt < CLICK_QUIET

  element.addEventListener(
    'scroll',
    () => {
      lastScrollAt = Date.now()
    },
    { capture: true, passive: true, signal },
  )

  element.addEventListener(
    'touchstart',
    (event) => {
      const touches = event.touches
      if (touches.length !== 1) {
        reset()
        return
      }
      const touch = touches[0]
      if (!touch) return
      start = { x: touch.clientX, y: touch.clientY, time: Date.now() }
    },
    { capture: true, passive: true, signal },
  )

  element.addEventListener(
    'touchcancel',
    () => {
      reset()
      lastTouchEndAt = Date.now()
    },
    { capture: true, passive: true, signal },
  )

  element.addEventListener(
    'touchend',
    (event) => {
      const current = start
      reset()
      lastTouchEndAt = Date.now()
      if (!current) return
      if (Date.now() - current.time > MAX_DURATION) return
      const touch = event.changedTouches[0]
      if (!touch) return
      if (Math.hypot(touch.clientX - current.x, touch.clientY - current.y) > MAX_DISTANCE) {
        return
      }
      // A tap that stops momentum scrolling must not also jump to a sentence.
      if (lastScrollAt >= current.time) return
      onTap(touch.clientX, touch.clientY)
    },
    { capture: true, passive: true, signal },
  )

  // Some builds only synthesize the click after a tap; keep it as a fallback
  // without replaying a gesture the touch stream already classified.
  element.addEventListener(
    'click',
    (event) => {
      const mouse = event as MouseEvent
      if (mouse.detail === 0) return
      if (Date.now() - lastTouchEndAt < CLICK_DEDUPE) return
      if (recentlyScrolled()) return
      onTap(mouse.clientX, mouse.clientY)
    },
    { capture: true, signal },
  )
}

/** Maps a stage-level point onto the element rendered inside the iframe. */
export function elementAtClientPoint(
  doc: Document,
  frame: HTMLElement,
  clientX: number,
  clientY: number,
): Element | null {
  const rect = frame.getBoundingClientRect()
  const x = clientX - rect.left
  const y = clientY - rect.top
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null
  return doc.elementFromPoint(x, y)
}
