import { describe, expect, it } from 'vitest'
import { stripToneMarkedPinyin } from '../src/core/text/pinyinSpeech'

function collapse(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

describe('stripToneMarkedPinyin', () => {
  it('removes pinyin runs and keeps surrounding English', () => {
    expect(collapse(stripToneMarkedPinyin('Read kàn zhe now.'))).toBe(
      'Read now.',
    )
    expect(collapse(stripToneMarkedPinyin('zhuó hello zhòng'))).toBe('hello')
  })

  it('removes neutral-tone syllables inside a pinyin run', () => {
    expect(collapse(stripToneMarkedPinyin('nǐ hǎo ma'))).toBe('')
    expect(collapse(stripToneMarkedPinyin('kàn zhe'))).toBe('')
    expect(collapse(stripToneMarkedPinyin('xué sheng'))).toBe('')
  })

  it('handles ü, joined syllables, apostrophes and punctuation gaps', () => {
    expect(collapse(stripToneMarkedPinyin('lǜ sè'))).toBe('')
    expect(collapse(stripToneMarkedPinyin('Zhōngguó'))).toBe('')
    expect(collapse(stripToneMarkedPinyin("xī'ān"))).toBe('')
    expect(stripToneMarkedPinyin('zhuó, zhòng')).not.toMatch(/zhuó|zhòng/)
  })

  it('normalizes decomposed tone marks', () => {
    expect(collapse(stripToneMarkedPinyin('zhuo\u0301 zho\u0300ng'))).toBe('')
  })

  it('de-accents English loanwords instead of removing them', () => {
    expect(stripToneMarkedPinyin('A café résumé')).toBe('A cafe resume')
    expect(stripToneMarkedPinyin('naïve déjà vu')).toBe('naive deja vu')
    expect(stripToneMarkedPinyin("Müller's façade")).toBe("Muller's facade")
  })

  it('leaves unmarked English alone', () => {
    expect(stripToneMarkedPinyin('he is a man')).toBe('he is a man')
    expect(stripToneMarkedPinyin('elite resume')).toBe('elite resume')
  })
})
