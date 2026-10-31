import { describe, expect, it } from 'vitest'
import { splitSentences } from '../src/core/text/SentenceSplitter'

const texts = (input: string, options = {}) =>
  splitSentences(input, { mergeShort: false, ...options }).map((sentence) => sentence.text)

describe('splitSentences', () => {
  it('splits on Chinese terminal punctuation', () => {
    expect(texts('第一句话。第二句话！第三句话？')).toEqual([
      '第一句话。',
      '第二句话！',
      '第三句话？',
    ])
  })

  it('keeps closing quotes with the sentence they finish', () => {
    expect(texts('他说：“好。”然后转过身，慢慢走远了。')).toEqual([
      '他说：',
      '“好。”',
      '然后转过身，慢慢走远了。',
    ])
  })

  it('sets quoted dialogue apart from its attribution', () => {
    expect(texts('他放下杯子，压低声音说：“别回头，后面有人。”')).toEqual([
      '他放下杯子，压低声音说：',
      '“别回头，后面有人。”',
    ])
    expect(texts('“你来了。”她低声说。')).toEqual(['“你来了。”', '她低声说。'])
    expect(texts('“别动！”他喊道。')).toEqual(['“别动！”', '他喊道。'])
    expect(texts('“你确定吗？”她停下来，问身后的邮递员。')).toEqual([
      '“你确定吗？”',
      '她停下来，问身后的邮递员。',
    ])
    expect(texts('“她走了。”许知遥没有回答。')).toEqual([
      '“她走了。”',
      '许知遥没有回答。',
    ])
    expect(texts('他低声说“好”，然后挂了电话。')).toEqual([
      '他低声说',
      '“好”，',
      '然后挂了电话。',
    ])
  })

  it('does not treat quoted emphasis as dialogue', () => {
    expect(texts('所谓“理性”不过是一种说法。')).toEqual([
      '所谓“理性”不过是一种说法。',
    ])
    expect(texts('“一带一路”倡议已经提出多年。')).toEqual([
      '“一带一路”倡议已经提出多年。',
    ])
  })

  it('marks dialogue ranges and groups them separately', () => {
    const result = splitSentences('“你来了。”她低声说。', { mergeShort: false })
    expect(result.map((sentence) => [sentence.text, sentence.dialogue])).toEqual([
      ['“你来了。”', true],
      ['她低声说。', false],
    ])
  })

  it('treats an ellipsis run as one boundary', () => {
    expect(texts('她犹豫了一下……最后还是点了点头。')).toEqual([
      '她犹豫了一下……',
      '最后还是点了点头。',
    ])
    expect(texts('等等......我想想。')).toEqual(['等等......', '我想想。'])
  })

  it('does not split decimals or dots inside tokens', () => {
    expect(texts('圆周率约等于3.14，这个数字很常用。')).toEqual([
      '圆周率约等于3.14，这个数字很常用。',
    ])
    expect(texts('访问 example.com 可以了解详情。')).toEqual(['访问 example.com 可以了解详情。'])
  })

  it('splits at ASCII sentence periods', () => {
    expect(texts('He stopped. Then he left.')).toEqual(['He stopped.', 'Then he left.'])
  })

  it('treats paragraphs as hard boundaries', () => {
    expect(splitSentences('第一段没有句号\n第二段也没有句号').map((s) => s.text)).toEqual([
      '第一段没有句号',
      '第二段也没有句号',
    ])
  })

  it('merges short fragments within the same paragraph', () => {
    expect(splitSentences('好。他说道。').map((s) => s.text)).toEqual(['好。他说道。'])
    expect(
      splitSentences('嗯。后面这句话比较长，于是被并成了一段完整的话。').map((s) => s.text),
    ).toEqual(['嗯。后面这句话比较长，于是被并成了一段完整的话。'])
  })

  it('does not merge short fragments across paragraphs', () => {
    expect(splitSentences('嗯。\n好吧。').map((s) => s.text)).toEqual(['嗯。', '好吧。'])
  })

  it('splits overlong text at secondary punctuation', () => {
    const input = `${'甲'.repeat(60)}，${'乙'.repeat(60)}。`
    const result = splitSentences(input, { maxLength: 80 })
    expect(result).toHaveLength(2)
    expect(result[0]!.text.endsWith('，')).toBe(true)
    expect(result.every((sentence) => sentence.text.length <= 80)).toBe(true)
    expect(result.map((sentence) => sentence.text).join('')).toBe(input)
  })

  it('falls back to a dash boundary for an overlong clause', () => {
    const input = `${'甲'.repeat(60)}——${'乙'.repeat(60)}。`
    const result = splitSentences(input, { maxLength: 80, mergeShort: false })
    expect(result).toHaveLength(2)
    expect(result[0]!.text.endsWith('——')).toBe(true)
    expect(result.every((sentence) => sentence.text.length <= 80)).toBe(true)
    expect(result.map((sentence) => sentence.text).join('')).toBe(input)
  })

  it('does not cut a number away from the Han text after it', () => {
    const input = `${'甲'.repeat(8)}200 年的核子冬天。`
    const result = splitSentences(input, { maxLength: 12, mergeShort: false })
    expect(result.map((sentence) => sentence.text)).toEqual([
      '甲'.repeat(8),
      '200 年的核子冬天。',
    ])
  })

  it('hard-splits text without any punctuation', () => {
    const input = '甲'.repeat(200)
    const result = splitSentences(input)
    expect(result.length).toBeGreaterThan(1)
    expect(result.every((sentence) => sentence.text.length <= 80)).toBe(true)
    expect(result.map((sentence) => sentence.text).join('')).toBe(input)
  })

  it('marks the last sentence of each paragraph', () => {
    const result = splitSentences('第一句话。第二句话！\n第三句话？', {
      mergeShort: false,
    })
    expect(result.map((sentence) => [sentence.text, sentence.paragraphEnd])).toEqual([
      ['第一句话。', false],
      ['第二句话！', true],
      ['第三句话？', true],
    ])
  })

  it('marks only the final piece of an overlong sentence as a paragraph end', () => {
    const input = `${'甲'.repeat(60)}，${'乙'.repeat(60)}。`
    const result = splitSentences(input, { maxLength: 80 })
    expect(result.map((sentence) => sentence.paragraphEnd)).toEqual([false, true])
  })

  it('keeps offsets addressable in the source string', () => {
    const input = '  第一句。 第二句！\n\n第三句。  '
    for (const sentence of splitSentences(input, { mergeShort: false })) {
      expect(input.slice(sentence.start, sentence.end)).toBe(sentence.text)
      expect(sentence.text).toBe(sentence.text.trim())
    }
  })

  it('drops punctuation-only fragments', () => {
    expect(splitSentences('……\n！\n。')).toEqual([])
  })
})
