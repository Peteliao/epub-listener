import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROTECTED_WORDS,
  WORD_BOUNDARY,
  protectPronunciations,
} from '../src/core/tts/pronunciationGuard'

const root = process.cwd()
const manifest = JSON.parse(
  readFileSync(resolve(root, 'public/models/manifest.json'), 'utf8'),
) as {
  packs: Array<{
    id: string
    files: Array<{ name: string; url: string }>
    model: { config: Record<string, string> }
  }>
}
const pack = manifest.packs.find((item) => item.id === 'matcha-icefall-zh-baker')!
const lexiconFile = pack.files.find((f) => f.name === pack.model.config.lexicon)!
const overlayFile = resolve(root, 'src/core/tts/polyphones.v1.txt')

function entriesFrom(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [word, ...phones] = trimmed.split(/\s+/)
    if (word && phones.length) entries.set(word, phones.join(' '))
  }
  return entries
}

const effective = entriesFrom(readFileSync(resolve(root, 'public', lexiconFile.url), 'utf8'))
for (const [word, reading] of entriesFrom(readFileSync(overlayFile, 'utf8'))) {
  effective.set(word, reading)
}
const maxLength = Math.max(
  ...Array.from(effective.keys(), (word) => Array.from(word).length),
)

interface Span { word: string; start: number; end: number }

/** Mirrors sherpa's longest-match front end; U+200B is an OOV char it skips. */
function tokenize(text: string, entries: Map<string, string>): Span[] {
  const chars = Array.from(text)
  const spans: Span[] = []
  let index = 0
  while (index < chars.length) {
    if (chars[index] === WORD_BOUNDARY) {
      index += 1
      continue
    }
    let matched = ''
    for (let length = Math.min(maxLength, chars.length - index); length >= 1; length -= 1) {
      const candidate = chars.slice(index, index + length).join('')
      if (entries.has(candidate)) {
        matched = candidate
        break
      }
    }
    if (matched) {
      const width = Array.from(matched).length
      spans.push({ word: matched, start: index, end: index + width })
      index += width
    } else {
      spans.push({ word: chars[index], start: index, end: index + 1 })
      index += 1
    }
  }
  return spans
}

function phoneAt(text: string, char: string, entries: Map<string, string>): string {
  const spans = tokenize(text, entries)
  const index = Array.from(text).indexOf(char)
  const span = spans.find((item) => index >= item.start && index < item.end)!
  const reading = entries.get(span.word) ?? ''
  const phones = reading.split(/\s+/).filter((phone) => phone && phone !== '"')
  return phones[index - span.start]
}

describe('整词保护（零宽边界）', () => {
  it('收录用户反馈的三个易错词及同类名词「地」', () => {
    for (const word of ['占便宜', '地盘', '地点', '会计']) {
      expect(PROTECTED_WORDS).toContain(word)
    }
    expect(PROTECTED_WORDS).not.toContain('便宜')
  })

  it('只在前面是汉字时插入边界，且保持幂等', () => {
    expect(protectPronunciations('可能是学会计出身的，')).toBe(
      `可能是学${WORD_BOUNDARY}会计出身的，`,
    )
    expect(protectPronunciations('会计。')).toBe('会计。')
    expect(protectPronunciations('做，会计')).toBe('做，会计')
    const once = protectPronunciations('一些会占便宜的有钱人长期地用盐不给钱；')
    expect(once).toBe(`一些会${WORD_BOUNDARY}占便宜的有钱人长期地用盐不给钱；`)
    expect(protectPronunciations(once)).toBe(once)
  })

  it('长词优先，不在更长的保护词内部再次插入', () => {
    expect(protectPronunciations('占了点地盘之争')).toBe(
      `占了点${WORD_BOUNDARY}地盘之争`,
    )
  })

  it('修复「学会计」被「学会」抢词：会读 kuai4', () => {
    const noComposite = new Map(effective)
    noComposite.delete('学会计')
    const sentence = '可能是学会计出身的，'
    expect(phoneAt(sentence, '会', noComposite)).toBe('hui4')
    expect(phoneAt(protectPronunciations(sentence), '会', noComposite)).toBe('kuai4')
    expect(phoneAt(sentence, '会', effective)).toBe('kuai4')
  })

  it('抢词条目存在时仍保住「便 pian2」与「地 di4」', () => {
    const stolen = new Map(effective)
    stolen.set('会占便宜', 'hui4 zhan4 bian4 yi2')
    stolen.set('点地盘', 'dian3 de pan2')

    const pianyi = '一些会占便宜的有钱人长期地用盐不给钱；'
    const dipan = '自己只是占了点地盘；'
    expect(phoneAt(pianyi, '便', stolen)).toBe('bian4')
    expect(phoneAt(dipan, '地', stolen)).toBe('de')
    expect(phoneAt(protectPronunciations(pianyi), '便', stolen)).toBe('pian2')
    expect(phoneAt(protectPronunciations(dipan), '地', stolen)).toBe('di4')
  })
})
