import { describe, expect, it } from 'vitest'
import {
  buildSpeechUnits,
  groupCharsForRtf,
  joinSentenceText,
  sentenceTerminal,
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

describe('groupCharsForRtf', () => {
  it('keeps the measured default on desktop and before the first sample', () => {
    expect(groupCharsForRtf(null)).toBe(90)
    expect(groupCharsForRtf(undefined)).toBe(90)
    expect(groupCharsForRtf(0.31)).toBe(90)
    expect(groupCharsForRtf(Number.NaN)).toBe(90)
  })

  it('shortens groups once synthesis approaches playback speed', () => {
    expect(groupCharsForRtf(0.9)).toBe(60)
    expect(groupCharsForRtf(1.4)).toBe(60)
  })
})

describe('buildSpeechUnits', () => {
  it('caps the default group at 90 characters per the A/B baseline', () => {
    const chunk = '山'.repeat(40) + '。'
    const units = buildSpeechUnits([
      sentence(chunk),
      sentence(chunk),
      sentence(chunk),
    ])
    // 40 + 40 <= 90, but a third sentence would reach 120.
    expect(units.map((unit) => [unit.start, unit.end])).toEqual([
      [0, 1],
      [2, 2],
    ])
  })

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

  it('ends a group at a question/exclamation so the final contour survives', () => {
    const units = buildSpeechUnits(
      [
        sentence('他为什么要走？'),
        sentence('没有人知道。'),
        sentence('真的吗！'),
        sentence('是的。'),
      ],
      { maxChars: 120 },
    )
    expect(units.map((unit) => [unit.start, unit.end])).toEqual([
      [0, 0],
      [1, 2],
      [3, 3],
    ])
    expect(units[0]!.terminal).toBe('question')
    expect(units[1]!.terminal).toBe('exclamation')
    expect(units[2]!.terminal).toBe('statement')
  })

  it('keeps question/exclamation dialogue separate even when both are dialogue', () => {
    const units = buildSpeechUnits(
      [
        sentence('“别动！”', false, true),
        sentence('“为什么？”', false, true),
      ],
      { maxChars: 120 },
    )
    expect(units.map((unit) => [unit.start, unit.end])).toEqual([
      [0, 0],
      [1, 1],
    ])
    expect(units.every((unit) => unit.dialogue)).toBe(true)
  })

  it('can disable terminal breaks for diagnostics', () => {
    const units = buildSpeechUnits(
      [sentence('第一句？'), sentence('第二句。')],
      { maxChars: 120, breakOnTerminal: false },
    )
    expect(units).toHaveLength(1)
  })

  it('classifies question/exclamation/ellipsis through closing quotes', () => {
    expect(sentenceTerminal('“你确定吗？”')).toBe('question')
    expect(sentenceTerminal('“别动！”')).toBe('exclamation')
    expect(sentenceTerminal('她犹豫了一下……')).toBe('ellipsis')
    expect(sentenceTerminal('他走了。')).toBe('statement')
    expect(sentenceTerminal('没有标点')).toBe(null)
  })

  it('returns no units for an empty chapter', () => {
    expect(buildSpeechUnits([])).toEqual([])
  })
})
