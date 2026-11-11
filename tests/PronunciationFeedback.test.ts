import { describe, expect, it } from 'vitest'
import { buildFeedbackParagraphs } from '@/core/feedback/paragraphs'
import {
  getReadingContext,
  normalizeCustomReading,
  textUnits,
} from '@/core/feedback/pinyin'
import { computeBookFingerprint } from '@/core/feedback/fingerprint'

const SENTENCES = [
  { text: '第一段第一句。', speechText: '第一段第一句。', paragraphEnd: false },
  { text: '第一段第二句。', speechText: '第一段第二句。', paragraphEnd: true },
  { text: '第二段。', speechText: '第二段。', paragraphEnd: true },
  { text: '第三段。', speechText: '第三段。', paragraphEnd: true },
  { text: '第四段。', speechText: '第四段。', paragraphEnd: true },
]

describe('feedback paragraphs', () => {
  it('groups sentences into paragraphs and keeps a window around the reader', () => {
    const paragraphs = buildFeedbackParagraphs(SENTENCES, 4, 'chapter-3.xhtml')
    expect(paragraphs.map((item) => item.text)).toEqual([
      '第二段。',
      '第三段。',
      '第四段。',
    ])
    expect(paragraphs.map((item) => item.id)).toEqual([
      'chapter-3.xhtml#p2',
      'chapter-3.xhtml#p3',
      'chapter-3.xhtml#p4',
    ])
    expect(paragraphs.map((item) => item.isCurrent)).toEqual([false, false, true])
  })

  it('keeps multi-sentence paragraphs in one selectable block', () => {
    const paragraphs = buildFeedbackParagraphs(SENTENCES, 0, 'c1')
    expect(paragraphs[0]?.text).toBe('第一段第一句。第一段第二句。')
    expect(paragraphs[0]?.startSentenceIndex).toBe(0)
    expect(paragraphs[0]?.endSentenceIndex).toBe(1)
  })
})

describe('reading candidates', () => {
  it('offers the contextual reading first and alternatives after it', async () => {
    const text = '他去还书。'
    const context = await getReadingContext(text, 2)
    expect(context?.char).toBe('还')
    expect(context?.word).toBe('还书')
    expect(context?.candidates[0]?.contextual).toBe(true)
    expect(context?.candidates.map((item) => item.value)).toContain('huan2')
    expect(context?.candidates.map((item) => item.value)).toContain('hai2')
  })

  it('expands single-character contexts into a nearby phrase', async () => {
    const text = '他声音沙哑干涩。'
    const context = await getReadingContext(text, 5)
    expect(context?.char).toBe('干')
    expect(context?.word).toBe('沙哑干涩')
    expect(context?.wordStart).toBe(3)
    expect(context?.wordEnd).toBe(7)
    expect(context?.candidates[0]).toMatchObject({
      value: 'gan1',
      contextual: true,
    })
  })

  it('maps UTF-16 offsets back to the displayed characters', () => {
    const units = textUnits('还书')
    expect(units).toEqual([
      { char: '还', start: 0, end: 1 },
      { char: '书', start: 1, end: 2 },
    ])
  })

  it('normalizes custom tone-mark and numeric readings', async () => {
    await expect(normalizeCustomReading('huán')).resolves.toEqual({
      value: 'huan2',
      label: 'huán',
    })
    await expect(normalizeCustomReading('huan2')).resolves.toEqual({
      value: 'huan2',
      label: 'huán',
    })
    await expect(normalizeCustomReading('lüè')).resolves.toEqual({
      value: 'lve4',
      label: 'lüè',
    })
    await expect(normalizeCustomReading('huan 2')).resolves.toBeNull()
    await expect(normalizeCustomReading('abc!')).resolves.toBeNull()
  })
})

describe('book fingerprint', () => {
  it('is stable for the same file and differs between files', async () => {
    const first = new TextEncoder().encode('sample epub payload').buffer
    const second = new TextEncoder().encode('another epub payload').buffer
    const a = await computeBookFingerprint(first, 'epub')
    const b = await computeBookFingerprint(first, 'epub')
    const c = await computeBookFingerprint(second, 'epub')
    expect(a).not.toBeNull()
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})
