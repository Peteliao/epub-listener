import { beforeEach, describe, expect, it } from 'vitest'
import {
  dayKey,
  formatListenDuration,
  getListeningSnapshot,
  recordListeningSpan,
  splitListenDuration,
} from '../src/core/stats/listeningStats'

const MINUTE = 60_000

function at(day: number, hour = 12, minute = 0): number {
  return new Date(2026, 10, day, hour, minute).getTime()
}

function october(day: number, hour = 12): number {
  return new Date(2026, 9, day, hour).getTime()
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('recordListeningSpan', () => {
  it('accumulates total, day, and per-book time', () => {
    recordListeningSpan('b1', '山间来信', at(1, 10), at(1, 10, 30))
    recordListeningSpan('b1', '山间来信', at(1, 11), at(1, 11, 15))
    recordListeningSpan('b2', '另一本', at(1, 12), at(1, 12, 10))

    const snapshot = getListeningSnapshot(at(1, 18))
    expect(snapshot.totalMs).toBe(55 * MINUTE)
    expect(snapshot.todayMs).toBe(55 * MINUTE)
    expect(snapshot.activeDays).toBe(1)
    expect(snapshot.bookCount).toBe(2)
    expect(snapshot.lastBook).toEqual({
      id: 'b2',
      title: '另一本',
      ms: 10 * MINUTE,
    })
  })

  it('splits a span across local midnight', () => {
    recordListeningSpan('b1', '夜读', at(1, 23, 50), at(2, 0, 10))

    const first = getListeningSnapshot(at(1, 23, 55))
    expect(first.todayMs).toBe(10 * MINUTE)
    expect(first.totalMs).toBe(20 * MINUTE)

    const second = getListeningSnapshot(at(2, 12))
    expect(second.todayMs).toBe(10 * MINUTE)
    expect(second.totalMs).toBe(20 * MINUTE)
    expect(second.streakDays).toBe(2)
  })

  it('ignores empty or reversed spans', () => {
    recordListeningSpan('b1', '书', at(1), at(1))
    recordListeningSpan('b1', '书', at(1), at(1) - 1000)
    recordListeningSpan('', '书', at(1), at(1, 13))
    expect(getListeningSnapshot(at(1, 18)).totalMs).toBe(0)
  })

  it('updates the remembered title for an existing book', () => {
    recordListeningSpan('b1', '旧书名', at(1, 10), at(1, 11))
    recordListeningSpan('b1', '新书名', at(1, 12), at(1, 13))
    expect(getListeningSnapshot(at(1, 18)).lastBook?.title).toBe('新书名')
  })
})

describe('getListeningSnapshot', () => {
  it('counts consecutive days ending today', () => {
    recordListeningSpan('b1', '书', october(30, 10), october(30, 11))
    recordListeningSpan('b1', '书', october(31, 10), october(31, 11))
    recordListeningSpan('b1', '书', at(1, 10), at(1, 11))
    const snapshot = getListeningSnapshot(at(2, 9))
    expect(snapshot.streakDays).toBe(3)
  })

  it('keeps yesterday’s streak until today ends', () => {
    recordListeningSpan('b1', '书', october(30, 10), october(30, 11))
    recordListeningSpan('b1', '书', october(31, 10), october(31, 11))
    expect(getListeningSnapshot(at(1, 8)).streakDays).toBe(2)
  })

  it('returns zero when neither today nor yesterday has listening', () => {
    recordListeningSpan('b1', '书', october(30, 10), october(30, 11))
    expect(getListeningSnapshot(at(1, 8)).streakDays).toBe(0)
  })

  it('tolerates corrupted storage', () => {
    window.localStorage.setItem('shusheng.listening.v1', '{oops')
    const snapshot = getListeningSnapshot(at(1))
    expect(snapshot.totalMs).toBe(0)
    expect(snapshot.streakDays).toBe(0)
    expect(snapshot.lastBook).toBeNull()
  })
})

describe('dayKey', () => {
  it('uses the local calendar day', () => {
    expect(dayKey(at(1, 0, 5))).toBe('2026-11-01')
    expect(dayKey(at(1, 23, 55))).toBe('2026-11-01')
  })
})

describe('formatListenDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatListenDuration(0)).toBe('0 分钟')
    expect(formatListenDuration(30_000)).toBe('不到 1 分钟')
    expect(formatListenDuration(MINUTE)).toBe('1 分钟')
    expect(formatListenDuration(59 * MINUTE + 59_000)).toBe('1 小时')
    expect(formatListenDuration(3_660_000)).toBe('1 小时 1 分钟')
    expect(formatListenDuration(3_660_000, true)).toBe('1 小时 1 分')
    expect(formatListenDuration(12 * 3_600_000 + 36 * MINUTE)).toBe(
      '12 小时 36 分钟',
    )
  })
})

describe('splitListenDuration', () => {
  it('switches the headline unit at one hour', () => {
    expect(splitListenDuration(30_000)).toEqual({ value: '1', unit: '分钟' })
    expect(splitListenDuration(45 * MINUTE)).toEqual({
      value: '45',
      unit: '分钟',
    })
    expect(splitListenDuration(90 * MINUTE)).toEqual({
      value: '1',
      unit: '小时',
    })
    expect(splitListenDuration(128 * 3_600_000)).toEqual({
      value: '128',
      unit: '小时',
    })
  })
})
