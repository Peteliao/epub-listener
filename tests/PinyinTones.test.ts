import { describe, expect, it } from 'vitest'
import {
  normalizeOverlayText,
  normalizePinyinReading,
} from '../src/core/tts/pinyinTones'

describe('normalizePinyinReading', () => {
  it('converts tone marks to the numeric tones used by the lexicons', () => {
    expect(normalizePinyinReading('zhuó zhòng')).toBe('zhuo2 zhong4')
    expect(normalizePinyinReading('zháo')).toBe('zhao2')
    expect(normalizePinyinReading('zhāo')).toBe('zhao1')
    expect(normalizePinyinReading('zhe')).toBe('zhe')
    expect(normalizePinyinReading('shuì zháo')).toBe('shui4 zhao2')
  })

  it('normalizes ü and already numeric readings', () => {
    expect(normalizePinyinReading('lǜ')).toBe('lv4')
    expect(normalizePinyinReading('nǚ')).toBe('nv3')
    expect(normalizePinyinReading('lve4')).toBe('lve4')
    expect(normalizePinyinReading('zhe5')).toBe('zhe')
    expect(normalizePinyinReading('zhe0')).toBe('zhe')
  })

  it('handles decomposed tone marks', () => {
    expect(normalizePinyinReading('zhuo\u0301')).toBe('zhuo2')
  })
})

describe('normalizeOverlayText', () => {
  it('rewrites readings and keeps comments and layout', () => {
    const source = [
      '# 多音字',
      '着重 zhuó zhòng',
      '',
      '看着 zhe',
      '险着 zhāo',
    ].join('\n')
    expect(normalizeOverlayText(source)).toBe(
      ['# 多音字', '着重 zhuo2 zhong4', '', '看着 zhe', '险着 zhao1'].join(
        '\n',
      ),
    )
  })

  it('leaves English-style lexicon lines alone', () => {
    expect(normalizeOverlayText('a || ə')).toBe('a || ə')
  })
})
