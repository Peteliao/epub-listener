import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeQueueBackgroundSafe } from '../src/core/reader/renditionQueue'

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  })
}

describe('makeQueueBackgroundSafe', () => {
  afterEach(() => {
    delete (document as unknown as { visibilityState?: DocumentVisibilityState })
      .visibilityState
    vi.restoreAllMocks()
  })

  it('drives the rendition queue with timers while the page is hidden', () => {
    setVisibility('hidden')
    const rendition = { q: { tick: undefined as unknown } }
    makeQueueBackgroundSafe(rendition)

    const timer = vi.spyOn(window, 'setTimeout')
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const callback = vi.fn()
    ;(rendition.q.tick as (next: () => void) => number)(callback)

    expect(timer).toHaveBeenCalledWith(callback, 0)
    expect(raf).not.toHaveBeenCalled()
  })

  it('keeps animation frames while the page is visible', () => {
    setVisibility('visible')
    const rendition = { q: { tick: undefined as unknown } }
    makeQueueBackgroundSafe(rendition)

    const timer = vi.spyOn(window, 'setTimeout')
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const callback = vi.fn()
    ;(rendition.q.tick as (next: () => void) => number)(callback)

    expect(raf).toHaveBeenCalledWith(callback)
    expect(timer).not.toHaveBeenCalled()
  })

  it('ignores renditions without a task queue', () => {
    expect(() => makeQueueBackgroundSafe({})).not.toThrow()
    expect(() => makeQueueBackgroundSafe(null)).not.toThrow()
  })
})
