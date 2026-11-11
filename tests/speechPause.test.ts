import { describe, expect, it } from 'vitest'
import {
  ensureSpeechEnd,
  lastSpeechChar,
  sentenceGapMs,
} from '../src/core/text/speechPause'

describe('lastSpeechChar', () => {
  it('skips closing quotes and brackets', () => {
    expect(lastSpeechChar('他说：“好。”')).toBe('。')
    expect(lastSpeechChar('（完。）')).toBe('。')
    expect(lastSpeechChar('"Done."')).toBe('.')
    expect(lastSpeechChar('   ')).toBe('')
  })
})

describe('ensureSpeechEnd', () => {
  it('closes utterances that have no punctuation', () => {
    expect(ensureSpeechEnd('第八章 槐树巷', true)).toBe('第八章 槐树巷。')
    expect(ensureSpeechEnd('他说', false)).toBe('他说，')
  })

  it('keeps existing terminal and clause punctuation', () => {
    expect(ensureSpeechEnd('他走了。', true)).toBe('他走了。')
    expect(ensureSpeechEnd('Really?!', false)).toBe('Really?!')
    expect(ensureSpeechEnd('他走了，', false)).toBe('他走了，')
  })

  it('appends after closing quotes but skips punctuation inside them', () => {
    expect(ensureSpeechEnd('他说“好”', true)).toBe('他说“好”。')
    expect(ensureSpeechEnd('他说“好。”', true)).toBe('他说“好。”')
  })

  it('trims trailing whitespace and ignores empty text', () => {
    expect(ensureSpeechEnd('第八章 槐树巷  ', true)).toBe('第八章 槐树巷。')
    expect(ensureSpeechEnd('   ', true)).toBe('')
    expect(ensureSpeechEnd('', false)).toBe('')
  })

  it('closes English utterances with ASCII punctuation', () => {
    expect(ensureSpeechEnd('The End', true, 'en')).toBe('The End.')
    expect(ensureSpeechEnd('and then', false, 'en')).toBe('and then,')
    expect(ensureSpeechEnd('Really?!', false, 'en')).toBe('Really?!')
  })
})

describe('sentenceGapMs', () => {
  it('uses a longer pause after terminal punctuation', () => {
    expect(sentenceGapMs('他走了。')).toBe(210)
    expect(sentenceGapMs('他走了！”')).toBe(210)
    expect(sentenceGapMs('Really?!')).toBe(210)
  })

  it('uses a shorter pause after clause punctuation', () => {
    expect(sentenceGapMs('他走了，')).toBe(120)
    expect(sentenceGapMs('他走了；')).toBe(120)
    expect(sentenceGapMs('他停了一下——')).toBe(120)
    expect(ensureSpeechEnd('他停了一下——', true)).toBe('他停了一下——')
  })

  it('uses a mid pause for hard-split sentences', () => {
    expect(sentenceGapMs('他说完这句话就')).toBe(170)
  })

  it('adds extra air at paragraph ends', () => {
    expect(sentenceGapMs('他走了。', { paragraphEnd: true })).toBe(490)
    expect(sentenceGapMs('他走了，', { paragraphEnd: true })).toBe(400)
  })

  it('shrinks the pause as playback speeds up', () => {
    expect(sentenceGapMs('他走了。', { rate: 2 })).toBe(148)
    expect(sentenceGapMs('他走了。', { rate: 1.5 })).toBe(171)
    expect(sentenceGapMs('他走了。', { rate: 0.5 })).toBe(297)
  })

  it('ignores out-of-range rates instead of dividing by zero', () => {
    expect(sentenceGapMs('他走了。', { rate: 2.4 })).toBe(148)
    expect(sentenceGapMs('他走了。', { rate: 0 })).toBe(297)
  })

  it('uses short group gaps because punctuation already provided the pause', () => {
    expect(sentenceGapMs('他走了。她也走了。', { grouped: true })).toBe(110)
    expect(
      sentenceGapMs('他走了。她也走了。', { grouped: true, paragraphEnd: true }),
    ).toBe(320)
  })

  it('applies the pause preset on top of the group gap', () => {
    expect(sentenceGapMs('他走了。', { grouped: true, scale: 0.8 })).toBe(88)
    expect(sentenceGapMs('他走了。', { grouped: true, scale: 1.25 })).toBe(138)
    expect(
      sentenceGapMs('他走了。', { grouped: true, paragraphEnd: true, scale: 1.25 }),
    ).toBe(400)
    expect(sentenceGapMs('他走了。', { scale: 1.25 })).toBe(263)
  })
})
