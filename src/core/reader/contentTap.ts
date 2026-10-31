const MAX_DISTANCE = 12
const MAX_DURATION = 700

export type ContentTapHandler = (target: Element) => void

/**
 * iOS Safari does not reliably synthesize click events for plain text inside
 * an iframe, so sentence taps are also read from the touch stream.
 */
export function bindContentTaps(
  doc: Document,
  onTap: ContentTapHandler,
  signal: AbortSignal,
): void {
  let start: { x: number; y: number; time: number; target: Element | null } | null =
    null

  const reset = (): void => {
    start = null
  }

  doc.addEventListener(
    'touchstart',
    (event) => {
      const touches = (event as TouchEvent).touches
      if (touches.length !== 1) {
        reset()
        return
      }
      const touch = touches[0]
      if (!touch) return
      const target = event.target as Element | null
      start = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
        target: target && typeof target.closest === 'function' ? target : null,
      }
    },
    { capture: true, passive: true, signal },
  )

  doc.addEventListener('touchcancel', reset, {
    capture: true,
    passive: true,
    signal,
  })

  doc.addEventListener(
    'touchend',
    (event) => {
      const current = start
      reset()
      if (!current || !current.target) return
      if (Date.now() - current.time > MAX_DURATION) return
      const touch = (event as TouchEvent).changedTouches[0]
      if (!touch) return
      const dx = touch.clientX - current.x
      const dy = touch.clientY - current.y
      if (Math.hypot(dx, dy) > MAX_DISTANCE) return

      const selection = doc.getSelection()
      if (selection && !selection.isCollapsed && selection.toString().trim()) return
      if (current.target.closest('a[href]')) return

      onTap(current.target)
    },
    { capture: true, passive: true, signal },
  )
}
