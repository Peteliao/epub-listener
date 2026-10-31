import { describe, expect, it } from 'vitest'
import {
  buildSpeechUnits,
  joinSentenceText,
} from '../src/core/text/speechGroups'

function sentence(text: string, paragraphEnd = false, dialogue = false) {
  return { text, speechText: text, paragraphEnd, dialogue }
}

describe('joinSentenceText', () => {
  it('lets Chinese punctuation carry the boundary', () => {
    expect(joinSentenceText(['他走了。', '她也走了。'])).toBe('他走了。她也走了。')
  })

  it('keeps a space between English sentences and after mixed text', () => {
    expect(joinSentenceText(['Hello.', 'World.'])).toBe('Hello. World.')
    expect(joinSentenceText(['看起来不错', 'OK.'])).toBe('看起来不错OK.')
    expect(joinSentenceText(['ABC', 'def'])).toBe('ABC def')
  })
})

describe('buildSpeechUnits', () => {
  it('groups two or three neighbouring sentences from one paragraph', () => {
    const units = buildSpeechUnits(
      [
        sentence('第一句足够长一些。'),
        sentence('第二句足够长一些。'),
        sentence('第三句足够长一些。', true),
      ],
      { maxChars: 40 },
    )

    expect(units).toHaveLength(1)
    expect(units[0]).toMatchObject({ start: 0, end: 2, paragraphEnd: true })
    expect(units[0]!.speechText).toBe(
      '第一句足够长一些。第二句足够长一些。第三句足够长一些。',
    )
  })

  it('never crosses a paragraph boundary', () => {
    const units = buildSpeechUnits(
      [
        sentence('第一段第一句足够长。', true),
        sentence('第二段第一句足够长。'),
        sentence('第二段第二句足够长。'),
      ],
      { maxChars: 120 },
    )

    expect(units.map((unit) => [unit.start, unit.end])).toEqual([
      [0, 0],
      [1, 2],
    ])
  })

  it('caps a group at three sentences', () => {
    const units = buildSpeechUnits(
      [
        sentence('一。'),
        sentence('二。'),
        sentence('三。'),
        sentence('四。'),
      ],
      { maxChars: 120 },
    )

    expect(units.map((unit) => [unit.start, unit.end])).toEqual([
      [0, 2],
      [3, 3],
    ])
  })

  it('keeps long sentences separate', () => {
    const long = '很'.repeat(61) + '。'
    const units = buildSpeechUnits(
      [sentence(long), sentence(long)],
      { maxChars: 120 },
    )

    expect(units.map((unit) => [unit.start, unit.end])).toEqual([
      [0, 0],
      [1, 1],
    ])
  })

  it('does not group dialogue with narration', () => {
    const units = buildSpeechUnits(
      [
        sentence('他放下杯子说：', false, false),
        sentence('“别回头。”', false, true),
        sentence('“后面有人。”', true, true),
      ],
      { maxChars: 120 },
    )

    expect(units.map((unit) => [unit.start, unit.end])).toEqual([
      [0, 0],
      [1, 2],
    ])
  })

  it('returns one unit per sentence when grouping is disabled', () => {
    const units = buildSpeechUnits(
      [sentence('第一句。'), sentence('第二句。')],
      { enabled: false },
    )

    expect(units.map((unit) => [unit.start, unit.end])).toEqual([
      [0, 0],
      [1, 1],
    ])
  })

  it('returns no units for an empty chapter', () => {
    expect(buildSpeechUnits([])).toEqual([])
  })
})
