import { describe, expect, it } from 'vitest'
import { shouldSkipEnglishChunk } from '../src/core/text/englishSkip'

const english = { engine: 'system', lang: 'en' } as const
const chineseAi = { engine: 'ai', lang: 'zh' } as const

const base = {
  enabled: true,
  aiMode: true,
  hidden: true,
  ios: true,
}

describe('shouldSkipEnglishChunk', () => {
  it('skips English system chunks while iOS is locked', () => {
    expect(shouldSkipEnglishChunk(english, base)).toBe(true)
  })

  it('keeps Chinese AI chunks', () => {
    expect(shouldSkipEnglishChunk(chineseAi, base)).toBe(false)
  })

  it('keeps English when the setting is off', () => {
    expect(shouldSkipEnglishChunk(english, { ...base, enabled: false })).toBe(
      false,
    )
  })

  it('keeps English outside AI mode', () => {
    expect(shouldSkipEnglishChunk(english, { ...base, aiMode: false })).toBe(
      false,
    )
  })

  it('keeps English while the page is visible', () => {
    expect(shouldSkipEnglishChunk(english, { ...base, hidden: false })).toBe(
      false,
    )
  })

  it('keeps English on other platforms', () => {
    expect(shouldSkipEnglishChunk(english, { ...base, ios: false })).toBe(false)
  })
})
