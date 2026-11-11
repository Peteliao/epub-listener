import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindStageTaps, elementAtClientPoint } from '../src/core/reader/stageTap'

type Point = [number, number]

function touchEvent(type: string, points: Point[]): Event {
  const event = new Event(type, { bubbles: true })
  const touches = points.map(([clientX, clientY]) => ({ clientX, clientY }))
  Object.defineProperty(event, 'touches', { value: touches })
  Object.defineProperty(event, 'changedTouches', { value: touches })
  return event
}

function clickEvent(x: number, y: number, detail = 1): MouseEvent {
  return new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, detail })
}

function tap(target: Element, from: Point = [100, 120], to: Point = from): void {
  target.dispatchEvent(touchEvent('touchstart', [from]))
  target.dispatchEvent(touchEvent('touchend', [to]))
}

let abort: AbortController
let stage: HTMLElement
let taps: Point[]

beforeEach(() => {
  document.body.innerHTML = '<div id="stage"><div id="surface"><span>一段文字</span></div></div>'
  stage = document.getElementById('stage')!
  abort = new AbortController()
  taps = []
  bindStageTaps(stage, (x, y) => taps.push([x, y]), abort.signal)
})

afterEach(() => {
  abort.abort()
  vi.restoreAllMocks()
})

describe('stage tap', () => {
  it('reports a short tap in page coordinates', () => {
    tap(document.getElementById('surface')!, [120, 340])
    expect(taps).toEqual([[120, 340]])
  })

  it('ignores drags, long presses and pinch gestures', () => {
    const surface = document.getElementById('surface')!
    tap(surface, [100, 120], [160, 130])

    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    surface.dispatchEvent(touchEvent('touchstart', [[100, 120]]))
    now.mockReturnValue(2_000)
    surface.dispatchEvent(touchEvent('touchend', [[100, 120]]))

    surface.dispatchEvent(touchEvent('touchstart', [[100, 120], [200, 120]]))
    surface.dispatchEvent(touchEvent('touchend', [[100, 120]]))

    expect(taps).toHaveLength(0)
  })

  it('does not run a tap twice when a click follows it', () => {
    const surface = document.getElementById('surface')!
    tap(surface, [120, 340])
    surface.dispatchEvent(clickEvent(120, 340))
    expect(taps).toHaveLength(1)
  })

  it('uses the synthesized click when no touch sequence arrived', () => {
    document.getElementById('surface')!.dispatchEvent(clickEvent(130, 350))
    expect(taps).toEqual([[130, 350]])
  })

  it('ignores clicks without a pointer position', () => {
    document.getElementById('surface')!.dispatchEvent(clickEvent(0, 0, 0))
    expect(taps).toHaveLength(0)
  })

  it('ignores taps that land while the page is still moving', () => {
    const surface = document.getElementById('surface')!
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    surface.dispatchEvent(new Event('scroll'))
    tap(surface, [120, 340])
    expect(taps).toHaveLength(0)

    now.mockReturnValue(1_400)
    tap(surface, [120, 340])
    expect(taps).toEqual([[120, 340]])
  })

  it('drops the gesture when the touch is cancelled', () => {
    const surface = document.getElementById('surface')!
    surface.dispatchEvent(touchEvent('touchstart', [[100, 120]]))
    surface.dispatchEvent(touchEvent('touchcancel', [[100, 120]]))
    surface.dispatchEvent(touchEvent('touchend', [[100, 120]]))
    expect(taps).toHaveLength(0)
  })

  it('ignores the click that follows a cancelled or dragged touch', () => {
    const surface = document.getElementById('surface')!
    surface.dispatchEvent(touchEvent('touchstart', [[100, 120]]))
    surface.dispatchEvent(touchEvent('touchcancel', [[100, 120]]))
    surface.dispatchEvent(clickEvent(100, 120))

    tap(surface, [100, 120], [180, 260])
    surface.dispatchEvent(clickEvent(180, 260))
    expect(taps).toHaveLength(0)
  })
})

describe('elementAtClientPoint', () => {
  const element = document.createElement('span')

  function makeFrame(rect: { left: number; top: number; width: number; height: number }) {
    return { getBoundingClientRect: () => rect as DOMRect } as unknown as HTMLElement
  }

  it('maps page coordinates into the frame viewport', () => {
    const frame = makeFrame({ left: 10, top: 200, width: 300, height: 400 })
    const doc = { elementFromPoint: vi.fn(() => element) } as unknown as Document
    expect(elementAtClientPoint(doc, frame, 60, 260)).toBe(element)
    expect(doc.elementFromPoint).toHaveBeenCalledWith(50, 60)
  })

  it('rejects points that fall outside the frame', () => {
    const frame = makeFrame({ left: 10, top: 200, width: 300, height: 400 })
    const doc = { elementFromPoint: vi.fn(() => element) } as unknown as Document
    expect(elementAtClientPoint(doc, frame, 5, 260)).toBeNull()
    expect(elementAtClientPoint(doc, frame, 60, 700)).toBeNull()
    expect(doc.elementFromPoint).not.toHaveBeenCalled()
  })
})
