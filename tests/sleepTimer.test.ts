import { describe, expect, it } from 'vitest'
import {
  formatClock,
  formatRemaining,
  formatRemainingShort,
  formatTargetDay,
  nextTimeOccurrence,
} from '../src/ui/sleepTimer'

const NOW = new Date(2026, 9, 27, 21, 15, 30).getTime()

describe('nextTimeOccurrence', () => {
  it('returns today when the time is still ahead', () => {
    expect(nextTimeOccurrence(23, 30, NOW)).toBe(
      new Date(2026, 9, 27, 23, 30).getTime(),
    )
  })

  it('rolls to tomorrow when the time has already passed', () => {
    expect(nextTimeOccurrence(20, 0, NOW)).toBe(
      new Date(2026, 9, 28, 20, 0).getTime(),
    )
  })

  it('rolls to tomorrow when the time equals now', () => {
    expect(nextTimeOccurrence(21, 15, NOW)).toBe(
      new Date(2026, 9, 28, 21, 15).getTime(),
    )
  })

  it('handles a month boundary', () => {
    const lateNight = new Date(2026, 9, 31, 23, 50).getTime()
    expect(nextTimeOccurrence(0, 30, lateNight)).toBe(
      new Date(2026, 10, 1, 0, 30).getTime(),
    )
  })
})

describe('formatClock', () => {
  it('pads hours and minutes', () => {
    expect(formatClock(new Date(2026, 9, 27, 7, 5).getTime())).toBe('07:05')
    expect(formatClock(new Date(2026, 9, 27, 23, 30).getTime())).toBe('23:30')
  })
})

describe('formatTargetDay', () => {
  it('labels the same day as today', () => {
    const target = new Date(2026, 9, 27, 23, 30).getTime()
    expect(formatTargetDay(target, NOW)).toBe('今天 23:30')
  })

  it('labels the next day as tomorrow', () => {
    const target = new Date(2026, 9, 28, 7, 0).getTime()
    expect(formatTargetDay(target, NOW)).toBe('明天 07:00')
  })
})

describe('formatRemaining', () => {
  it('shows seconds under a minute', () => {
    expect(formatRemaining(45_000)).toBe('45 秒')
  })

  it('shows minutes under an hour', () => {
    expect(formatRemaining(20 * 60_000)).toBe('20 分钟')
    expect(formatRemaining(59_500)).toBe('1 分钟')
  })

  it('shows hours and minutes', () => {
    expect(formatRemaining(90 * 60_000)).toBe('1 小时 30 分钟')
    expect(formatRemaining(2 * 3_600_000)).toBe('2 小时')
  })

  it('handles an expired timer', () => {
    expect(formatRemaining(0)).toBe('0 秒')
  })
})

describe('formatRemainingShort', () => {
  it('keeps a minimum of one minute', () => {
    expect(formatRemainingShort(30_000)).toBe('1 分')
  })

  it('shows compact hours and minutes', () => {
    expect(formatRemainingShort(20 * 60_000)).toBe('20 分')
    expect(formatRemainingShort(65 * 60_000)).toBe('1 时 5 分')
    expect(formatRemainingShort(120 * 60_000)).toBe('2 时')
  })
})
