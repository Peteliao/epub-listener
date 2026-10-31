const MIN_DISTANCE = 40
const EARLY_DISTANCE = 48
const MAX_DURATION = 1500
const END_ANGLE_RATIO = 1.2
const EARLY_ANGLE_RATIO = 1.6
const VERTICAL_LOCK = 32
// Touches starting at the left screen edge belong to the iOS back gesture.
const EDGE_GUARD = 28
const RESET_DELAY = 400

export type SwipeDirection = 'next' | 'previous'

interface Gesture {
  x: number
  y: number
  time: number
  pointerId: number | null
  guarded: boolean
  vertical: boolean
  fired: boolean
}

function hasSelection(doc: Document): boolean {
  const selection = doc.getSelection()
  return !!selection && !selection.isCollapsed && !!selection.toString().trim()
}

/**
 * Horizontal page-turn swipes inside a book iframe. iOS only delivers a
 * touch sequence to an iframe when a touch listener exists there, and often
 * cancels it once scrolling takes over, so pointer and touch streams are both
 * watched and a clear horizontal pull fires before the finger lifts.
 */
export function bindSwipeNavigation(
  doc: Document,
  onSwipe: (direction: SwipeDirection) => void,
  signal: AbortSignal,
): void {
  const win = doc.defaultView
  let gesture: Gesture | null = null
  let resetTimer: number | null = null

  const scheduleReset = (delay = RESET_DELAY): void => {
    if (!win) return
    if (resetTimer !== null) win.clearTimeout(resetTimer)
    resetTimer = win.setTimeout(() => {
      resetTimer = null
      gesture = null
    }, delay)
  }

  const begin = (x: number, y: number, pointerId: number | null): void => {
    const now = Date.now()
    if (resetTimer !== null && win) {
      win.clearTimeout(resetTimer)
      resetTimer = null
    }
    // Pointer and touch sequences describe the same finger; keep the first
    // origin instead of restamping it.
    if (
      gesture &&
      !gesture.fired &&
      now - gesture.time < 150 &&
      Math.abs(gesture.x - x) < 24 &&
      Math.abs(gesture.y - y) < 24
    ) {
      return
    }
    gesture = {
      x,
      y,
      time: now,
      pointerId,
      guarded: x <= EDGE_GUARD,
      vertical: false,
      fired: false,
    }
  }

  const reset = (): void => {
    if (resetTimer !== null && win) {
      win.clearTimeout(resetTimer)
      resetTimer = null
    }
    gesture = null
  }

  const fire = (direction: SwipeDirection): void => {
    onSwipe(direction)
  }

  const track = (x: number, y: number): void => {
    const current = gesture
    if (!current || current.guarded || current.fired || current.vertical) return
    const dx = x - current.x
    const dy = y - current.y

    if (Math.abs(dy) >= VERTICAL_LOCK && Math.abs(dy) > Math.abs(dx)) {
      current.vertical = true
      return
    }

    if (
      Math.abs(dx) < EARLY_DISTANCE ||
      Math.abs(dx) < Math.abs(dy) * EARLY_ANGLE_RATIO
    ) {
      return
    }
    if (hasSelection(doc)) {
      current.vertical = true
      return
    }
    current.fired = true
    fire(dx < 0 ? 'next' : 'previous')
  }

  const end = (x: number, y: number): void => {
    const current = gesture
    if (!current) return
    // The pointer and touch streams both end the same finger; keep the
    // gesture around briefly so the other stream can still evaluate it.
    scheduleReset()
    if (current.guarded || current.fired || current.vertical) return
    if (Date.now() - current.time > MAX_DURATION) return

    const dx = x - current.x
    const dy = y - current.y
    if (Math.abs(dx) < MIN_DISTANCE) return
    if (Math.abs(dx) < Math.abs(dy) * END_ANGLE_RATIO) return
    if (hasSelection(doc)) return

    current.fired = true
    fire(dx < 0 ? 'next' : 'previous')
  }

  const listen = (
    type: string,
    handler: (event: Event) => void,
    target: Document = doc,
  ): void => {
    target.addEventListener(type, handler, {
      capture: true,
      passive: true,
      signal,
    })
  }

  if (typeof win?.PointerEvent === 'function') {
    listen('pointerdown', (event) => {
      const pointer = event as PointerEvent
      if (pointer.pointerType !== 'touch' && pointer.pointerType !== 'pen') {
        reset()
        return
      }
      begin(pointer.clientX, pointer.clientY, pointer.pointerId)
    })

    listen('pointermove', (event) => {
      const pointer = event as PointerEvent
      if (gesture?.pointerId !== null && pointer.pointerId !== gesture?.pointerId) {
        return
      }
      track(pointer.clientX, pointer.clientY)
    })

    listen('pointerup', (event) => {
      const pointer = event as PointerEvent
      if (gesture?.pointerId !== null && pointer.pointerId !== gesture?.pointerId) {
        return
      }
      end(pointer.clientX, pointer.clientY)
    })

    listen('pointercancel', (event) => {
      const pointer = event as PointerEvent
      if (gesture?.pointerId === null || pointer.pointerId === gesture?.pointerId) {
        scheduleReset(200)
      }
    })
  }

  listen('touchstart', (event) => {
    const touches = (event as TouchEvent).touches
    if (touches.length !== 1) {
      reset()
      return
    }
    const touch = touches[0]
    if (touch) begin(touch.clientX, touch.clientY, null)
  })

  listen('touchmove', (event) => {
    const touch = (event as TouchEvent).touches[0]
    if (touch) track(touch.clientX, touch.clientY)
  })

  listen('touchend', (event) => {
    const touch = (event as TouchEvent).changedTouches[0]
    if (touch) end(touch.clientX, touch.clientY)
  })

  listen('touchcancel', () => {
    scheduleReset(200)
  })

  signal.addEventListener(
    'abort',
    () => {
      if (resetTimer !== null) win?.clearTimeout(resetTimer)
      resetTimer = null
    },
    { once: true },
  )
}
