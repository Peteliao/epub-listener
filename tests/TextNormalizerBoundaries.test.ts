import { describe, expect, it } from 'vitest'
import { normalizeSpeechText } from '../src/core/text/TextNormalizer'

/**
 * Boundary corpus for the rule-chain text front end.
 *
 * The second group deliberately pins behaviour that is NOT yet correct. It is
 * a snapshot: fixing any of these rules will fail this test, which is the
 * reminder to review the whole chain (rules run in a fixed order) and update
 * the expectation together with pronunciation-golden.jsonl.
 */
describe('normalizeSpeechText', () => {
  it('folds full-width digits and Roman numerals before the number rules', () => {
    expect(normalizeSpeechText('价格１２５元。')).toBe('价格125元。')
    expect(normalizeSpeechText('第Ⅳ章 停摆的齿轮')).toBe('第4章停摆的齿轮')
    expect(normalizeSpeechText('Ⅳ 与 ⅻ')).toBe('4与12')
    // Full-width digits must reach the date rule, not stop at the front end.
    expect(normalizeSpeechText('２０２６年１０月')).toBe('二零二六年十月')
  })

  it('pins the known uncovered patterns (fix these together, not one by one)', () => {
    // Ratios / 24-hour clock times are not rewritten.
    expect(normalizeSpeechText('比分 3:2，时间是 24:00')).toBe(
      '比分3:2，时间是24:00',
    )
    // Phone numbers with internal spaces and international prefixes.
    expect(normalizeSpeechText('电话 138 0013 8000')).toBe(
      '电话138 0013 8000',
    )
    expect(normalizeSpeechText('＋86 与 5G')).toBe('＋86与5G')
    // Dotted version numbers stay literal; mixed fractions are only partly
    // rewritten by the fraction rule.
    expect(normalizeSpeechText('版本 v1.2.3')).toBe('版本 v1.2.3')
    // Date validation only checks 1..31, so an impossible day survives.
    expect(normalizeSpeechText('2026-02-31 的日期')).toBe(
      '二零二六年二月三十一日的日期',
    )
  })

  it('pins the line-level CJK context leak (needs segment-level context)', () => {
    // One Han character anywhere on the line makes expandSymbols rewrite the
    // English "50% off" too. Fixing this requires splitting expandSymbols by
    // local context rather than flipping one regex.
    expect(normalizeSpeechText('50% off 和 50% 的中文行')).toBe(
      '百分之50 off 和百分之50的中文行',
    )
  })
})
