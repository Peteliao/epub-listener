import { describe, expect, it } from 'vitest'
import { splitLanguageSegments } from '../src/core/text/LanguageSegments'

describe('splitLanguageSegments', () => {
  it('separates Chinese runs from embedded English words', () => {
    expect(splitLanguageSegments('他打开 MacBook 开始写代码。')).toEqual([
      { text: '他打开', lang: 'zh' },
      { text: 'MacBook', lang: 'en' },
      { text: '开始写代码。', lang: 'zh' },
    ])
  })

  it('keeps a whole English sentence as one segment', () => {
    expect(splitLanguageSegments('It took about 3.5 hours to finish.')).toEqual([
      { text: 'It took about 3.5 hours to finish.', lang: 'en' },
    ])
  })

  it('keeps Chinese punctuation with Chinese text only', () => {
    expect(splitLanguageSegments('他说：“好。”')).toEqual([
      { text: '他说：“好。”', lang: 'zh' },
    ])
  })

  it('absorbs punctuation that falls between two English words', () => {
    expect(splitLanguageSegments('Hello，world！')).toEqual([
      { text: 'Hello，world！', lang: 'en' },
    ])
  })

  it('keeps numbers with the surrounding Chinese context', () => {
    expect(splitLanguageSegments('第 3 章介绍了 2026 年的计划。')).toEqual([
      { text: '第 3 章介绍了 2026 年的计划。', lang: 'zh' },
    ])
  })

  it('attaches numbers at the start to the language that follows', () => {
    expect(splitLanguageSegments('2026 was a good year.')).toEqual([
      { text: '2026 was a good year.', lang: 'en' },
    ])
    expect(splitLanguageSegments('2026年我们去了北京。')).toEqual([
      { text: '2026年我们去了北京。', lang: 'zh' },
    ])
  })

  it('attaches trailing English quotes to the English run', () => {
    expect(splitLanguageSegments('他说：“Hello”')).toEqual([
      { text: '他说：“', lang: 'zh' },
      { text: 'Hello”', lang: 'en' },
    ])
  })

  it('returns nothing for text without letters or digits', () => {
    expect(splitLanguageSegments('……')).toEqual([])
    expect(splitLanguageSegments('')).toEqual([])
  })

  it('keeps a digit run with the English term that follows it', () => {
    expect(splitLanguageSegments('用了5G就开始卡。')).toEqual([
      { text: '用了', lang: 'zh' },
      { text: '5G', lang: 'en' },
      { text: '就开始卡。', lang: 'zh' },
    ])
  })

  it('never drops speakable text that has no Han or ASCII Latin letters', () => {
    expect(splitLanguageSegments('Ａｐｐ')).toEqual([
      { text: 'Ａｐｐ', lang: 'en' },
    ])
    expect(splitLanguageSegments('2026')).toEqual([
      { text: '2026', lang: 'zh' },
    ])
    expect(splitLanguageSegments('Ⅳ')).toEqual([{ text: 'Ⅳ', lang: 'zh' }])
  })
})
