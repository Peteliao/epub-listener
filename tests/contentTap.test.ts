import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindContentTaps } from '../src/core/reader/contentTap'

type Point = [number, number]

function touchEvent(type: string, points: Point[]): Event {
  const event = new Event(type, { bubbles: true })
  const touches = points.map(([clientX, clientY]) => ({ clientX, clientY }))
  Object.defineProperty(event, 'touches', { value: touches })
  Object.defineProperty(event, 'changedTouches', { value: touches })
  return event
}

function tap(target: Element, from: Point = [100, 120], to: Point = from): void {
  target.dispatchEvent(touchEvent('touchstart', [from]))
  target.dispatchEvent(touchEvent('touchend', [to]))
}

let abort: AbortController
let taps: Element[]

beforeEach(() => {
  document.body.innerHTML = [
    '<p id="text">',
    '  <span id="sentence" data-sentence-index="3">一段文字</span>',
    '  <a id="link" href="https://example.com/">链接</a>',
    '</p>',
  ].join('')
  abort = new AbortController()
  taps = []
  bindContentTaps(document, (target) => taps.push(target), abort.signal)
})

afterEach(() => {
  abort.abort()
  vi.restoreAllMocks()
})

describe('content tap', () => {
  it('reports a short tap on a sentence', () => {
    const sentence = document.getElementById('sentence')!
    tap(sentence)
    expect(taps).toHaveLength(1)
    expect(taps[0]?.closest('[data-sentence-index]')).toBe(sentence)
  })

  it('ignores drags, long presses and pinch gestures', () => {
    const sentence = document.getElementById('sentence')!
    tap(sentence, [100, 120], [160, 130])

    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    sentence.dispatchEvent(touchEvent('touchstart', [[100, 120]]))
    now.mockReturnValue(2_000)
    sentence.dispatchEvent(touchEvent('touchend', [[100, 120]]))

    sentence.dispatchEvent(touchEvent('touchstart', [[100, 120], [200, 120]]))
    sentence.dispatchEvent(touchEvent('touchend', [[100, 120]]))

    expect(taps).toHaveLength(0)
  })

  it('leaves links and text selections alone', () => {
    tap(document.getElementById('link')!)

    const paragraph = document.getElementById('text')!
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    tap(document.getElementById('sentence')!)

    expect(taps).toHaveLength(0)
    selection.removeAllRanges()
  })

  it('drops the gesture when the touch is cancelled', () => {
    const sentence = document.getElementById('sentence')!
    sentence.dispatchEvent(touchEvent('touchstart', [[100, 120]]))
    sentence.dispatchEvent(touchEvent('touchcancel', [[100, 120]]))
    sentence.dispatchEvent(touchEvent('touchend', [[100, 120]]))
    expect(taps).toHaveLength(0)
  })
})
