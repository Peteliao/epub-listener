import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CATEGORIES = [
  'polyphone',
  'long-sentence',
  'dialogue',
  'particle',
  'number',
  'acoustic',
] as const

interface BlindItem {
  id: string
  category: string
  text: string
  focus: string
  note: string
}

function loadCorpus(): BlindItem[] {
  const file = resolve(process.cwd(), 'tests/fixtures/blind-listening.v1.jsonl')
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => JSON.parse(line) as BlindItem)
}

describe('2026-11-23 第十一轮：固定盲听语料', () => {
  const corpus = loadCorpus()

  it('至少 40 条，六个类别都有足够样本', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(40)
    for (const category of CATEGORIES) {
      const items = corpus.filter((item) => item.category === category)
      expect(items.length, category).toBeGreaterThanOrEqual(6)
    }
  })

  it('id 与文本唯一，字段完整', () => {
    const ids = new Set<string>()
    const texts = new Set<string>()
    for (const item of corpus) {
      expect(item.id, item.text).toMatch(/^blind-/)
      expect(ids.has(item.id), item.id).toBe(false)
      expect(texts.has(item.text), item.text).toBe(false)
      ids.add(item.id)
      texts.add(item.text)
      expect(CATEGORIES).toContain(item.category as (typeof CATEGORIES)[number])
      expect(/\p{Script=Han}/u.test(item.text), item.text).toBe(true)
      expect(item.focus.trim().length, item.id).toBeGreaterThan(0)
      expect(item.note.trim().length, item.id).toBeGreaterThan(0)
    }
  })

  it('每个类别至少有 6 条，方便按维度做盲听评分', () => {
    for (const category of CATEGORIES) {
      expect(corpus.filter((item) => item.category === category).length).toBeGreaterThanOrEqual(6)
    }
  })
})
