import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bindSwipeNavigation,
  type SwipeDirection,
} from '../src/core/reader/contentSwipe'

type Point = [number, number]

class FakePointerEvent extends Event {
  readonly pointerId: number
  readonly pointerType: string
  readonly clientX: number
  readonly clientY: number
  readonly isPrimary: boolean

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, { bubbles: true })
    this.pointerId = init.pointerId ?? 1
    this.pointerType = init.pointerType ?? 'touch'
    this.clientX = init.clientX ?? 0
    this.clientY = init.clientY ?? 0
    this.isPrimary = init.isPrimary ?? true
  }
}

function touchEvent(type: string, points: Point[]): Event {
  const event = new Event(type, { bubbles: true })
  const touches = points.map(([clientX, clientY]) => ({ clientX, clientY }))
  Object.defineProperty(event, 'touches', { value: touches })
  Object.defineProperty(event, 'changedTouches', { value: touches })
  return event
}

function pointer(type: string, [clientX, clientY]: Point, pointerId = 1): void {
  document.getElementById('text')!.dispatchEvent(
    new FakePointerEvent(type, {
      pointerId,
      pointerType: 'touch',
      clientX,
      clientY,
    }),
  )
}

function swipe(from: Point, to: Point): void {
  const target = document.getElementById('text')!
  target.dispatchEvent(touchEvent('touchstart', [from]))
  target.dispatchEvent(touchEvent('touchend', [to]))
}

let abort: AbortController
let swipes: SwipeDirection[]

beforeEach(() => {
  ;(
    window as unknown as { PointerEvent: typeof FakePointerEvent }
  ).PointerEvent = FakePointerEvent
  document.body.innerHTML = '<p id="text">一段用于手势测试的正文。</p>'
  abort = new AbortController()
  swipes = []
  bindSwipeNavigation(document, (direction) => swipes.push(direction), abort.signal)
})

afterEach(() => {
  abort.abort()
})

describe('page swipe', () => {
  it('turns forward on a left swipe and back on a right swipe', () => {
    swipe([300, 200], [180, 206])
    expect(swipes).toEqual(['next'])

    swipe([160, 200], [300, 204])
    expect(swipes).toEqual(['next', 'previous'])
  })

  it('fires as soon as a pointer drag is clearly horizontal', () => {
    pointer('pointerdown', [300, 200])
    pointer('pointermove', [236, 203])
    expect(swipes).toEqual(['next'])

    pointer('pointerup', [230, 203])
    expect(swipes).toEqual(['next'])
  })

  it('fires from touch moves before iOS ends the touch sequence', () => {
    const target = document.getElementById('text')!
    target.dispatchEvent(touchEvent('touchstart', [[300, 200]]))
    target.dispatchEvent(touchEvent('touchmove', [[234, 202]]))

    expect(swipes).toEqual(['next'])
  })

  it('ignores swipes that start at the left screen edge', () => {
    swipe([10, 200], [220, 200])
    expect(swipes).toEqual([])

    pointer('pointerdown', [12, 200])
    pointer('pointermove', [150, 200])
    pointer('pointerup', [150, 200])
    expect(swipes).toEqual([])
  })

  it('ignores vertical scrolls, short drags and pinch gestures', () => {
    swipe([300, 150], [220, 320])
    swipe([300, 200], [270, 200])

    pointer('pointerdown', [300, 100])
    pointer('pointermove', [294, 150])
    pointer('pointermove', [200, 160])
    pointer('pointerup', [200, 160])

    const target = document.getElementById('text')!
    target.dispatchEvent(touchEvent('touchstart', [[300, 200], [200, 200]]))
    target.dispatchEvent(touchEvent('touchend', [[180, 200]]))

    expect(swipes).toEqual([])
  })

  it('pages once when pointer and touch report the same swipe', () => {
    pointer('pointerdown', [300, 200])
    document.getElementById('text')!.dispatchEvent(touchEvent('touchstart', [[300, 200]]))
    pointer('pointermove', [236, 202])

    document.getElementById('text')!.dispatchEvent(touchEvent('touchend', [[230, 202]]))
    pointer('pointerup', [230, 202])

    expect(swipes).toEqual(['next'])
  })

  it('leaves text selections alone', () => {
    const paragraph = document.getElementById('text')!
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    swipe([300, 200], [180, 200])
    expect(swipes).toEqual([])
    selection.removeAllRanges()
  })

  it('stops handling gestures after the session is torn down', () => {
    abort.abort()
    swipe([300, 200], [180, 200])
    expect(swipes).toEqual([])
  })
})
