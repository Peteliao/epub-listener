import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushListeningTracking,
  getListeningSnapshot,
  stopListeningTracking,
  updateListeningContext,
} from '../src/core/stats/listeningStats'

const START = new Date(2026, 10, 1, 10, 0, 0).getTime()

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  })
}

function emitVisibility(): void {
  document.dispatchEvent(new Event('visibilitychange'))
}

function elapsed(): number {
  return getListeningSnapshot().totalMs
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  window.localStorage.clear()
  setVisibility('visible')
  stopListeningTracking()
})

afterEach(() => {
  stopListeningTracking()
  vi.useRealTimers()
  setVisibility('visible')
})

describe('listening timer', () => {
  it('counts only while playback is active', () => {
    updateListeningContext({
      bookId: 'b1',
      title: '书',
      playing: true,
      engine: 'system',
    })
    vi.setSystemTime(START + 30_000)
    flushListeningTracking()
    expect(elapsed()).toBe(30_000)

    updateListeningContext({
      bookId: 'b1',
      title: '书',
      playing: false,
      engine: null,
    })
    vi.setSystemTime(START + 90_000)
    flushListeningTracking()
    expect(elapsed()).toBe(30_000)
  })

  it('stops counting system speech when the page is hidden', () => {
    updateListeningContext({
      bookId: 'b1',
      title: '书',
      playing: true,
      engine: 'system',
    })
    vi.setSystemTime(START + 10_000)
    setVisibility('hidden')
    emitVisibility()

    vi.setSystemTime(START + 40_000)
    flushListeningTracking()
    expect(elapsed()).toBe(10_000)

    setVisibility('visible')
    emitVisibility()
    vi.setSystemTime(START + 50_000)
    flushListeningTracking()
    expect(elapsed()).toBe(20_000)
  })

  it('keeps counting the offline AI voice behind the lock screen', () => {
    updateListeningContext({
      bookId: 'b1',
      title: '书',
      playing: true,
      engine: 'sherpa',
    })
    setVisibility('hidden')
    emitVisibility()

    vi.setSystemTime(START + 40_000)
    flushListeningTracking()
    expect(elapsed()).toBe(40_000)
  })

  it('flushes the current span when tracking stops', () => {
    updateListeningContext({
      bookId: 'b1',
      title: '书',
      playing: true,
      engine: 'sherpa',
    })
    vi.setSystemTime(START + 20_000)
    stopListeningTracking()

    updateListeningContext({
      bookId: 'b1',
      title: '书',
      playing: true,
      engine: 'sherpa',
    })
    vi.setSystemTime(START + 30_000)
    flushListeningTracking()
    expect(elapsed()).toBe(30_000)
  })
})
