import { describe, expect, it } from 'vitest'
import { estimateRemainingMs } from '../src/core/player/listenTime'
import type { SpeechUnit } from '../src/core/text/speechGroups'

function unit(
  speechText: string,
  paragraphEnd = false,
): SpeechUnit {
  return { start: 0, end: 0, text: speechText, speechText, paragraphEnd }
}

const options = {
  rate: 1,
  englishRate: 1,
  zhMsPerChar: 200,
  enMsPerChar: 50,
  unitGapMs: 0,
  paragraphGapMs: 0,
}

describe('estimateRemainingMs', () => {
  it('scales Chinese audio by the calibrated milliseconds per character', () => {
    expect(estimateRemainingMs([unit('一二三四五。')], 0, options)).toBe(1000)
  })

  it('counts English runs at the English rate', () => {
    expect(estimateRemainingMs([unit('Hi there.')], 0, options)).toBe(350)
    expect(
      estimateRemainingMs([unit('Hi there.')], 0, { ...options, englishRate: 1.4 }),
    ).toBe(250)
  })

  it('skips already played units', () => {
    const units = [unit('一二三四五。'), unit('六七八九十。')]
    expect(estimateRemainingMs(units, 1, options)).toBe(1000)
    expect(estimateRemainingMs(units, 2, options)).toBe(1000)
  })

  it('speeds the estimate up with the playback rate', () => {
    expect(estimateRemainingMs([unit('一二三四五。')], 0, { ...options, rate: 2 })).toBe(
      500,
    )
  })

  it('adds inter-unit and paragraph gaps', () => {
    const units = [unit('一。', false), unit('二。', true)]
    expect(
      estimateRemainingMs(units, 0, {
        ...options,
        unitGapMs: 100,
        paragraphGapMs: 200,
      }),
    ).toBe(800)
  })

  it('returns 0 for an empty chapter', () => {
    expect(estimateRemainingMs([], 0, options)).toBe(0)
  })
})
